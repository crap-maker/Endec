import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  TaskEventSchema,
  TaskEventSeveritySchema,
  TaskEventTypeSchema,
  type TaskEvent,
  type TaskEventSeverity,
  type TaskEventType
} from "@endec/domain";
import { ensureTasksSchema } from "./schema.ts";
import { openSqliteDatabase } from "./sqlite.ts";

type TaskEventRow = {
  eventId: string;
  taskId: string;
  runId: string | null;
  workspaceId: string;
  seq: number;
  eventType: string;
  severity: string;
  message: string;
  dataJson: string | null;
  idempotencyKey: string | null;
  createdAt: string;
};

export type AppendTaskEventInput = {
  taskId: string;
  runId?: string;
  workspaceId: string;
  eventType: TaskEventType;
  severity: TaskEventSeverity;
  message: string;
  data?: unknown;
  idempotencyKey?: string;
  now?: Date;
};

function parseEvent(row: TaskEventRow): TaskEvent {
  return TaskEventSchema.parse({
    eventId: row.eventId,
    taskId: row.taskId,
    runId: row.runId ?? undefined,
    workspaceId: row.workspaceId,
    seq: row.seq,
    eventType: row.eventType,
    severity: row.severity,
    message: row.message,
    data: row.dataJson === null ? undefined : JSON.parse(row.dataJson),
    idempotencyKey: row.idempotencyKey ?? undefined,
    createdAt: row.createdAt
  });
}

export function createTaskEventStore({ filename }: { filename: string }) {
  const db = openSqliteDatabase(filename);
  ensureTasksSchema(db);

  const selectColumns = `
    event_id as eventId,
    task_id as taskId,
    run_id as runId,
    workspace_id as workspaceId,
    seq,
    event_type as eventType,
    severity,
    message,
    data_json as dataJson,
    idempotency_key as idempotencyKey,
    created_at as createdAt
  `;

  const loadByIdempotencyKeyStmt = db.prepare(`
    SELECT ${selectColumns}
    FROM task_events
    WHERE task_id = ? AND idempotency_key = ?
  `);

  const loadByEventIdStmt = db.prepare(`
    SELECT ${selectColumns}
    FROM task_events
    WHERE event_id = ?
  `);

  const nextSeqStmt = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 as seq
    FROM task_events
    WHERE task_id = ?
  `);

  const insertEventStmt = db.prepare(`
    INSERT INTO task_events (
      event_id,
      task_id,
      run_id,
      workspace_id,
      seq,
      event_type,
      severity,
      message,
      data_json,
      idempotency_key,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const appendTransaction = db.transaction((input: AppendTaskEventInput) => {
    TaskEventTypeSchema.parse(input.eventType);
    TaskEventSeveritySchema.parse(input.severity);

    if (input.idempotencyKey) {
      const existing = loadByIdempotencyKeyStmt.get(input.taskId, input.idempotencyKey) as TaskEventRow | undefined;
      if (existing) {
        return parseEvent(existing);
      }
    }

    const eventId = randomUUID();
    const createdAt = (input.now ?? new Date()).toISOString();
    const { seq } = nextSeqStmt.get(input.taskId) as { seq: number };
    const dataJson = input.data === undefined ? null : JSON.stringify(input.data);

    insertEventStmt.run(
      eventId,
      input.taskId,
      input.runId ?? null,
      input.workspaceId,
      seq,
      input.eventType,
      input.severity,
      input.message,
      dataJson,
      input.idempotencyKey ?? null,
      createdAt
    );

    const row = loadByEventIdStmt.get(eventId) as TaskEventRow | undefined;
    if (!row) {
      throw new Error(`failed to load task event ${eventId}`);
    }
    return parseEvent(row);
  });

  async function appendTaskEvent(input: AppendTaskEventInput) {
    return appendTransaction(input);
  }

  async function listEventsByTask({ taskId }: { taskId: string }) {
    const rows = db.prepare(`
      SELECT ${selectColumns}
      FROM task_events
      WHERE task_id = ?
      ORDER BY seq ASC, event_id ASC
    `).all(taskId) as TaskEventRow[];
    return rows.map(parseEvent);
  }

  async function listEventsByRun({ runId }: { runId: string }) {
    const rows = db.prepare(`
      SELECT ${selectColumns}
      FROM task_events
      WHERE run_id = ?
      ORDER BY seq ASC, event_id ASC
    `).all(runId) as TaskEventRow[];
    return rows.map(parseEvent);
  }

  return {
    appendTaskEvent,
    listEventsByTask,
    listEventsByRun
  };
}
