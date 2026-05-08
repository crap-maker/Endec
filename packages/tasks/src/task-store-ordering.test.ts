import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapSql } from "./schema.ts";
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

describe("TaskStore active ordering", () => {
  it("orders active tasks by updated_at DESC, then task_id DESC", async () => {
    const filename = join(await mkdtemp(join(tmpdir(), "endec-task-store-")), "tasks.sqlite");
    tempFiles.add(filename);

    const db = new Database(filename);
    db.exec(bootstrapSql);
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
    `).run("task_a", "workspace_local", "session_001", "Task A", "same timestamp", "act", "active", "turn_a", "checkpoint_a", "2026-04-11T08:00:00.000Z", "2026-04-11T09:00:00.000Z");
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
    `).run("task_b", "workspace_local", "session_001", "Task B", "same timestamp but higher id", "act", "active", "turn_b", "checkpoint_b", "2026-04-11T08:05:00.000Z", "2026-04-11T09:00:00.000Z");
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
    `).run("task_c", "workspace_local", "session_001", "Task C", "newest timestamp", "act", "active", "turn_c", "checkpoint_c", "2026-04-11T08:10:00.000Z", "2026-04-11T09:05:00.000Z");
    db.close();

    const store = createTaskStore({ filename });
    const tasks = await store.listActiveBySession("session_001");

    expect(tasks.map((task) => task.taskId)).toEqual(["task_c", "task_b", "task_a"]);
  });
});
