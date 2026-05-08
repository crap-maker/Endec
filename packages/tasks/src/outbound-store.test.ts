import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskStore } from "./task-store.ts";

const conversationRef = {
  accountId: "telegram:bot:endec",
  conversationId: "telegram:chat:1001",
  peerId: "1001",
  peerKind: "group" as const,
  parentConversationId: "telegram:chat:root",
  baseConversationId: "telegram:chat:base",
  threadId: "42",
  topicId: "7",
  senderScope: "workspace:local"
};

const messagePayload = {
  kind: "background_final",
  text: "Background task completed",
  task: {
    taskId: "task_001",
    title: "Investigate failures"
  },
  run: {
    runId: "run_001",
    status: "succeeded"
  }
};

async function withStore(test: (store: ReturnType<typeof createTaskStore>, filename: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "endec-outbound-store-"));
  const filename = join(dir, "tasks.sqlite");
  try {
    const store = createTaskStore({ filename });

    await store.upsertTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Seed task for outbound store tests",
      description: "Ensures outbound_events FK(task_id) has a parent row",
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
          status,
          attempt_no,
          idempotency_key,
          turn_request_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "run_001",
        "task_001",
        "workspace_local",
        "session_001",
        "succeeded",
        1,
        "seed:run_001",
        "{}",
        "2026-04-25T10:00:00.000Z",
        "2026-04-25T10:00:00.000Z"
      );
    } finally {
      db.close();
    }

    await test(store, filename);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function enqueueInput(overrides: Partial<Parameters<ReturnType<typeof createTaskStore>["enqueueOutboundEvent"]>[0]> = {}) {
  return {
    outboundEventId: "outbound_001",
    workspaceId: "workspace_local",
    sessionId: "session_001",
    actorId: "actor_001",
    taskId: "task_001",
    runId: "run_001",
    conversationRef,
    channel: "telegram" as const,
    eventKind: "final" as const,
    renderPayload: messagePayload,
    idempotencyKey: "run:run_001:callback:final",
    availableAt: "2026-04-25T10:00:00.000Z",
    now: "2026-04-25T10:00:00.000Z",
    ...overrides
  };
}

async function enqueueEvent(store: ReturnType<typeof createTaskStore>, overrides: Partial<Parameters<ReturnType<typeof createTaskStore>["enqueueOutboundEvent"]>[0]> = {}) {
  return store.enqueueOutboundEvent(enqueueInput(overrides));
}

describe("outbound outbox store", () => {
  it("enqueue/load pending outbound event with conversationRef JSON and message payload", async () => {
    await withStore(async (store) => {
      const event = await enqueueEvent(store);

      expect(event).toMatchObject({
        outboundEventId: "outbound_001",
        workspaceId: "workspace_local",
        sessionId: "session_001",
        actorId: "actor_001",
        taskId: "task_001",
        runId: "run_001",
        conversationRef,
        channel: "telegram",
        eventKind: "final",
        renderPayload: messagePayload,
        idempotencyKey: "run:run_001:callback:final",
        status: "pending",
        availableAt: "2026-04-25T10:00:00.000Z"
      });

      await expect(store.loadOutboundEvent("outbound_001")).resolves.toEqual(event);
    });
  });

  it("fresh outbound_events schema includes task/run foreign keys", async () => {
    await withStore(async (_store, filename) => {
      const db = new Database(filename, { readonly: true });
      try {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_events'")
          .get() as { sql: string } | undefined;

        expect(row).toBeDefined();
        const normalizedSql = row!.sql.replace(/\s+/g, " ").trim();

        expect(normalizedSql).toContain("session_id TEXT");
        expect(normalizedSql).not.toContain("session_id TEXT NOT NULL");
        expect(normalizedSql).toContain("FOREIGN KEY(task_id) REFERENCES tasks(task_id)");
        expect(normalizedSql).toContain("FOREIGN KEY(run_id) REFERENCES task_runs(run_id)");
      } finally {
        db.close();
      }
    });
  });

  it("allows enqueue/load of operator notices without session truth", async () => {
    await withStore(async (store) => {
      const event = await enqueueEvent(store, {
        outboundEventId: "outbound_pairing_001",
        sessionId: undefined,
        actorId: "operator_alpha",
        taskId: undefined,
        runId: undefined,
        conversationRef: {
          accountId: "telegram:bot:endec",
          conversationId: "dm:chat_42",
          peerId: "chat_42",
          peerKind: "dm"
        },
        eventKind: "operator_notice",
        renderPayload: {
          schemaVersion: 1,
          contractVersion: "im.authority-control.v1",
          noticeKind: "pairing_success",
          message: [
            "Pairing complete. Normal chat is ready now.",
            "",
            "Optional setup: reply in this direct chat with any of the following if you want:",
            "- your display name",
            "- my display name (default: Endec)",
            "- your timezone (default: server timezone)",
            "",
            "Silence is okay; you can start chatting normally anytime."
          ].join("\n"),
          ownerBindingId: "binding_001",
          ownerGeneration: 0,
          conversationRef: {
            accountId: "telegram:bot:endec",
            conversationId: "dm:chat_42",
            peerId: "chat_42",
            peerKind: "dm"
          }
        },
        idempotencyKey: "authority:telegram:acct_bot:pairing_success:binding_001"
      });

      expect(event).toMatchObject({
        outboundEventId: "outbound_pairing_001",
        workspaceId: "workspace_local",
        sessionId: undefined,
        actorId: "operator_alpha",
        taskId: undefined,
        runId: undefined,
        eventKind: "operator_notice"
      });
      await expect(store.loadOutboundEvent("outbound_pairing_001")).resolves.toEqual(event);
    });
  });

  it("idempotent enqueue by workspaceId + idempotencyKey returns existing event", async () => {
    await withStore(async (store) => {
      const first = await enqueueEvent(store, { outboundEventId: "outbound_001" });
      const second = await enqueueEvent(store, {
        outboundEventId: "outbound_002",
        renderPayload: { text: "new payload must not overwrite existing event" },
        conversationRef: {
          accountId: "telegram:bot:changed",
          conversationId: "telegram:chat:changed",
          peerId: "changed",
          peerKind: "dm"
        }
      });

      expect(second).toEqual(first);
      expect(second.renderPayload).toEqual(messagePayload);
      expect(second.conversationRef).toEqual(conversationRef);
      expect(await store.listOutboundEventsByTask({ taskId: "task_001" })).toHaveLength(1);
    });
  });

  it("enqueueOutboundEvent handles unique-key race by returning existing row instead of throwing", async () => {
    await withStore(async (store, filename) => {
      const db = new Database(filename);
      db.exec(`
        CREATE TRIGGER outbound_events_race_trigger
        BEFORE INSERT ON outbound_events
        WHEN NEW.idempotency_key = 'race:idem:event'
        BEGIN
          INSERT INTO outbound_events (
            outbound_event_id,
            workspace_id,
            session_id,
            conversation_ref_json,
            channel,
            event_kind,
            render_payload_json,
            idempotency_key,
            status,
            available_at,
            created_at,
            updated_at
          ) VALUES (
            'outbound_race_existing',
            NEW.workspace_id,
            NEW.session_id,
            NEW.conversation_ref_json,
            NEW.channel,
            NEW.event_kind,
            '{"kind":"seed","text":"seed payload"}',
            NEW.idempotency_key,
            'pending',
            NEW.available_at,
            NEW.created_at,
            NEW.updated_at
          );
        END;
      `);
      db.close();

      const event = await enqueueEvent(store, {
        outboundEventId: "outbound_race_new",
        idempotencyKey: "race:idem:event",
        renderPayload: { kind: "new", text: "new payload" }
      });

      expect(event.outboundEventId).toBe("outbound_race_existing");
      expect(event.renderPayload).toEqual({ kind: "seed", text: "seed payload" });
    });
  });

  it("claim pending event marks it claimed with lease owner/token/expiry", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);

      const claimed = await store.claimPendingOutboundEvent({
        channel: "telegram",
        leaseOwner: "worker-a",
        leaseToken: "lease-token-a",
        leaseDurationMs: 30_000,
        now: "2026-04-25T10:00:01.000Z"
      });

      expect(claimed).toMatchObject({
        outboundEventId: "outbound_001",
        status: "claimed",
        claimOwner: "worker-a",
        claimToken: "lease-token-a",
        claimExpiresAt: "2026-04-25T10:00:31.000Z"
      });
      await expect(store.loadOutboundEvent("outbound_001")).resolves.toMatchObject({
        status: "claimed",
        claimOwner: "worker-a",
        claimToken: "lease-token-a",
        claimExpiresAt: "2026-04-25T10:00:31.000Z"
      });
    });
  });

  it("claimed non-expired event is not claimed twice", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.claimPendingOutboundEvent({
        channel: "telegram",
        leaseOwner: "worker-a",
        leaseToken: "lease-token-a",
        leaseDurationMs: 30_000,
        now: "2026-04-25T10:00:01.000Z"
      });

      await expect(store.claimPendingOutboundEvent({
        channel: "telegram",
        leaseOwner: "worker-b",
        leaseToken: "lease-token-b",
        leaseDurationMs: 30_000,
        now: "2026-04-25T10:00:02.000Z"
      })).resolves.toBeUndefined();
    });
  });

  it("cancel pending event prevents claim", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.cancelOutboundEvent({
        outboundEventId: "outbound_001",
        now: "2026-04-25T10:00:01.000Z"
      });

      await expect(store.claimPendingOutboundEvent({
        channel: "telegram",
        leaseOwner: "worker-a",
        leaseToken: "lease-token-a",
        leaseDurationMs: 30_000,
        now: "2026-04-25T10:00:02.000Z"
      })).resolves.toBeUndefined();
    });
  });

  it("create delivery record idempotently", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);

      const first = await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001", messageThreadId: 7 },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });
      const second = await store.createOutboundDelivery({
        deliveryId: "delivery_002",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001", messageThreadId: 99 },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:02.000Z"
      });

      expect(first).toMatchObject({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001", messageThreadId: 7 },
        status: "pending",
        attemptNo: 1,
        idempotencyKey: "outbound_001:telegram"
      });
      expect(second).toEqual(first);
      expect(second.transportTarget).toEqual({ chatId: "1001", messageThreadId: 7 });
    });
  });

  it("createOutboundDelivery handles unique-key race by returning existing row instead of throwing", async () => {
    await withStore(async (store, filename) => {
      await enqueueEvent(store);

      const db = new Database(filename);
      db.exec(`
        CREATE TRIGGER outbound_deliveries_race_trigger
        BEFORE INSERT ON outbound_deliveries
        WHEN NEW.idempotency_key = 'race:idem:delivery'
        BEGIN
          INSERT INTO outbound_deliveries (
            delivery_id,
            outbound_event_id,
            transport,
            transport_target_json,
            status,
            attempt_no,
            idempotency_key,
            created_at,
            updated_at
          ) VALUES (
            'delivery_race_existing',
            NEW.outbound_event_id,
            NEW.transport,
            '{"chatId":"seed"}',
            'pending',
            1,
            NEW.idempotency_key,
            NEW.created_at,
            NEW.updated_at
          );
        END;
      `);
      db.close();

      const delivery = await store.createOutboundDelivery({
        deliveryId: "delivery_race_new",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "new" },
        idempotencyKey: "race:idem:delivery",
        now: "2026-04-25T10:00:01.000Z"
      });

      expect(delivery.deliveryId).toBe("delivery_race_existing");
      expect(delivery.transportTarget).toEqual({ chatId: "seed" });
    });
  });

  it("claim pending delivery once, second claim before lease expiry returns undefined", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      const firstClaim = await store.claimPendingOutboundDelivery({
        transport: "telegram",
        claimOwner: "telegram-drain-a",
        claimDurationMs: 30_000,
        now: "2026-04-25T10:00:02.000Z"
      });

      expect(firstClaim).toMatchObject({
        deliveryId: "delivery_001",
        status: "pending",
        claimOwner: "telegram-drain-a",
        claimExpiresAt: "2026-04-25T10:00:32.000Z"
      });

      await expect(store.claimPendingOutboundDelivery({
        transport: "telegram",
        claimOwner: "telegram-drain-b",
        claimDurationMs: 30_000,
        now: "2026-04-25T10:00:03.000Z"
      })).resolves.toBeUndefined();
    });
  });

  it("after lease expiry, pending delivery can be claimed again if it has never entered sending", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      await store.claimPendingOutboundDelivery({
        transport: "telegram",
        claimOwner: "telegram-drain-a",
        claimDurationMs: 30_000,
        now: "2026-04-25T10:00:02.000Z"
      });

      const claimAfterExpiry = await store.claimPendingOutboundDelivery({
        transport: "telegram",
        claimOwner: "telegram-drain-b",
        claimDurationMs: 30_000,
        now: "2026-04-25T10:00:33.000Z"
      });

      expect(claimAfterExpiry).toMatchObject({
        deliveryId: "delivery_001",
        status: "pending",
        claimOwner: "telegram-drain-b",
        claimExpiresAt: "2026-04-25T10:01:03.000Z"
      });
    });
  });

  it("sending delivery is not claimable even after lease expiry", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });
      await store.markDeliverySending({
        deliveryId: "delivery_001",
        claimOwner: "telegram-drain-a",
        claimExpiresAt: "2026-04-25T10:00:10.000Z",
        sendStartedAt: "2026-04-25T10:00:02.000Z"
      });

      await expect(store.claimPendingOutboundDelivery({
        transport: "telegram",
        claimOwner: "telegram-drain-b",
        claimDurationMs: 30_000,
        now: "2026-04-25T10:00:20.000Z"
      })).resolves.toBeUndefined();
    });
  });

  it("mark delivery sending before transport send", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      const sending = await store.markDeliverySending({
        deliveryId: "delivery_001",
        claimOwner: "telegram-drain-a",
        claimExpiresAt: "2026-04-25T10:01:00.000Z",
        sendStartedAt: "2026-04-25T10:00:02.000Z"
      });

      expect(sending).toMatchObject({
        wonTransition: true,
        delivery: {
          status: "sending",
          claimOwner: "telegram-drain-a",
          claimExpiresAt: "2026-04-25T10:01:00.000Z",
          sendStartedAt: "2026-04-25T10:00:02.000Z"
        }
      });
    });
  });

  it("markDeliverySending reports lost race without granting ownership", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      const first = await store.markDeliverySending({
        deliveryId: "delivery_001",
        claimOwner: "telegram-drain-a",
        claimExpiresAt: "2026-04-25T10:01:00.000Z",
        sendStartedAt: "2026-04-25T10:00:02.000Z"
      });
      const second = await store.markDeliverySending({
        deliveryId: "delivery_001",
        claimOwner: "telegram-drain-b",
        claimExpiresAt: "2026-04-25T10:02:00.000Z",
        sendStartedAt: "2026-04-25T10:00:03.000Z"
      });

      expect(first).toMatchObject({
        wonTransition: true,
        delivery: {
          status: "sending",
          claimOwner: "telegram-drain-a",
          claimExpiresAt: "2026-04-25T10:01:00.000Z",
          sendStartedAt: "2026-04-25T10:00:02.000Z"
        }
      });
      expect(second).toMatchObject({
        wonTransition: false,
        delivery: {
          status: "sending",
          claimOwner: "telegram-drain-a",
          claimExpiresAt: "2026-04-25T10:01:00.000Z",
          sendStartedAt: "2026-04-25T10:00:02.000Z"
        }
      });
    });
  });

  it("pending delivery cannot be marked delivered", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      const result = await store.markDeliveryDelivered({
        deliveryId: "delivery_001",
        deliveredAt: "2026-04-25T10:00:03.000Z",
        transportMessageId: "tg_msg_123",
        receipt: { messageId: "tg_msg_123" }
      });

      expect(result).toMatchObject({ status: "pending" });
      expect(result?.deliveredAt).toBeUndefined();
      expect(result?.transportMessageId).toBeUndefined();
    });
  });

  it("pending delivery cannot be marked failed", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      const result = await store.markDeliveryFailed({
        deliveryId: "delivery_001",
        failedAt: "2026-04-25T10:00:03.000Z",
        error: { code: "ETIMEDOUT", message: "transport timeout" }
      });

      expect(result).toMatchObject({ status: "pending" });
      expect(result?.error).toBeUndefined();
    });
  });

  it("pending delivery cannot be marked delivery_unknown", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      const result = await store.markDeliveryUnknown({
        deliveryId: "delivery_001",
        deliveryUnknownAt: "2026-04-25T10:00:03.000Z",
        error: { code: "AMBIGUOUS_AFTER_SEND", message: "process crashed before receipt persisted" }
      });

      expect(result).toMatchObject({ status: "pending" });
      expect(result?.deliveryUnknownAt).toBeUndefined();
      expect(result?.error).toBeUndefined();
    });
  });

  it("mark delivered stores transport receipt metadata", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });
      await store.markDeliverySending({
        deliveryId: "delivery_001",
        sendStartedAt: "2026-04-25T10:00:02.000Z"
      });

      const delivered = await store.markDeliveryDelivered({
        deliveryId: "delivery_001",
        deliveredAt: "2026-04-25T10:00:03.000Z",
        transportMessageId: "tg_msg_123",
        receipt: { messageId: "tg_msg_123", date: 1_776_510_003 }
      });

      expect(delivered).toMatchObject({
        status: "delivered",
        deliveredAt: "2026-04-25T10:00:03.000Z",
        transportMessageId: "tg_msg_123",
        transportReceipt: { messageId: "tg_msg_123", date: 1_776_510_003 }
      });
    });
  });

  it("mark failed stores error", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });
      await store.markDeliverySending({
        deliveryId: "delivery_001",
        sendStartedAt: "2026-04-25T10:00:02.000Z"
      });

      const failed = await store.markDeliveryFailed({
        deliveryId: "delivery_001",
        failedAt: "2026-04-25T10:00:03.000Z",
        error: { code: "ETIMEDOUT", message: "transport timeout" }
      });

      expect(failed).toMatchObject({
        status: "failed",
        error: { code: "ETIMEDOUT", message: "transport timeout" }
      });
    });
  });

  it("mark delivery_unknown is terminal for automatic drain / not claimable as pending", async () => {
    await withStore(async (store) => {
      await enqueueEvent(store);
      await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: "outbound_001",
        transport: "telegram",
        transportTarget: { chatId: "1001" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });
      await store.markDeliverySending({
        deliveryId: "delivery_001",
        sendStartedAt: "2026-04-25T10:00:02.000Z"
      });

      const unknown = await store.markDeliveryUnknown({
        deliveryId: "delivery_001",
        deliveryUnknownAt: "2026-04-25T10:00:03.000Z",
        error: { code: "AMBIGUOUS_AFTER_SEND", message: "process crashed after send started" }
      });

      expect(unknown).toMatchObject({
        status: "delivery_unknown",
        deliveryUnknownAt: "2026-04-25T10:00:03.000Z",
        error: { code: "AMBIGUOUS_AFTER_SEND" }
      });
      await expect(store.claimPendingOutboundDelivery({
        transport: "telegram",
        claimOwner: "telegram-drain-b",
        claimDurationMs: 30_000,
        now: "2026-04-25T10:00:04.000Z"
      })).resolves.toBeUndefined();
    });
  });

  it("no Telegram-specific fields required in domain truth; transport metadata stays in delivery payload", async () => {
    await withStore(async (store) => {
      const event = await enqueueEvent(store, {
        conversationRef: {
          accountId: "generic-account",
          conversationId: "generic-conversation",
          peerId: "peer-001",
          peerKind: "dm"
        },
        renderPayload: {
          text: "done",
          blocks: [{ type: "paragraph", text: "done" }]
        }
      });
      const delivery = await store.createOutboundDelivery({
        deliveryId: "delivery_001",
        outboundEventId: event.outboundEventId,
        transport: "telegram",
        transportTarget: { chatId: "1001", messageThreadId: 7, parseMode: "Markdown" },
        idempotencyKey: "outbound_001:telegram",
        now: "2026-04-25T10:00:01.000Z"
      });

      expect(event.conversationRef).toEqual({
        accountId: "generic-account",
        conversationId: "generic-conversation",
        peerId: "peer-001",
        peerKind: "dm"
      });
      expect(event.renderPayload).toEqual({
        text: "done",
        blocks: [{ type: "paragraph", text: "done" }]
      });
      expect(delivery.transportTarget).toEqual({
        chatId: "1001",
        messageThreadId: 7,
        parseMode: "Markdown"
      });
    });
  });
});
