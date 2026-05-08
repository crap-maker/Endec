import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureTasksSchema } from "./schema.ts";
import { createTaskRunStore } from "./task-run-store.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "endec-multislice-schema-"));
  tempDirs.add(dir);
  return join(dir, "tasks.sqlite");
}

describe("multi-slice task schema migration", () => {
  it("drops the legacy applied_slice_id foreign key so terminal control markers remain durable", async () => {
    const filename = await tempDb();
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        turn_request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE runtime_slices (
        slice_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        slice_no INTEGER NOT NULL,
        trigger_kind TEXT NOT NULL,
        lane TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE run_control_inputs (
        control_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        control_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        applied_slice_id TEXT,
        applied_at TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id),
        FOREIGN KEY(run_id) REFERENCES task_runs(run_id),
        FOREIGN KEY(applied_slice_id) REFERENCES runtime_slices(slice_id)
      );
    `);
    db.close();

    const migrated = new Database(filename);
    ensureTasksSchema(migrated);
    const foreignKeys = (migrated.prepare("PRAGMA foreign_key_list(run_control_inputs)").all() as Array<{ from: string; table: string }>);
    migrated.close();

    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "task_id", table: "tasks" }),
      expect.objectContaining({ from: "run_id", table: "task_runs" })
    ]));
    expect(foreignKeys.some((foreignKey) => foreignKey.from === "applied_slice_id")).toBe(false);
  });

  it("adds run-centric columns, backfills legacy run deadlines during migration, and creates new persistence tables idempotently", async () => {
    const filename = await tempDb();
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        run_kind TEXT NOT NULL DEFAULT 'normal',
        attempt_no INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        turn_request_json TEXT NOT NULL,
        wall_clock_deadline_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO tasks (
        task_id, workspace_id, session_id, title, description, kind, status, last_turn_id, checkpoint_ref, created_at, updated_at
      ) VALUES (
        'task_legacy_001', 'workspace_local', 'session_001', 'Legacy task', 'still here', 'background', 'active', 'turn_001', 'checkpoint_001',
        '2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z'
      );

      INSERT INTO task_runs (
        run_id, task_id, workspace_id, session_id, status, attempt_no, idempotency_key, turn_request_json, wall_clock_deadline_at, created_at, updated_at
      ) VALUES (
        'run_legacy_001', 'task_legacy_001', 'workspace_local', 'session_001', 'suspended', 1, 'legacy:001', '{}', '2026-04-30T01:30:00.000Z',
        '2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z'
      );
    `);
    db.close();

    const migrate1 = new Database(filename);
    ensureTasksSchema(migrate1);
    migrate1.close();
    const migrate2 = new Database(filename);
    ensureTasksSchema(migrate2);
    migrate2.close();

    const migrated = new Database(filename);
    const taskRunColumns = (migrated.prepare(`PRAGMA table_info(task_runs)`).all() as Array<{ name: string }>).map((column) => column.name);
    expect(taskRunColumns).toEqual(expect.arrayContaining([
      "attention_mode",
      "continuation_kind",
      "continuation_payload_json",
      "continuation_updated_at",
      "cumulative_input_tokens",
      "cumulative_output_tokens",
      "cumulative_total_tokens",
      "cumulative_estimated_cost",
      "autonomy_window_slice_count",
      "autonomy_window_tool_call_count",
      "foreground_burst_slice_count",
      "foreground_burst_started_at",
      "last_human_input_at",
      "run_started_at",
      "run_deadline_at",
      "cancel_requested_by",
      "cancel_observed_slice_id"
    ]));

    const legacyDeadlineRow = migrated.prepare(`
      SELECT run_id as runId, wall_clock_deadline_at as wallClockDeadlineAt, run_deadline_at as runDeadlineAt
      FROM task_runs
      WHERE run_id = ?
    `).get("run_legacy_001") as { runId: string; wallClockDeadlineAt: string | null; runDeadlineAt: string | null };

    const tables = (migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["runtime_slices", "run_control_inputs"]));
    migrated.close();

    expect(legacyDeadlineRow).toEqual({
      runId: "run_legacy_001",
      wallClockDeadlineAt: "2026-04-30T01:30:00.000Z",
      runDeadlineAt: "2026-04-30T01:30:00.000Z"
    });

    const store = createTaskRunStore({ filename });
    await expect(store.loadRunById("run_legacy_001")).resolves.toMatchObject({
      runId: "run_legacy_001",
      status: "blocked",
      runDeadlineAt: "2026-04-30T01:30:00.000Z",
      wallClockDeadlineAt: "2026-04-30T01:30:00.000Z"
    });
  });
});
