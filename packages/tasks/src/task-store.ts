import Database from "better-sqlite3";
import {
  ConversationRefSchema,
  OutboundDeliverySchema,
  OutboundEventSchema,
  TaskStateSchema,
  type ConversationRef,
  type OutboundDelivery,
  type OutboundEvent,
  type OutboundEventKind,
  type OutboundTransport,
  type TaskState
} from "@endec/domain";
import { ensureTasksSchema } from "./schema.ts";
import { openSqliteDatabase } from "./sqlite.ts";

type TaskRow = {
  taskId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  description: string;
  kind: TaskState["kind"];
  status: TaskState["status"];
  lastTurnId: string;
  checkpointRef: string;
  createdAt: string;
  updatedAt: string;
  plan: string | null;
  currentStep: string | null;
  nextAction: string | null;
  artifacts: string | null;
  blockingReason: string | null;
};

type OutboundEventRow = {
  outboundEventId: string;
  workspaceId: string;
  sessionId: string | null;
  actorId: string | null;
  taskId: string | null;
  runId: string | null;
  conversationRefJson: string;
  channel: OutboundTransport;
  eventKind: OutboundEventKind;
  renderPayloadJson: string;
  idempotencyKey: string;
  status: "pending" | "claimed" | "canceled";
  claimOwner: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
};

type OutboundEventWithLease = OutboundEvent & {
  claimOwner?: string;
  claimToken?: string;
  claimExpiresAt?: string;
};

type OutboundDeliveryRow = {
  deliveryId: string;
  outboundEventId: string;
  transport: OutboundTransport;
  transportTargetJson: string;
  status: OutboundDelivery["status"];
  claimOwner: string | null;
  claimExpiresAt: string | null;
  sendStartedAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  deliveryUnknownAt: string | null;
  transportMessageId: string | null;
  transportReceiptJson: string | null;
  errorJson: string | null;
  attemptNo: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

type OutboundDeliveryWithMetadata = OutboundDelivery & {
  failedAt?: string;
  transportReceipt?: unknown;
};

function parseTask(row: TaskRow): TaskState {
  return TaskStateSchema.parse({
    ...row,
    plan: row.plan ? JSON.parse(row.plan) : undefined,
    currentStep: row.currentStep ?? undefined,
    nextAction: row.nextAction ?? undefined,
    artifacts: row.artifacts ? JSON.parse(row.artifacts) : undefined,
    blockingReason: row.blockingReason ?? undefined
  });
}

function jsonOrUndefined(value: string | null) {
  return value === null ? undefined : JSON.parse(value);
}

function parseOutboundEvent(row: OutboundEventRow): OutboundEventWithLease {
  return {
    ...OutboundEventSchema.parse({
      outboundEventId: row.outboundEventId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId ?? undefined,
      actorId: row.actorId ?? undefined,
      taskId: row.taskId ?? undefined,
      runId: row.runId ?? undefined,
      conversationRef: JSON.parse(row.conversationRefJson),
      channel: row.channel,
      eventKind: row.eventKind,
      renderPayload: JSON.parse(row.renderPayloadJson),
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      availableAt: row.availableAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }),
    claimOwner: row.claimOwner ?? undefined,
    claimToken: row.claimToken ?? undefined,
    claimExpiresAt: row.claimExpiresAt ?? undefined
  };
}

function parseOutboundDelivery(row: OutboundDeliveryRow): OutboundDeliveryWithMetadata {
  return {
    ...OutboundDeliverySchema.parse({
      deliveryId: row.deliveryId,
      outboundEventId: row.outboundEventId,
      transport: row.transport,
      transportTarget: JSON.parse(row.transportTargetJson),
      status: row.status,
      claimOwner: row.claimOwner ?? undefined,
      claimExpiresAt: row.claimExpiresAt ?? undefined,
      sendStartedAt: row.sendStartedAt ?? undefined,
      deliveredAt: row.deliveredAt ?? undefined,
      deliveryUnknownAt: row.deliveryUnknownAt ?? undefined,
      transportMessageId: row.transportMessageId ?? undefined,
      error: jsonOrUndefined(row.errorJson),
      attemptNo: row.attemptNo,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }),
    failedAt: row.failedAt ?? undefined,
    transportReceipt: jsonOrUndefined(row.transportReceiptJson)
  };
}

type MarkDeliverySendingResult = {
  delivery: OutboundDelivery;
  wonTransition: boolean;
};

export function createTaskStore({ filename }: { filename: string }) {
  const db = openSqliteDatabase(filename);
  ensureTasksSchema(db);

  const loadTaskStmt = db.prepare(`
    SELECT
      task_id as taskId,
      workspace_id as workspaceId,
      session_id as sessionId,
      title,
      description,
      kind,
      status,
      last_turn_id as lastTurnId,
      checkpoint_ref as checkpointRef,
      created_at as createdAt,
      updated_at as updatedAt,
      plan_json as plan,
      current_step as currentStep,
      next_action as nextAction,
      artifacts_json as artifacts,
      blocking_reason as blockingReason
    FROM tasks
    WHERE task_id = ?
  `);

  const loadOutboundEventStmt = db.prepare(`
    SELECT
      outbound_event_id as outboundEventId,
      workspace_id as workspaceId,
      session_id as sessionId,
      actor_id as actorId,
      task_id as taskId,
      run_id as runId,
      conversation_ref_json as conversationRefJson,
      channel,
      event_kind as eventKind,
      render_payload_json as renderPayloadJson,
      idempotency_key as idempotencyKey,
      status,
      claim_owner as claimOwner,
      claim_token as claimToken,
      claim_expires_at as claimExpiresAt,
      available_at as availableAt,
      created_at as createdAt,
      updated_at as updatedAt
    FROM outbound_events
    WHERE outbound_event_id = ?
  `);

  const loadOutboundDeliveryStmt = db.prepare(`
    SELECT
      delivery_id as deliveryId,
      outbound_event_id as outboundEventId,
      transport,
      transport_target_json as transportTargetJson,
      status,
      claim_owner as claimOwner,
      claim_expires_at as claimExpiresAt,
      send_started_at as sendStartedAt,
      delivered_at as deliveredAt,
      failed_at as failedAt,
      delivery_unknown_at as deliveryUnknownAt,
      transport_message_id as transportMessageId,
      transport_receipt_json as transportReceiptJson,
      error_json as errorJson,
      attempt_no as attemptNo,
      idempotency_key as idempotencyKey,
      created_at as createdAt,
      updated_at as updatedAt
    FROM outbound_deliveries
    WHERE delivery_id = ?
  `);

  const loadOutboundEventByIdempotencyStmt = db.prepare(`
    SELECT outbound_event_id as outboundEventId
    FROM outbound_events
    WHERE workspace_id = ? AND idempotency_key = ?
  `);

  const loadOutboundDeliveryByIdempotencyStmt = db.prepare(`
    SELECT delivery_id as deliveryId
    FROM outbound_deliveries
    WHERE outbound_event_id = ? AND transport = ? AND idempotency_key = ?
  `);

  async function upsertTask(update: {
    taskId: string;
    workspaceId: string;
    sessionId: string;
    title: string;
    description: string;
    kind: TaskState["kind"];
    status: TaskState["status"];
    lastTurnId: string;
    checkpointRef: string;
    plan?: string[];
    currentStep?: string;
    nextAction?: string;
    artifacts?: unknown[];
    blockingReason?: string;
  }) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (
        task_id,
        workspace_id,
        session_id,
        title,
        description,
        kind,
        status,
        last_turn_id,
        checkpoint_ref,
        plan_json,
        current_step,
        next_action,
        artifacts_json,
        blocking_reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        session_id = excluded.session_id,
        title = excluded.title,
        description = excluded.description,
        kind = excluded.kind,
        status = excluded.status,
        last_turn_id = excluded.last_turn_id,
        checkpoint_ref = excluded.checkpoint_ref,
        plan_json = excluded.plan_json,
        current_step = excluded.current_step,
        next_action = excluded.next_action,
        artifacts_json = excluded.artifacts_json,
        blocking_reason = excluded.blocking_reason,
        updated_at = excluded.updated_at
    `).run(
      update.taskId,
      update.workspaceId,
      update.sessionId,
      update.title,
      update.description,
      update.kind,
      update.status,
      update.lastTurnId,
      update.checkpointRef,
      JSON.stringify(update.plan ?? []),
      update.currentStep ?? null,
      update.nextAction ?? null,
      JSON.stringify(update.artifacts ?? []),
      update.blockingReason ?? null,
      now,
      now
    );

    const row = loadTaskStmt.get(update.taskId) as TaskRow | undefined;
    if (!row) {
      throw new Error(`failed to load task ${update.taskId}`);
    }
    return parseTask(row);
  }

  async function loadById(taskId: string) {
    const row = loadTaskStmt.get(taskId) as TaskRow | undefined;
    return row ? parseTask(row) : undefined;
  }

  async function listActiveBySession(sessionId: string) {
    return db.prepare(`
      SELECT
        task_id as taskId,
        status,
        last_turn_id as lastTurnId
      FROM tasks
      WHERE session_id = ?
        AND status IN ('new', 'planned', 'active', 'blocked', 'waiting_input')
      ORDER BY updated_at DESC, task_id DESC
    `).all(sessionId) as Array<{ taskId: string; status: TaskState["status"]; lastTurnId: string }>;
  }

  async function loadLatestActiveBySession(sessionId: string) {
    const row = db.prepare(`
      SELECT
        task_id as taskId,
        workspace_id as workspaceId,
        session_id as sessionId,
        title,
        description,
        kind,
        status,
        last_turn_id as lastTurnId,
        checkpoint_ref as checkpointRef,
        created_at as createdAt,
        updated_at as updatedAt,
        plan_json as plan,
        current_step as currentStep,
        next_action as nextAction,
        artifacts_json as artifacts,
        blocking_reason as blockingReason
      FROM tasks
      WHERE session_id = ?
        AND status IN ('new', 'planned', 'active', 'blocked', 'waiting_input')
      ORDER BY updated_at DESC, task_id DESC
      LIMIT 1
    `).get(sessionId) as TaskRow | undefined;

    return row ? parseTask(row) : undefined;
  }

  async function loadOutboundEvent(outboundEventId: string) {
    const row = loadOutboundEventStmt.get(outboundEventId) as OutboundEventRow | undefined;
    return row ? parseOutboundEvent(row) : undefined;
  }

  async function enqueueOutboundEvent(input: {
    outboundEventId: string;
    workspaceId: string;
    sessionId?: string;
    actorId?: string;
    taskId?: string;
    runId?: string;
    conversationRef: ConversationRef;
    channel: OutboundTransport;
    eventKind: OutboundEventKind;
    renderPayload: unknown;
    idempotencyKey: string;
    availableAt?: string;
    now?: string;
  }) {
    const existing = loadOutboundEventByIdempotencyStmt.get(input.workspaceId, input.idempotencyKey) as { outboundEventId: string } | undefined;
    if (existing) {
      const event = await loadOutboundEvent(existing.outboundEventId);
      if (!event) {
        throw new Error(`failed to load outbound event ${existing.outboundEventId}`);
      }
      return event;
    }

    const now = input.now ?? new Date().toISOString();
    const availableAt = input.availableAt ?? now;
    const conversationRef = ConversationRefSchema.parse(input.conversationRef);
    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO outbound_events (
        outbound_event_id,
        workspace_id,
        session_id,
        actor_id,
        task_id,
        run_id,
        conversation_ref_json,
        channel,
        event_kind,
        render_payload_json,
        idempotency_key,
        status,
        available_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      input.outboundEventId,
      input.workspaceId,
      input.sessionId ?? null,
      input.actorId ?? null,
      input.taskId ?? null,
      input.runId ?? null,
      JSON.stringify(conversationRef),
      input.channel,
      input.eventKind,
      JSON.stringify(input.renderPayload),
      input.idempotencyKey,
      availableAt,
      now,
      now
    );

    if (insertResult.changes === 1) {
      const event = await loadOutboundEvent(input.outboundEventId);
      if (!event) {
        throw new Error(`failed to load outbound event ${input.outboundEventId}`);
      }
      return event;
    }

    const raced = loadOutboundEventByIdempotencyStmt.get(input.workspaceId, input.idempotencyKey) as { outboundEventId: string } | undefined;
    if (!raced) {
      throw new Error(`failed to resolve outbound event idempotency conflict ${input.workspaceId}:${input.idempotencyKey}`);
    }

    const event = await loadOutboundEvent(raced.outboundEventId);
    if (!event) {
      throw new Error(`failed to load outbound event ${raced.outboundEventId}`);
    }
    return event;
  }

  async function listPendingOutboundEvents(input: { channel?: OutboundTransport; now?: string } = {}) {
    const now = input.now ?? new Date().toISOString();
    const rows = input.channel
      ? db.prepare(`
          SELECT
            outbound_event_id as outboundEventId,
            workspace_id as workspaceId,
            session_id as sessionId,
            actor_id as actorId,
            task_id as taskId,
            run_id as runId,
            conversation_ref_json as conversationRefJson,
            channel,
            event_kind as eventKind,
            render_payload_json as renderPayloadJson,
            idempotency_key as idempotencyKey,
            status,
            claim_owner as claimOwner,
            claim_token as claimToken,
            claim_expires_at as claimExpiresAt,
            available_at as availableAt,
            created_at as createdAt,
            updated_at as updatedAt
          FROM outbound_events
          WHERE status = 'pending' AND channel = ? AND available_at <= ?
          ORDER BY available_at ASC, created_at ASC, outbound_event_id ASC
        `).all(input.channel, now) as OutboundEventRow[]
      : db.prepare(`
          SELECT
            outbound_event_id as outboundEventId,
            workspace_id as workspaceId,
            session_id as sessionId,
            actor_id as actorId,
            task_id as taskId,
            run_id as runId,
            conversation_ref_json as conversationRefJson,
            channel,
            event_kind as eventKind,
            render_payload_json as renderPayloadJson,
            idempotency_key as idempotencyKey,
            status,
            claim_owner as claimOwner,
            claim_token as claimToken,
            claim_expires_at as claimExpiresAt,
            available_at as availableAt,
            created_at as createdAt,
            updated_at as updatedAt
          FROM outbound_events
          WHERE status = 'pending' AND available_at <= ?
          ORDER BY available_at ASC, created_at ASC, outbound_event_id ASC
        `).all(now) as OutboundEventRow[];

    return rows.map(parseOutboundEvent);
  }

  async function listOutboundEventsByTask(input: { taskId: string; runId?: string }) {
    const rows = input.runId
      ? db.prepare(`
          SELECT
            outbound_event_id as outboundEventId,
            workspace_id as workspaceId,
            session_id as sessionId,
            actor_id as actorId,
            task_id as taskId,
            run_id as runId,
            conversation_ref_json as conversationRefJson,
            channel,
            event_kind as eventKind,
            render_payload_json as renderPayloadJson,
            idempotency_key as idempotencyKey,
            status,
            claim_owner as claimOwner,
            claim_token as claimToken,
            claim_expires_at as claimExpiresAt,
            available_at as availableAt,
            created_at as createdAt,
            updated_at as updatedAt
          FROM outbound_events
          WHERE task_id = ? AND run_id = ?
          ORDER BY created_at ASC, outbound_event_id ASC
        `).all(input.taskId, input.runId) as OutboundEventRow[]
      : db.prepare(`
          SELECT
            outbound_event_id as outboundEventId,
            workspace_id as workspaceId,
            session_id as sessionId,
            actor_id as actorId,
            task_id as taskId,
            run_id as runId,
            conversation_ref_json as conversationRefJson,
            channel,
            event_kind as eventKind,
            render_payload_json as renderPayloadJson,
            idempotency_key as idempotencyKey,
            status,
            claim_owner as claimOwner,
            claim_token as claimToken,
            claim_expires_at as claimExpiresAt,
            available_at as availableAt,
            created_at as createdAt,
            updated_at as updatedAt
          FROM outbound_events
          WHERE task_id = ?
          ORDER BY created_at ASC, outbound_event_id ASC
        `).all(input.taskId) as OutboundEventRow[];

    return rows.map(parseOutboundEvent);
  }

  async function claimPendingOutboundEvent(input: {
    channel: OutboundTransport;
    leaseOwner: string;
    leaseToken: string;
    leaseDurationMs: number;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const claimExpiresAt = new Date(new Date(now).getTime() + input.leaseDurationMs).toISOString();
    const claim = db.transaction(() => {
      const candidate = db.prepare(`
        SELECT outbound_event_id as outboundEventId
        FROM outbound_events
        WHERE channel = ?
          AND available_at <= ?
          AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= ?))
        ORDER BY available_at ASC, created_at ASC, outbound_event_id ASC
        LIMIT 1
      `).get(input.channel, now, now) as { outboundEventId: string } | undefined;

      if (!candidate) {
        return undefined;
      }

      const result = db.prepare(`
        UPDATE outbound_events
        SET status = 'claimed',
            claim_owner = ?,
            claim_token = ?,
            claim_expires_at = ?,
            updated_at = ?
        WHERE outbound_event_id = ?
          AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= ?))
      `).run(input.leaseOwner, input.leaseToken, claimExpiresAt, now, candidate.outboundEventId, now);

      return result.changes === 1 ? candidate.outboundEventId : undefined;
    })();

    return claim ? loadOutboundEvent(claim) : undefined;
  }

  async function cancelOutboundEvent(input: { outboundEventId: string; now?: string }) {
    const now = input.now ?? new Date().toISOString();
    db.prepare(`
      UPDATE outbound_events
      SET status = 'canceled', updated_at = ?
      WHERE outbound_event_id = ? AND status = 'pending'
    `).run(now, input.outboundEventId);
    return loadOutboundEvent(input.outboundEventId);
  }

  async function loadOutboundDelivery(deliveryId: string) {
    const row = loadOutboundDeliveryStmt.get(deliveryId) as OutboundDeliveryRow | undefined;
    return row ? parseOutboundDelivery(row) : undefined;
  }

  async function createOutboundDelivery(input: {
    deliveryId: string;
    outboundEventId: string;
    transport: OutboundTransport;
    transportTarget: unknown;
    idempotencyKey: string;
    now?: string;
  }) {
    const existing = loadOutboundDeliveryByIdempotencyStmt.get(
      input.outboundEventId,
      input.transport,
      input.idempotencyKey
    ) as { deliveryId: string } | undefined;
    if (existing) {
      const delivery = await loadOutboundDelivery(existing.deliveryId);
      if (!delivery) {
        throw new Error(`failed to load outbound delivery ${existing.deliveryId}`);
      }
      return delivery;
    }

    const now = input.now ?? new Date().toISOString();
    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO outbound_deliveries (
        delivery_id,
        outbound_event_id,
        transport,
        transport_target_json,
        status,
        attempt_no,
        idempotency_key,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)
    `).run(
      input.deliveryId,
      input.outboundEventId,
      input.transport,
      JSON.stringify(input.transportTarget),
      input.idempotencyKey,
      now,
      now
    );

    if (insertResult.changes === 1) {
      const delivery = await loadOutboundDelivery(input.deliveryId);
      if (!delivery) {
        throw new Error(`failed to load outbound delivery ${input.deliveryId}`);
      }
      return delivery;
    }

    const raced = loadOutboundDeliveryByIdempotencyStmt.get(
      input.outboundEventId,
      input.transport,
      input.idempotencyKey
    ) as { deliveryId: string } | undefined;
    if (!raced) {
      throw new Error(`failed to resolve outbound delivery idempotency conflict ${input.outboundEventId}:${input.transport}:${input.idempotencyKey}`);
    }

    const delivery = await loadOutboundDelivery(raced.deliveryId);
    if (!delivery) {
      throw new Error(`failed to load outbound delivery ${raced.deliveryId}`);
    }
    return delivery;
  }

  async function listOutboundDeliveriesByEvent(input: { outboundEventId: string }) {
    const rows = db.prepare(`
      SELECT
        delivery_id as deliveryId,
        outbound_event_id as outboundEventId,
        transport,
        transport_target_json as transportTargetJson,
        status,
        claim_owner as claimOwner,
        claim_expires_at as claimExpiresAt,
        send_started_at as sendStartedAt,
        delivered_at as deliveredAt,
        failed_at as failedAt,
        delivery_unknown_at as deliveryUnknownAt,
        transport_message_id as transportMessageId,
        transport_receipt_json as transportReceiptJson,
        error_json as errorJson,
        attempt_no as attemptNo,
        idempotency_key as idempotencyKey,
        created_at as createdAt,
        updated_at as updatedAt
      FROM outbound_deliveries
      WHERE outbound_event_id = ?
      ORDER BY created_at ASC, delivery_id ASC
    `).all(input.outboundEventId) as OutboundDeliveryRow[];

    return rows.map(parseOutboundDelivery);
  }

  async function claimPendingOutboundDelivery(input: {
    transport: OutboundTransport;
    claimOwner: string;
    claimDurationMs: number;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const claimExpiresAt = new Date(new Date(now).getTime() + input.claimDurationMs).toISOString();
    const claim = db.transaction(() => {
      const candidate = db.prepare(`
        SELECT delivery_id as deliveryId
        FROM outbound_deliveries
        WHERE transport = ?
          AND status = 'pending'
          AND (claim_expires_at IS NULL OR claim_expires_at < ?)
        ORDER BY created_at ASC, delivery_id ASC
        LIMIT 1
      `).get(input.transport, now) as { deliveryId: string } | undefined;
      if (!candidate) {
        return undefined;
      }

      const result = db.prepare(`
        UPDATE outbound_deliveries
        SET claim_owner = ?, claim_expires_at = ?, updated_at = ?
        WHERE delivery_id = ?
          AND status = 'pending'
          AND (claim_expires_at IS NULL OR claim_expires_at < ?)
      `).run(input.claimOwner, claimExpiresAt, now, candidate.deliveryId, now);
      return result.changes === 1 ? candidate.deliveryId : undefined;
    })();

    return claim ? loadOutboundDelivery(claim) : undefined;
  }

  async function markDeliverySending(input: {
    deliveryId: string;
    claimOwner?: string;
    claimExpiresAt?: string;
    sendStartedAt?: string;
  }): Promise<MarkDeliverySendingResult | undefined> {
    const sendStartedAt = input.sendStartedAt ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE outbound_deliveries
      SET status = 'sending',
          claim_owner = COALESCE(?, claim_owner),
          claim_expires_at = COALESCE(?, claim_expires_at),
          send_started_at = ?,
          updated_at = ?
      WHERE delivery_id = ? AND status = 'pending'
    `).run(input.claimOwner ?? null, input.claimExpiresAt ?? null, sendStartedAt, sendStartedAt, input.deliveryId);
    const delivery = await loadOutboundDelivery(input.deliveryId);
    if (!delivery) {
      return undefined;
    }

    return {
      delivery,
      wonTransition: result.changes === 1
    };
  }

  async function markDeliveryDelivered(input: {
    deliveryId: string;
    deliveredAt?: string;
    transportMessageId?: string;
    receipt?: unknown;
  }) {
    const deliveredAt = input.deliveredAt ?? new Date().toISOString();
    db.prepare(`
      UPDATE outbound_deliveries
      SET status = 'delivered',
          delivered_at = ?,
          transport_message_id = ?,
          transport_receipt_json = ?,
          updated_at = ?
      WHERE delivery_id = ? AND status = 'sending' AND send_started_at IS NOT NULL
    `).run(
      deliveredAt,
      input.transportMessageId ?? null,
      input.receipt === undefined ? null : JSON.stringify(input.receipt),
      deliveredAt,
      input.deliveryId
    );
    return loadOutboundDelivery(input.deliveryId);
  }

  async function markDeliveryFailed(input: {
    deliveryId: string;
    failedAt?: string;
    error: unknown;
  }) {
    const failedAt = input.failedAt ?? new Date().toISOString();
    db.prepare(`
      UPDATE outbound_deliveries
      SET status = 'failed', failed_at = ?, error_json = ?, updated_at = ?
      WHERE delivery_id = ? AND status = 'sending' AND send_started_at IS NOT NULL
    `).run(failedAt, JSON.stringify(input.error), failedAt, input.deliveryId);
    return loadOutboundDelivery(input.deliveryId);
  }

  async function markDeliveryUnknown(input: {
    deliveryId: string;
    deliveryUnknownAt?: string;
    error?: unknown;
  }) {
    const deliveryUnknownAt = input.deliveryUnknownAt ?? new Date().toISOString();
    db.prepare(`
      UPDATE outbound_deliveries
      SET status = 'delivery_unknown', delivery_unknown_at = ?, error_json = ?, updated_at = ?
      WHERE delivery_id = ? AND status = 'sending' AND send_started_at IS NOT NULL
    `).run(
      deliveryUnknownAt,
      input.error === undefined ? null : JSON.stringify(input.error),
      deliveryUnknownAt,
      input.deliveryId
    );
    return loadOutboundDelivery(input.deliveryId);
  }

  return {
    upsertTask,
    loadById,
    listActiveBySession,
    loadLatestActiveBySession,
    enqueueOutboundEvent,
    loadOutboundEvent,
    listPendingOutboundEvents,
    listOutboundEventsByTask,
    listOutboundDeliveriesByEvent,
    claimPendingOutboundEvent,
    cancelOutboundEvent,
    createOutboundDelivery,
    claimPendingOutboundDelivery,
    loadOutboundDelivery,
    markDeliverySending,
    markDeliveryDelivered,
    markDeliveryFailed,
    markDeliveryUnknown
  };
}
