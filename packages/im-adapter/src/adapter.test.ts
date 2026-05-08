import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFallbackOutboundText, createImAdapter, createMentionGate, normalizeFakeTransportInbound } from "./index.ts";
import type { OutboundMessage } from "./types.ts";

function allowAdmissionDecision() {
  return {
    outcome: "dispatch_turn" as const,
    expectsUserVisibleReply: true
  };
}

function passiveIngestAdmissionDecision() {
  return {
    outcome: "passive_ingest" as const,
    expectsUserVisibleReply: false
  };
}

type JsonObject = Record<string, unknown>;

function createChatCompletionTransport(responses: Array<Array<JsonObject>>) {
  let index = 0;

  return {
    async *stream() {
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
  };
}

const tempDirs = new Set<string>();

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-im-adapter-"));
}

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("createImAdapter", () => {
  it("keeps normal inbound turns on the synchronous execute-and-dispatch path", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "completed" as const,
      messages: [
        {
          role: "assistant",
          content: "synchronous reply"
        }
      ],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_${index + 1}`,
      messageId: `out_${index + 1}`,
      message
    })));
    const resolveSessionId = vi.fn(async () => "session_sync_001");
    const resolveActorId = vi.fn(async () => "actor_sync_001");
    const evaluateInboundAdmission = vi.fn(async () => allowAdmissionDecision());

    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId,
          resolveActorId,
          evaluateInboundAdmission
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_sync_001",
      senderId: "user_sync_001",
      messageId: "msg_sync_001",
      text: "hello",
      mentionsBot: false
    });

    expect(handled.status).toBe("dispatched");
    if (handled.status !== "dispatched") {
      throw new Error("expected dispatched IM result");
    }

    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(executeTurn).toHaveBeenCalledWith(expect.objectContaining({
      input: "hello",
      sessionId: "session_sync_001",
      actorId: "actor_sync_001"
    }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "synchronous reply",
        sessionId: "session_sync_001",
        conversationRef: expect.objectContaining({
          conversationId: "dm:chat_sync_001"
        })
      })
    ]);
  });

  it("drops unmentioned group traffic before agent dispatch", async () => {
    const executeTurn = vi.fn();
    const dispatch = vi.fn(async () => []);
    const resolveSessionId = vi.fn(async () => "session_canonical_unused");
    const resolveActorId = vi.fn(async () => "actor_canonical_unused");
    const evaluateInboundAdmission = vi.fn(async () => allowAdmissionDecision());
    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId,
          resolveActorId,
          evaluateInboundAdmission
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      senderId: "user_001",
      messageId: "msg_001",
      text: "hello from the group",
      mentionsBot: false
    });

    expect(handled).toMatchObject({
      status: "dropped",
      gateDecision: {
        kind: "drop",
        reasonCode: "mention_required"
      }
    });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(resolveSessionId).not.toHaveBeenCalled();
    expect(resolveActorId).not.toHaveBeenCalled();
  });

  it("records passive-ingest admissions without creating a visible reply", async () => {
    const executeTurn = vi.fn();
    const dispatch = vi.fn(async () => []);
    const resolveSessionId = vi.fn(async () => "session_passive_001");
    const resolveActorId = vi.fn(async () => "actor_passive_001");
    const recordPassiveIngress = vi.fn(async () => undefined);

    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId,
          resolveActorId,
          evaluateInboundAdmission: vi.fn(async () => passiveIngestAdmissionDecision()),
          recordPassiveIngress
        }
      },
      normalizeInbound: () => ({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "user_passive_001",
        text: "release slipped by one day",
        attachments: [],
        transportMessageId: "msg_passive_001",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "supergroup:-100123",
          peerId: "-100123",
          peerKind: "group",
          baseConversationId: "supergroup:-100123"
        },
        conversationScope: "shared",
        channelContext: {
          messageId: "msg_passive_001"
        },
        activationHint: {
          pairRequested: false,
          explicitActivation: false,
          mentionMatched: false,
          replyToBot: false
        },
        activationKind: "passive_ingest"
      }),
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({});

    expect(handled).toMatchObject({ status: "passive_ingested" });
    expect(recordPassiveIngress).toHaveBeenCalledWith(expect.objectContaining({
      turnRequest: expect.objectContaining({
        input: "release slipped by one day",
        imContext: expect.objectContaining({
          activationKind: "passive_ingest",
          boundary: expect.objectContaining({
            boundaryKey: "supergroup:-100123",
            disclosureMode: "local_only"
          })
        })
      })
    }));
    expect(executeTurn).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("routes recognized IM commands through the command service before model execution", async () => {
    const executeTurn = vi.fn();
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_command_${index + 1}`,
      messageId: `out_command_${index + 1}`,
      message
    })));
    const executeCommand = vi.fn(async () => ({
      kind: "reply_text" as const,
      replyText: "conversation: supergroup:-100123\ndisclosureMode: local_only"
    }));

    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_command_001"),
          resolveActorId: vi.fn(async () => "actor_command_001"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision()),
          executeCommand
        }
      },
      normalizeInbound: () => ({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "user_command_001",
        text: "/status",
        attachments: [],
        transportMessageId: "msg_command_001",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "supergroup:-100123",
          peerId: "-100123",
          peerKind: "group",
          baseConversationId: "supergroup:-100123"
        },
        conversationScope: "shared",
        channelContext: {
          messageId: "msg_command_001"
        },
        activationHint: {
          pairRequested: false,
          explicitActivation: true,
          mentionMatched: false,
          replyToBot: false
        },
        activationKind: "command_execution",
        commandIntent: {
          name: "status",
          args: [],
          options: {},
          rawText: "/status",
          helpRequested: false
        }
      }),
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({});

    expect(handled).toMatchObject({ status: "command_replied" });
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandIntent: expect.objectContaining({ name: "status" }),
      conversationScope: "shared",
      turnRequest: expect.objectContaining({
        imContext: expect.objectContaining({
          activationKind: "command_execution",
          commandIntent: expect.objectContaining({ name: "status" })
        })
      })
    }));
    expect(executeTurn).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: expect.stringContaining("disclosureMode: local_only"),
        replyToMessageId: "msg_command_001"
      })
    ]);
  });

  it("preserves structured model-picker command replies for transport-specific rendering", async () => {
    const executeTurn = vi.fn();
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_picker_${index + 1}`,
      messageId: `out_picker_${index + 1}`,
      message
    })));
    const executeCommand = vi.fn(async () => ({
      kind: "reply_model_picker" as never,
      replyText: "Choose the active model:",
      options: [{ providerId: "openai", modelId: "gpt-5.4", label: "GPT 5.4" }]
    }));

    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_models_001"),
          resolveActorId: vi.fn(async () => "actor_models_001"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision()),
          executeCommand
        }
      },
      normalizeInbound: () => ({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "user_models_001",
        text: "/models",
        attachments: [],
        transportMessageId: "msg_models_001",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "private:42",
          peerId: "42",
          peerKind: "dm"
        },
        conversationScope: "direct",
        channelContext: {
          messageId: "msg_models_001"
        },
        activationHint: {
          pairRequested: false,
          explicitActivation: true,
          mentionMatched: false,
          replyToBot: false
        },
        activationKind: "command_execution",
        commandIntent: {
          name: "models" as never,
          args: [],
          options: {},
          rawText: "/models",
          helpRequested: false
        }
      }),
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({});

    expect(handled).toMatchObject({ status: "command_replied" });
    if (handled.status !== "command_replied") {
      throw new Error("expected command_replied IM result");
    }

    expect(executeTurn).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "Choose the active model:",
        replyToMessageId: "msg_models_001",
        metadata: expect.objectContaining({
          commandReply: true,
          commandName: "models",
          commandReplyPayload: {
            kind: "reply_model_picker",
            replyText: "Choose the active model:",
            options: [{ providerId: "openai", modelId: "gpt-5.4", label: "GPT 5.4" }]
          }
        })
      })
    ]);
    expect(handled.outboundMessages[0]?.metadata).toMatchObject({
      commandReplyPayload: {
        kind: "reply_model_picker",
        options: [{ providerId: "openai", modelId: "gpt-5.4", label: "GPT 5.4" }]
      }
    });
  });

  it("derives distinct inbound turn ids for the same telegram message id in different conversations", async () => {
    const recordPassiveIngress = vi.fn(async (_input: { turnRequest: { turnId: string } }) => undefined);
    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn: vi.fn()
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_shared_001"),
          resolveActorId: vi.fn(async () => "actor_shared_001"),
          evaluateInboundAdmission: vi.fn(async () => passiveIngestAdmissionDecision()),
          recordPassiveIngress
        }
      },
      normalizeInbound: (input: { conversationId: string }) => ({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "user_shared_001",
        text: "same message id across chats",
        attachments: [],
        transportMessageId: "91",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: input.conversationId,
          peerId: input.conversationId,
          peerKind: "group",
          baseConversationId: input.conversationId
        },
        conversationScope: "shared",
        channelContext: {
          messageId: "91"
        },
        activationHint: {
          pairRequested: false,
          explicitActivation: false,
          mentionMatched: false,
          replyToBot: false
        },
        activationKind: "passive_ingest"
      }),
      outbound: {
        dispatch: vi.fn(async () => [])
      }
    });

    await adapter.handleInbound({ conversationId: "supergroup:-100123" });
    await adapter.handleInbound({ conversationId: "supergroup:-100456" });

    const passiveCalls = recordPassiveIngress.mock.calls as Array<[{ turnRequest: { turnId: string } }]>;
    const firstTurnId = passiveCalls[0]?.[0]?.turnRequest.turnId;
    const secondTurnId = passiveCalls[1]?.[0]?.turnRequest.turnId;
    expect(firstTurnId).toBeTruthy();
    expect(secondTurnId).toBeTruthy();
    expect(firstTurnId).not.toBe(secondTurnId);
  });

  it("passes adapter binding hints into the sanctioned app IM host seam before dispatching", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "completed" as const,
      messages: [
        {
          role: "assistant",
          content: "hello from adapter"
        }
      ],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_${index + 1}`,
      messageId: `out_${index + 1}`,
      message
    })));
    const resolveSessionId = vi.fn(async ({ binding }: { binding?: { sessionId?: string } }) => binding?.sessionId ?? "session_created_001");
    const resolveActorId = vi.fn(async ({ binding }: { binding?: { actorId?: string } }) => binding?.actorId ?? "actor_im_created_001");
    const evaluateInboundAdmission = vi.fn(async () => allowAdmissionDecision());
    const lookupSessionBinding = vi.fn(async () => ({
      sessionId: "session_bound_777"
    }));
    const lookupActorBinding = vi.fn(async () => ({
      actorId: "actor_bound_user_002"
    }));

    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId,
          resolveActorId,
          evaluateInboundAdmission
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: {
        dispatch
      },
      lookupSessionBinding,
      lookupActorBinding
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      threadId: "thread_777",
      senderId: "user_002",
      messageId: "msg_002",
      text: "@endec summarize this",
      mentionsBot: true
    });

    expect(handled.status).toBe("dispatched");
    expect(lookupSessionBinding).toHaveBeenCalledTimes(1);
    expect(lookupActorBinding).toHaveBeenCalledTimes(1);
    expect(resolveSessionId).toHaveBeenCalledWith({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "chat_001",
        peerKind: "group",
        conversationId: "group:chat_001:thread:thread_777",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: "thread_777"
      },
      binding: {
        sessionId: "session_bound_777"
      }
    });
    expect(resolveActorId).toHaveBeenCalledWith({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "user_002",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "chat_001",
        peerKind: "group",
        conversationId: "group:chat_001:thread:thread_777",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: "thread_777"
      },
      binding: {
        actorId: "actor_bound_user_002"
      }
    });
    expect(handled.turnRequest).toMatchObject({
      source: "telegram",
      sessionId: "session_bound_777",
      actorId: "actor_bound_user_002",
      input: "@endec summarize this",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "chat_001",
        peerKind: "group",
        conversationId: "group:chat_001:thread:thread_777",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: "thread_777"
      },
      channelContext: {
        messageId: "msg_002",
        chatType: "group",
        replyToMessageId: "msg_002"
      }
    });
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "hello from adapter",
        replyToMessageId: "msg_002",
        sessionId: handled.turnRequest?.sessionId,
        conversationRef: expect.objectContaining({
          conversationId: "group:chat_001:thread:thread_777"
        })
      })
    ]);
  });

  it("bypasses turn creation for reply_direct admissions", async () => {
    const executeTurn = vi.fn();
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_reply_${index + 1}`,
      messageId: `out_reply_${index + 1}`,
      message
    })));
    const resolveSessionId = vi.fn(async () => "session_unused_reply_direct");
    const resolveActorId = vi.fn(async () => "actor_unused_reply_direct");
    const evaluateInboundAdmission = vi.fn(async () => ({
      outcome: "reply_direct" as const,
      expectsUserVisibleReply: true,
      directReply: {
        text: "Pair code: ABCD1234"
      }
    }));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId,
          resolveActorId,
          evaluateInboundAdmission
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_reply_direct",
      senderId: "user_reply_direct",
      messageId: "msg_reply_direct",
      text: "/pair",
      mentionsBot: false
    });

    expect(handled).toMatchObject({
      status: "direct_replied",
      admissionDecision: {
        outcome: "reply_direct"
      }
    });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(resolveSessionId).not.toHaveBeenCalled();
    expect(resolveActorId).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "Pair code: ABCD1234",
        replyToMessageId: "msg_reply_direct"
      })
    ]);
  });

  it("bypasses turn creation for reject_direct admissions", async () => {
    const executeTurn = vi.fn();
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_reject_${index + 1}`,
      messageId: `out_reject_${index + 1}`,
      message
    })));
    const resolveSessionId = vi.fn(async () => "session_unused_reject_direct");
    const resolveActorId = vi.fn(async () => "actor_unused_reject_direct");
    const evaluateInboundAdmission = vi.fn(async () => ({
      outcome: "reject_direct" as const,
      expectsUserVisibleReply: true,
      directReply: {
        text: "This instance is already bound."
      }
    }));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId,
          resolveActorId,
          evaluateInboundAdmission
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_reject_direct",
      senderId: "user_reject_direct",
      messageId: "msg_reject_direct",
      text: "hello",
      mentionsBot: false
    });

    expect(handled).toMatchObject({
      status: "direct_replied",
      admissionDecision: {
        outcome: "reject_direct"
      }
    });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(resolveSessionId).not.toHaveBeenCalled();
    expect(resolveActorId).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "This instance is already bound.",
        replyToMessageId: "msg_reject_direct"
      })
    ]);
  });

  it("consumes deterministic owner-init direct messages before model dispatch", async () => {
    const executeTurn = vi.fn();
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_preflight_${index + 1}`,
      messageId: `out_preflight_${index + 1}`,
      message
    })));
    const resolveSessionId = vi.fn(async () => "session_owner_init_001");
    const resolveActorId = vi.fn(async () => "actor_owner_init_001");
    const evaluateInboundAdmission = vi.fn(async () => allowAdmissionDecision());
    const preflightOwnerInit = vi.fn(async () => ({
      outcome: "consumed" as const,
      controlKind: "owner_init" as const,
      completionReason: "fields_captured" as const,
      replyText: "Saved your timezone = Asia/Shanghai."
    }));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId,
          resolveActorId,
          evaluateInboundAdmission,
          preflightOwnerInit
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_owner_init",
      senderId: "owner_user",
      messageId: "msg_owner_init",
      text: "timezone is Beijing time",
      mentionsBot: false
    });

    expect(handled).toMatchObject({
      status: "preflight_consumed",
      preflightDecision: {
        outcome: "consumed",
        completionReason: "fields_captured"
      }
    });
    expect(preflightOwnerInit).toHaveBeenCalledTimes(1);
    expect(executeTurn).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "Saved your timezone = Asia/Shanghai.",
        sessionId: "session_owner_init_001",
        replyToMessageId: "msg_owner_init",
        metadata: expect.objectContaining({
          preflightConsumed: true,
          controlKind: "owner_init"
        })
      })
    ]);
  });

  it("falls through to the normal model path when owner-init input is ambiguous", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "completed" as const,
      messages: [
        {
          role: "assistant",
          content: "normal chat reply"
        }
      ],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_ambiguous_${index + 1}`,
      messageId: `out_ambiguous_${index + 1}`,
      message
    })));
    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_ambiguous_001"),
          resolveActorId: vi.fn(async () => "actor_ambiguous_001"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision()),
          preflightOwnerInit: vi.fn(async () => ({ outcome: "continue" as const }))
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_owner_init_ambiguous",
      senderId: "owner_user",
      messageId: "msg_owner_init_ambiguous",
      text: "maybe call me A or B",
      mentionsBot: false
    });

    expect(handled.status).toBe("dispatched");
    expect(executeTurn).toHaveBeenCalledTimes(1);
  });

  it("routes execution-shaped IM turns onto the stronger runway so a four-tool loop does not die on chat defaults", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "act" as const,
      status: "completed" as const,
      messages: [{ role: "assistant", content: "四次工具调用都完成了。" }],
      toolEvents: [{}, {}, {}, {}],
      taskUpdates: [],
      usage: {
        inputTokens: 32,
        outputTokens: 8,
        totalTokens: 40,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_${index + 1}`,
      messageId: `out_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_runtime_act"),
          resolveActorId: vi.fn(async () => "actor_runtime_act"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      threadId: "thread_777",
      senderId: "user_002",
      messageId: "msg_002_real",
      text: "@endec 请检查这个仓库，读取相关文件并排查失败测试",
      mentionsBot: true
    });

    expect(handled.status).toBe("dispatched");
    if (handled.status !== "dispatched") {
      throw new Error("expected dispatched IM result");
    }

    expect(handled.turnRequest).toMatchObject({
      source: "telegram",
      sessionId: "session_runtime_act",
      actorId: "actor_runtime_act",
      requestedMode: "act",
      input: "@endec 请检查这个仓库，读取相关文件并排查失败测试"
    });
    expect(handled.turnResult).toMatchObject({
      status: "completed",
      resolvedMode: "act",
      messages: [
        {
          role: "assistant",
          content: "四次工具调用都完成了。"
        }
      ]
    });
    expect(handled.turnResult.warnings.join("\n")).not.toContain("maxToolCallsPerBatch");
    expect(handled.turnResult.warnings.join("\n")).not.toContain("maxToolCallsPerTurn");
    expect(handled.turnResult.toolEvents).toHaveLength(4);
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "四次工具调用都完成了。",
        sessionId: handled.turnRequest?.sessionId,
        conversationRef: expect.objectContaining({
          conversationId: "group:chat_001:thread:thread_777"
        })
      })
    ]);
  });

  it("keeps owner-private self-awareness questions on chat and surfaces the bounded inspection reply", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "completed" as const,
      messages: [{ role: "assistant", content: "可以。我会在 owner-private 边界内读取源码、文档和掩码配置，不会默认泄露完整密钥。" }],
      toolEvents: [{}, {}, {}],
      taskUpdates: [],
      usage: {
        inputTokens: 36,
        outputTokens: 12,
        totalTokens: 48,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_${index + 1}`,
      messageId: `out_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_runtime_chat"),
          resolveActorId: vi.fn(async () => "actor_runtime_chat"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_owner_dm",
      senderId: "owner_user",
      messageId: "msg_owner_dm_self",
      text: "你能看见你自己的源码和当前配置吗",
      mentionsBot: false
    });

    expect(handled.status).toBe("dispatched");
    if (handled.status !== "dispatched") {
      throw new Error("expected dispatched IM result");
    }

    expect(handled.turnRequest).toMatchObject({
      source: "telegram",
      requestedMode: "chat",
      sessionId: "session_runtime_chat",
      actorId: "actor_runtime_chat",
      input: "你能看见你自己的源码和当前配置吗"
    });
    expect(handled.turnResult).toMatchObject({
      status: "completed",
      resolvedMode: "chat",
      messages: [
        {
          role: "assistant",
          content: expect.stringContaining("owner-private")
        }
      ]
    });
    expect(handled.turnResult.warnings.join("\n")).not.toContain("maxToolCallsPerBatch");
    expect(handled.turnResult.warnings.join("\n")).not.toContain("maxToolCallsPerTurn");
    expect(handled.turnResult.warnings.join("\n")).not.toContain("Reached maxLoopCount (3)");
    expect(handled.turnResult.toolEvents).toHaveLength(3);
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: expect.stringContaining("owner-private"),
        sessionId: handled.turnRequest?.sessionId,
        conversationRef: expect.objectContaining({
          conversationId: "dm:chat_owner_dm"
        })
      })
    ]);
  });

  it("passes through shared-chat self-awareness denial on chat without escalating to act", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "completed" as const,
      messages: [{ role: "assistant", content: "不能在共享聊天里检查 Endec 自身的源码、配置或密钥。" }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_group_${index + 1}`,
      messageId: `out_group_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_runtime_group"),
          resolveActorId: vi.fn(async () => "actor_runtime_group"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      threadId: "thread_777",
      senderId: "user_003",
      messageId: "msg_003_chat_self",
      text: "@endec 你能看见你自己的代码文件吗",
      mentionsBot: true
    });

    expect(handled.status).toBe("dispatched");
    if (handled.status !== "dispatched") {
      throw new Error("expected dispatched IM result");
    }

    expect(handled.turnRequest).toMatchObject({
      source: "telegram",
      requestedMode: "chat",
      sessionId: "session_runtime_group",
      actorId: "actor_runtime_group",
      input: "@endec 你能看见你自己的代码文件吗"
    });
    expect(handled.turnResult).toMatchObject({
      status: "completed",
      resolvedMode: "chat",
      messages: [
        {
          role: "assistant",
          content: expect.stringContaining("共享聊天")
        }
      ]
    });
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: expect.stringContaining("共享聊天"),
        sessionId: handled.turnRequest?.sessionId,
        conversationRef: expect.objectContaining({
          conversationId: "group:chat_001:thread:thread_777"
        })
      })
    ]);
  });

  it("routes review-shaped IM turns onto review instead of collapsing them into act", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: turnRequest.requestedMode ?? "chat",
      status: "completed" as const,
      messages: [
        {
          role: "assistant",
          content: "review routing observed"
        }
      ],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_${index + 1}`,
      messageId: `out_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_review_001"),
          resolveActorId: vi.fn(async () => "actor_review_001"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      senderId: "user_003",
      messageId: "msg_review_001",
      text: "@endec review this patch and call out the risky parts",
      mentionsBot: true
    });

    expect(handled.status).toBe("dispatched");
    if (handled.status !== "dispatched") {
      throw new Error("expected dispatched IM result");
    }

    expect(handled.turnRequest).toMatchObject({
      requestedMode: "review",
      input: "@endec review this patch and call out the risky parts"
    });
    expect(handled.turnResult).toMatchObject({
      status: "completed",
      resolvedMode: "review"
    });
  });

  it("routes mixed English execute-review overlap onto act before dispatch", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: turnRequest.requestedMode ?? "chat",
      status: "completed" as const,
      messages: [
        {
          role: "assistant",
          content: "act routing observed"
        }
      ],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_${index + 1}`,
      messageId: `out_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_act_001"),
          resolveActorId: vi.fn(async () => "actor_act_001"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: {
        dispatch
      }
    });

    const handled = await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      senderId: "user_004",
      messageId: "msg_act_001",
      text: "@endec inspect this repo and fix the failing tests",
      mentionsBot: true
    });

    expect(handled.status).toBe("dispatched");
    if (handled.status !== "dispatched") {
      throw new Error("expected dispatched IM result");
    }

    expect(handled.turnRequest).toMatchObject({
      requestedMode: "act",
      input: "@endec inspect this repo and fix the failing tests"
    });
    expect(handled.turnResult).toMatchObject({
      status: "completed",
      resolvedMode: "act"
    });
  });

  it("passes through provider incomplete fallback text by default", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "failed" as const,
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
      warnings: ["Provider stream ended without a completed event for invocation invoke_turn_001"],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_${index + 1}`,
      messageId: `out_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_im_incomplete"),
          resolveActorId: vi.fn(async () => "actor_im_incomplete"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_incomplete",
      senderId: "user_incomplete",
      messageId: "msg_incomplete",
      text: "hello",
      mentionsBot: false
    });

    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({ text: "Provider stream ended without a completed event for invocation invoke_turn_001" })
    ]);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("模型响应流提前结束，本轮已安全停止，请重试。");
  });

  it("passes through tool-turn-limit fallback text by default", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "interrupted" as const,
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
      warnings: ["Reached maxToolCallsPerTurn (2) before executing the next tool batch."],
      checkpointRef: `checkpoint:${turnRequest.turnId}`,
      continuation: {
        schemaVersion: 1 as const,
        contractVersion: "ws0.execution-control.v1" as const,
        frameRef: `frame:${turnRequest.turnId}`,
        checkpointRef: `checkpoint:${turnRequest.turnId}`,
        continuationKind: "resume" as const,
        allowedActions: ["resume", "cancel"] as ("resume" | "cancel")[],
        metadata: {}
      }
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_turn_limit_${index + 1}`,
      messageId: `out_turn_limit_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_im_turn_limit"),
          resolveActorId: vi.fn(async () => "actor_im_turn_limit"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_turn_limit",
      senderId: "user_turn_limit",
      messageId: "msg_turn_limit",
      text: "inspect several files",
      mentionsBot: false
    });

    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({ text: "Reached maxToolCallsPerTurn (2) before executing the next tool batch." })
    ]);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("Reply \"continue\" to resume.");
  });

  it("passes through tool-batch fallback text by default", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "interrupted" as const,
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
      warnings: ["Provider requested 3 tool calls in one batch, exceeding maxToolCallsPerBatch (2)."],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_batch_${index + 1}`,
      messageId: `out_batch_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_im_batch"),
          resolveActorId: vi.fn(async () => "actor_im_batch"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_batch",
      senderId: "user_batch",
      messageId: "msg_batch",
      text: "inspect several files",
      mentionsBot: false
    });

    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({ text: "Provider requested 3 tool calls in one batch, exceeding maxToolCallsPerBatch (2)." })
    ]);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("模型一次请求了过多工具，本轮已安全停止，请重试或拆分任务。");
  });
  it("ordinary IM passthrough fallback ignores invalid assistant text candidate and uses the rendered warning", async () => {
    const executeTurn = vi.fn(async (turnRequest) => ({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      resolvedMode: "chat" as const,
      status: "interrupted" as const,
      messages: [{ role: "assistant" as const, content: "oversized attempt 2" }],
      toolEvents: [],
      taskUpdates: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
      warnings: ["Provider requested 3 tool calls in one batch, exceeding maxToolCallsPerBatch (2)."],
      checkpointRef: `checkpoint:${turnRequest.turnId}`
    }));
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_retry_${index + 1}`,
      messageId: `out_retry_${index + 1}`,
      message
    })));

    const adapter = createImAdapter({
      app: {
        shell: { executeTurn },
        im: {
          resolveSessionId: vi.fn(async () => "session_im_retry_exhausted"),
          resolveActorId: vi.fn(async () => "actor_im_retry_exhausted"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    await adapter.handleInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "dm",
      chatId: "chat_retry_exhausted",
      senderId: "user_retry_exhausted",
      messageId: "msg_retry_exhausted",
      text: "inspect files",
      mentionsBot: false
    });

    expect(JSON.stringify(dispatch.mock.calls)).toContain("Provider requested 3 tool calls in one batch, exceeding maxToolCallsPerBatch (2).");
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("oversized attempt 2");
  });

  it("uses passthrough fallback warning text and generic retry fallback when failed warnings are empty", () => {
    expect(createFallbackOutboundText({
      status: "failed",
      warnings: ["Provider stream ended without a completed event"],
      blockedBy: undefined,
      continuation: undefined
    }, "passthrough")).toBe("Provider stream ended without a completed event");

    expect(createFallbackOutboundText({
      status: "failed",
      warnings: [],
      blockedBy: undefined,
      continuation: undefined
    }, "passthrough")).toBe("请求失败，请重试。");
  });

  it("uses the neutral retry fallback instead of the legacy interrupted wrapper in passthrough mode", () => {
    expect(createFallbackOutboundText({
      status: "interrupted",
      warnings: [],
      blockedBy: undefined,
      continuation: undefined
    }, "passthrough")).toBe("请求失败，请重试。");
  });

  it("does not show memory truncation diagnostics to ordinary IM users when assistant text exists", async () => {
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_memory_text_${index + 1}`,
      messageId: `out_memory_text_${index + 1}`,
      message
    })));
    const adapter = createImAdapter({
      app: {
        shell: { executeTurn: vi.fn() },
        im: {
          resolveSessionId: vi.fn(async () => "session_memory_warning_hidden_with_text"),
          resolveActorId: vi.fn(async () => "actor_memory_warning_hidden_with_text"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.dispatchTurnResult({
      sessionId: "session_memory_warning_hidden_with_text",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_memory_warning_hidden_with_text",
        peerId: "chat_memory_warning_hidden_with_text",
        peerKind: "dm"
      },
      turnResult: {
        turnId: "turn_memory_warning_hidden_with_text",
        sessionId: "session_memory_warning_hidden_with_text",
        resolvedMode: "chat",
        status: "completed",
        messages: [{ role: "assistant", content: "Here is the normal answer." }],
        toolEvents: [],
        taskUpdates: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
        warnings: ["memory_context_truncated", "memory selection truncated to fit budget"],
        checkpointRef: "checkpoint:turn_memory_warning_hidden_with_text"
      }
    });

    const text = handled.messages.map((message) => message.text).join("\n");
    expect(text).toBe("Here is the normal answer.");
    expect(text).not.toContain("memory_context_truncated");
    expect(text).not.toContain("memory selection truncated to fit budget");
  });

  it("keeps unrelated ordinary warnings visible in ordinary IM fallback", async () => {
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_ordinary_warning_${index + 1}`,
      messageId: `out_ordinary_warning_${index + 1}`,
      message
    })));
    const adapter = createImAdapter({
      app: {
        shell: { executeTurn: vi.fn() },
        im: {
          resolveSessionId: vi.fn(async () => "session_ordinary_warning_visible"),
          resolveActorId: vi.fn(async () => "actor_ordinary_warning_visible"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.dispatchTurnResult({
      sessionId: "session_ordinary_warning_visible",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_ordinary_warning_visible",
        peerId: "chat_ordinary_warning_visible",
        peerKind: "dm"
      },
      turnResult: {
        turnId: "turn_ordinary_warning_visible",
        sessionId: "session_ordinary_warning_visible",
        resolvedMode: "chat",
        status: "completed",
        messages: [],
        toolEvents: [],
        taskUpdates: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
        warnings: ["memory_context_truncated", "rate limit exceeded"],
        checkpointRef: "checkpoint:turn_ordinary_warning_visible"
      }
    });

    const text = handled.messages.map((message) => message.text).join("\n");
    expect(text).toBe("rate limit exceeded");
    expect(text).not.toContain("memory_context_truncated");
  });

  it("does not use memory truncation as ordinary IM fallback when it is the only warning", async () => {
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_memory_only_${index + 1}`,
      messageId: `out_memory_only_${index + 1}`,
      message
    })));
    const adapter = createImAdapter({
      app: {
        shell: { executeTurn: vi.fn() },
        im: {
          resolveSessionId: vi.fn(async () => "session_only_memory_warning_hidden"),
          resolveActorId: vi.fn(async () => "actor_only_memory_warning_hidden"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.dispatchTurnResult({
      sessionId: "session_only_memory_warning_hidden",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_only_memory_warning_hidden",
        peerId: "chat_only_memory_warning_hidden",
        peerKind: "dm"
      },
      turnResult: {
        turnId: "turn_only_memory_warning_hidden",
        sessionId: "session_only_memory_warning_hidden",
        resolvedMode: "chat",
        status: "completed",
        messages: [],
        toolEvents: [],
        taskUpdates: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
        warnings: ["memory_context_truncated", "memory selection truncated to fit budget"],
        checkpointRef: "checkpoint:turn_only_memory_warning_hidden"
      }
    });

    const text = handled.messages.map((message) => message.text).join("\n");
    expect(text).toBe("The turn completed without an assistant text reply.");
    expect(text).not.toContain("memory_context_truncated");
    expect(text).not.toContain("memory selection truncated to fit budget");
    expect(text).not.toMatch(/selected|injected|dropped|budget used|token/i);
  });

  it("renders a tool-result fallback when a completed turn has no final assistant text", async () => {
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_tool_only_${index + 1}`,
      messageId: `out_tool_only_${index + 1}`,
      message
    })));
    const adapter = createImAdapter({
      app: {
        shell: { executeTurn: vi.fn() },
        im: {
          resolveSessionId: vi.fn(async () => "session_tool_only_completed"),
          resolveActorId: vi.fn(async () => "actor_tool_only_completed"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.dispatchTurnResult({
      sessionId: "session_tool_only_completed",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_tool_only_completed",
        peerId: "chat_tool_only_completed",
        peerKind: "dm"
      },
      turnResult: {
        turnId: "turn_tool_only_completed",
        sessionId: "session_tool_only_completed",
        resolvedMode: "chat",
        status: "completed",
        messages: [],
        toolEvents: [
          {
            toolCallId: "tool_call_001",
            toolName: "inspect_source",
            state: "executed",
            normalizedPayload: {
              contentType: "text",
              value: "source: packages/app/src/index.ts\nexport * from './create-endec-app.ts';"
            }
          }
        ],
        taskUpdates: [],
        usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3, estimatedCost: 0 },
        warnings: [],
        checkpointRef: "checkpoint:turn_tool_only_completed"
      }
    });

    const text = handled.messages.map((message) => message.text).join("\n");
    expect(text).toContain("completed after using tools");
    expect(text).toContain("inspect_source");
    expect(text).toContain("source: packages/app/src/index.ts");
    expect(text).not.toBe("The turn completed without an assistant text reply.");
  });

  it("prioritizes provider/tool terminal failures over memory diagnostics for ordinary IM fallback", async () => {
    const dispatch = vi.fn(async (messages: OutboundMessage[]) => messages.map((message, index) => ({
      deliveryId: `delivery_terminal_priority_${index + 1}`,
      messageId: `out_terminal_priority_${index + 1}`,
      message
    })));
    const adapter = createImAdapter({
      app: {
        shell: { executeTurn: vi.fn() },
        im: {
          resolveSessionId: vi.fn(async () => "session_terminal_warning_priority"),
          resolveActorId: vi.fn(async () => "actor_terminal_warning_priority"),
          evaluateInboundAdmission: vi.fn(async () => allowAdmissionDecision())
        }
      },
      normalizeInbound: normalizeFakeTransportInbound,
      gates: [createMentionGate()],
      outbound: { dispatch }
    });

    const handled = await adapter.dispatchTurnResult({
      sessionId: "session_terminal_warning_priority",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_terminal_warning_priority",
        peerId: "chat_terminal_warning_priority",
        peerKind: "dm"
      },
      turnResult: {
        turnId: "turn_terminal_warning_priority",
        sessionId: "session_terminal_warning_priority",
        resolvedMode: "act",
        status: "blocked",
        blockedBy: "permission",
        messages: [],
        toolEvents: [],
        taskUpdates: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
        warnings: ["memory_context_truncated", "permission required"],
        checkpointRef: "checkpoint:turn_terminal_warning_priority"
      }
    });

    const text = handled.messages.map((message) => message.text).join("\n");
    expect(text).toBe("Blocked: waiting for permission.");
    expect(text).not.toContain("memory_context_truncated");
  });
});
