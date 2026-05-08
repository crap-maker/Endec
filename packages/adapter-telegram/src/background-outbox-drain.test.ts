import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { OutboundDelivery, OutboundEvent } from "@endec/domain";
import { createTelegramBackgroundOutboxDrain } from "./outbound.ts";
import type { TelegramBotClient } from "./telegram-types.ts";

const conversationRef = {
  accountId: "telegram:bot:endec",
  conversationId: "telegram:chat:1001",
  peerId: "1001",
  peerKind: "group" as const,
  threadId: "42",
  topicId: "7"
};

const renderPayload = {
  schemaVersion: 1,
  contractVersion: "im.background-callback.v1",
  eventKind: "final" as const,
  taskId: "task_001",
  runId: "run_001",
  attemptNo: 1,
  taskTitle: "Investigate failures",
  summary: "Background investigation completed with root cause summary.",
  turnResultStatus: "completed" as const
};

function createClaimedEvent(overrides: Partial<OutboundEvent> = {}): OutboundEvent {
  return {
    outboundEventId: "outbound_001",
    workspaceId: "workspace_local",
    sessionId: "session_001",
    actorId: "actor_001",
    taskId: "task_001",
    runId: "run_001",
    conversationRef,
    channel: "telegram",
    eventKind: "final",
    renderPayload,
    idempotencyKey: "run:run_001:callback:final",
    status: "claimed",
    availableAt: "2026-04-26T00:00:00.000Z",
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    ...overrides
  };
}

function createDelivery(overrides: Partial<OutboundDelivery> = {}): OutboundDelivery {
  return {
    deliveryId: "delivery_001",
    outboundEventId: "outbound_001",
    transport: "telegram",
    transportTarget: {
      chatId: conversationRef.peerId,
      messageThreadId: Number(conversationRef.topicId)
    },
    status: "pending",
    attemptNo: 1,
    idempotencyKey: "outbound:outbound_001:telegram",
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    ...overrides
  };
}

function createAmbiguousTransportError() {
  const error = new TypeError("fetch failed: connection reset after request body write");
  Object.assign(error, {
    cause: {
      code: "ECONNRESET",
      message: "connection reset after request body write"
    }
  });
  return error;
}

type TestStore = Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"] & {
  upsertTask(input: {
    taskId: string;
    workspaceId: string;
    sessionId: string;
    title: string;
    description: string;
    kind: "background";
    status: "active";
    lastTurnId: string;
    checkpointRef: string;
  }): Promise<unknown>;
  enqueueOutboundEvent(input: {
    outboundEventId: string;
    workspaceId: string;
    sessionId: string;
    actorId: string;
    taskId: string;
    runId: string;
    conversationRef: typeof conversationRef;
    channel: "telegram";
    eventKind: "final";
    renderPayload: typeof renderPayload;
    idempotencyKey: string;
    now: string;
    availableAt: string;
  }): Promise<unknown>;
  loadOutboundEvent(outboundEventId: string): Promise<{ renderPayload: unknown } | undefined>;
};

async function withStore(test: (input: {
  store: TestStore;
  filename: string;
  client: TelegramBotClient;
  sendMessage: ReturnType<typeof vi.fn<TelegramBotClient["sendMessage"]>>;
}) => Promise<void>) {
  const taskStoreModuleUrl = pathToFileURL(
    join(import.meta.dirname, "../../tasks/src/task-store.ts")
  ).href;
  const { createTaskStore } = await import(taskStoreModuleUrl);
  const dir = await mkdtemp(join(tmpdir(), "endec-tg-outbox-drain-"));
  const filename = join(dir, "tasks.sqlite");
  const store = createTaskStore({ filename }) as TestStore;
  const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
    messageId: `msg_${input.chatId}_1`,
    chatId: input.chatId
  }));
  const client: TelegramBotClient = {
    getUpdates: async () => [],
    sendMessage,
    sendChatAction: async () => undefined,
    getMe: async () => ({ id: 999, is_bot: true, username: "endec" })
  };

  try {
    await store.upsertTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Seed task",
      description: "Parent task for outbound event FK",
      kind: "background",
      status: "active",
      lastTurnId: "turn_seed_001",
      checkpointRef: "checkpoint_seed_001"
    });

    const db = new Database(filename);
    try {
      db.prepare(`
        INSERT OR IGNORE INTO task_runs (
          run_id,
          task_id,
          workspace_id,
          session_id,
          conversation_ref_json,
          status,
          attempt_no,
          idempotency_key,
          turn_request_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "run_001",
        "task_001",
        "workspace_local",
        "session_001",
        JSON.stringify(conversationRef),
        "succeeded",
        1,
        "seed:run_001",
        "{}",
        "2026-04-26T00:00:00.000Z",
        "2026-04-26T00:00:00.000Z"
      );
    } finally {
      db.close();
    }

    await store.enqueueOutboundEvent({
      outboundEventId: "outbound_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      taskId: "task_001",
      runId: "run_001",
      conversationRef,
      channel: "telegram",
      eventKind: "final",
      renderPayload,
      idempotencyKey: "run:run_001:callback:final",
      now: "2026-04-26T00:00:00.000Z",
      availableAt: "2026-04-26T00:00:00.000Z"
    });

    await test({ store, filename, client, sendMessage: vi.mocked(sendMessage) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("telegram background outbox drain", () => {
  it("stale worker that loses delivery send ownership does not call sendMessage", async () => {
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `msg_${input.chatId}_1`,
      chatId: input.chatId
    }));
    const client: TelegramBotClient = {
      getUpdates: async () => [],
      sendMessage,
      sendChatAction: async () => undefined,
      getMe: async () => ({ id: 999, is_bot: true, username: "endec" })
    };
    const store = {
      claimPendingOutboundEvent: vi.fn(async () => createClaimedEvent()),
      createOutboundDelivery: vi.fn(async () => createDelivery()),
      markDeliverySending: vi.fn(async () => ({
        wonTransition: false,
        delivery: createDelivery({
          status: "sending",
          claimOwner: "telegram-drain-winner",
          claimExpiresAt: "2026-04-26T00:00:31.000Z",
          sendStartedAt: "2026-04-26T00:00:01.000Z"
        })
      })),
      markDeliveryDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(),
      markDeliveryUnknown: vi.fn()
    } as unknown as Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"];

    const drain = createTelegramBackgroundOutboxDrain({
      store,
      client,
      leaseOwner: "telegram-drain-stale",
      leaseDurationMs: 30_000
    });

    const result = await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

    expect(result).toEqual({ status: "idle" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.markDeliveryDelivered).not.toHaveBeenCalled();
    expect(store.markDeliveryFailed).not.toHaveBeenCalled();
    expect(store.markDeliveryUnknown).not.toHaveBeenCalled();
  });

  it("already delivered delivery is not sent again even if a stale event claim reaches the drain", async () => {
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `msg_${input.chatId}_1`,
      chatId: input.chatId
    }));
    const client: TelegramBotClient = {
      getUpdates: async () => [],
      sendMessage,
      sendChatAction: async () => undefined,
      getMe: async () => ({ id: 999, is_bot: true, username: "endec" })
    };
    const store = {
      claimPendingOutboundEvent: vi.fn(async () => createClaimedEvent()),
      createOutboundDelivery: vi.fn(async () => createDelivery({
        status: "delivered",
        deliveredAt: "2026-04-26T00:00:01.000Z",
        transportMessageId: "msg_1001_1"
      })),
      markDeliverySending: vi.fn(),
      markDeliveryDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(),
      markDeliveryUnknown: vi.fn()
    } as unknown as Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"];

    const drain = createTelegramBackgroundOutboxDrain({
      store,
      client,
      leaseOwner: "telegram-drain",
      leaseDurationMs: 30_000
    });

    const result = await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

    expect(result).toEqual({ status: "idle" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.markDeliverySending).not.toHaveBeenCalled();
  });

  it("already sending delivery is not sent by another drain attempt", async () => {
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `msg_${input.chatId}_1`,
      chatId: input.chatId
    }));
    const client: TelegramBotClient = {
      getUpdates: async () => [],
      sendMessage,
      sendChatAction: async () => undefined,
      getMe: async () => ({ id: 999, is_bot: true, username: "endec" })
    };
    const store = {
      claimPendingOutboundEvent: vi.fn(async () => createClaimedEvent()),
      createOutboundDelivery: vi.fn(async () => createDelivery({
        status: "sending",
        claimOwner: "telegram-drain-winner",
        claimExpiresAt: "2026-04-26T00:00:31.000Z",
        sendStartedAt: "2026-04-26T00:00:01.000Z"
      })),
      markDeliverySending: vi.fn(),
      markDeliveryDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(),
      markDeliveryUnknown: vi.fn()
    } as unknown as Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"];

    const drain = createTelegramBackgroundOutboxDrain({
      store,
      client,
      leaseOwner: "telegram-drain-stale",
      leaseDurationMs: 30_000
    });

    const result = await drain.drainOnce({ now: "2026-04-26T00:00:02.000Z" });

    expect(result).toEqual({ status: "idle" });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.markDeliverySending).not.toHaveBeenCalled();
  });

  it("exactly one send occurs under a simulated stale-worker race", async () => {
    let sendCount = 0;
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => {
      sendCount += 1;
      return {
        messageId: `msg_${input.chatId}_${sendCount}`,
        chatId: input.chatId
      };
    });
    const client: TelegramBotClient = {
      getUpdates: async () => [],
      sendMessage,
      sendChatAction: async () => undefined,
      getMe: async () => ({ id: 999, is_bot: true, username: "endec" })
    };
    let claimCount = 0;
    let ownershipAttempt = 0;
    const store = {
      claimPendingOutboundEvent: vi.fn(async () => {
        claimCount += 1;
        return claimCount <= 2 ? createClaimedEvent() : undefined;
      }),
      createOutboundDelivery: vi.fn(async () => createDelivery()),
      markDeliverySending: vi.fn(async () => {
        ownershipAttempt += 1;
        if (ownershipAttempt === 1) {
          return {
            wonTransition: true,
            delivery: createDelivery({
              status: "sending",
              claimOwner: "telegram-drain-b",
              claimExpiresAt: "2026-04-26T00:00:31.000Z",
              sendStartedAt: "2026-04-26T00:00:01.000Z"
            })
          };
        }

        return {
          wonTransition: false,
          delivery: createDelivery({
            status: "sending",
            claimOwner: "telegram-drain-b",
            claimExpiresAt: "2026-04-26T00:00:31.000Z",
            sendStartedAt: "2026-04-26T00:00:01.000Z"
          })
        };
      }),
      markDeliveryDelivered: vi.fn(async () => createDelivery({
        status: "delivered",
        deliveredAt: "2026-04-26T00:00:02.000Z",
        transportMessageId: "msg_1001_1"
      })),
      markDeliveryFailed: vi.fn(),
      markDeliveryUnknown: vi.fn()
    } as unknown as Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"];

    const winningDrain = createTelegramBackgroundOutboxDrain({
      store,
      client,
      leaseOwner: "telegram-drain-b",
      leaseDurationMs: 30_000
    });
    const staleDrain = createTelegramBackgroundOutboxDrain({
      store,
      client,
      leaseOwner: "telegram-drain-a",
      leaseDurationMs: 30_000
    });

    const first = await winningDrain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });
    const second = await staleDrain.drainOnce({ now: "2026-04-26T00:00:02.000Z" });

    expect(first).toMatchObject({ status: "delivered", outboundEventId: "outbound_001" });
    expect(second).toEqual({ status: "idle" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(store.markDeliveryDelivered).toHaveBeenCalledTimes(1);
  });

  it("claims one pending Telegram outbound event and sends it successfully", async () => {
    await withStore(async ({ store, client, sendMessage }) => {
      const drain = createTelegramBackgroundOutboxDrain({
        store,
        client,
        leaseOwner: "telegram-drain",
        leaseDurationMs: 30_000
      });

      const result = await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

      expect(result).toMatchObject({
        status: "delivered",
        outboundEventId: "outbound_001"
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith({
        chatId: "1001",
        text: expect.stringContaining("Investigate failures"),
        messageThreadId: 7,
        replyToMessageId: undefined
      });
    });
  });

  it("marks delivery sending before send and delivered after success", async () => {
    await withStore(async ({ store, client, filename }) => {
      const seenStatuses: string[] = [];
      const inspectingClient: TelegramBotClient = {
        ...client,
        sendMessage: vi.fn(async (input) => {
          const db = new Database(filename, { readonly: true });
          try {
            const row = db.prepare(`SELECT status FROM outbound_deliveries ORDER BY created_at ASC LIMIT 1`).get() as { status: string } | undefined;
            seenStatuses.push(row?.status ?? "missing");
          } finally {
            db.close();
          }
          return {
            messageId: `msg_${input.chatId}_1`,
            chatId: input.chatId
          };
        })
      };

      const drain = createTelegramBackgroundOutboxDrain({
        store,
        client: inspectingClient,
        leaseOwner: "telegram-drain",
        leaseDurationMs: 30_000
      });

      await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

      expect(seenStatuses).toEqual(["sending"]);
      const db = new Database(filename, { readonly: true });
      try {
        const row = db.prepare(`SELECT status FROM outbound_deliveries ORDER BY created_at ASC LIMIT 1`).get() as { status: string } | undefined;
        expect(row?.status).toBe("delivered");
      } finally {
        db.close();
      }
    });
  });

  it("persists Telegram message id and receipt metadata on success", async () => {
    await withStore(async ({ store, client, filename }) => {
      const drain = createTelegramBackgroundOutboxDrain({
        store,
        client,
        leaseOwner: "telegram-drain",
        leaseDurationMs: 30_000
      });

      await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

      const db = new Database(filename, { readonly: true });
      try {
        const row = db.prepare(`
          SELECT status, transport_message_id as transportMessageId, transport_receipt_json as transportReceiptJson
          FROM outbound_deliveries
          ORDER BY created_at ASC
          LIMIT 1
        `).get() as {
          status: string;
          transportMessageId: string | null;
          transportReceiptJson: string | null;
        } | undefined;

        expect(row).toMatchObject({
          status: "delivered",
          transportMessageId: "msg_1001_1"
        });
        expect(row?.transportReceiptJson ? JSON.parse(row.transportReceiptJson) : undefined).toEqual({
          messageId: "msg_1001_1",
          chatId: "1001"
        });
      } finally {
        db.close();
      }
    });
  });

  it("does not resend already delivered event", async () => {
    await withStore(async ({ store, client, sendMessage }) => {
      const drain = createTelegramBackgroundOutboxDrain({
        store,
        client,
        leaseOwner: "telegram-drain",
        leaseDurationMs: 30_000
      });

      await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });
      const second = await drain.drainOnce({ now: "2026-04-26T00:00:02.000Z" });

      expect(second).toMatchObject({ status: "idle" });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("if send fails deterministically before ambiguous success, marks failed", async () => {
    await withStore(async ({ store, client }) => {
      const failingClient: TelegramBotClient = {
        ...client,
        sendMessage: vi.fn(async () => {
          throw new Error("chat not found");
        })
      };
      const drain = createTelegramBackgroundOutboxDrain({
        store,
        client: failingClient,
        leaseOwner: "telegram-drain",
        leaseDurationMs: 30_000
      });

      const result = await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

      expect(result).toMatchObject({ status: "failed" });
    });
  });

  it("if send outcome is ambiguous on the real classifier path, marks delivery_unknown", async () => {
    await withStore(async ({ store, client }) => {
      const ambiguousClient: TelegramBotClient = {
        ...client,
        sendMessage: vi.fn(async () => {
          throw createAmbiguousTransportError();
        })
      };
      const drain = createTelegramBackgroundOutboxDrain({
        store,
        client: ambiguousClient,
        leaseOwner: "telegram-drain",
        leaseDurationMs: 30_000
      });

      const result = await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

      expect(result).toMatchObject({ status: "delivery_unknown" });
    });
  });

  it("delivery_unknown is not auto-claimed again when classified from a real transport error", async () => {
    await withStore(async ({ store, client }) => {
      const ambiguousClient: TelegramBotClient = {
        ...client,
        sendMessage: vi.fn(async () => {
          throw createAmbiguousTransportError();
        })
      };
      const drain = createTelegramBackgroundOutboxDrain({
        store,
        client: ambiguousClient,
        leaseOwner: "telegram-drain",
        leaseDurationMs: 30_000
      });

      await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });
      const second = await drain.drainOnce({ now: "2026-04-26T00:01:01.000Z" });

      expect(second).toMatchObject({ status: "idle" });
    });
  });

  it("cancels claimed outbound events whose conversation is no longer legal before sending", async () => {
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `msg_${input.chatId}_1`,
      chatId: input.chatId
    }));
    const cancelOutboundEvent = vi.fn(async () => undefined);
    const client: TelegramBotClient = {
      getUpdates: async () => [],
      sendMessage,
      sendChatAction: async () => undefined,
      getMe: async () => ({ id: 999, is_bot: true, username: "endec" })
    };
    const store = {
      claimPendingOutboundEvent: vi.fn(async () => createClaimedEvent()),
      createOutboundDelivery: vi.fn(async () => createDelivery()),
      markDeliverySending: vi.fn(),
      markDeliveryDelivered: vi.fn(),
      markDeliveryFailed: vi.fn(),
      markDeliveryUnknown: vi.fn(),
      cancelOutboundEvent
    } as unknown as Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"];

    const drain = createTelegramBackgroundOutboxDrain({
      store,
      client,
      leaseOwner: "telegram-drain",
      leaseDurationMs: 30_000,
      app: {
        im: {
          evaluateOutboundConversationLegality: vi.fn(async () => ({
            status: "blocked" as const,
            reason: "conversation_not_trusted"
          }))
        }
      }
    });

    const result = await drain.drainOnce({ now: "2026-04-26T00:00:01.000Z" });

    expect(result).toEqual({
      status: "canceled",
      outboundEventId: "outbound_001",
      messageCount: 0
    });
    expect(cancelOutboundEvent).toHaveBeenCalledWith({
      outboundEventId: "outbound_001",
      now: "2026-04-26T00:00:01.000Z"
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.createOutboundDelivery).not.toHaveBeenCalled();
  });
});
