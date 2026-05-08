import Database from "better-sqlite3";
import type { RunControlInput, RunControlKind } from "@endec/domain";
import { RunControlInputSchema } from "@endec/domain";
import { ensureTasksSchema } from "./schema.ts";
import { openSqliteDatabase } from "./sqlite.ts";

type RunControlRow = {
  controlSeq: number;
  controlId: string;
  taskId: string;
  runId: string;
  kind: RunControlKind;
  payloadJson: string | null;
  createdAt: string;
  appliedSliceId: string | null;
  appliedAt: string | null;
};

const controlSelect = `
  SELECT
    control_seq as controlSeq,
    control_id as controlId,
    task_id as taskId,
    run_id as runId,
    kind,
    payload_json as payloadJson,
    created_at as createdAt,
    applied_slice_id as appliedSliceId,
    applied_at as appliedAt
  FROM run_control_inputs
`;

function maybeJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function maybeParseJson(value: string | null) {
  return value ? JSON.parse(value) : undefined;
}

function parseControl(row: RunControlRow): RunControlInput {
  return RunControlInputSchema.parse({
    controlSeq: row.controlSeq,
    controlId: row.controlId,
    taskId: row.taskId,
    runId: row.runId,
    kind: row.kind,
    payload: maybeParseJson(row.payloadJson),
    createdAt: row.createdAt,
    appliedSliceId: row.appliedSliceId ?? undefined,
    appliedAt: row.appliedAt ?? undefined
  });
}

function loadRunOwnership(db: Database.Database, runId: string) {
  return db.prepare(`
    SELECT task_id as taskId
    FROM task_runs
    WHERE run_id = ?
  `).get(runId) as { taskId: string } | undefined;
}

export function createRunControlStore({ filename }: { filename: string }) {
  const db = openSqliteDatabase(filename);
  ensureTasksSchema(db);

  const appendTransaction = db.transaction((input: {
    controlId: string;
    taskId: string;
    runId: string;
    kind: RunControlKind;
    payload?: unknown;
    createdAt?: string;
  }) => {
    const existing = db.prepare(`${controlSelect} WHERE control_id = ?`).get(input.controlId) as RunControlRow | undefined;
    if (existing) return parseControl(existing);

    const owner = loadRunOwnership(db, input.runId);
    if (owner && owner.taskId !== input.taskId) {
      throw new Error(`run ${input.runId} belongs to task ${owner.taskId}, not ${input.taskId}`);
    }

    const createdAt = input.createdAt ?? new Date().toISOString();
    db.prepare(`
      INSERT INTO run_control_inputs (
        control_id,
        task_id,
        run_id,
        kind,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.controlId, input.taskId, input.runId, input.kind, maybeJson(input.payload), createdAt);

    const row = db.prepare(`${controlSelect} WHERE control_id = ?`).get(input.controlId) as RunControlRow;
    return parseControl(row);
  });

  async function appendControlInput(input: {
    controlId: string;
    taskId: string;
    runId: string;
    kind: RunControlKind;
    payload?: unknown;
    createdAt?: string;
  }) {
    return appendTransaction(input);
  }

  async function listPendingControls(runId: string) {
    const rows = db.prepare(`
      ${controlSelect}
      WHERE run_id = ? AND applied_slice_id IS NULL
      ORDER BY control_seq ASC
    `).all(runId) as RunControlRow[];
    return rows.map(parseControl);
  }

  async function markControlsApplied(input: {
    runId: string;
    throughControlSeq: number;
    appliedSliceId: string;
    appliedAt?: string;
  }) {
    const appliedAt = input.appliedAt ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE run_control_inputs
      SET applied_slice_id = ?, applied_at = ?
      WHERE run_id = ? AND applied_slice_id IS NULL AND control_seq <= ?
    `).run(input.appliedSliceId, appliedAt, input.runId, input.throughControlSeq);
    return result.changes;
  }

  return {
    appendControlInput,
    listPendingControls,
    markControlsApplied
  };
}
