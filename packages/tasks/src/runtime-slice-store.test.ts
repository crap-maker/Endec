import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskRunStore } from "./task-run-store.ts";
import { createRuntimeSliceStore } from "./runtime-slice-store.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "endec-runtime-slices-"));
  tempDirs.add(dir);
  return join(dir, "tasks.sqlite");
}

describe("runtime slice store", () => {
  it("enforces one runnable head per run and lane-aware claiming", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRuntimeSliceStore({ filename });
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

    const initial = await store.enqueueInitialSlice({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      lane: "foreground",
      budgetSnapshot: { maxToolCallsPerSlice: 8 },
      now: "2026-04-30T00:00:00.000Z"
    });

    expect(initial).toMatchObject({ sliceNo: 1, triggerKind: "initial", status: "queued" });
    await expect(store.enqueueNextSlice({
      sliceId: "slice_002",
      runId: "run_001",
      taskId: "task_001",
      triggerKind: "auto_continue",
      lane: "foreground",
      now: "2026-04-30T00:00:01.000Z"
    })).rejects.toThrow(/open slice/i);

    await expect(store.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "background",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:02.000Z"
    })).resolves.toEqual({ status: "none" });

    await expect(store.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "foreground",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:02.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      slice: {
        sliceId: "slice_001",
        status: "running",
        lane: "foreground"
      }
    });
  });

  it("finalizes slices, allocates next slice numbers, and recovers expired leases", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRuntimeSliceStore({ filename });
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
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:00.500Z"
    });
    await store.enqueueInitialSlice({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      lane: "background",
      now: "2026-04-30T00:00:00.000Z"
    });
    await store.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "background",
      leaseDurationMs: 1_000,
      now: "2026-04-30T00:00:01.000Z"
    });

    await expect(store.finalizeSlice({
      sliceId: "slice_001",
      status: "yielded",
      continuationPayload: { checkpointRef: "checkpoint:001" },
      usageSummary: {
        inputTokens: 6,
        outputTokens: 4,
        totalTokens: 10,
        estimatedCost: 0.05
      },
      finishedAt: "2026-04-30T00:00:02.000Z"
    })).resolves.toMatchObject({ status: "yielded" });

    await expect(store.enqueueNextSlice({
      sliceId: "slice_002",
      runId: "run_001",
      taskId: "task_001",
      triggerKind: "auto_continue",
      lane: "background",
      now: "2026-04-30T00:00:03.000Z"
    })).resolves.toMatchObject({ sliceNo: 2, triggerKind: "auto_continue" });

    await store.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "background",
      leaseDurationMs: 1_000,
      now: "2026-04-30T00:00:04.000Z"
    });
    await expect(store.recoverExpiredSlice({
      sliceId: "slice_002",
      now: "2026-04-30T00:00:06.000Z"
    })).resolves.toMatchObject({ status: "lease_expired" });

    await expect(store.listSlicesByRun("run_001")).resolves.toMatchObject([
      { sliceId: "slice_001", sliceNo: 1, status: "yielded" },
      { sliceId: "slice_002", sliceNo: 2, status: "lease_expired" }
    ]);
  });

  it("rejects slice inserts when the run belongs to another task and leaves queued siblings blocked behind a running slice", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRuntimeSliceStore({ filename });
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
      title: "Second task",
      description: "Used to prove ownership checks",
      sourceTurnId: "turn_002",
      now: "2026-04-30T00:00:00.100Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:00.500Z"
    });

    await expect(store.enqueueInitialSlice({
      sliceId: "slice_wrong_task",
      runId: "run_001",
      taskId: "task_002",
      lane: "background",
      now: "2026-04-30T00:00:00.750Z"
    })).rejects.toThrow(/belongs to task/i);

    const db = new Database(filename);
    expect(() => db.prepare(`
      INSERT INTO runtime_slices (
        slice_id,
        run_id,
        task_id,
        slice_no,
        trigger_kind,
        lane,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      "slice_wrong_task_raw",
      "run_001",
      "task_002",
      1,
      "initial",
      "background",
      "2026-04-30T00:00:00.800Z",
      "2026-04-30T00:00:00.800Z"
    )).toThrow(/runtime_slices\.task_id must match task_runs\.task_id/i);
    db.close();

    await store.enqueueInitialSlice({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      lane: "background",
      now: "2026-04-30T00:00:01.000Z"
    });
    await store.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "background",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:02.000Z"
    });

    const queuedSiblingDb = new Database(filename);
    queuedSiblingDb.prepare(`
      INSERT INTO runtime_slices (
        slice_id,
        run_id,
        task_id,
        slice_no,
        trigger_kind,
        lane,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      "slice_002",
      "run_001",
      "task_001",
      2,
      "auto_continue",
      "background",
      "2026-04-30T00:00:03.000Z",
      "2026-04-30T00:00:03.000Z"
    );
    queuedSiblingDb.close();

    await expect(store.claimNextRunnableSlice({
      workerId: "worker_002",
      lane: "background",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:04.000Z"
    })).resolves.toEqual({ status: "none" });

    await expect(store.listSlicesByRun("run_001")).resolves.toMatchObject([
      { sliceId: "slice_001", status: "running" },
      { sliceId: "slice_002", status: "queued" }
    ]);
  });

  it("loads the latest durable slice truth for status building", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRuntimeSliceStore({ filename });
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
    await store.enqueueInitialSlice({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      lane: "foreground",
      now: "2026-04-30T00:00:00.750Z"
    });
    await store.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "foreground",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.000Z"
    });
    await store.finalizeSlice({
      sliceId: "slice_001",
      status: "yielded",
      usageSummary: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        estimatedCost: 0.02
      },
      continuationPayload: { checkpointRef: "checkpoint:001" },
      finishedAt: "2026-04-30T00:00:02.000Z"
    });
    await store.enqueueNextSlice({
      sliceId: "slice_002",
      runId: "run_001",
      taskId: "task_001",
      triggerKind: "auto_continue",
      lane: "foreground",
      now: "2026-04-30T00:00:03.000Z"
    });

    await expect(store.loadLatestSliceByRun("run_001")).resolves.toMatchObject({
      sliceId: "slice_002",
      sliceNo: 2,
      triggerKind: "auto_continue",
      status: "queued"
    });
  });

  it("rejects slice inserts for missing parent run once foreign keys are enabled", async () => {
    const filename = await tempDb();
    const runStore = createTaskRunStore({ filename });
    const store = createRuntimeSliceStore({ filename });
    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });

    await expect(store.enqueueInitialSlice({
      sliceId: "slice_missing_run",
      runId: "run_missing",
      taskId: "task_001",
      lane: "background",
      now: "2026-04-30T00:00:00.500Z"
    })).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });
});
