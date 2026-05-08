import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdmissionDecision, OutboundConversationLegality } from "@endec/domain";
import { createInMemoryTelegramAdapterStateStore } from "./state-store.ts";
import type { TelegramBotClient } from "./telegram-types.ts";
import {
  createTelegramReplyFallbackText,
  loadTelegramRunnerConfigFromEnv,
  runTelegramBot
} from "./index.ts";

const tempDirs = new Set<string>();

async function createTempDir() {
  const directory = await mkdtemp(join(tmpdir(), "endec-tg-runner-"));
  tempDirs.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

function dispatchAdmission(): AdmissionDecision {
  return {
    outcome: "dispatch_turn",
    expectsUserVisibleReply: true
  };
}

function allowedOutboundLegality(): OutboundConversationLegality {
  return {
    status: "allowed",
    reason: "owner_direct"
  };
}

describe("telegram runner config", () => {
  it("requires TELEGRAM_BOT_TOKEN and ENDEC_DATA_DIR while applying minimal defaults", () => {
    expect(() =>
      loadTelegramRunnerConfigFromEnv({
        ENDEC_DATA_DIR: "/tmp/endec"
      })
    ).toThrow(/TELEGRAM_BOT_TOKEN/);

    const config = loadTelegramRunnerConfigFromEnv({
      TELEGRAM_BOT_TOKEN: "bot-token",
      ENDEC_DATA_DIR: "/tmp/endec",
      TELEGRAM_ALLOWED_CHAT_IDS: "42, -100123",
      TELEGRAM_ALLOWED_SENDER_IDS: "7,9"
    });

    expect(config).toMatchObject({
      token: "bot-token",
      dataDir: "/tmp/endec",
      workspaceId: "workspace_local",
      accountId: "telegram-bot",
      pollTimeoutSeconds: 30,
      apiBase: "https://api.telegram.org",
      allowedChatIds: ["42", "-100123"],
      allowedSenderIds: ["7", "9"]
    });
  });
});

describe("telegram blocked fallback text", () => {
  it("tells telegram users to use Endec operator or CLI for blocked turns", () => {
    expect(
      createTelegramReplyFallbackText({
        status: "blocked",
        blockedBy: "permission",
        warnings: []
      })
    ).toContain("Endec operator / CLI");

    expect(
      createTelegramReplyFallbackText({
        status: "blocked",
        blockedBy: "user_decision",
        warnings: []
      })
    ).toContain("Endec operator / CLI");
  });
});

describe("telegram runner background maintenance", () => {
  it("runs same-process background maintenance once after polling and respects an already-aborted signal", async () => {
    const dataDir = await createTempDir();
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const runWorkerOnce = vi.fn(async () => ({
      status: "idle" as const
    }));
    const app = {
      shell: {
        executeTurn: vi.fn(async () => ({
          turnId: "turn_runner_bg_001",
          sessionId: "session_runner_bg_001",
          resolvedMode: "chat" as const,
          status: "completed" as const,
          messages: [{ role: "assistant", content: "runner reply" }],
          toolEvents: [],
          taskUpdates: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            estimatedCost: 0
          },
          warnings: [],
          checkpointRef: "checkpoint_runner_bg_001"
        }))
      },
      im: {
        resolveSessionId: vi.fn(async () => "session_runner_bg_001"),
        resolveActorId: vi.fn(async () => "actor_runner_bg_001"),
        recordPassiveIngress: vi.fn(async () => undefined),
        executeCommand: vi.fn(async () => ({ kind: "reply_text" as const, replyText: "runner command reply" })),
        evaluateInboundAdmission: vi.fn(async () => dispatchAdmission()),
        applyConversationLifecycleEvent: vi.fn(async () => undefined),
        evaluateOutboundConversationLegality: vi.fn(async () => allowedOutboundLegality())
      },
      background: {
        runWorkerOnce
      }
    };
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));

    await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
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

    expect(runWorkerOnce).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    runWorkerOnce.mockClear();

    const aborted = await runTelegramBot({
      once: true,
      signal: controller.signal,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: {
        getUpdates: vi.fn(async () => {
          throw new Error("should not poll when already aborted");
        }),
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

    expect(aborted.pollResult).toMatchObject({
      receivedCount: 0,
      dispatchedCount: 0,
      nextUpdateId: 0
    });
    expect(runWorkerOnce).not.toHaveBeenCalled();
  });
});

describe("runTelegramBot", () => {
  it("registers scoped native Telegram commands before polling begins", async () => {
    const dataDir = await createTempDir();
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const callOrder: string[] = [];
    const setMyCommands = vi.fn(async (params: {
      commands: Array<{ command: string; description: string }>;
      scope?: { type: string };
    }) => {
      callOrder.push(`setMyCommands:${params.scope?.type ?? "default"}`);
      return params;
    });
    const getUpdates: TelegramBotClient["getUpdates"] = vi.fn(async () => {
      callOrder.push("getUpdates");
      return [];
    });

    await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app: {
        shell: {
          executeTurn: vi.fn(async () => ({
            turnId: "turn_unused",
            sessionId: "session_unused",
            resolvedMode: "chat" as const,
            status: "completed" as const,
            messages: [{ role: "assistant", content: "unused" }],
            toolEvents: [],
            taskUpdates: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
            warnings: [],
            checkpointRef: "checkpoint_unused"
          }))
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_runner_commands_001"),
          resolveActorId: vi.fn(async () => "actor_runner_commands_001"),
          recordPassiveIngress: vi.fn(async () => undefined),
          executeCommand: vi.fn(async () => ({ kind: "reply_text" as const, replyText: "unused command reply" })),
          evaluateInboundAdmission: vi.fn(async () => dispatchAdmission()),
          applyConversationLifecycleEvent: vi.fn(async () => undefined),
          evaluateOutboundConversationLegality: vi.fn(async () => allowedOutboundLegality())
        }
      },
      client: {
        getUpdates,
        setMyCommands,
        sendMessage: vi.fn(async (input) => ({
          messageId: `sent_${input.chatId}`,
          chatId: input.chatId
        })),
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      } as never,
      stateStore
    });

    expect(setMyCommands).toHaveBeenNthCalledWith(1, {
      commands: [
        { command: "help", description: "Show supported commands" },
        { command: "status", description: "Show conversation and trust status" },
        { command: "model", description: "Show model and connection status" },
        { command: "persona", description: "Show or change persona" },
        { command: "history", description: "Summarize recent history" },
        { command: "trust", description: "Trust the current shared chat" }
      ],
      scope: { type: "all_group_chats" }
    });
    expect(setMyCommands).toHaveBeenNthCalledWith(2, {
      commands: [
        { command: "help", description: "Show supported commands" },
        { command: "status", description: "Show conversation and trust status" },
        { command: "model", description: "Show model and connection status" },
        { command: "models", description: "Choose the active model" },
        { command: "reload", description: "Reload runtime config" },
        { command: "restart", description: "Request a graceful restart" },
        { command: "persona", description: "Show or change persona" },
        { command: "history", description: "Summarize recent history" },
        { command: "recall", description: "Run owner-only cross-conversation recall" }
      ],
      scope: { type: "all_private_chats" }
    });
    expect(callOrder.slice(0, 3)).toEqual([
      "setMyCommands:all_group_chats",
      "setMyCommands:all_private_chats",
      "getUpdates"
    ]);
  });

  it("wires long polling through tg2 adapter and tg1 app.im seam before executeTurn", async () => {
    const dataDir = await createTempDir();
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const resolveSessionId = vi.fn(async () => "session_runner_1");
    const resolveActorId = vi.fn(async () => "actor_runner_1");
    const executeTurn = vi.fn(async () => ({
      turnId: "turn_runner_1",
      sessionId: "session_runner_1",
      resolvedMode: "chat" as const,
      status: "completed" as const,
      messages: [{ role: "assistant", content: "runner reply" }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        estimatedCost: 0.01
      },
      warnings: [],
      checkpointRef: "checkpoint_runner_1"
    }));
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const getUpdates: TelegramBotClient["getUpdates"] = vi.fn(async () => [
      {
        update_id: 501,
        message: {
          message_id: 90,
          date: 1_712_001_000,
          text: "hello from runner",
          chat: {
            id: 42,
            type: "private" as const
          },
          from: {
            id: 7,
            is_bot: false,
            username: "alice"
          }
        }
      }
    ]);

    const result = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app: {
        shell: {
          executeTurn
        },
        im: {
          resolveSessionId,
          resolveActorId,
          recordPassiveIngress: vi.fn(async () => undefined),
          executeCommand: vi.fn(async () => ({ kind: "reply_text" as const, replyText: "runner command reply" })),
          evaluateInboundAdmission: vi.fn(async () => dispatchAdmission()),
          applyConversationLifecycleEvent: vi.fn(async () => undefined),
          evaluateOutboundConversationLegality: vi.fn(async () => allowedOutboundLegality())
        }
      },
      client: {
        getUpdates,
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

    expect(result.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 1,
      nextUpdateId: 502
    });
    expect(resolveSessionId).toHaveBeenCalledTimes(1);
    expect(resolveActorId).toHaveBeenCalledTimes(1);
    expect(executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "telegram",
        sessionId: "session_runner_1",
        actorId: "actor_runner_1",
        input: "hello from runner"
      })
    );
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "runner reply",
      messageThreadId: undefined,
      replyToMessageId: 90
    });
  });

  it("supports one-shot fake polling smoke with persisted sqlite offsets", async () => {
    const dataDir = await createTempDir();
    const executeTurn = vi.fn(async () => ({
      turnId: "turn_runner_smoke",
      sessionId: "session_runner_smoke",
      resolvedMode: "chat" as const,
      status: "completed" as const,
      messages: [{ role: "assistant", content: "smoke reply" }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
        estimatedCost: 0.01
      },
      warnings: [],
      checkpointRef: "checkpoint_runner_smoke"
    }));
    const app = {
      shell: {
        executeTurn
      },
      im: {
        resolveSessionId: async () => "session_runner_smoke",
        resolveActorId: async () => "actor_runner_smoke",
        recordPassiveIngress: async () => undefined,
        executeCommand: async () => ({ kind: "reply_text" as const, replyText: "runner command reply" }),
        evaluateInboundAdmission: async () => dispatchAdmission(),
        applyConversationLifecycleEvent: async () => undefined,
        evaluateOutboundConversationLegality: async () => allowedOutboundLegality()
      }
    };

    const firstGetUpdates: TelegramBotClient["getUpdates"] = vi.fn(async (params) => {
      expect(params.offset ?? 0).toBe(0);
      return [
        {
          update_id: 601,
          message: {
            message_id: 91,
            date: 1_712_001_111,
            text: "smoke message",
            chat: {
              id: 84,
              type: "private" as const
            },
            from: {
              id: 8,
              is_bot: false,
              username: "bob"
            }
          }
        }
      ];
    });

    await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: {
        getUpdates: firstGetUpdates,
        sendMessage: async (input) => ({
          messageId: `sent_${input.chatId}`,
          chatId: input.chatId
        }),
        sendChatAction: async () => undefined
      }
    });

    const secondGetUpdates: TelegramBotClient["getUpdates"] = vi.fn(async (params) => {
      expect(params.offset).toBe(602);
      return [];
    });

    const second = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: {
        getUpdates: secondGetUpdates,
        sendMessage: async (input) => ({
          messageId: `sent_${input.chatId}`,
          chatId: input.chatId
        }),
        sendChatAction: async () => undefined
      }
    });

    expect(second.pollResult).toMatchObject({
      receivedCount: 0,
      nextUpdateId: 602
    });
  });

  it("counts passive ingest and command replies in poll accounting", async () => {
    const dataDir = await createTempDir();
    const recordPassiveIngress = vi.fn(async () => undefined);
    const executeCommand = vi.fn(async () => ({
      kind: "reply_text" as const,
      replyText: "conversation: supergroup:-100123\ndisclosureMode: local_only"
    }));
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));

    const result = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app: {
        shell: {
          executeTurn: vi.fn(async () => ({
            turnId: "turn_unused",
            sessionId: "session_unused",
            resolvedMode: "chat" as const,
            status: "completed" as const,
            messages: [{ role: "assistant", content: "unused" }],
            toolEvents: [],
            taskUpdates: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
            warnings: [],
            checkpointRef: "checkpoint_unused"
          }))
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_runner_status_001"),
          resolveActorId: vi.fn(async () => "actor_runner_status_001"),
          recordPassiveIngress,
          executeCommand,
          evaluateInboundAdmission: vi.fn(async (request: { activationHint: { explicitActivation: boolean } }) =>
            request.activationHint.explicitActivation
              ? dispatchAdmission()
              : { outcome: "passive_ingest" as const, expectsUserVisibleReply: false }
          ),
          applyConversationLifecycleEvent: vi.fn(async () => undefined),
          evaluateOutboundConversationLegality: vi.fn(async () => allowedOutboundLegality())
        }
      },
      client: {
        getUpdates: vi.fn(async () => [
          {
            update_id: 701,
            message: {
              message_id: 31,
              date: 1_714_000_001,
              text: "release slipped by one day",
              chat: { id: -100123, type: "supergroup" as const, is_forum: true },
              from: { id: 9, is_bot: false, username: "alice" },
              message_thread_id: 77,
              is_topic_message: true
            }
          },
          {
            update_id: 702,
            message: {
              message_id: 32,
              date: 1_714_000_002,
              text: "/status",
              chat: { id: -100123, type: "supergroup" as const },
              from: { id: 9, is_bot: false, username: "alice" }
            }
          }
        ]),
        sendMessage,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore: createInMemoryTelegramAdapterStateStore()
    });

    expect(result.pollResult).toMatchObject({
      receivedCount: 2,
      ignoredCount: 0,
      droppedCount: 0,
      dispatchedCount: 2,
      nextUpdateId: 703
    });
    expect(recordPassiveIngress).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("passes a graceful requestExit callback into created apps and aborts after the restart ack is delivered", async () => {
    const dataDir = await createTempDir();
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const requestExitCalls: Array<{ code: number; reason: string }> = [];
    let requestExitFromRunner: ((input: { code: number; reason: string }) => void | Promise<void>) | undefined;
    const createApp = vi.fn((options: { requestExit?: (input: { code: number; reason: string }) => void | Promise<void> }) => {
      requestExitFromRunner = options.requestExit;
      return {
        shell: {
          executeTurn: vi.fn(async () => ({
            turnId: "turn_unused",
            sessionId: "session_unused",
            resolvedMode: "chat" as const,
            status: "completed" as const,
            messages: [{ role: "assistant", content: "unused" }],
            toolEvents: [],
            taskUpdates: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
            warnings: [],
            checkpointRef: "checkpoint_unused"
          }))
        },
        im: {
          resolveSessionId: vi.fn(async () => "session_runner_restart_001"),
          resolveActorId: vi.fn(async () => "actor_runner_restart_001"),
          recordPassiveIngress: vi.fn(async () => undefined),
          executeCommand: vi.fn(async () => ({
            kind: "reply_text" as const,
            replyText: "Graceful restart requested. The runtime will exit so the supervisor can start it again.",
            afterReplyDelivered: async () => {
              if (!requestExitFromRunner) {
                throw new Error("runner did not provide requestExit");
              }
              const payload = {
                code: 0,
                reason: "owner private restart via telegram/acct_bot requested by actor_runner_restart_001"
              };
              requestExitCalls.push(payload);
              await requestExitFromRunner(payload);
            }
          })),
          evaluateInboundAdmission: vi.fn(async () => dispatchAdmission()),
          applyConversationLifecycleEvent: vi.fn(async () => undefined),
          evaluateOutboundConversationLegality: vi.fn(async () => allowedOutboundLegality())
        }
      };
    });
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));

    const result = await runTelegramBot({
      once: false,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      createApp,
      client: {
        getUpdates: vi.fn(async () => [
          {
            update_id: 801,
            message: {
              message_id: 41,
              date: 1_714_000_101,
              text: "/restart",
              chat: { id: 42, type: "private" as const },
              from: { id: 7, is_bot: false, username: "owner" }
            }
          }
        ]),
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

    expect(createApp).toHaveBeenCalledTimes(1);
    expect(createApp.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      dataDir,
      env: expect.objectContaining({ ENDEC_DATA_DIR: dataDir }),
      requestExit: expect.any(Function)
    }));
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: "42",
      text: "Graceful restart requested. The runtime will exit so the supervisor can start it again.",
      messageThreadId: undefined,
      replyToMessageId: 41
    });
    expect(requestExitCalls).toEqual([
      {
        code: 0,
        reason: "owner private restart via telegram/acct_bot requested by actor_runner_restart_001"
      }
    ]);
    expect(result.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 1,
      nextUpdateId: 802
    });
  });
});
