import { describe, expect, it, vi } from "vitest";
import type { AdmissionDecision, TurnResult } from "@endec/domain";
import {
  createInMemoryTelegramAdapterStateStore,
  createTelegramAdapter,
  createTelegramPollingWorker,
  createTelegramReplyFallbackText
} from "./index.ts";

function createTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    turnId: overrides.turnId ?? "turn_001",
    sessionId: overrides.sessionId ?? "session_topic_77",
    resolvedMode: overrides.resolvedMode ?? "chat",
    status: overrides.status ?? "completed",
    messages: overrides.messages ?? [{ role: "assistant", content: "hello from telegram adapter" }],
    toolEvents: overrides.toolEvents ?? [],
    taskUpdates: overrides.taskUpdates ?? [],
    usage: overrides.usage ?? {
      inputTokens: 10,
      outputTokens: 6,
      totalTokens: 16,
      estimatedCost: 0.01
    },
    warnings: overrides.warnings ?? [],
    checkpointRef: overrides.checkpointRef ?? "checkpoint_001",
    blockedBy: overrides.blockedBy
  };
}

function createBoundConversationRef() {
  return {
    accountId: "acct_bot",
    conversationId: "dm:42",
    peerId: "42",
    peerKind: "dm" as const
  };
}

function dispatchAdmission(): AdmissionDecision {
  return {
    outcome: "dispatch_turn",
    expectsUserVisibleReply: true
  };
}

function dropAdmission(): AdmissionDecision {
  return {
    outcome: "drop",
    expectsUserVisibleReply: false
  };
}

function directReplyAdmission(text: string, outcome: "reply_direct" | "reject_direct" = "reply_direct"): AdmissionDecision {
  return {
    outcome,
    expectsUserVisibleReply: true,
    directReply: { text }
  };
}

function createAppStub(options: {
  evaluateInboundAdmission?: any;
  evaluateOutboundConversationLegality?: any;
  applyConversationLifecycleEvent?: any;
  executeTurn?: any;
  resolveSessionId?: any;
  resolveActorId?: any;
  recordPassiveIngress?: any;
  executeCommand?: any;
} = {}) {
  return {
    shell: {
      executeTurn: options.executeTurn ?? vi.fn(async () => createTurnResult())
    },
    im: {
      resolveSessionId: options.resolveSessionId ?? vi.fn(async () => "session_topic_77"),
      resolveActorId: options.resolveActorId ?? vi.fn(async () => "actor_bob"),
      recordPassiveIngress: options.recordPassiveIngress ?? vi.fn(async () => undefined),
      executeCommand: options.executeCommand ?? vi.fn(async (input: { commandIntent: { options: Record<string, unknown> } }) => {
        const unknownCommand = input.commandIntent.options.unknownCommand;
        if (typeof unknownCommand === "string") {
          return {
            kind: "reply_text" as const,
            replyText: `Unknown command: /${unknownCommand}. Use /help for the supported command list.`
          };
        }

        return {
          kind: "reply_text" as const,
          replyText: "default command reply"
        };
      }),
      evaluateInboundAdmission: options.evaluateInboundAdmission ?? vi.fn(async () => dispatchAdmission()),
      applyConversationLifecycleEvent: options.applyConversationLifecycleEvent ?? vi.fn(async () => undefined),
      evaluateOutboundConversationLegality:
        options.evaluateOutboundConversationLegality ?? vi.fn(async () => ({ status: "allowed" as const, reason: "owner_direct" }))
    }
  };
}

function createClientStub() {
  const sendMessage = vi.fn(async (input: {
    chatId: string;
    text: string;
    messageThreadId?: number;
    replyToMessageId?: number;
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  }) => ({
    messageId: `sent_${input.replyToMessageId ?? "root"}`,
    chatId: input.chatId
  }));
  const sendChatAction = vi.fn(async () => undefined);
  const answerCallbackQuery = vi.fn(async () => undefined);

  return {
    client: {
      getUpdates: vi.fn(async () => []),
      sendMessage,
      sendChatAction,
      answerCallbackQuery,
      getMe: async () => ({
        id: 999,
        is_bot: true,
        username: "endec"
      })
    } as never,
    sendMessage,
    sendChatAction,
    answerCallbackQuery
  };
}

describe("createTelegramAdapter", () => {
  it("routes lifecycle updates through the shared app lifecycle seam without typing or direct reply", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub();

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 201,
      my_chat_member: {
        date: 1_712_000_222,
        chat: {
          id: -100555,
          type: "supergroup"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        },
        old_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "left"
        },
        new_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "member"
        }
      }
    });

    expect(handled).toMatchObject({
      status: "lifecycle_applied",
      lifecycleEvent: {
        eventKind: "bot_added",
        conversationScope: "shared",
        subjectRef: "999",
        metadata: expect.objectContaining({
          workspaceId: "workspace_local"
        })
      }
    });
    expect(app.im.applyConversationLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(app.im.applyConversationLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        workspaceId: "workspace_local"
      })
    }));
    expect(app.im.evaluateInboundAdmission).not.toHaveBeenCalled();
    expect(sendChatAction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("replies with a pair code for a first ordinary unbound direct message", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub({
      evaluateInboundAdmission: vi.fn(async () => directReplyAdmission("Pair code: ABCD1234"))
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 101,
      message: {
        message_id: 11,
        date: 1_712_000_000,
        text: "hello there",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(handled).toMatchObject({
      status: "direct_replied",
      admissionDecision: {
        outcome: "reply_direct"
      }
    });
    expect(app.im.evaluateInboundAdmission).toHaveBeenCalledWith(expect.objectContaining({
      conversationScope: "direct",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: false,
        replyToBot: false
      }
    }));
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "Pair code: ABCD1234",
      messageThreadId: undefined,
      replyToMessageId: 11
    });
  });

  it("reuses the pending pair code for repeated unbound direct messages until expiry", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const evaluateInboundAdmission = vi
      .fn(async () => directReplyAdmission("Pair code: ABCD1234"))
      .mockImplementationOnce(async () => directReplyAdmission("Pair code: ABCD1234"))
      .mockImplementationOnce(async () => directReplyAdmission("Pair code: ABCD1234"));
    const app = createAppStub({ evaluateInboundAdmission });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const first = await adapter.handleUpdate({
      update_id: 102,
      message: {
        message_id: 12,
        date: 1_712_000_001,
        text: "hello there",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    const second = await adapter.handleUpdate({
      update_id: 103,
      message: {
        message_id: 13,
        date: 1_712_000_002,
        text: "still there?",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(first).toMatchObject({ status: "direct_replied" });
    expect(second).toMatchObject({ status: "direct_replied" });
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      chatId: "42",
      text: "Pair code: ABCD1234",
      messageThreadId: undefined,
      replyToMessageId: 12
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: "42",
      text: "Pair code: ABCD1234",
      messageThreadId: undefined,
      replyToMessageId: 13
    });
  });


  it("dispatches bound owner direct messages by owner identity without requiring a mention", async () => {
    const executeTurn = vi.fn(async () => createTurnResult({ messages: [{ role: "assistant", content: "owner dm reply" }] }));
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub({ executeTurn });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 103,
      message: {
        message_id: 13,
        date: 1_712_000_002,
        text: "summarize this",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        }
      }
    });

    expect(handled).toMatchObject({
      status: "dispatched",
      turnRequest: {
        input: "summarize this"
      }
    });
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "owner dm reply",
      messageThreadId: undefined,
      replyToMessageId: 13
    });
  });

  it("rejects bound non-owner direct messages with an explicit reply", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub({
      evaluateInboundAdmission: vi.fn(async () => directReplyAdmission(
        "This instance is already bound to another owner. This direct conversation is not available.",
        "reject_direct"
      ))
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    await adapter.handleUpdate({
      update_id: 104,
      message: {
        message_id: 14,
        date: 1_712_000_003,
        text: "can I use this",
        chat: {
          id: 43,
          type: "private"
        },
        from: {
          id: 8,
          is_bot: false,
          username: "stranger"
        }
      }
    });

    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]?.text).toContain("already bound");
  });

  it("passively ingests trusted shared-chat traffic without typing or replying", async () => {
    const evaluateInboundAdmission = vi.fn(async (request: { activationHint: { explicitActivation: boolean } }) =>
      request.activationHint.explicitActivation
        ? dispatchAdmission()
        : { outcome: "passive_ingest" as const, expectsUserVisibleReply: false }
    );
    const recordPassiveIngress = vi.fn(async () => undefined);
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub({ evaluateInboundAdmission, recordPassiveIngress });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 501,
      message: {
        message_id: 51,
        date: 1_714_000_001,
        text: "release slipped by one day",
        chat: { id: -100123, type: "supergroup", is_forum: true },
        from: { id: 9, is_bot: false, username: "alice" },
        message_thread_id: 77,
        is_topic_message: true
      }
    });

    expect(handled).toMatchObject({ status: "passive_ingested" });
    expect(app.im.recordPassiveIngress).toHaveBeenCalledTimes(1);
    expect(sendChatAction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats /status as an activating command in trusted shared chats", async () => {
    const executeCommand = vi.fn(async () => ({
      kind: "reply_text" as const,
      replyText: "conversation: supergroup:-100123\ndisclosureMode: local_only"
    }));
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub({ executeCommand });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 502,
      message: {
        message_id: 52,
        date: 1_714_000_002,
        text: "/status",
        chat: { id: -100123, type: "supergroup" },
        from: { id: 9, is_bot: false, username: "alice" }
      }
    });

    expect(handled).toMatchObject({ status: "command_replied" });
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]?.text).toContain("disclosureMode: local_only");
    expect(app.shell.executeTurn).not.toHaveBeenCalled();
  });

  it("returns deterministic help for unknown slash commands instead of forwarding them to the model", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub();

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 504,
      message: {
        message_id: 54,
        date: 1_714_000_004,
        text: "/notacommand",
        chat: { id: -100123, type: "supergroup" },
        from: { id: 9, is_bot: false, username: "alice" }
      }
    });

    expect(handled).toMatchObject({ status: "command_replied" });
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]?.text).toContain("Unknown command");
    expect(app.shell.executeTurn).not.toHaveBeenCalled();
  });

  it("forwards bot-added lifecycle updates with bot subjectRef and derived actor identity", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client } = createClientStub();
    const applyConversationLifecycleEvent = vi.fn(async () => undefined);
    const app = createAppStub({ applyConversationLifecycleEvent });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 211,
      my_chat_member: {
        date: 1_712_000_444,
        chat: {
          id: -100777,
          type: "supergroup"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        },
        old_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "left"
        },
        new_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "member"
        }
      }
    });

    expect(handled).toMatchObject({
      status: "lifecycle_applied",
      lifecycleEvent: {
        eventKind: "bot_added",
        subjectRef: "999",
        actorId: "actor_im_744a2f09c35c59fbc3d16d3b",
        metadata: expect.objectContaining({
          workspaceId: "workspace_local",
          actorId: "7",
          subjectId: "999"
        })
      }
    });
    expect(applyConversationLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "bot_added",
      subjectRef: "999",
      actorId: "actor_im_744a2f09c35c59fbc3d16d3b"
    }));
  });

  it("dispatches trusted group mentions after re-add when lifecycle events preserve workspace metadata", async () => {
    const executeTurn = vi.fn(async () => createTurnResult({ messages: [{ role: "assistant", content: "trusted group reply" }] }));
    const evaluateInboundAdmission = vi.fn(async (request: { activationHint: { explicitActivation: boolean } }) =>
      request.activationHint.explicitActivation ? dispatchAdmission() : dropAdmission()
    );
    const applyConversationLifecycleEvent = vi.fn(async () => undefined);
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub({ executeTurn, evaluateInboundAdmission, applyConversationLifecycleEvent });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    await adapter.handleUpdate({
      update_id: 205,
      my_chat_member: {
        date: 1_712_000_222,
        chat: {
          id: -100555,
          type: "supergroup"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        },
        old_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "left"
        },
        new_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "member"
        }
      }
    });

    const mentionHandled = await adapter.handleUpdate({
      update_id: 206,
      message: {
        message_id: 25,
        date: 1_712_000_230,
        text: "@endec summarize the topic again",
        message_thread_id: 77,
        is_topic_message: true,
        chat: {
          id: -100123,
          type: "supergroup",
          is_forum: true
        },
        from: {
          id: 9,
          is_bot: false,
          username: "bob"
        },
        entities: [
          {
            type: "mention",
            offset: 0,
            length: 6
          }
        ]
      }
    });

    expect(mentionHandled).toMatchObject({ status: "dispatched" });
    expect(applyConversationLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ workspaceId: "workspace_local" })
    }));
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("silently drops untrusted group activation and untrusted group noise", async () => {
    const evaluateInboundAdmission = vi.fn(async () => dropAdmission());
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, sendChatAction } = createClientStub();
    const app = createAppStub({ evaluateInboundAdmission });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const activationHandled = await adapter.handleUpdate({
      update_id: 107,
      message: {
        message_id: 17,
        date: 1_712_000_006,
        text: "@endec help here",
        chat: {
          id: -100200,
          type: "supergroup"
        },
        from: {
          id: 10,
          is_bot: false,
          username: "carol"
        },
        entities: [
          {
            type: "mention",
            offset: 0,
            length: 6
          }
        ]
      }
    });

    const noiseHandled = await adapter.handleUpdate({
      update_id: 108,
      message: {
        message_id: 18,
        date: 1_712_000_007,
        text: "ambient noise",
        chat: {
          id: -100200,
          type: "supergroup"
        },
        from: {
          id: 10,
          is_bot: false,
          username: "carol"
        }
      }
    });

    expect(activationHandled).toMatchObject({ status: "dropped" });
    expect(noiseHandled).toMatchObject({ status: "dropped" });
    expect(sendChatAction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("renders owner-DM /models pickers, applies callback selections without model turns, and keeps later /model replies single-model", async () => {
    let activeModel = "openai/gpt-5.4";
    const executeTurn = vi.fn(async () => createTurnResult({ messages: [{ role: "assistant", content: "model turn should stay unused" }] }));
    const executeCommand = vi.fn(async (input: {
      commandIntent: {
        name: string;
        subcommand?: string;
        args: string[];
      };
      conversationScope: "direct" | "shared";
    }) => {
      if (input.commandIntent.name === "models" && input.conversationScope === "shared") {
        return {
          kind: "reply_text" as const,
          replyText: "/models is owner-only and only available in the owner private chat. Shared chats stay read-only; use /model here to inspect the active model."
        };
      }

      if (input.commandIntent.name === "models" && input.commandIntent.subcommand === "select") {
        activeModel = input.commandIntent.args[0] ?? activeModel;
        return {
          kind: "reply_text" as const,
          replyText: `Updated model: ${activeModel}`
        };
      }

      if (input.commandIntent.name === "models") {
        return {
          kind: "reply_model_picker" as const,
          replyText: "Choose the active model:",
          options: [
            { providerId: "openai", modelId: "gpt-5.4", label: "GPT 5.4" },
            { providerId: "anthropic", modelId: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" }
          ]
        };
      }

      if (input.commandIntent.name === "model") {
        return {
          kind: "reply_text" as const,
          replyText: `model: ${activeModel}`
        };
      }

      return {
        kind: "reply_text" as const,
        replyText: "default command reply"
      };
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage, answerCallbackQuery } = createClientStub();
    const app = createAppStub({ executeTurn, executeCommand });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const pickerHandled = await adapter.handleUpdate({
      update_id: 120,
      message: {
        message_id: 30,
        date: 1_714_000_020,
        text: "/models",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        }
      }
    });

    expect(pickerHandled).toMatchObject({ status: "command_replied" });
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      chatId: "42",
      text: "Choose the active model:",
      messageThreadId: undefined,
      replyToMessageId: 30,
      replyMarkup: {
        inline_keyboard: [
          [{ text: "GPT 5.4", callback_data: "/models select openai/gpt-5.4" }],
          [{ text: "Claude Sonnet 4.5", callback_data: "/models select anthropic/claude-sonnet-4.5" }]
        ]
      }
    });
    expect(executeTurn).not.toHaveBeenCalled();

    const callbackHandled = await adapter.handleUpdate({
      update_id: 121,
      callback_query: {
        id: "cbq_models_001",
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        },
        data: "/models select anthropic/claude-sonnet-4.5",
        message: {
          message_id: 31,
          date: 1_714_000_021,
          chat: {
            id: 42,
            type: "private"
          }
        }
      }
    });

    expect(callbackHandled).toMatchObject({ status: "command_replied" });
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: "cbq_models_001",
      text: "Updated model: anthropic/claude-sonnet-4.5"
    });
    expect(executeTurn).not.toHaveBeenCalled();

    const modelHandled = await adapter.handleUpdate({
      update_id: 122,
      message: {
        message_id: 32,
        date: 1_714_000_022,
        text: "/model",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        }
      }
    });

    expect(modelHandled).toMatchObject({ status: "command_replied" });
    expect(sendMessage).toHaveBeenNthCalledWith(3, {
      chatId: "42",
      text: "model: anthropic/claude-sonnet-4.5",
      messageThreadId: undefined,
      replyToMessageId: 32
    });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("keeps shared-chat /models read-only without rendering an inline keyboard", async () => {
    const executeCommand = vi.fn(async () => ({
      kind: "reply_text" as const,
      replyText: "/models is owner-only and only available in the owner private chat. Shared chats stay read-only; use /model here to inspect the active model."
    }));
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const { client, sendMessage } = createClientStub();
    const app = createAppStub({ executeCommand });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client,
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 123,
      message: {
        message_id: 33,
        date: 1_714_000_023,
        text: "/models",
        chat: {
          id: -100123,
          type: "supergroup"
        },
        from: {
          id: 9,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(handled).toMatchObject({ status: "command_replied" });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "-100123",
      text: expect.stringContaining("owner private chat"),
      messageThreadId: undefined,
      replyToMessageId: 33
    });
    expect(sendMessage.mock.calls[0]?.[0]).not.toHaveProperty("replyMarkup");
  });

  it("does not let typing failures block visible auto-pair direct replies", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.replyToMessageId ?? "root"}`,
      chatId: input.chatId
    }));
    const sendChatAction = vi.fn(async () => {
      throw new Error("typing failed");
    });
    const app = createAppStub({
      evaluateInboundAdmission: vi.fn(async () => directReplyAdmission("Pair code: ZXCV1234"))
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client: {
        getUpdates: vi.fn(async () => []),
        sendMessage,
        sendChatAction,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 109,
      message: {
        message_id: 19,
        date: 1_712_000_008,
        text: "hello there",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(handled).toMatchObject({ status: "direct_replied" });
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "Pair code: ZXCV1234",
      messageThreadId: undefined,
      replyToMessageId: 19
    });
  });

  it("bypasses legality rechecks for control replies while still rechecking normal outbound", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.replyToMessageId ?? "root"}`,
      chatId: input.chatId
    }));
    const evaluateOutboundConversationLegality = vi.fn(async () => ({
      status: "blocked" as const,
      reason: "authority_unbound"
    }));
    const app = createAppStub({
      evaluateInboundAdmission: vi.fn(async () => directReplyAdmission("Pair code: BYPASS123")),
      evaluateOutboundConversationLegality
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client: {
        getUpdates: vi.fn(async () => []),
        sendMessage,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 110,
      message: {
        message_id: 20,
        date: 1_712_000_009,
        text: "hello there",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(handled).toMatchObject({ status: "direct_replied" });
    expect(evaluateOutboundConversationLegality).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "Pair code: BYPASS123",
      messageThreadId: undefined,
      replyToMessageId: 20
    });
  });

  it("rechecks legality for normal outbound turn replies", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.replyToMessageId ?? "root"}`,
      chatId: input.chatId
    }));
    const evaluateOutboundConversationLegality = vi.fn(async () => ({
      status: "blocked" as const,
      reason: "conversation_not_trusted"
    }));
    const executeTurn = vi.fn(async () => createTurnResult({ messages: [{ role: "assistant", content: "should not send" }] }));
    const app = createAppStub({ executeTurn, evaluateOutboundConversationLegality });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client: {
        getUpdates: vi.fn(async () => []),
        sendMessage,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    const handled = await adapter.handleUpdate({
      update_id: 111,
      message: {
        message_id: 21,
        date: 1_712_000_010,
        text: "owner turn",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        }
      }
    });

    expect(handled).toMatchObject({ status: "dispatched" });
    expect(evaluateOutboundConversationLegality).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rechecks outbound legality before dispatching bound session replies", async () => {
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const stateStore = createInMemoryTelegramAdapterStateStore();
    await stateStore.saveSessionBinding({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      sessionId: "session_blocked_outbound",
      conversationRef: createBoundConversationRef()
    });

    const app = createAppStub({
      evaluateOutboundConversationLegality: vi.fn(async () => ({ status: "blocked" as const, reason: "conversation_not_trusted" }))
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client: {
        getUpdates: async () => [],
        sendMessage,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    await adapter.dispatchTurnResultForSession({
      sessionId: "session_blocked_outbound",
      turnResult: createTurnResult({
        turnId: "turn_blocked_outbound",
        sessionId: "session_blocked_outbound",
        messages: [{ role: "assistant", content: "should not send" }]
      })
    });

    expect(app.im.evaluateOutboundConversationLegality).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("prioritizes the telegram permission-blocked notice over assistant preamble text", async () => {
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const stateStore = createInMemoryTelegramAdapterStateStore();
    await stateStore.saveSessionBinding({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      sessionId: "session_blocked_permission",
      conversationRef: createBoundConversationRef()
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app: createAppStub(),
      client: {
        getUpdates: async () => [],
        sendMessage,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    await adapter.dispatchTurnResultForSession({
      sessionId: "session_blocked_permission",
      turnResult: createTurnResult({
        turnId: "turn_blocked_permission",
        status: "blocked",
        blockedBy: "permission",
        messages: [{ role: "assistant", content: "我先帮你继续处理，稍等一下。" }],
        warnings: ["permission required"]
      })
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: createTelegramReplyFallbackText({
        status: "blocked",
        blockedBy: "permission",
        warnings: []
      }),
      messageThreadId: undefined,
      replyToMessageId: undefined
    });
    expect(sendMessage.mock.calls[0]?.[0]?.text).not.toContain("我先帮你继续处理");
  });

  it("respects the configured sanitized mode when dispatching Telegram fallback replies", async () => {
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const stateStore = createInMemoryTelegramAdapterStateStore();
    await stateStore.saveSessionBinding({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      sessionId: "session_sanitized_fallback",
      conversationRef: createBoundConversationRef()
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app: createAppStub(),
      client: {
        getUpdates: async () => [],
        sendMessage,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore,
      errorExposureMode: "sanitized"
    });

    await adapter.dispatchTurnResultForSession({
      sessionId: "session_sanitized_fallback",
      turnResult: createTurnResult({
        turnId: "turn_sanitized_fallback",
        sessionId: "session_sanitized_fallback",
        status: "interrupted",
        messages: [],
        warnings: []
      })
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "The turn was interrupted before an outbound reply could be rendered.",
      messageThreadId: undefined,
      replyToMessageId: undefined
    });
  });

  it("keeps owner-private lifecycle updates silent in-group while later private traffic still routes normally", async () => {
    const executeTurn = vi.fn(async () => createTurnResult({ turnId: "turn_polled_1" }));
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const sendChatAction = vi.fn(async () => undefined);
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const app = createAppStub({ executeTurn });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app,
      client: {
        getUpdates: async () => [],
        sendMessage,
        sendChatAction,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    const worker = createTelegramPollingWorker({
      accountId: "acct_bot",
      client: {
        getUpdates: async () => [
          {
            update_id: 401,
            my_chat_member: {
              date: 1_712_000_222,
              chat: {
                id: -100555,
                type: "supergroup"
              },
              from: {
                id: 7,
                is_bot: false,
                username: "owner"
              },
              old_chat_member: {
                user: { id: 999, is_bot: true, username: "endec" },
                status: "left"
              },
              new_chat_member: {
                user: { id: 999, is_bot: true, username: "endec" },
                status: "member"
              }
            }
          },
          {
            update_id: 402,
            message: {
              message_id: 66,
              date: 1_712_000_444,
              text: "hello from dm",
              chat: {
                id: 42,
                type: "private"
              },
              from: {
                id: 7,
                is_bot: false,
                username: "alice"
              }
            }
          }
        ],
        sendMessage,
        sendChatAction,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      adapter,
      stateStore
    });

    const polled = await worker.pollOnce();

    expect(polled).toMatchObject({
      receivedCount: 2,
      ignoredCount: 1,
      droppedCount: 0,
      dispatchedCount: 1,
      nextUpdateId: 403
    });
    await expect(stateStore.readPollingOffset({ accountId: "acct_bot" })).resolves.toBe(403);
    expect(app.im.applyConversationLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "hello from telegram adapter",
      messageThreadId: undefined,
      replyToMessageId: 66
    });
  });


  it("does not send raw memory diagnostics through Telegram fallback", async () => {
    const sendMessage = vi.fn(async (input: { chatId: string; text: string; messageThreadId?: number; replyToMessageId?: number }) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const stateStore = createInMemoryTelegramAdapterStateStore();
    await stateStore.saveSessionBinding({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      sessionId: "session_telegram_memory_hidden",
      conversationRef: createBoundConversationRef()
    });

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app: createAppStub(),
      client: {
        getUpdates: async () => [],
        sendMessage,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    await adapter.dispatchTurnResultForSession({
      sessionId: "session_telegram_memory_hidden",
      turnResult: createTurnResult({
        turnId: "turn_telegram_memory_hidden",
        sessionId: "session_telegram_memory_hidden",
        status: "completed",
        messages: [],
        warnings: ["memory_context_truncated"]
      })
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "The turn completed without an assistant text reply.",
      messageThreadId: undefined,
      replyToMessageId: undefined
    });
    expect(sendMessage.mock.calls[0]?.[0]?.text).not.toContain("memory_context_truncated");
    expect(sendMessage.mock.calls[0]?.[0]?.text).not.toContain("memory selection truncated to fit budget");
  });
});
