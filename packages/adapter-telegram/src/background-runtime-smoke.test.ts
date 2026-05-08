import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotClient, TelegramSendMessageParams } from "./index.ts";
import {
  createInMemoryTelegramAdapterStateStore,
  createTelegramReplyFallbackText,
  runTelegramBot
} from "./index.ts";
import { runBackgroundMaintenanceTick } from "./background-runtime.ts";

type JsonObject = Record<string, unknown>;
type PairApprovalApp = {
  operator: {
    listPairClaims(input: {
      source: "telegram";
      accountId: string;
      includeInactive: boolean;
    }): Promise<{ claims: Array<{ claimId?: string }> }>;
    approvePairClaim(input: {
      source: "telegram";
      accountId: string;
      claimId?: string;
      operatorActorId: string;
    }): Promise<{ outcome: string }>;
  };
};

const tempDirs = new Set<string>();

async function createTempDataDir() {
  const directory = await mkdtemp(join(tmpdir(), "endec-tg-bg-runtime-"));
  tempDirs.add(directory);
  return directory;
}

function createChatCompletionTransport(
  responses: Array<Array<JsonObject>>,
  onRequest?: (request: unknown) => void
) {
  let index = 0;

  return {
    async *stream(request: unknown) {
      onRequest?.(request);
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
  };
}

function createCompletedTransportResponse(text: string) {
  return [
    {
      choices: [
        {
          delta: {
            content: text
          }
        }
      ]
    },
    {
      choices: [
        {
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18
      }
    }
  ];
}

function createApprovalBlockedTransport() {
  return createChatCompletionTransport([
    [
      {
        choices: [
          {
            delta: {
              content: "requesting operator approval for bash"
            }
          }
        ]
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tool_call_tg_bg_blocked_001",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "printf background-smoke; git push --dry-run . HEAD:refs/heads/endec-test-dry-run"
                    })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 18,
          total_tokens: 48
        }
      }
    ]
  ]);
}

function createTelegramClient(input: {
  getUpdates: TelegramBotClient["getUpdates"];
  sendMessage?: TelegramBotClient["sendMessage"];
  answerCallbackQuery?: (input: { callbackQueryId: string; text?: string }) => Promise<void>;
  setMyCommands?: (commands: Array<{ command: string; description: string }>) => Promise<unknown>;
}): TelegramBotClient {
  return {
    getUpdates: input.getUpdates,
    sendMessage: input.sendMessage ?? (vi.fn(async (message) => ({
      messageId: `sent_${message.chatId}_${Date.now()}`,
      chatId: message.chatId
    })) as TelegramBotClient["sendMessage"]),
    sendChatAction: vi.fn(async () => undefined),
    answerCallbackQuery: input.answerCallbackQuery,
    setMyCommands: input.setMyCommands,
    getMe: async () => ({
      id: 999,
      is_bot: true,
      username: "endec"
    })
  } as never;
}

async function loadAppAndTaskStores() {
  const appModuleUrl = pathToFileURL(join(import.meta.dirname, "../../app/src/index.ts")).href;
  const tasksModuleUrl = pathToFileURL(join(import.meta.dirname, "../../tasks/src/index.ts")).href;
  const [{ createEndecApp }, { createTaskRunStore, createTaskStore }] = await Promise.all([
    import(appModuleUrl),
    import(tasksModuleUrl)
  ]);

  return {
    createEndecApp,
    createTaskRunStore,
    createTaskStore
  };
}

function createBackgroundCommandUpdate(input: {
  updateId: number;
  messageId: number;
  chatId: number;
  senderId: number;
  text: string;
}) {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      date: 1_712_123_456,
      text: input.text,
      chat: {
        id: input.chatId,
        type: "private" as const
      },
      from: {
        id: input.senderId,
        is_bot: false,
        username: "alice"
      }
    }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

async function approveLatestPairClaim(app: PairApprovalApp) {
  const claims = await app.operator.listPairClaims({
    source: "telegram",
    accountId: "telegram-bot",
    includeInactive: true
  });

  expect(claims.claims).toHaveLength(1);

  const approved = await app.operator.approvePairClaim({
    source: "telegram",
    accountId: "telegram-bot",
    claimId: claims.claims[0]?.claimId,
    operatorActorId: "operator_alpha"
  });

  expect(approved.outcome).toBe("approved");
}

describe("telegram same-process background runtime smoke", () => {
  it("keeps blocked telegram fallback guidance unchanged in passthrough mode", () => {
    expect(createTelegramReplyFallbackText({
      status: "blocked",
      blockedBy: "permission",
      warnings: []
    }, "passthrough")).toContain("审批");
  });

  it("bounded maintenance tick exits immediately when worker and outbox are idle", async () => {
    const runWorkerOnce = vi.fn(async () => ({
      status: "idle" as const
    }));
    const drainBackgroundOutboxOnce = vi.fn(async () => ({
      status: "idle" as const
    }));

    const result = await runBackgroundMaintenanceTick({
      app: {
        background: {
          runWorkerOnce
        }
      },
      adapter: {
        drainBackgroundOutboxOnce
      },
      workerId: "worker_idle_001",
      workerLeaseDurationMs: 30_000,
      outboxLeaseDurationMs: 30_000,
      maxIterations: 5,
      leaseOwner: "telegram-maintenance-idle",
      store: {}
    });

    expect(result).toMatchObject({
      status: "idle",
      iterations: 1
    });
    expect(runWorkerOnce).toHaveBeenCalledTimes(1);
    expect(drainBackgroundOutboxOnce).toHaveBeenCalledTimes(1);
  });

  it("auto-pairs the first ordinary private DM, then sends sync ack and later final callback through fake telegram client", async () => {
    const dataDir = await createTempDataDir();
    const { createEndecApp, createTaskRunStore, createTaskStore } = await loadAppAndTaskStores();
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("background root cause summary")
      ])
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (message) => ({
      messageId: `sent_${message.chatId}_${message.replyToMessageId ?? "callback"}`,
      chatId: message.chatId
    }));

    const firstResult = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 801,
            messageId: 91,
            chatId: 42,
            senderId: 7,
            text: "hello there"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    expect(firstResult.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 0,
      nextUpdateId: 802
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      chatId: "42",
      text: expect.stringMatching(/pair code/i),
      messageThreadId: undefined,
      replyToMessageId: 91
    });

    await approveLatestPairClaim(app);

    const result = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 802,
            messageId: 92,
            chatId: 42,
            senderId: 7,
            text: "/background investigate recent failures"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    expect(result.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 1,
      nextUpdateId: 803
    });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: "42",
      text: expect.stringContaining("已排队"),
      messageThreadId: undefined,
      replyToMessageId: 92
    });
    expect(vi.mocked(sendMessage).mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({
        chatId: "42",
        text: expect.stringContaining("Pairing complete"),
        messageThreadId: undefined,
        replyToMessageId: undefined
      })],
      [expect.objectContaining({
        chatId: "42",
        text: expect.stringContaining("background root cause summary"),
        messageThreadId: undefined,
        replyToMessageId: undefined
      })]
    ]));

    const runStore = createTaskRunStore({
      filename: join(dataDir, "state", "tasks.sqlite")
    });
    const taskStore = createTaskStore({
      filename: join(dataDir, "state", "tasks.sqlite")
    });

    const tasks = await runStore.listBackgroundTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      agentStatus: "done",
      conversationRef: expect.objectContaining({
        peerId: "42"
      })
    });

    const runs = await runStore.listRunsByTask(tasks[0]!.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "completed",
      attemptNo: 1
    });

    const outboundEvents = await taskStore.listOutboundEventsByTask({
      taskId: tasks[0]!.taskId,
      runId: runs[0]!.runId
    });
    expect(outboundEvents).toHaveLength(1);
    expect(outboundEvents[0]).toMatchObject({
      eventKind: "final"
    });

    const deliveries = await taskStore.listOutboundDeliveriesByEvent({
      outboundEventId: outboundEvents[0]!.outboundEventId
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      status: "delivered"
    });
  });

  it("auto-pairs the first ordinary private DM, then sends sync ack and later blocked callback without Telegram approval button claims", async () => {
    const dataDir = await createTempDataDir();
    const { createEndecApp, createTaskRunStore, createTaskStore } = await loadAppAndTaskStores();
    const app = createEndecApp({
      dataDir,
      providerTransport: createApprovalBlockedTransport()
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (message) => ({
      messageId: `sent_${message.chatId}_${message.replyToMessageId ?? "callback"}`,
      chatId: message.chatId
    }));

    const firstResult = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 901,
            messageId: 191,
            chatId: 52,
            senderId: 17,
            text: "hello there"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    expect(firstResult.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 0,
      nextUpdateId: 902
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      chatId: "52",
      text: expect.stringMatching(/pair code/i),
      messageThreadId: undefined,
      replyToMessageId: 191
    });

    await approveLatestPairClaim(app);

    const result = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 902,
            messageId: 192,
            chatId: 52,
            senderId: 17,
            text: "/background 请执行需要审批的 bash 操作"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    expect(result.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 1,
      nextUpdateId: 903
    });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: "52",
      text: expect.stringContaining("已排队"),
      messageThreadId: undefined,
      replyToMessageId: 192
    });
    expect(vi.mocked(sendMessage).mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({
        chatId: "52",
        text: expect.stringContaining("Pairing complete"),
        messageThreadId: undefined,
        replyToMessageId: undefined
      })],
      [expect.objectContaining({
        chatId: "52",
        text: expect.stringMatching(/operator|CLI/i),
        messageThreadId: undefined,
        replyToMessageId: undefined
      })]
    ]));

    const blockedCallbackText = vi.mocked(sendMessage).mock.calls
      .map((call) => call[0].text)
      .find((text): text is string => /operator|CLI/i.test(text)) ?? "";
    expect(blockedCallbackText).toMatch(/operator|CLI/i);
    expect(blockedCallbackText).not.toMatch(/inline|button|按钮|点击审批/i);

    const runStore = createTaskRunStore({
      filename: join(dataDir, "state", "tasks.sqlite")
    });
    const taskStore = createTaskStore({
      filename: join(dataDir, "state", "tasks.sqlite")
    });

    const tasks = await runStore.listBackgroundTasks({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      agentStatus: "blocked",
      blockingReason: "permission"
    });

    const runs = await runStore.listRunsByTask(tasks[0]!.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "blocked",
      pendingControlRef: expect.any(String)
    });
    expect(runs[0]?.status).not.toBe("interrupted");

    const outboundEvents = await taskStore.listOutboundEventsByTask({
      taskId: tasks[0]!.taskId,
      runId: runs[0]!.runId
    });
    expect(outboundEvents).toHaveLength(1);
    expect(outboundEvents[0]).toMatchObject({
      eventKind: "blocked"
    });
  });

  it("runs owner-DM /recall --chat through the real telegram runtime after shared activity is recorded", async () => {
    const dataDir = await createTempDataDir();
    const { createEndecApp } = await loadAppAndTaskStores();
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("Sources: release-room")
      ])
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (message) => ({
      messageId: `sent_${message.chatId}_${message.replyToMessageId ?? "callback"}`,
      chatId: message.chatId
    }));

    await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 950,
            messageId: 290,
            chatId: 42,
            senderId: 7,
            text: "hello there"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    await approveLatestPairClaim(app);

    const ownerConversationRef = {
      accountId: "telegram-bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const sharedConversationRef = {
      accountId: "telegram-bot",
      conversationId: "supergroup:-100123",
      peerId: "-100123",
      peerKind: "group" as const,
      baseConversationId: "supergroup:-100123"
    };
    const createBoundary = (boundaryKey: string, conversationScope: "direct" | "shared") => ({
      boundaryKey,
      conversationScope,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    });

    const ownerActorId = await app.im.resolveActorId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "telegram-bot",
      senderId: "7",
      conversationRef: ownerConversationRef
    });
    await app.im.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "telegram-bot",
      conversationRef: sharedConversationRef,
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "7",
      actorId: ownerActorId,
      observedAt: "2026-05-01T09:00:00.000Z",
      metadata: {
        workspaceId: "workspace_local"
      }
    });

    await app.shell.executeTurn({
      turnId: "turn_release_room_seed",
      sessionId: "session_release_room",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_release_room_member",
      input: "release-room delta changed",
      attachments: [],
      requestedMode: "chat",
      conversationRef: sharedConversationRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("supergroup:-100123", "shared")
      }
    });
    await app.im.recordConversationActivity({
      source: "telegram",
      accountId: "telegram-bot",
      conversationRef: sharedConversationRef,
      sessionId: "session_release_room",
      conversationLabel: "release-room",
      observedAt: "2026-05-01T09:01:00.000Z"
    });

    const result = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 951,
            messageId: 291,
            chatId: 42,
            senderId: 7,
            text: "/recall --chat release-room what changed?"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    expect(result.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 1,
      nextUpdateId: 952
    });
    expect(vi.mocked(sendMessage).mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({
        chatId: "42",
        text: expect.stringContaining("Sources: release-room"),
        replyToMessageId: 291
      })]
    ]));
  });

  it("runs owner-DM /models picker selections through the real telegram runtime and keeps both internal tiers aligned", async () => {
    const dataDir = await createTempDataDir();
    const { createEndecApp } = await loadAppAndTaskStores();
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("provider should stay unused for model commands")
      ])
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage = vi.fn(async (message: TelegramSendMessageParams) => ({
      messageId: `sent_${message.chatId}_${message.replyToMessageId ?? "callback"}`,
      chatId: message.chatId
    }));
    const answerCallbackQuery = vi.fn(async () => undefined);

    await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 970,
            messageId: 490,
            chatId: 62,
            senderId: 27,
            text: "hello there"
          })
        ]),
        sendMessage,
        answerCallbackQuery
      }),
      stateStore
    });

    await approveLatestPairClaim(app);
    sendMessage.mockClear();
    answerCallbackQuery.mockClear();

    const result = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 971,
            messageId: 491,
            chatId: 62,
            senderId: 27,
            text: "/models"
          }),
          {
            update_id: 972,
            callback_query: {
              id: "cbq_bg_models_001",
              from: {
                id: 27,
                is_bot: false,
                username: "alice"
              },
              data: "/models select local-default/cheap-default",
              message: {
                message_id: 492,
                date: 1_714_000_101,
                chat: {
                  id: 62,
                  type: "private" as const
                }
              }
            }
          },
          createBackgroundCommandUpdate({
            updateId: 973,
            messageId: 493,
            chatId: 62,
            senderId: 27,
            text: "/model"
          })
        ]),
        sendMessage,
        answerCallbackQuery
      }),
      stateStore
    });

    expect(result.pollResult).toMatchObject({
      receivedCount: 3,
      dispatchedCount: 3,
      nextUpdateId: 974
    });
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      chatId: "62",
      text: "Choose the active model:",
      replyToMessageId: 491,
      replyMarkup: {
        inline_keyboard: expect.arrayContaining([
          [expect.objectContaining({ text: "local-default/default", callback_data: "/models select local-default/cheap-default" })]
        ])
      }
    }));
    const pickerRows = sendMessage.mock.calls[0]?.[0].replyMarkup?.inline_keyboard ?? [];
    expect(
      pickerRows.flat().filter((button) => button.text === "local-default/default")
    ).toHaveLength(1);
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: "cbq_bg_models_001",
      text: "Updated model: local-default/default"
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chatId: "62",
      text: "Updated model: local-default/default"
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      chatId: "62",
      text: expect.stringContaining("model: local-default/default"),
      replyToMessageId: 493
    }));
    expect(sendMessage.mock.calls.map((call) => String(call[0]?.text ?? "")).join("\n")).not.toContain("cheapModel:");
    expect(sendMessage.mock.calls.map((call) => String(call[0]?.text ?? "")).join("\n")).not.toContain("strongModel:");

    const ownerConversationRef = {
      accountId: "telegram-bot",
      conversationId: "private:62",
      peerId: "62",
      peerKind: "dm" as const
    };
    const ownerActorId = await app.im.resolveActorId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "telegram-bot",
      senderId: "27",
      conversationRef: ownerConversationRef
    });
    const status = await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_bg_models_status",
        sessionId: "session_owner_dm_models",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/status",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:62",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      },
      commandIntent: {
        name: "status",
        args: [],
        options: {},
        rawText: "/status",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(status).toMatchObject({ kind: "reply_text" });
    if (status.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${status.kind}`);
    }
    expect(status.replyText).toContain("model: local-default/cheap-default");
    expect(status.replyText).toContain("modelState: capability=chat execute=yes source=provider_control providerConfigured=yes modelConfigured=yes");
    expect(status.replyText).toContain("baseUrl: http://127.0.0.1:11434/v1");
  });

  it("returns deterministic help for unknown slash commands without touching the model in the runtime loop", async () => {
    const dataDir = await createTempDataDir();
    const capturedProviderRequests: unknown[] = [];
    const { createEndecApp } = await loadAppAndTaskStores();
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("provider should stay unused")
      ], (request) => capturedProviderRequests.push(request))
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (message) => ({
      messageId: `sent_${message.chatId}_${message.replyToMessageId ?? "callback"}`,
      chatId: message.chatId
    }));

    await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 960,
            messageId: 390,
            chatId: 52,
            senderId: 17,
            text: "hello there"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    await approveLatestPairClaim(app);

    const result = await runTelegramBot({
      once: true,
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        ENDEC_DATA_DIR: dataDir
      },
      app,
      client: createTelegramClient({
        getUpdates: vi.fn(async () => [
          createBackgroundCommandUpdate({
            updateId: 961,
            messageId: 391,
            chatId: 52,
            senderId: 17,
            text: "/notacommand"
          })
        ]),
        sendMessage
      }),
      stateStore
    });

    expect(result.pollResult).toMatchObject({
      receivedCount: 1,
      dispatchedCount: 1,
      nextUpdateId: 962
    });
    expect(vi.mocked(sendMessage).mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({
        chatId: "52",
        text: expect.stringContaining("Unknown command: /notacommand"),
        replyToMessageId: 391
      })]
    ]));
    expect(capturedProviderRequests).toHaveLength(0);
  });
});
