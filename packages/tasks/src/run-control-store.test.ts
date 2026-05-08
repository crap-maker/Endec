import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskRunStore } from "./task-run-store.ts";
import { createRuntimeSliceStore } from "./runtime-slice-store.ts";
import { createRunControlStore } from "./run-control-store.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "endec-run-controls-"));
  tempDirs.add(dir);
  return join(dir, "tasks.sqlite");
}

describe("run control store", () => {
  it("orders queued controls by control_seq and appends idempotently", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRunControlStore({ filename });
    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:00.500Z"
    });

    const first = await store.appendControlInput({
      controlId: "control_001",
      taskId: "task_001",
      runId: "run_001",
      kind: "steer",
      payload: { text: "focus on tests" },
      createdAt: "2026-04-30T00:00:00.000Z"
    });
    const duplicate = await store.appendControlInput({
      controlId: "control_001",
      taskId: "task_001",
      runId: "run_001",
      kind: "steer",
      payload: { text: "ignored duplicate" },
      createdAt: "2026-04-30T00:00:01.000Z"
    });
    const second = await store.appendControlInput({
      controlId: "control_002",
      taskId: "task_001",
      runId: "run_001",
      kind: "continue",
      createdAt: "2026-04-30T00:00:02.000Z"
    });

    expect(duplicate.controlSeq).toBe(first.controlSeq);
    expect(second.controlSeq).toBeGreaterThan(first.controlSeq);
    await expect(store.listPendingControls("run_001")).resolves.toMatchObject([
      { controlId: "control_001", controlSeq: first.controlSeq, kind: "steer" },
      { controlId: "control_002", controlSeq: second.controlSeq, kind: "continue" }
    ]);
  });

  it("preserves consumed cancel controls as durable history when the run reaches a terminal state", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRunControlStore({ filename });
    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:00.500Z"
    });
    await runStore.claimNextRun({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.750Z"
    });
    await runStore.requestRunCancellation({
      runId: "run_001",
      reason: "operator stop",
      now: "2026-04-30T00:00:01.000Z"
    });

    await expect(store.listPendingControls("run_001")).resolves.toMatchObject([
      { kind: "cancel", appliedSliceId: undefined, appliedAt: undefined }
    ]);

    await runStore.completeRun({
      runId: "run_001",
      resultSummary: "done anyway",
      now: "2026-04-30T00:00:02.000Z"
    });

    await expect(store.listPendingControls("run_001")).resolves.toEqual([]);

    const db = new Database(filename);
    const controls = db.prepare(`
      SELECT kind, payload_json as payloadJson, applied_slice_id as appliedSliceId, applied_at as appliedAt
      FROM run_control_inputs
      WHERE run_id = ?
      ORDER BY control_seq ASC
    `).all("run_001") as Array<{
      kind: string;
      payloadJson: string | null;
      appliedSliceId: string | null;
      appliedAt: string | null;
    }>;
    db.close();

    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      kind: "cancel",
      appliedSliceId: "terminal:run_001:completed",
      appliedAt: "2026-04-30T00:00:02.000Z"
    });
    expect(JSON.parse(controls[0]!.payloadJson ?? "null")).toEqual({ reason: "operator stop" });
  });

  it("preserves consumed cancel controls when a running lease expires", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:00.500Z"
    });
    await runStore.claimNextRun({
      workerId: "worker_001",
      leaseDurationMs: 1_000,
      now: "2026-04-30T00:00:01.000Z"
    });
    await runStore.requestRunCancellation({
      runId: "run_001",
      reason: "operator stop",
      now: "2026-04-30T00:00:01.100Z"
    });

    const result = await runStore.markLeaseExpired({
      runId: "run_001",
      now: "2026-04-30T00:00:03.000Z"
    });
    expect(result.expired).toMatchObject({ status: "failed" });

    const db = new Database(filename);
    const controls = db.prepare(`
      SELECT applied_slice_id as appliedSliceId, applied_at as appliedAt
      FROM run_control_inputs
      WHERE run_id = ? AND kind = 'cancel'
    `).all("run_001") as Array<{ appliedSliceId: string | null; appliedAt: string | null }>;
    db.close();

    expect(controls).toEqual([
      {
        appliedSliceId: "terminal:run_001:failed",
        appliedAt: "2026-04-30T00:00:03.000Z"
      }
    ]);
  });

  it("rejects control inserts when the run belongs to another task", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRunControlStore({ filename });
    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createBackgroundTask({
      taskId: "task_002",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Another task",
      description: "Used to prove ownership checks",
      sourceTurnId: "turn_002",
      now: "2026-04-30T00:00:00.100Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:00.500Z"
    });

    await expect(store.appendControlInput({
      controlId: "control_wrong_task",
      taskId: "task_002",
      runId: "run_001",
      kind: "steer",
      payload: { text: "wrong task" },
      createdAt: "2026-04-30T00:00:00.750Z"
    })).rejects.toThrow(/belongs to task/i);

    const db = new Database(filename);
    expect(() => db.prepare(`
      INSERT INTO run_control_inputs (
        control_id,
        task_id,
        run_id,
        kind,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "control_wrong_task_raw",
      "task_002",
      "run_001",
      "steer",
      JSON.stringify({ text: "wrong task" }),
      "2026-04-30T00:00:00.800Z"
    )).toThrow(/run_control_inputs\.task_id must match task_runs\.task_id/i);
    db.close();
  });

  it("rejects control inserts for missing parent run once foreign keys are enabled", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRunControlStore({ filename });
    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });

    await expect(store.appendControlInput({
      controlId: "control_missing_run",
      taskId: "task_001",
      runId: "run_missing",
      kind: "steer",
      payload: { text: "focus" },
      createdAt: "2026-04-30T00:00:01.000Z"
    })).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("marks pending controls applied to the consuming slice", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const sliceStore = createRuntimeSliceStore({ filename });
    const store = createRunControlStore({ filename });
    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:00.500Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_002",
      runId: "run_001",
      taskId: "task_001",
      lane: "foreground",
      now: "2026-04-30T00:00:00.750Z"
    });
    const first = await store.appendControlInput({
      controlId: "control_001",
      taskId: "task_001",
      runId: "run_001",
      kind: "follow_up",
      createdAt: "2026-04-30T00:00:00.000Z"
    });
    await store.appendControlInput({
      controlId: "control_002",
      taskId: "task_001",
      runId: "run_001",
      kind: "cancel",
      createdAt: "2026-04-30T00:00:01.000Z"
    });

    await expect(store.markControlsApplied({
      runId: "run_001",
      throughControlSeq: first.controlSeq,
      appliedSliceId: "slice_002",
      appliedAt: "2026-04-30T00:00:05.000Z"
    })).resolves.toEqual(1);

    await expect(store.listPendingControls("run_001")).resolves.toMatchObject([
      { controlId: "control_002", kind: "cancel" }
    ]);
  });
});
