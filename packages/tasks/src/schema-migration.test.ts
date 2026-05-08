import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureTasksSchema } from "./schema.ts";
import { createTaskStore } from "./task-store.ts";

const tempFiles = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempFiles].map(async (filename) => {
      await rm(filename, { force: true });
      tempFiles.delete(filename);
    })
  );
});

function createLegacyTasksDatabase(filename: string) {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      last_turn_id TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      plan_json TEXT,
      current_step TEXT,
      next_action TEXT,
      artifacts_json TEXT,
      blocking_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, '[]', NULL, ?, ?)
  `).run(
    "task_legacy_001",
    "workspace_local",
    "session_001",
    "Legacy task",
    "Created before background schema",
    "background",
    "active",
    "turn_001",
    "checkpoint_001",
    "2026-04-25T00:00:00.000Z",
    "2026-04-25T00:00:00.000Z"
  );
  db.close();
}

function listColumns(db: Database.Database, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: 0 | 1;
  }>;
}

function listTables(db: Database.Database) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
}

describe("tasks schema migration", () => {
  it("migrates a legacy tasks database idempotently without rewriting old rows", async () => {
    const filename = join(await mkdtemp(join(tmpdir(), "endec-task-schema-")), "tasks.sqlite");
    tempFiles.add(filename);
    createLegacyTasksDatabase(filename);

    const firstStore = createTaskStore({ filename });
    const secondStore = createTaskStore({ filename });

    await expect(firstStore.loadById("task_legacy_001")).resolves.toMatchObject({
      taskId: "task_legacy_001",
      status: "active",
      kind: "background",
      checkpointRef: "checkpoint_001"
    });
    await expect(secondStore.loadById("task_legacy_001")).resolves.toMatchObject({
      taskId: "task_legacy_001",
      status: "active"
    });

    const db = new Database(filename);
    const columns = listColumns(db, "tasks").map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      "actor_id",
      "conversation_ref_json",
      "agent_status",
      "background_created_at"
    ]));

    const outboundColumns = listColumns(db, "outbound_events");
    expect(outboundColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "session_id"
    ]));
    expect(outboundColumns.find((column) => column.name === "session_id")?.notnull).toBe(0);

    const tables = listTables(db);
    expect(tables).toEqual(expect.arrayContaining([
      "tasks",
      "task_runs",
      "task_events",
      "outbound_events",
      "outbound_deliveries"
    ]));

    const legacyRow = db.prepare(`
      SELECT actor_id, conversation_ref_json, agent_status, background_created_at
      FROM tasks
      WHERE task_id = ?
    `).get("task_legacy_001") as Record<string, unknown>;
    expect(legacyRow).toEqual({
      actor_id: null,
      conversation_ref_json: null,
      agent_status: null,
      background_created_at: null
    });
    db.close();
  });

  it("repairs outbound_deliveries foreign keys when outbound_events is rebuilt during session-nullability migration", async () => {
    const filename = join(await mkdtemp(join(tmpdir(), "endec-task-schema-outbound-deliveries-")), "tasks.sqlite");
    tempFiles.add(filename);

    const db = new Database(filename);
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        last_turn_id TEXT NOT NULL,
        checkpoint_ref TEXT NOT NULL,
        plan_json TEXT,
        current_step TEXT,
        next_action TEXT,
        artifacts_json TEXT,
        blocking_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_id TEXT,
        conversation_ref_json TEXT,
        status TEXT NOT NULL,
        run_kind TEXT NOT NULL DEFAULT 'normal',
        attempt_no INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        turn_request_json TEXT NOT NULL,
        source_turn_id TEXT,
        worker_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        claimed_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        wall_clock_deadline_at TEXT,
        cancel_requested_at TEXT,
        cancel_reason TEXT,
        pending_approval_ref TEXT,
        pending_control_ref TEXT,
        parent_run_id TEXT,
        retry_of_run_id TEXT,
        result_summary TEXT,
        error_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE outbound_events (
        outbound_event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_id TEXT,
        task_id TEXT,
        run_id TEXT,
        conversation_ref_json TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        render_payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id),
        FOREIGN KEY(run_id) REFERENCES task_runs(run_id)
      );

      CREATE TABLE outbound_deliveries (
        delivery_id TEXT PRIMARY KEY,
        outbound_event_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        transport_target_json TEXT NOT NULL,
        status TEXT NOT NULL,
        claim_owner TEXT,
        claim_expires_at TEXT,
        send_started_at TEXT,
        delivered_at TEXT,
        delivery_unknown_at TEXT,
        transport_message_id TEXT,
        error_json TEXT,
        attempt_no INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(outbound_event_id) REFERENCES outbound_events(outbound_event_id)
      );

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
        created_at,
        updated_at
      ) VALUES (
        'task_legacy_001',
        'workspace_local',
        'session_001',
        'Legacy task',
        'Task backing outbound row',
        'background',
        'active',
        'turn_001',
        'checkpoint_001',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z'
      );

      INSERT INTO task_runs (
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
      ) VALUES (
        'run_legacy_001',
        'task_legacy_001',
        'workspace_local',
        'session_001',
        'succeeded',
        1,
        'seed:run_legacy_001',
        '{}',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z'
      );

      INSERT INTO outbound_events (
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
      ) VALUES (
        'outbound_legacy_001',
        'workspace_local',
        'session_001',
        'actor_001',
        'task_legacy_001',
        'run_legacy_001',
        '{"accountId":"telegram:bot:endec","conversationId":"dm:chat_42","peerId":"chat_42","peerKind":"dm"}',
        'telegram',
        'final',
        '{"kind":"legacy"}',
        'legacy:outbound:001',
        'pending',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z'
      );

      INSERT INTO outbound_deliveries (
        delivery_id,
        outbound_event_id,
        transport,
        transport_target_json,
        status,
        claim_owner,
        claim_expires_at,
        send_started_at,
        delivered_at,
        delivery_unknown_at,
        transport_message_id,
        error_json,
        attempt_no,
        idempotency_key,
        created_at,
        updated_at
      ) VALUES (
        'delivery_legacy_001',
        'outbound_legacy_001',
        'telegram',
        '{"chatId":"42"}',
        'pending',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        1,
        'legacy:delivery:001',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z'
      );
    `);
    ensureTasksSchema(db);

    const outboundDeliveryForeignKeys = db.prepare("PRAGMA foreign_key_list(outbound_deliveries)").all() as Array<{ from: string; table: string }>;
    expect(outboundDeliveryForeignKeys).toEqual([
      expect.objectContaining({
        from: "outbound_event_id",
        table: "outbound_events"
      })
    ]);

    const deliveryRow = db.prepare(`
      SELECT outbound_event_id, failed_at, transport_receipt_json
      FROM outbound_deliveries
      WHERE delivery_id = ?
    `).get("delivery_legacy_001") as Record<string, unknown>;
    expect(deliveryRow).toEqual({
      outbound_event_id: "outbound_legacy_001",
      failed_at: null,
      transport_receipt_json: null
    });

    expect(() =>
      db.prepare(`
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "delivery_legacy_002",
        "outbound_legacy_001",
        "telegram",
        '{"chatId":"84"}',
        "pending",
        1,
        "legacy:delivery:002",
        "2026-04-25T00:01:00.000Z",
        "2026-04-25T00:01:00.000Z"
      )
    ).not.toThrow();

    db.close();
  });

  it("migrates legacy outbound_events to nullable session ownership without rewriting rows", async () => {
    const filename = join(await mkdtemp(join(tmpdir(), "endec-task-schema-outbound-")), "tasks.sqlite");
    tempFiles.add(filename);

    const db = new Database(filename);
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        last_turn_id TEXT NOT NULL,
        checkpoint_ref TEXT NOT NULL,
        plan_json TEXT,
        current_step TEXT,
        next_action TEXT,
        artifacts_json TEXT,
        blocking_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_id TEXT,
        conversation_ref_json TEXT,
        status TEXT NOT NULL,
        run_kind TEXT NOT NULL DEFAULT 'normal',
        attempt_no INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        turn_request_json TEXT NOT NULL,
        source_turn_id TEXT,
        worker_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        claimed_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        wall_clock_deadline_at TEXT,
        cancel_requested_at TEXT,
        cancel_reason TEXT,
        pending_approval_ref TEXT,
        pending_control_ref TEXT,
        parent_run_id TEXT,
        retry_of_run_id TEXT,
        result_summary TEXT,
        error_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE outbound_events (
        outbound_event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_id TEXT,
        task_id TEXT,
        run_id TEXT,
        conversation_ref_json TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        render_payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id),
        FOREIGN KEY(run_id) REFERENCES task_runs(run_id)
      );

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
        created_at,
        updated_at
      ) VALUES (
        'task_legacy_001',
        'workspace_local',
        'session_001',
        'Legacy task',
        'Task backing outbound row',
        'background',
        'active',
        'turn_001',
        'checkpoint_001',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z'
      );

      INSERT INTO task_runs (
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
      ) VALUES (
        'run_legacy_001',
        'task_legacy_001',
        'workspace_local',
        'session_001',
        'succeeded',
        1,
        'seed:run_legacy_001',
        '{}',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z'
      );

      INSERT INTO outbound_events (
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
      ) VALUES (
        'outbound_legacy_001',
        'workspace_local',
        'session_001',
        'actor_001',
        'task_legacy_001',
        'run_legacy_001',
        '{"accountId":"telegram:bot:endec","conversationId":"dm:chat_42","peerId":"chat_42","peerKind":"dm"}',
        'telegram',
        'final',
        '{"kind":"legacy"}',
        'legacy:outbound:001',
        'pending',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z',
        '2026-04-25T00:00:00.000Z'
      );
    `);
    db.close();

    const store = createTaskStore({ filename });
    await expect(store.loadOutboundEvent("outbound_legacy_001")).resolves.toMatchObject({
      outboundEventId: "outbound_legacy_001",
      sessionId: "session_001",
      eventKind: "final"
    });

    const migratedDb = new Database(filename);
    const outboundColumns = listColumns(migratedDb, "outbound_events");
    expect(outboundColumns.find((column) => column.name === "session_id")?.notnull).toBe(0);
    const legacyRow = migratedDb.prepare(`
      SELECT session_id, event_kind
      FROM outbound_events
      WHERE outbound_event_id = ?
    `).get("outbound_legacy_001") as Record<string, unknown>;
    expect(legacyRow).toEqual({
      session_id: "session_001",
      event_kind: "final"
    });
    migratedDb.close();
  });
});
