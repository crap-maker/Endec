import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskRunStore } from "./task-run-store.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "endec-multislice-runs-"));
  tempDirs.add(dir);
  return join(dir, "tasks.sqlite");
}

const conversationRef = {
  accountId: "telegram_bot",
  conversationId: "chat_100/thread_7",
  peerId: "100",
  peerKind: "group" as const,
  threadId: "7"
};

describe("multi-slice task run store", () => {
  it("creates a run with attention mode and null run_started_at until first execution start", async () => {
    const filename = await tempDb();
    const store = createTaskRunStore({ filename });
    await store.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      conversationRef,
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });

    const run = await store.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      conversationRef,
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:01.000Z"
    });
    const enqueued = await store.enqueueRun({
      runId: "run_002",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      conversationRef,
      idempotencyKey: "enqueue:run_002",
      turnRequest: { turnId: "turn_002", sessionId: "session_001" },
      now: "2026-04-30T00:00:01.500Z"
    });

    expect(run).toMatchObject({
      runId: "run_001",
      status: "queued",
      attentionMode: "foreground_attached",
      cumulativeTotalTokens: 0,
      autonomyWindowSliceCount: 0,
      foregroundBurstSliceCount: 0,
      runStartedAt: undefined
    });
    expect(enqueued).toMatchObject({
      runId: "run_002",
      status: "queued",
      attentionMode: "background_detached",
      runStartedAt: undefined
    });

    const db = new Database(filename);
    const rows = db.prepare("SELECT run_id as runId, run_started_at as runStartedAt FROM task_runs WHERE run_id IN (?, ?) ORDER BY run_id ASC")
      .all("run_001", "run_002") as Array<{ runId: string; runStartedAt: string | null }>;
    db.close();
    expect(rows).toEqual([
      { runId: "run_001", runStartedAt: null },
      { runId: "run_002", runStartedAt: null }
    ]);
  });

  it("seeds an initial queued runtime slice for detached runs at enqueue time", async () => {
    const filename = await tempDb();
    const store = createTaskRunStore({ filename });
    await store.createBackgroundTask({
      taskId: "task_seeded_slice",
      workspaceId: "workspace_local",
      sessionId: "session_seeded_slice",
      actorId: "actor_001",
      conversationRef,
      title: "Seed slice task",
      description: "Detached runs should be born slice-backed",
      sourceTurnId: "turn_seeded_slice",
      now: "2026-05-01T00:00:00.000Z"
    });

    await store.enqueueRun({
      runId: "run_seeded_slice",
      taskId: "task_seeded_slice",
      workspaceId: "workspace_local",
      sessionId: "session_seeded_slice",
      actorId: "actor_001",
      conversationRef,
      idempotencyKey: "enqueue:run_seeded_slice",
      turnRequest: { turnId: "turn_seeded_slice", sessionId: "session_seeded_slice" },
      sourceTurnId: "turn_seeded_slice",
      seedInitialSlice: true,
      now: "2026-05-01T00:00:00.010Z"
    });

    const db = new Database(filename);
    const rows = db.prepare(`
      SELECT
        run_id as runId,
        slice_no as sliceNo,
        trigger_kind as triggerKind,
        lane,
        status
      FROM runtime_slices
      WHERE run_id = ?
      ORDER BY slice_no ASC, created_at ASC, slice_id ASC
    `).all("run_seeded_slice") as Array<{
      runId: string;
      sliceNo: number;
      triggerKind: string;
      lane: string;
      status: string;
    }>;
    db.close();

    expect(rows).toEqual([
      {
        runId: "run_seeded_slice",
        sliceNo: 1,
        triggerKind: "initial",
        lane: "background",
        status: "queued"
      }
    ]);
  });

  it("claims the run once and preserves the first execution start timestamp", async () => {
    const filename = await tempDb();
    const store = createTaskRunStore({ filename });
    await store.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await store.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:01.000Z"
    });

    const claim = await store.claimNextRun({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:02.000Z"
    });
    expect(claim).toMatchObject({
      status: "claimed",
      run: {
        runId: "run_001",
        status: "running",
        runStartedAt: "2026-04-30T00:00:02.000Z"
      }
    });

    const updated = await store.updateRunStatusAndLedger({
      runId: "run_001",
      status: "running",
      ledger: {
        cumulativeInputTokens: 120,
        cumulativeOutputTokens: 30,
        cumulativeTotalTokens: 150,
        cumulativeEstimatedCost: 0.42,
        autonomyWindowSliceCount: 2,
        autonomyWindowToolCallCount: 5,
        foregroundBurstSliceCount: 2,
        foregroundBurstStartedAt: "2026-04-30T00:00:02.000Z",
        lastHumanInputAt: "2026-04-30T00:00:00.000Z",
        runStartedAt: "2026-04-30T00:00:05.000Z",
        runDeadlineAt: "2026-04-30T01:00:00.000Z"
      },
      now: "2026-04-30T00:00:06.000Z"
    });

    expect(updated).toMatchObject({
      status: "running",
      runStartedAt: "2026-04-30T00:00:02.000Z",
      continuationKind: undefined,
      cumulativeTotalTokens: 150,
      autonomyWindowToolCallCount: 5,
      runDeadlineAt: "2026-04-30T01:00:00.000Z"
    });
  });

  it("keeps canonical runDeadlineAt opt-in for new rows while preserving legacy migration compatibility", async () => {
    const filename = await tempDb();
    const store = createTaskRunStore({ filename });
    await store.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });

    const enqueued = await store.enqueueRun({
      runId: "run_legacy_deadline",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      conversationRef,
      idempotencyKey: "enqueue:run_legacy_deadline",
      turnRequest: { turnId: "turn_002", sessionId: "session_001" },
      wallClockDeadlineAt: "2026-04-30T00:45:00.000Z",
      now: "2026-04-30T00:00:01.500Z"
    });
    const canonical = await store.createRun({
      runId: "run_canonical_deadline",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      conversationRef,
      attentionMode: "foreground_attached",
      runDeadlineAt: "2026-04-30T01:00:00.000Z",
      now: "2026-04-30T00:00:02.000Z"
    });

    expect(enqueued).toMatchObject({
      runId: "run_legacy_deadline",
      runDeadlineAt: undefined,
      wallClockDeadlineAt: "2026-04-30T00:45:00.000Z"
    });
    expect(canonical).toMatchObject({
      runId: "run_canonical_deadline",
      runDeadlineAt: "2026-04-30T01:00:00.000Z"
    });

    const db = new Database(filename);
    const rows = db.prepare(`
      SELECT
        run_id as runId,
        wall_clock_deadline_at as wallClockDeadlineAt,
        run_deadline_at as runDeadlineAt
      FROM task_runs
      WHERE run_id IN (?, ?)
      ORDER BY run_id ASC
    `).all("run_canonical_deadline", "run_legacy_deadline") as Array<{
      runId: string;
      wallClockDeadlineAt: string | null;
      runDeadlineAt: string | null;
    }>;
    db.close();

    expect(rows).toEqual([
      {
        runId: "run_canonical_deadline",
        wallClockDeadlineAt: null,
        runDeadlineAt: "2026-04-30T01:00:00.000Z"
      },
      {
        runId: "run_legacy_deadline",
        wallClockDeadlineAt: "2026-04-30T00:45:00.000Z",
        runDeadlineAt: null
      }
    ]);
  });

  it("updates run status and budget ledger without touching continuation truth", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await store.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await store.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:01.000Z"
    });
    await store.attachContinuation({
      runId: "run_001",
      kind: "auto_continue",
      payload: { checkpointRef: "checkpoint:001" },
      now: "2026-04-30T00:00:02.000Z"
    });

    const updated = await store.updateRunStatusAndLedger({
      runId: "run_001",
      status: "running",
      ledger: {
        cumulativeInputTokens: 120,
        cumulativeOutputTokens: 30,
        cumulativeTotalTokens: 150,
        cumulativeEstimatedCost: 0.42,
        autonomyWindowSliceCount: 2,
        autonomyWindowToolCallCount: 5,
        foregroundBurstSliceCount: 2,
        foregroundBurstStartedAt: "2026-04-30T00:00:01.000Z",
        lastHumanInputAt: "2026-04-30T00:00:00.000Z",
        runStartedAt: "2026-04-30T00:00:01.000Z",
        runDeadlineAt: "2026-04-30T01:00:00.000Z"
      },
      now: "2026-04-30T00:00:03.000Z"
    });

    expect(updated).toMatchObject({
      status: "running",
      continuationKind: "auto_continue",
      cumulativeTotalTokens: 150,
      autonomyWindowToolCallCount: 5,
      runDeadlineAt: "2026-04-30T01:00:00.000Z"
    });
  });

  it("updates attention mode, attaches then clears continuation, and latches cooperative cancel", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await store.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Investigate failures",
      description: "Find why CI failed",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await store.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:01.000Z"
    });

    await expect(store.updateRunAttentionMode({
      runId: "run_001",
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:02.000Z"
    })).resolves.toMatchObject({ attentionMode: "background_detached" });

    await expect(store.attachContinuation({
      runId: "run_001",
      kind: "approval_resume",
      payload: { pendingApprovalRef: "approval_001" },
      now: "2026-04-30T00:00:03.000Z"
    })).resolves.toMatchObject({ continuationKind: "approval_resume" });

    await expect(store.latchRunCancel({
      runId: "run_001",
      cancelRequestedAt: "2026-04-30T00:00:04.000Z",
      cancelRequestedBy: "operator_alpha",
      cancelReason: "stop now",
      cancelObservedSliceId: "slice_009"
    })).resolves.toMatchObject({
      cancelRequestedAt: "2026-04-30T00:00:04.000Z",
      cancelRequestedBy: "operator_alpha",
      cancelReason: "stop now",
      cancelObservedSliceId: "slice_009"
    });

    await expect(store.clearContinuation({
      runId: "run_001",
      now: "2026-04-30T00:00:05.000Z"
    })).resolves.toMatchObject({
      continuationKind: undefined,
      continuationPayload: undefined
    });
  });
});
