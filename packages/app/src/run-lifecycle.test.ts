import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "@endec/sessions";
import { createRunControlStore, createRuntimeSliceStore, createTaskRunStore, createTaskStore } from "@endec/tasks";
import { createRunLifecycle } from "./run-lifecycle.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function tempDbPaths() {
  const dir = await mkdtemp(join(tmpdir(), "endec-run-lifecycle-"));
  tempDirs.add(dir);
  return {
    tasks: join(dir, "tasks.sqlite"),
    sessions: join(dir, "sessions.sqlite")
  };
}

async function seedClaimedSliceFixture(input: {
  paths: Awaited<ReturnType<typeof tempDbPaths>>;
  taskId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  triggerKind: "legacy_cutover" | "auto_continue" | "user_resume" | "approval_resume" | "operator_resume" | "recovery_retry";
  runContinuationKind?: "auto_continue" | "user_resume" | "approval_resume" | "operator_resume" | "recovery_retry";
  runContinuationPayload?: unknown;
  sliceContinuationPayload?: unknown;
}) {
  const runStore = createTaskRunStore({ filename: input.paths.tasks });
  const sliceStore = createRuntimeSliceStore({ filename: input.paths.tasks });
  const controlStore = createRunControlStore({ filename: input.paths.tasks });
  const sessionStore = createSessionStore({ filename: input.paths.sessions });

  await runStore.createBackgroundTask({
    taskId: input.taskId,
    workspaceId: "workspace_local",
    sessionId: input.sessionId,
    actorId: "actor_001",
    title: `Task ${input.taskId}`,
    description: `Fixture for ${input.triggerKind}`,
    sourceTurnId: input.turnId,
    now: "2026-04-30T00:00:00.000Z"
  });
  await runStore.enqueueRun({
    runId: input.runId,
    taskId: input.taskId,
    workspaceId: "workspace_local",
    sessionId: input.sessionId,
    actorId: "actor_001",
    idempotencyKey: `seed:${input.runId}`,
    turnRequest: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: "workspace_local",
      actorId: "actor_001",
      source: "cli",
      input: `continue ${input.triggerKind}`,
      requestedMode: "act",
      originTurnId: input.turnId
    },
    sourceTurnId: input.turnId,
    maxAttempts: 1,
    now: "2026-04-30T00:00:00.010Z"
  });

  if (input.runContinuationKind || input.runContinuationPayload !== undefined) {
    const db = new Database(input.paths.tasks);
    db.prepare(`
      UPDATE task_runs
      SET continuation_kind = ?,
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      input.runContinuationKind ?? null,
      input.runContinuationPayload === undefined ? null : JSON.stringify(input.runContinuationPayload),
      "2026-04-30T00:00:00.020Z",
      "2026-04-30T00:00:00.020Z",
      input.runId
    );
    db.close();
  }

  const sliceId = `slice_${input.runId}_001`;
  await sliceStore.enqueueNextSlice({
    sliceId,
    runId: input.runId,
    taskId: input.taskId,
    triggerKind: input.triggerKind,
    lane: "background",
    now: "2026-04-30T00:00:00.030Z"
  });

  if (input.sliceContinuationPayload !== undefined) {
    const db = new Database(input.paths.tasks);
    db.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify(input.sliceContinuationPayload),
      "2026-04-30T00:00:00.031Z",
      sliceId
    );
    db.close();
  }

  const run = await runStore.loadRunById(input.runId);
  const [slice] = await sliceStore.listSlicesByRun(input.runId);
  if (!run || !slice) {
    throw new Error(`failed to seed claimed slice fixture for ${input.runId}`);
  }

  return {
    runStore,
    sliceStore,
    controlStore,
    sessionStore,
    run,
    slice
  };
}

describe("run lifecycle", () => {
  it("eagerly migrates legacy queued runs during lifecycle bootstrap before any claim path runs", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await runStore.createBackgroundTask({
      taskId: "task_bootstrap_cutover",
      workspaceId: "workspace_local",
      sessionId: "session_bootstrap_cutover",
      title: "Bootstrap cutover task",
      description: "queued legacy run should cut over before claims",
      sourceTurnId: "turn_bootstrap_cutover",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_bootstrap_cutover",
      taskId: "task_bootstrap_cutover",
      workspaceId: "workspace_local",
      sessionId: "session_bootstrap_cutover",
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:00.010Z"
    });

    createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(sliceStore.listSlicesByRun("run_bootstrap_cutover")).resolves.toMatchObject([
      {
        sliceNo: 1,
        triggerKind: "legacy_cutover",
        lane: "background",
        status: "queued"
      }
    ]);
    await expect(runStore.loadRunById("run_bootstrap_cutover")).resolves.toMatchObject({
      status: "queued"
    });
  });

  it("migrates legacy queued/running runs into slices, leaves blocked runs gated, and skips already migrated runs", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await runStore.createBackgroundTask({
      taskId: "task_blocked",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Blocked task",
      description: "legacy blocked run",
      sourceTurnId: "turn_blocked",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_blocked",
      taskId: "task_blocked",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:00.300Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.500Z"
    });
    await runStore.suspendRun({
      runId: "run_blocked",
      pendingApprovalRef: "approval_001",
      pendingControlRef: "frame:blocked_001",
      blockedBy: "permission",
      resultSummary: "approval required",
      now: "2026-04-30T00:00:02.000Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_running",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Running task",
      description: "legacy running run",
      sourceTurnId: "turn_running",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_running",
      taskId: "task_running",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:00.200Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.000Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_queued",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Queued task",
      description: "legacy queued run",
      sourceTurnId: "turn_queued",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_queued",
      taskId: "task_queued",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:00.100Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_canceled",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Canceled task",
      description: "legacy canceled latch run",
      sourceTurnId: "turn_canceled",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_canceled",
      taskId: "task_canceled",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "background_detached",
      now: "2026-04-30T00:00:00.400Z"
    });
    await runStore.requestRunCancellation({
      runId: "run_canceled",
      actorId: "operator_001",
      reason: "stop immediately",
      now: "2026-04-30T00:00:00.500Z"
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await lifecycle.migrateLegacyRunsToSlices();
    await lifecycle.migrateLegacyRunsToSlices();

    await expect(sliceStore.listSlicesByRun("run_queued")).resolves.toMatchObject([
      {
        sliceNo: 1,
        triggerKind: "legacy_cutover",
        lane: "background",
        status: "queued"
      }
    ]);

    await expect(sliceStore.listSlicesByRun("run_running")).resolves.toMatchObject([
      {
        sliceNo: 1,
        triggerKind: "recovery_retry",
        lane: "background",
        status: "queued"
      }
    ]);
    await expect(runStore.loadRunById("run_running")).resolves.toMatchObject({
      status: "queued",
      leaseOwner: undefined,
      continuationKind: "recovery_retry"
    });

    await expect(sliceStore.listSlicesByRun("run_blocked")).resolves.toEqual([]);
    await expect(runStore.loadRunById("run_blocked")).resolves.toMatchObject({
      status: "blocked",
      continuationKind: "approval_resume",
      pendingApprovalRef: "approval_001",
      pendingControlRef: "frame:blocked_001"
    });

    await expect(sliceStore.listSlicesByRun("run_canceled")).resolves.toEqual([]);
    await expect(runStore.loadRunById("run_canceled")).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "stop immediately"
    });
  });

  it("routes recovery-retry slices through the continuation executor when durable continuation truth exists", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await runStore.createBackgroundTask({
      taskId: "task_recovery_retry",
      workspaceId: "workspace_local",
      sessionId: "session_recovery_retry",
      actorId: "actor_001",
      title: "Recovery retry task",
      description: "resume a recoverable continuation",
      sourceTurnId: "turn_recovery_retry_origin",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_recovery_retry",
      taskId: "task_recovery_retry",
      workspaceId: "workspace_local",
      sessionId: "session_recovery_retry",
      actorId: "actor_001",
      idempotencyKey: "seed:recovery-retry",
      turnRequest: {
        turnId: "turn_recovery_retry_origin",
        sessionId: "session_recovery_retry",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "continue the interrupted work",
        requestedMode: "act",
        originTurnId: "turn_recovery_retry_origin"
      },
      sourceTurnId: "turn_recovery_retry_origin",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });

    const setupDb = new Database(paths.tasks);
    setupDb.prepare(`
      UPDATE task_runs
      SET continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_control_ref = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify({
        checkpointRef: "checkpoint:recovery_retry",
        recovery: {
          checkpointRef: "checkpoint:recovery_retry"
        }
      }),
      "2026-04-30T00:00:00.020Z",
      "frame:recovery_retry",
      "2026-04-30T00:00:00.020Z",
      "run_recovery_retry"
    );
    setupDb.close();

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_recovery_retry_001",
      runId: "run_recovery_retry",
      taskId: "task_recovery_retry",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-30T00:00:00.030Z"
    });
    const slicePayloadDb = new Database(paths.tasks);
    slicePayloadDb.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify({
        checkpointRef: "checkpoint:recovery_retry",
        recovery: {
          checkpointRef: "checkpoint:recovery_retry"
        }
      }),
      "2026-04-30T00:00:00.031Z",
      "slice_recovery_retry_001"
    );
    slicePayloadDb.close();

    const run = await runStore.loadRunById("run_recovery_retry");
    const [slice] = await sliceStore.listSlicesByRun("run_recovery_retry");
    expect(run).toBeDefined();
    expect(slice).toBeDefined();

    const continueSlice = vi.fn(async () => ({
      turnId: "run_recovery_retry",
      sessionId: "session_recovery_retry",
      resolvedMode: "act" as const,
      status: "interrupted" as const,
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
      },
      warnings: ["continued from recoverable state"],
      checkpointRef: "checkpoint:recovery_retry",
      nextSessionStateRef: "session_state_ref:recovery_retry"
    }));
    const executeTurnSlice = vi.fn(async () => {
      throw new Error("fresh executeTurnSlice should not run for recovery_retry");
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: run!,
      slice: slice!
    });

    expect(continueSlice).toHaveBeenCalledTimes(1);
    expect(continueSlice).toHaveBeenCalledWith({
      run: run!,
      slice: slice!
    });
    expect(executeTurnSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "interrupted",
      checkpointRef: "checkpoint:recovery_retry"
    });
  });

  it("falls back to fresh slice execution for recovery-retry slices with stale refs but no true continuation", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await runStore.createBackgroundTask({
      taskId: "task_recovery_retry_fresh",
      workspaceId: "workspace_local",
      sessionId: "session_recovery_retry_fresh",
      actorId: "actor_001",
      title: "Fresh recovery retry task",
      description: "replay a non-resumable legacy retry slice",
      sourceTurnId: "turn_recovery_retry_fresh_origin",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_recovery_retry_fresh",
      taskId: "task_recovery_retry_fresh",
      workspaceId: "workspace_local",
      sessionId: "session_recovery_retry_fresh",
      actorId: "actor_001",
      idempotencyKey: "seed:recovery-retry-fresh",
      turnRequest: {
        turnId: "turn_recovery_retry_fresh_origin",
        sessionId: "session_recovery_retry_fresh",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "rerun from scratch after a crash",
        requestedMode: "act",
        originTurnId: "turn_recovery_retry_fresh_origin"
      },
      sourceTurnId: "turn_recovery_retry_fresh_origin",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });

    const setupDb = new Database(paths.tasks);
    setupDb.prepare(`
      UPDATE task_runs
      SET continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_approval_ref = ?,
          pending_control_ref = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify({ checkpointRef: "checkpoint:recovery_retry_fresh" }),
      "2026-04-30T00:00:00.020Z",
      "approval:stale_recovery_retry",
      "frame:stale_recovery_retry",
      "2026-04-30T00:00:00.020Z",
      "run_recovery_retry_fresh"
    );
    setupDb.close();

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_recovery_retry_fresh_001",
      runId: "run_recovery_retry_fresh",
      taskId: "task_recovery_retry_fresh",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-30T00:00:00.030Z"
    });
    const slicePayloadDb = new Database(paths.tasks);
    slicePayloadDb.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify({ checkpointRef: "checkpoint:recovery_retry_fresh" }),
      "2026-04-30T00:00:00.031Z",
      "slice_recovery_retry_fresh_001"
    );
    slicePayloadDb.close();

    const run = await runStore.loadRunById("run_recovery_retry_fresh");
    const [slice] = await sliceStore.listSlicesByRun("run_recovery_retry_fresh");
    expect(run).toBeDefined();
    expect(slice).toBeDefined();

    const continueSlice = vi.fn(async () => {
      throw new Error("continueSlice must not run for stale refs without a real continuation source");
    });
    const executeTurnSlice = vi.fn(async () => ({
      turnId: "run_recovery_retry_fresh",
      sessionId: "session_recovery_retry_fresh",
      resolvedMode: "act" as const,
      status: "completed" as const,
      messages: [{ role: "assistant" as const, content: "fresh execution recovered the run" }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: "checkpoint:recovery_retry_fresh"
    }));

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: run!,
      slice: slice!
    });

    expect(executeTurnSlice).toHaveBeenCalledTimes(1);
    expect(continueSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "completed",
      checkpointRef: "checkpoint:recovery_retry_fresh"
    });
  });

  it("routes recovery-retry slices through continueSlice when same-run live inflight continuation still exists", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_recovery_retry_live",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_recovery_retry_live_seed",
      actorId: "actor_001",
      input: "seed recovery state",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_recovery_retry_live",
      workspaceId: "workspace_local",
      sessionId: "session_recovery_retry_live",
      actorId: "actor_001",
      title: "Live recovery retry task",
      description: "resume directly from live inflight recovery state",
      sourceTurnId: "turn_recovery_retry_live_origin",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_recovery_retry_live",
      taskId: "task_recovery_retry_live",
      workspaceId: "workspace_local",
      sessionId: "session_recovery_retry_live",
      actorId: "actor_001",
      idempotencyKey: "seed:recovery-retry-live",
      turnRequest: {
        turnId: "turn_recovery_retry_live_origin",
        sessionId: "session_recovery_retry_live",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "continue the still-live recovery retry",
        requestedMode: "act",
        originTurnId: "turn_recovery_retry_live_origin"
      },
      sourceTurnId: "turn_recovery_retry_live_origin",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });

    const setupDb = new Database(paths.tasks);
    setupDb.prepare(`
      UPDATE task_runs
      SET continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify({ checkpointRef: "checkpoint:recovery_retry_live" }),
      "2026-04-30T00:00:00.020Z",
      "2026-04-30T00:00:00.020Z",
      "run_recovery_retry_live"
    );
    setupDb.close();

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_recovery_retry_live_001",
      runId: "run_recovery_retry_live",
      taskId: "task_recovery_retry_live",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-30T00:00:00.030Z"
    });
    const slicePayloadDb = new Database(paths.tasks);
    slicePayloadDb.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify({ checkpointRef: "checkpoint:recovery_retry_live" }),
      "2026-04-30T00:00:00.031Z",
      "slice_recovery_retry_live_001"
    );
    slicePayloadDb.close();

    await sessionStore.markInflight({
      turnId: "run_recovery_retry_live",
      sessionId: "session_recovery_retry_live",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      checkpointRef: "checkpoint:recovery_retry_live",
      frameRef: "frame:recovery_retry_live",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:recovery_retry_live",
        frameRef: "frame:recovery_retry_live",
        checkpointRef: "checkpoint:recovery_retry_live",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:recovery_retry_live",
          checkpointRef: "checkpoint:recovery_retry_live",
          turnId: "run_recovery_retry_live",
          sessionId: "session_recovery_retry_live",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "recovery_retry",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              actorId: "actor_001"
            }
          }
        }
      }
    });

    const run = await runStore.loadRunById("run_recovery_retry_live");
    const [slice] = await sliceStore.listSlicesByRun("run_recovery_retry_live");
    expect(run).toBeDefined();
    expect(slice).toBeDefined();

    const continueSlice = vi.fn(async () => ({
      turnId: "run_recovery_retry_live",
      sessionId: "session_recovery_retry_live",
      resolvedMode: "act" as const,
      status: "interrupted" as const,
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
      },
      warnings: ["continued from live inflight recovery state"],
      checkpointRef: "checkpoint:recovery_retry_live",
      nextSessionStateRef: "session_state_ref:recovery_retry_live"
    }));
    const executeTurnSlice = vi.fn(async () => {
      throw new Error("fresh executeTurnSlice should not run while live inflight recovery exists");
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: run!,
      slice: slice!
    });

    expect(continueSlice).toHaveBeenCalledTimes(1);
    expect(continueSlice).toHaveBeenCalledWith({
      run: run!,
      slice: slice!
    });
    expect(executeTurnSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "interrupted",
      checkpointRef: "checkpoint:recovery_retry_live"
    });
  });

  it.each([
    "auto_continue",
    "user_resume",
    "operator_resume"
  ] as const)("dispatches %s slices through continueSlice even when run continuationKind is stale approval truth", async (triggerKind) => {
    const paths = await tempDbPaths();
    const fixture = await seedClaimedSliceFixture({
      paths,
      taskId: `task_${triggerKind}_dispatch`,
      runId: `run_${triggerKind}_dispatch`,
      sessionId: `session_${triggerKind}_dispatch`,
      turnId: `turn_${triggerKind}_dispatch`,
      triggerKind,
      runContinuationKind: "approval_resume"
    });

    const continueSlice = vi.fn(async () => ({
      turnId: fixture.run.runId,
      sessionId: fixture.run.sessionId,
      resolvedMode: "act" as const,
      status: "interrupted" as const,
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
      },
      warnings: [`continued ${triggerKind}`],
      checkpointRef: `checkpoint:${triggerKind}`
    }));
    const resolveApprovalSlice = vi.fn(async () => {
      throw new Error(`resolveApprovalSlice should not run for ${triggerKind}`);
    });
    const executeTurnSlice = vi.fn(async () => {
      throw new Error(`fresh executeTurnSlice should not run for ${triggerKind}`);
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore: fixture.runStore,
      sliceStore: fixture.sliceStore,
      controlStore: fixture.controlStore,
      sessionStore: fixture.sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: fixture.run,
      slice: fixture.slice
    });

    expect(continueSlice).toHaveBeenCalledTimes(1);
    expect(continueSlice).toHaveBeenCalledWith({
      run: fixture.run,
      slice: fixture.slice
    });
    expect(resolveApprovalSlice).not.toHaveBeenCalled();
    expect(executeTurnSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "interrupted",
      checkpointRef: `checkpoint:${triggerKind}`
    });
  });

  it("dispatches approval-resume slices through resolveApprovalSlice even when run continuationKind is stale operator truth", async () => {
    const paths = await tempDbPaths();
    const fixture = await seedClaimedSliceFixture({
      paths,
      taskId: "task_approval_dispatch",
      runId: "run_approval_dispatch",
      sessionId: "session_approval_dispatch",
      turnId: "turn_approval_dispatch",
      triggerKind: "approval_resume",
      runContinuationKind: "operator_resume"
    });

    const resolveApprovalSlice = vi.fn(async () => ({
      turnId: fixture.run.runId,
      sessionId: fixture.run.sessionId,
      resolvedMode: "act" as const,
      status: "completed" as const,
      messages: [{ role: "assistant" as const, content: "approved continuation executed" }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: "checkpoint:approval_dispatch"
    }));
    const continueSlice = vi.fn(async () => {
      throw new Error("continueSlice should not run for approval_resume");
    });
    const executeTurnSlice = vi.fn(async () => {
      throw new Error("fresh executeTurnSlice should not run for approval_resume");
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore: fixture.runStore,
      sliceStore: fixture.sliceStore,
      controlStore: fixture.controlStore,
      sessionStore: fixture.sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: fixture.run,
      slice: fixture.slice
    });

    expect(resolveApprovalSlice).toHaveBeenCalledTimes(1);
    expect(resolveApprovalSlice).toHaveBeenCalledWith({
      run: fixture.run,
      slice: fixture.slice
    });
    expect(continueSlice).not.toHaveBeenCalled();
    expect(executeTurnSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "approved continuation executed" })]
    });
  });

  it("dispatches legacy-cutover slices through fresh execution even when run continuationKind is stale continuation truth", async () => {
    const paths = await tempDbPaths();
    const fixture = await seedClaimedSliceFixture({
      paths,
      taskId: "task_legacy_dispatch",
      runId: "run_legacy_dispatch",
      sessionId: "session_legacy_dispatch",
      turnId: "turn_legacy_dispatch",
      triggerKind: "legacy_cutover",
      runContinuationKind: "operator_resume"
    });

    const executeTurnSlice = vi.fn(async () => ({
      turnId: fixture.run.runId,
      sessionId: fixture.run.sessionId,
      resolvedMode: "act" as const,
      status: "completed" as const,
      messages: [{ role: "assistant" as const, content: "fresh legacy execution ran" }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: "checkpoint:legacy_dispatch"
    }));
    const continueSlice = vi.fn(async () => {
      throw new Error("continueSlice should not run for legacy_cutover");
    });
    const resolveApprovalSlice = vi.fn(async () => {
      throw new Error("resolveApprovalSlice should not run for legacy_cutover");
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore: fixture.runStore,
      sliceStore: fixture.sliceStore,
      controlStore: fixture.controlStore,
      sessionStore: fixture.sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: fixture.run,
      slice: fixture.slice
    });

    expect(executeTurnSlice).toHaveBeenCalledTimes(1);
    expect(continueSlice).not.toHaveBeenCalled();
    expect(resolveApprovalSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "fresh legacy execution ran" })]
    });
  });

  it("dispatches recovery-retry slices through continueSlice only when durable continuation truth exists, regardless of stale run continuationKind", async () => {
    const paths = await tempDbPaths();
    const fixture = await seedClaimedSliceFixture({
      paths,
      taskId: "task_recovery_dispatch",
      runId: "run_recovery_dispatch",
      sessionId: "session_recovery_dispatch",
      turnId: "turn_recovery_dispatch",
      triggerKind: "recovery_retry",
      runContinuationKind: "approval_resume",
      sliceContinuationPayload: {
        recovery: {
          checkpointRef: "checkpoint:recovery_dispatch"
        }
      }
    });

    const continueSlice = vi.fn(async () => ({
      turnId: fixture.run.runId,
      sessionId: fixture.run.sessionId,
      resolvedMode: "act" as const,
      status: "interrupted" as const,
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
      },
      warnings: ["continued recovery_retry"],
      checkpointRef: "checkpoint:recovery_dispatch"
    }));
    const executeTurnSlice = vi.fn(async () => {
      throw new Error("fresh executeTurnSlice should not run when recovery truth exists");
    });
    const resolveApprovalSlice = vi.fn(async () => {
      throw new Error("resolveApprovalSlice should not run for recovery_retry");
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore: fixture.runStore,
      sliceStore: fixture.sliceStore,
      controlStore: fixture.controlStore,
      sessionStore: fixture.sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: fixture.run,
      slice: fixture.slice
    });

    expect(continueSlice).toHaveBeenCalledTimes(1);
    expect(resolveApprovalSlice).not.toHaveBeenCalled();
    expect(executeTurnSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "interrupted",
      checkpointRef: "checkpoint:recovery_dispatch"
    });
  });

  it("dispatches recovery-retry slices through fresh execution when no durable continuation truth exists, regardless of stale run continuationKind", async () => {
    const paths = await tempDbPaths();
    const fixture = await seedClaimedSliceFixture({
      paths,
      taskId: "task_recovery_fresh_dispatch",
      runId: "run_recovery_fresh_dispatch",
      sessionId: "session_recovery_fresh_dispatch",
      turnId: "turn_recovery_fresh_dispatch",
      triggerKind: "recovery_retry",
      runContinuationKind: "approval_resume",
      sliceContinuationPayload: {
        checkpointRef: "checkpoint:recovery_fresh_dispatch"
      }
    });

    const executeTurnSlice = vi.fn(async () => ({
      turnId: fixture.run.runId,
      sessionId: fixture.run.sessionId,
      resolvedMode: "act" as const,
      status: "completed" as const,
      messages: [{ role: "assistant" as const, content: "fresh recovery execution ran" }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: "checkpoint:recovery_fresh_dispatch"
    }));
    const continueSlice = vi.fn(async () => {
      throw new Error("continueSlice should not run without durable recovery truth");
    });
    const resolveApprovalSlice = vi.fn(async () => {
      throw new Error("resolveApprovalSlice should not run for recovery_retry");
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore: fixture.runStore,
      sliceStore: fixture.sliceStore,
      controlStore: fixture.controlStore,
      sessionStore: fixture.sessionStore,
      executeTurnSlice,
      continueSlice,
      resolveApprovalSlice
    });

    const execution = await lifecycle.executeClaimedSlice({
      run: fixture.run,
      slice: fixture.slice
    });

    expect(executeTurnSlice).toHaveBeenCalledTimes(1);
    expect(continueSlice).not.toHaveBeenCalled();
    expect(resolveApprovalSlice).not.toHaveBeenCalled();
    expect(execution.turnResult).toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "fresh recovery execution ran" })]
    });
  });

  it("atomically transitions blocked approval runs into exactly one queued resume slice and reuses it idempotently", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_approval_resume",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_approval_resume",
      workspaceId: "workspace_local",
      sessionId: "session_approval_resume",
      actorId: "actor_001",
      title: "Approval resume task",
      description: "blocked run awaiting approval",
      sourceTurnId: "turn_approval_resume",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_approval_resume",
      taskId: "task_approval_resume",
      workspaceId: "workspace_local",
      sessionId: "session_approval_resume",
      actorId: "actor_001",
      idempotencyKey: "seed:approval-resume",
      turnRequest: {
        turnId: "turn_approval_resume",
        sessionId: "session_approval_resume",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "continue after approval",
        requestedMode: "act",
        originTurnId: "turn_approval_resume"
      },
      sourceTurnId: "turn_approval_resume",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.050Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.100Z"
    });
    await runStore.suspendRun({
      runId: "run_approval_resume",
      pendingApprovalRef: "approval_approval_resume_001",
      pendingControlRef: "frame:approval_resume_001",
      blockedBy: "permission",
      resultSummary: "awaiting approval",
      now: "2026-04-30T00:00:00.150Z"
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    const firstTransition = await lifecycle.transitionBlockedRunToQueuedSlice({
      sessionId: "session_approval_resume",
      taskId: "task_approval_resume",
      runId: "run_approval_resume",
      attentionMode: "background_detached",
      triggerKind: "approval_resume",
      lane: "background",
      control: {
        kind: "continue",
        payload: {
          action: "approve",
          decisionId: "approval_approval_resume_001"
        }
      },
      continuationPayload: {
        control: {
          action: "approve",
          decisionId: "approval_approval_resume_001"
        }
      },
      now: "2026-04-30T00:00:00.200Z"
    });

    expect(firstTransition).toMatchObject({
      status: "queued",
      slice: expect.objectContaining({
        triggerKind: "approval_resume",
        lane: "background",
        status: "queued"
      })
    });
    await expect(runStore.loadRunById("run_approval_resume")).resolves.toMatchObject({
      status: "queued",
      continuationKind: "approval_resume",
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(controlStore.listPendingControls("run_approval_resume")).resolves.toEqual([
      expect.objectContaining({
        kind: "continue",
        payload: {
          action: "approve",
          decisionId: "approval_approval_resume_001"
        }
      })
    ]);
    await expect(sliceStore.listSlicesByRun("run_approval_resume")).resolves.toMatchObject([
      {
        sliceNo: 1,
        triggerKind: "approval_resume",
        lane: "background",
        status: "queued"
      }
    ]);

    const secondTransition = await lifecycle.transitionBlockedRunToQueuedSlice({
      sessionId: "session_approval_resume",
      taskId: "task_approval_resume",
      runId: "run_approval_resume",
      attentionMode: "background_detached",
      triggerKind: "approval_resume",
      lane: "background",
      control: {
        kind: "continue",
        payload: {
          action: "approve",
          decisionId: "approval_approval_resume_001"
        }
      },
      continuationPayload: {
        control: {
          action: "approve",
          decisionId: "approval_approval_resume_001"
        }
      },
      now: "2026-04-30T00:00:00.250Z"
    });

    expect(secondTransition).toMatchObject({
      status: "already_queued",
      slice: expect.objectContaining({
        triggerKind: "approval_resume",
        status: "queued"
      })
    });
    await expect(controlStore.listPendingControls("run_approval_resume")).resolves.toHaveLength(1);
    await expect(sliceStore.listSlicesByRun("run_approval_resume")).resolves.toHaveLength(1);
  });

  it("clears stale session recovery during the blocked-to-queued Task 2 handoff", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_handoff_cleanup",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_handoff_cleanup",
      workspaceId: "workspace_local",
      sessionId: "session_handoff_cleanup",
      actorId: "actor_001",
      title: "Cleanup handoff task",
      description: "blocked run moving back to queued",
      sourceTurnId: "turn_handoff_cleanup",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_handoff_cleanup",
      taskId: "task_handoff_cleanup",
      workspaceId: "workspace_local",
      sessionId: "session_handoff_cleanup",
      actorId: "actor_001",
      idempotencyKey: "seed:handoff-cleanup",
      turnRequest: {
        turnId: "turn_handoff_cleanup",
        sessionId: "session_handoff_cleanup",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "continue after approval",
        requestedMode: "act",
        originTurnId: "turn_handoff_cleanup"
      },
      sourceTurnId: "turn_handoff_cleanup",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.050Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.100Z"
    });
    await runStore.suspendRun({
      runId: "run_handoff_cleanup",
      pendingApprovalRef: "approval_handoff_cleanup_001",
      pendingControlRef: "frame:handoff_cleanup_001",
      blockedBy: "permission",
      resultSummary: "awaiting approval",
      now: "2026-04-30T00:00:00.150Z"
    });
    await sessionStore.markInflight({
      turnId: "run_handoff_cleanup",
      sessionId: "session_handoff_cleanup",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      pendingApprovalRef: "approval_handoff_cleanup_001",
      checkpointRef: "checkpoint:handoff_cleanup",
      frameRef: "frame:handoff_cleanup_001",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:handoff_cleanup",
        frameRef: "frame:handoff_cleanup_001",
        checkpointRef: "checkpoint:handoff_cleanup",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:handoff_cleanup_001",
          checkpointRef: "checkpoint:handoff_cleanup",
          turnId: "run_handoff_cleanup",
          sessionId: "session_handoff_cleanup",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "approval_resume",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["approve", "deny", "cancel"],
            metadata: {
              actorId: "actor_001"
            }
          }
        }
      }
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.transitionBlockedRunToQueuedSlice({
      sessionId: "session_handoff_cleanup",
      taskId: "task_handoff_cleanup",
      runId: "run_handoff_cleanup",
      attentionMode: "background_detached",
      triggerKind: "approval_resume",
      lane: "background",
      control: {
        kind: "continue",
        payload: {
          action: "approve",
          decisionId: "approval_handoff_cleanup_001"
        }
      },
      continuationPayload: {
        control: {
          action: "approve",
          decisionId: "approval_handoff_cleanup_001"
        },
        recovery: {
          schemaVersion: 1,
          contractVersion: "im.task2.slice-recovery.v1",
          turnId: "run_handoff_cleanup",
          sessionId: "session_handoff_cleanup",
          workspaceId: "workspace_local",
          source: "cli",
          mode: "act",
          checkpointRef: "checkpoint:handoff_cleanup",
          frameRef: "frame:handoff_cleanup_001",
          pendingApprovalRef: "approval_handoff_cleanup_001",
          pendingExecution: {
            schemaVersion: 1,
            contractVersion: "ws0.pending-execution.v1",
            pendingExecutionId: "pending:handoff_cleanup",
            frameRef: "frame:handoff_cleanup_001",
            checkpointRef: "checkpoint:handoff_cleanup",
            status: "ready",
            frame: {
              schemaVersion: 1,
              contractVersion: "ws0.execution-frame.v1",
              frameRef: "frame:handoff_cleanup_001",
              checkpointRef: "checkpoint:handoff_cleanup",
              turnId: "run_handoff_cleanup",
              sessionId: "session_handoff_cleanup",
              workspaceId: "workspace_local",
              phase: "awaiting_operator",
              step: "approval_resume",
              pendingToolCalls: [],
              pendingPermissionDecisions: [],
              loopCount: 0,
              toolCallCount: 0,
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                estimatedCost: 0
              },
              continuation: {
                continuationKind: "resume",
                allowedActions: ["approve", "deny", "cancel"],
                metadata: {
                  actorId: "actor_001"
                }
              }
            }
          }
        }
      },
      now: "2026-04-30T00:00:00.200Z"
    })).resolves.toMatchObject({
      status: "queued",
      slice: expect.objectContaining({
        triggerKind: "approval_resume",
        status: "queued"
      })
    });

    await expect(sessionStore.loadRecoveryContext("session_handoff_cleanup")).resolves.toBeNull();
    await expect(runStore.loadRunById("run_handoff_cleanup")).resolves.toMatchObject({
      status: "queued",
      continuationKind: "approval_resume",
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
  });

  it("marks detached blocked-to-queued handoffs as consumed even before session cleanup succeeds", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_handoff_consumed_marker",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });
    await runStore.createBackgroundTask({
      taskId: "task_handoff_consumed_marker",
      workspaceId: "workspace_local",
      sessionId: "session_handoff_consumed_marker",
      actorId: "actor_001",
      title: "Consumed marker task",
      description: "blocked detached handoff should mark task-side consumption",
      sourceTurnId: "turn_handoff_consumed_marker",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_handoff_consumed_marker",
      taskId: "task_handoff_consumed_marker",
      workspaceId: "workspace_local",
      sessionId: "session_handoff_consumed_marker",
      actorId: "actor_001",
      idempotencyKey: "seed:handoff-consumed-marker",
      turnRequest: {
        turnId: "turn_handoff_consumed_marker",
        sessionId: "session_handoff_consumed_marker",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "continue after approval",
        requestedMode: "act",
        originTurnId: "turn_handoff_consumed_marker"
      },
      sourceTurnId: "turn_handoff_consumed_marker",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.050Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.100Z"
    });
    await runStore.suspendRun({
      runId: "run_handoff_consumed_marker",
      pendingApprovalRef: "approval_handoff_consumed_marker_001",
      pendingControlRef: "frame:handoff_consumed_marker_001",
      blockedBy: "permission",
      resultSummary: "awaiting approval",
      now: "2026-04-30T00:00:00.150Z"
    });
    await sessionStore.markInflight({
      turnId: "run_handoff_consumed_marker",
      sessionId: "session_handoff_consumed_marker",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      pendingApprovalRef: "approval_handoff_consumed_marker_001",
      checkpointRef: "checkpoint:handoff_consumed_marker",
      frameRef: "frame:handoff_consumed_marker_001",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:handoff_consumed_marker",
        frameRef: "frame:handoff_consumed_marker_001",
        checkpointRef: "checkpoint:handoff_consumed_marker",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:handoff_consumed_marker_001",
          checkpointRef: "checkpoint:handoff_consumed_marker",
          turnId: "run_handoff_consumed_marker",
          sessionId: "session_handoff_consumed_marker",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "approval_resume",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["approve", "deny", "cancel"],
            metadata: {
              actorId: "actor_001"
            }
          }
        }
      }
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore: {
        ...sessionStore,
        finalize: vi.fn(async () => "session_state_ref:run_handoff_consumed_marker")
      },
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.transitionBlockedRunToQueuedSlice({
      sessionId: "session_handoff_consumed_marker",
      taskId: "task_handoff_consumed_marker",
      runId: "run_handoff_consumed_marker",
      attentionMode: "background_detached",
      triggerKind: "approval_resume",
      lane: "background",
      continuationPayload: {
        checkpointRef: "checkpoint:handoff_consumed_marker"
      },
      now: "2026-04-30T00:00:00.200Z"
    })).resolves.toMatchObject({
      status: "queued",
      slice: expect.objectContaining({
        triggerKind: "approval_resume",
        status: "queued"
      })
    });

    await expect(sessionStore.loadRecoveryContext("session_handoff_consumed_marker")).resolves.toMatchObject({
      inflight: expect.objectContaining({
        turnId: "run_handoff_consumed_marker"
      })
    });
    await expect(runStore.loadRunById("run_handoff_consumed_marker")).resolves.toMatchObject({
      status: "queued",
      recoveryTruthState: "consumed"
    });
  });

  it("returns cancel_requested and keeps durable running truth when detached queued cancel loses to an in-transaction worker claim", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const taskStore = createTaskStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_detached_cancel_claim_race",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_detached_cancel_claim_race",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_claim_race",
      actorId: "actor_001",
      title: "Detached cancel claim race",
      description: "queued detached cancel loses after worker claim wins inside the transaction",
      sourceTurnId: "turn_detached_cancel_claim_race",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_detached_cancel_claim_race",
      taskId: "task_detached_cancel_claim_race",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_claim_race",
      actorId: "actor_001",
      idempotencyKey: "seed:run-detached-cancel-claim-race",
      turnRequest: {
        turnId: "turn_detached_cancel_claim_race",
        sessionId: "session_detached_cancel_claim_race",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "queued detached run",
        requestedMode: "act",
        originTurnId: "turn_detached_cancel_claim_race"
      },
      sourceTurnId: "turn_detached_cancel_claim_race",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_detached_cancel_claim_race_001",
      runId: "run_detached_cancel_claim_race",
      taskId: "task_detached_cancel_claim_race",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_detached_cancel_claim_race
      AFTER UPDATE OF status ON runtime_slices
      FOR EACH ROW
      WHEN NEW.slice_id = 'slice_detached_cancel_claim_race_001'
        AND OLD.status = 'queued'
        AND NEW.status = 'canceled'
      BEGIN
        UPDATE runtime_slices
        SET status = 'running',
            worker_id = 'worker_race',
            lease_owner = 'worker_race',
            lease_expires_at = '2026-04-30T00:01:00.000Z',
            claimed_at = '2026-04-30T00:00:30.000Z',
            started_at = '2026-04-30T00:00:30.000Z',
            updated_at = '2026-04-30T00:00:30.000Z'
        WHERE slice_id = 'slice_detached_cancel_claim_race_001';

        UPDATE task_runs
        SET status = 'running',
            worker_id = 'worker_race',
            claimed_at = '2026-04-30T00:00:30.000Z',
            started_at = '2026-04-30T00:00:30.000Z',
            lease_owner = 'worker_race',
            lease_expires_at = '2026-04-30T00:01:00.000Z',
            run_started_at = '2026-04-30T00:00:30.000Z',
            updated_at = '2026-04-30T00:00:30.000Z'
        WHERE run_id = 'run_detached_cancel_claim_race';
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.cancelDetachedRun({
      sessionId: "session_detached_cancel_claim_race",
      taskId: "task_detached_cancel_claim_race",
      runId: "run_detached_cancel_claim_race",
      attentionMode: "background_detached",
      reason: "worker won the claim first",
      requestedBy: "operator_001",
      now: "2026-04-30T00:00:31.000Z"
    })).resolves.toEqual({ status: "cancel_requested" });

    await expect(runStore.loadRunById("run_detached_cancel_claim_race")).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "operator_001",
      cancelReason: "worker won the claim first"
    });
    await expect(taskStore.loadById("task_detached_cancel_claim_race")).resolves.toMatchObject({
      status: "active"
    });
    await expect(sliceStore.listSlicesByRun("run_detached_cancel_claim_race")).resolves.toEqual([
      expect.objectContaining({
        sliceId: "slice_detached_cancel_claim_race_001",
        status: "running"
      })
    ]);
    await expect(controlStore.listPendingControls("run_detached_cancel_claim_race")).resolves.toEqual([
      expect.objectContaining({
        kind: "cancel",
        payload: {
          reason: "worker won the claim first",
          requestedBy: "operator_001"
        }
      })
    ]);
  });

  it("keeps queued detached cancel non-terminal when the guarded slice transition misses", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const taskStore = createTaskStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_detached_cancel_slice_miss",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_detached_cancel_slice_miss",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_slice_miss",
      actorId: "actor_001",
      title: "Detached cancel slice miss",
      description: "queued cancel must not go terminal when the guarded slice update misses",
      sourceTurnId: "turn_detached_cancel_slice_miss",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_detached_cancel_slice_miss",
      taskId: "task_detached_cancel_slice_miss",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_slice_miss",
      actorId: "actor_001",
      idempotencyKey: "seed:run-detached-cancel-slice-miss",
      turnRequest: {
        turnId: "turn_detached_cancel_slice_miss",
        sessionId: "session_detached_cancel_slice_miss",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "queued detached run",
        requestedMode: "act",
        originTurnId: "turn_detached_cancel_slice_miss"
      },
      sourceTurnId: "turn_detached_cancel_slice_miss",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_detached_cancel_slice_miss_001",
      runId: "run_detached_cancel_slice_miss",
      taskId: "task_detached_cancel_slice_miss",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_detached_cancel_slice_miss
      BEFORE UPDATE OF status ON runtime_slices
      FOR EACH ROW
      WHEN OLD.slice_id = 'slice_detached_cancel_slice_miss_001'
        AND OLD.status = 'queued'
        AND NEW.status = 'canceled'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.cancelDetachedRun({
      sessionId: "session_detached_cancel_slice_miss",
      taskId: "task_detached_cancel_slice_miss",
      runId: "run_detached_cancel_slice_miss",
      attentionMode: "background_detached",
      reason: "slice guard lost",
      requestedBy: "operator_001",
      now: "2026-04-30T00:00:31.000Z"
    })).resolves.toEqual({ status: "cancel_requested" });

    await expect(runStore.loadRunById("run_detached_cancel_slice_miss")).resolves.toMatchObject({
      status: "queued",
      cancelRequestedBy: "operator_001",
      cancelReason: "slice guard lost"
    });
    await expect(taskStore.loadById("task_detached_cancel_slice_miss")).resolves.toMatchObject({
      status: "active"
    });
    await expect(sliceStore.listSlicesByRun("run_detached_cancel_slice_miss")).resolves.toEqual([
      expect.objectContaining({
        sliceId: "slice_detached_cancel_slice_miss_001",
        status: "queued"
      })
    ]);
    await expect(controlStore.listPendingControls("run_detached_cancel_slice_miss")).resolves.toEqual([
      expect.objectContaining({
        kind: "cancel",
        payload: {
          reason: "slice guard lost",
          requestedBy: "operator_001"
        }
      })
    ]);
  });

  it("keeps queued detached cancel miss idempotent across retries", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_detached_cancel_retry_idempotent",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_detached_cancel_retry_idempotent",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_retry_idempotent",
      actorId: "actor_001",
      title: "Detached cancel retry idempotent",
      description: "retries should preserve one pending cancel signal after a queued miss",
      sourceTurnId: "turn_detached_cancel_retry_idempotent",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_detached_cancel_retry_idempotent",
      taskId: "task_detached_cancel_retry_idempotent",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_retry_idempotent",
      actorId: "actor_001",
      idempotencyKey: "seed:run-detached-cancel-retry-idempotent",
      turnRequest: {
        turnId: "turn_detached_cancel_retry_idempotent",
        sessionId: "session_detached_cancel_retry_idempotent",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "queued detached run",
        requestedMode: "act",
        originTurnId: "turn_detached_cancel_retry_idempotent"
      },
      sourceTurnId: "turn_detached_cancel_retry_idempotent",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_detached_cancel_retry_idempotent_001",
      runId: "run_detached_cancel_retry_idempotent",
      taskId: "task_detached_cancel_retry_idempotent",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_detached_cancel_retry_idempotent
      BEFORE UPDATE OF status ON runtime_slices
      FOR EACH ROW
      WHEN OLD.slice_id = 'slice_detached_cancel_retry_idempotent_001'
        AND OLD.status = 'queued'
        AND NEW.status = 'canceled'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    for (const now of ["2026-04-30T00:00:31.000Z", "2026-04-30T00:00:32.000Z"] as const) {
      await expect(lifecycle.cancelDetachedRun({
        sessionId: "session_detached_cancel_retry_idempotent",
        taskId: "task_detached_cancel_retry_idempotent",
        runId: "run_detached_cancel_retry_idempotent",
        attentionMode: "background_detached",
        reason: "retry me once",
        requestedBy: "operator_001",
        now
      })).resolves.toEqual({ status: "cancel_requested" });
    }

    await expect(controlStore.listPendingControls("run_detached_cancel_retry_idempotent")).resolves.toEqual([
      expect.objectContaining({
        kind: "cancel",
        payload: {
          reason: "retry me once",
          requestedBy: "operator_001"
        }
      })
    ]);
  });

  it("drops queued detached cancel control leakage when a terminal result wins before queued cancellation can commit", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const taskStore = createTaskStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_detached_cancel_terminal_miss",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_detached_cancel_terminal_miss",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_terminal_miss",
      actorId: "actor_001",
      title: "Detached cancel terminal miss",
      description: "terminal completion wins before queued cancel can commit",
      sourceTurnId: "turn_detached_cancel_terminal_miss",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_detached_cancel_terminal_miss",
      taskId: "task_detached_cancel_terminal_miss",
      workspaceId: "workspace_local",
      sessionId: "session_detached_cancel_terminal_miss",
      actorId: "actor_001",
      idempotencyKey: "seed:run-detached-cancel-terminal-miss",
      turnRequest: {
        turnId: "turn_detached_cancel_terminal_miss",
        sessionId: "session_detached_cancel_terminal_miss",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "queued detached run",
        requestedMode: "act",
        originTurnId: "turn_detached_cancel_terminal_miss"
      },
      sourceTurnId: "turn_detached_cancel_terminal_miss",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_detached_cancel_terminal_miss_001",
      runId: "run_detached_cancel_terminal_miss",
      taskId: "task_detached_cancel_terminal_miss",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_detached_cancel_terminal_miss
      BEFORE UPDATE OF status ON runtime_slices
      FOR EACH ROW
      WHEN OLD.slice_id = 'slice_detached_cancel_terminal_miss_001'
        AND OLD.status = 'queued'
        AND NEW.status = 'canceled'
      BEGIN
        UPDATE task_runs
        SET status = 'completed',
            result_summary = 'completed before queued cancel won',
            finished_at = '2026-04-30T00:00:31.000Z',
            updated_at = '2026-04-30T00:00:31.000Z'
        WHERE run_id = 'run_detached_cancel_terminal_miss';
        SELECT RAISE(IGNORE);
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.cancelDetachedRun({
      sessionId: "session_detached_cancel_terminal_miss",
      taskId: "task_detached_cancel_terminal_miss",
      runId: "run_detached_cancel_terminal_miss",
      attentionMode: "background_detached",
      reason: "too late",
      requestedBy: "operator_001",
      now: "2026-04-30T00:00:31.000Z"
    })).resolves.toEqual({ status: "not_runnable" });

    await expect(runStore.loadRunById("run_detached_cancel_terminal_miss")).resolves.toMatchObject({
      status: "completed",
      resultSummary: "completed before queued cancel won"
    });
    await expect(taskStore.loadById("task_detached_cancel_terminal_miss")).resolves.toMatchObject({
      status: "active"
    });
    await expect(controlStore.listPendingControls("run_detached_cancel_terminal_miss")).resolves.toEqual([]);
  });

  it("refuses stale blocked-to-queued handoffs after a terminal close wins inside the transaction", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const taskStore = createTaskStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_blocked_to_queued_terminal_race",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_blocked_to_queued_terminal_race",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_to_queued_terminal_race",
      actorId: "actor_001",
      title: "Blocked-to-queued terminal race",
      description: "terminal close wins before blocked resume can commit",
      sourceTurnId: "turn_blocked_to_queued_terminal_race",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_blocked_to_queued_terminal_race",
      taskId: "task_blocked_to_queued_terminal_race",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_to_queued_terminal_race",
      actorId: "actor_001",
      idempotencyKey: "seed:run-blocked-to-queued-terminal-race",
      turnRequest: {
        turnId: "turn_blocked_to_queued_terminal_race",
        sessionId: "session_blocked_to_queued_terminal_race",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "blocked detached run",
        requestedMode: "act",
        originTurnId: "turn_blocked_to_queued_terminal_race"
      },
      sourceTurnId: "turn_blocked_to_queued_terminal_race",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await runStore.claimNextRun({
      workerId: "worker_legacy",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.020Z"
    });
    await runStore.suspendRun({
      runId: "run_blocked_to_queued_terminal_race",
      pendingApprovalRef: "approval_blocked_to_queued_terminal_race_001",
      pendingControlRef: "frame:blocked_to_queued_terminal_race_001",
      blockedBy: "permission",
      resultSummary: "awaiting approval",
      now: "2026-04-30T00:00:00.030Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_blocked_to_queued_terminal_race
      BEFORE UPDATE OF status ON task_runs
      FOR EACH ROW
      WHEN OLD.run_id = 'run_blocked_to_queued_terminal_race'
        AND OLD.status = 'blocked'
        AND NEW.status = 'queued'
      BEGIN
        UPDATE task_runs
        SET status = 'failed',
            result_summary = 'terminal close won first',
            finished_at = '2026-04-30T00:00:31.000Z',
            updated_at = '2026-04-30T00:00:31.000Z'
        WHERE run_id = 'run_blocked_to_queued_terminal_race';
        SELECT RAISE(IGNORE);
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.transitionBlockedRunToQueuedSlice({
      sessionId: "session_blocked_to_queued_terminal_race",
      taskId: "task_blocked_to_queued_terminal_race",
      runId: "run_blocked_to_queued_terminal_race",
      attentionMode: "background_detached",
      triggerKind: "approval_resume",
      lane: "background",
      control: {
        kind: "continue",
        payload: {
          decisionId: "approval_blocked_to_queued_terminal_race_001"
        }
      },
      continuationPayload: {
        decisionId: "approval_blocked_to_queued_terminal_race_001"
      },
      now: "2026-04-30T00:00:32.000Z"
    })).resolves.toEqual({
      status: "not_runnable",
      slice: undefined
    });

    await expect(runStore.loadRunById("run_blocked_to_queued_terminal_race")).resolves.toMatchObject({
      status: "failed",
      resultSummary: "terminal close won first"
    });
    await expect(taskStore.loadById("task_blocked_to_queued_terminal_race")).resolves.toMatchObject({
      status: "blocked"
    });
    const slicesAfterRace = await sliceStore.listSlicesByRun("run_blocked_to_queued_terminal_race");
    expect(slicesAfterRace.some((slice) => slice.status === "queued" || slice.status === "running")).toBe(false);
    await expect(controlStore.listPendingControls("run_blocked_to_queued_terminal_race")).resolves.toEqual([]);
  });

  it("preserves cancel signal when blocked terminal close loses to a resumed queued/running winner", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const taskStore = createTaskStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_blocked_close_resume_race",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_blocked_close_resume_race",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_close_resume_race",
      actorId: "actor_001",
      title: "Blocked close resume race",
      description: "resume wins before blocked cancel close can commit",
      sourceTurnId: "turn_blocked_close_resume_race",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_blocked_close_resume_race",
      taskId: "task_blocked_close_resume_race",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_close_resume_race",
      actorId: "actor_001",
      idempotencyKey: "seed:run-blocked-close-resume-race",
      turnRequest: {
        turnId: "turn_blocked_close_resume_race",
        sessionId: "session_blocked_close_resume_race",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "blocked detached run",
        requestedMode: "act",
        originTurnId: "turn_blocked_close_resume_race"
      },
      sourceTurnId: "turn_blocked_close_resume_race",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await runStore.claimNextRun({
      workerId: "worker_legacy",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.020Z"
    });
    await runStore.suspendRun({
      runId: "run_blocked_close_resume_race",
      pendingApprovalRef: "approval_blocked_close_resume_race_001",
      pendingControlRef: "frame:blocked_close_resume_race_001",
      blockedBy: "permission",
      resultSummary: "awaiting approval",
      now: "2026-04-30T00:00:00.030Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_blocked_close_resume_race
      BEFORE UPDATE OF status ON task_runs
      FOR EACH ROW
      WHEN OLD.run_id = 'run_blocked_close_resume_race'
        AND OLD.status = 'blocked'
        AND NEW.status = 'canceled'
      BEGIN
        INSERT INTO runtime_slices (
          slice_id,
          run_id,
          task_id,
          slice_no,
          trigger_kind,
          lane,
          status,
          worker_id,
          lease_owner,
          lease_expires_at,
          claimed_at,
          started_at,
          created_at,
          updated_at
        ) VALUES (
          'slice_blocked_close_resume_race_001',
          'run_blocked_close_resume_race',
          'task_blocked_close_resume_race',
          1,
          'approval_resume',
          'background',
          'running',
          'worker_resume',
          'worker_resume',
          '2026-04-30T00:01:31.000Z',
          '2026-04-30T00:00:31.000Z',
          '2026-04-30T00:00:31.000Z',
          '2026-04-30T00:00:31.000Z',
          '2026-04-30T00:00:31.000Z'
        );
        UPDATE task_runs
        SET status = 'running',
            worker_id = 'worker_resume',
            claimed_at = '2026-04-30T00:00:31.000Z',
            started_at = '2026-04-30T00:00:31.000Z',
            lease_owner = 'worker_resume',
            lease_expires_at = '2026-04-30T00:01:31.000Z',
            run_started_at = '2026-04-30T00:00:31.000Z',
            updated_at = '2026-04-30T00:00:31.000Z'
        WHERE run_id = 'run_blocked_close_resume_race';
        SELECT RAISE(IGNORE);
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.closeBlockedRunTerminally({
      sessionId: "session_blocked_close_resume_race",
      taskId: "task_blocked_close_resume_race",
      runId: "run_blocked_close_resume_race",
      attentionMode: "background_detached",
      terminalStatus: "canceled",
      resultSummary: "operator canceled too late",
      cancel: {
        requestedAt: "2026-04-30T00:00:32.000Z",
        requestedBy: "operator_001",
        reason: "operator canceled too late"
      },
      control: {
        kind: "cancel",
        payload: {
          reason: "operator canceled too late",
          requestedBy: "operator_001"
        }
      },
      now: "2026-04-30T00:00:32.000Z"
    })).resolves.toBeUndefined();

    await expect(runStore.loadRunById("run_blocked_close_resume_race")).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "operator_001",
      cancelReason: "operator canceled too late"
    });
    await expect(taskStore.loadById("task_blocked_close_resume_race")).resolves.toMatchObject({
      status: "blocked"
    });
    await expect(controlStore.listPendingControls("run_blocked_close_resume_race")).resolves.toEqual([
      expect.objectContaining({
        kind: "cancel",
        payload: {
          reason: "operator canceled too late",
          requestedBy: "operator_001"
        }
      })
    ]);
  });

  it("returns an undefined close result and preserves terminal truth when blocked close loses the transaction race", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const taskStore = createTaskStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_blocked_close_terminal_race",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_blocked_close_terminal_race",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_close_terminal_race",
      actorId: "actor_001",
      title: "Blocked close terminal race",
      description: "another terminal outcome wins before the close mutator commits",
      sourceTurnId: "turn_blocked_close_terminal_race",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_blocked_close_terminal_race",
      taskId: "task_blocked_close_terminal_race",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_close_terminal_race",
      actorId: "actor_001",
      idempotencyKey: "seed:run-blocked-close-terminal-race",
      turnRequest: {
        turnId: "turn_blocked_close_terminal_race",
        sessionId: "session_blocked_close_terminal_race",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "blocked detached run",
        requestedMode: "act",
        originTurnId: "turn_blocked_close_terminal_race"
      },
      sourceTurnId: "turn_blocked_close_terminal_race",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await runStore.claimNextRun({
      workerId: "worker_legacy",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.020Z"
    });
    await runStore.suspendRun({
      runId: "run_blocked_close_terminal_race",
      pendingApprovalRef: "approval_blocked_close_terminal_race_001",
      pendingControlRef: "frame:blocked_close_terminal_race_001",
      blockedBy: "permission",
      resultSummary: "awaiting approval",
      now: "2026-04-30T00:00:00.030Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_blocked_close_terminal_race
      BEFORE UPDATE OF status ON task_runs
      FOR EACH ROW
      WHEN OLD.run_id = 'run_blocked_close_terminal_race'
        AND OLD.status = 'blocked'
        AND NEW.status = 'canceled'
      BEGIN
        UPDATE task_runs
        SET status = 'completed',
            result_summary = 'completion won first',
            finished_at = '2026-04-30T00:00:31.000Z',
            updated_at = '2026-04-30T00:00:31.000Z'
        WHERE run_id = 'run_blocked_close_terminal_race';
        SELECT RAISE(IGNORE);
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.closeBlockedRunTerminally({
      sessionId: "session_blocked_close_terminal_race",
      taskId: "task_blocked_close_terminal_race",
      runId: "run_blocked_close_terminal_race",
      attentionMode: "background_detached",
      terminalStatus: "canceled",
      resultSummary: "operator canceled too late",
      cancel: {
        requestedAt: "2026-04-30T00:00:32.000Z",
        requestedBy: "operator_001",
        reason: "operator canceled too late"
      },
      control: {
        kind: "cancel",
        payload: {
          reason: "operator canceled too late",
          requestedBy: "operator_001"
        }
      },
      now: "2026-04-30T00:00:32.000Z"
    })).resolves.toBeUndefined();

    await expect(runStore.loadRunById("run_blocked_close_terminal_race")).resolves.toMatchObject({
      status: "completed",
      resultSummary: "completion won first"
    });
    await expect(taskStore.loadById("task_blocked_close_terminal_race")).resolves.toMatchObject({
      status: "blocked"
    });
    await expect(controlStore.listPendingControls("run_blocked_close_terminal_race")).resolves.toEqual([]);
  });

  it("claims the highest-priority runnable slice and skips stale queued slices on canceled runs", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await runStore.createBackgroundTask({
      taskId: "task_low",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Low priority",
      description: "should not win claim order",
      sourceTurnId: "turn_low",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_low",
      taskId: "task_low",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "seed:run-low",
      turnRequest: {
        turnId: "turn_low",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_low",
        source: "cli",
        input: "low priority",
        originTurnId: "turn_low"
      },
      priority: 0,
      sourceTurnId: "turn_low",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_low_001",
      runId: "run_low",
      taskId: "task_low",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_canceled_head",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Canceled head",
      description: "stale queued slice must not resurrect",
      sourceTurnId: "turn_canceled_head",
      now: "2026-04-30T00:00:00.030Z"
    });
    await runStore.enqueueRun({
      runId: "run_canceled_head",
      taskId: "task_canceled_head",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "seed:run-canceled-head",
      turnRequest: {
        turnId: "turn_canceled_head",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cancel",
        source: "cli",
        input: "canceled head",
        originTurnId: "turn_canceled_head"
      },
      priority: 100,
      sourceTurnId: "turn_canceled_head",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.040Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_canceled_head_001",
      runId: "run_canceled_head",
      taskId: "task_canceled_head",
      lane: "background",
      now: "2026-04-30T00:00:00.050Z"
    });
    await runStore.cancelQueuedOrSuspendedRun({
      runId: "run_canceled_head",
      reason: "operator canceled queued run",
      now: "2026-04-30T00:00:00.060Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_high",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "High priority",
      description: "must win claim order",
      sourceTurnId: "turn_high",
      now: "2026-04-30T00:00:00.070Z"
    });
    await runStore.enqueueRun({
      runId: "run_high",
      taskId: "task_high",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "seed:run-high",
      turnRequest: {
        turnId: "turn_high",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_high",
        source: "cli",
        input: "high priority",
        originTurnId: "turn_high"
      },
      priority: 10,
      sourceTurnId: "turn_high",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.080Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_high_001",
      runId: "run_high",
      taskId: "task_high",
      lane: "background",
      now: "2026-04-30T00:00:00.090Z"
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "background",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      run: {
        runId: "run_high",
        taskId: "task_high"
      },
      slice: {
        sliceId: "slice_high_001",
        runId: "run_high",
        status: "running"
      }
    });

    await expect(runStore.loadRunById("run_canceled_head")).resolves.toMatchObject({
      status: "canceled"
    });
    await expect(sliceStore.listSlicesByRun("run_canceled_head")).resolves.toMatchObject([
      {
        sliceId: "slice_canceled_head_001",
        status: "queued"
      }
    ]);
  });

  it("recovers expired leases before targeted detached claims", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await runStore.createBackgroundTask({
      taskId: "task_expired_target_claim",
      workspaceId: "workspace_local",
      sessionId: "session_expired_target_claim",
      actorId: "actor_001",
      title: "Expired target claim",
      description: "recover expired detached claim path",
      sourceTurnId: "turn_expired_target_claim",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_expired_target_claim",
      taskId: "task_expired_target_claim",
      workspaceId: "workspace_local",
      sessionId: "session_expired_target_claim",
      actorId: "actor_001",
      idempotencyKey: "seed:run-expired-target-claim",
      turnRequest: {
        turnId: "turn_expired_target_claim",
        sessionId: "session_expired_target_claim",
        workspaceId: "workspace_local",
        actorId: "actor_001",
        source: "cli",
        input: "resume detached run after expired lease",
        requestedMode: "chat",
        originTurnId: "turn_expired_target_claim"
      },
      sourceTurnId: "turn_expired_target_claim",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueNextSlice({
      sliceId: "slice_expired_target_claim_001",
      runId: "run_expired_target_claim",
      taskId: "task_expired_target_claim",
      triggerKind: "operator_resume",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    const db = new Database(paths.tasks);
    db.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_crashed',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'operator_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-30T00:00:01.000Z",
      "2026-04-30T00:00:01.000Z",
      "2026-04-30T00:00:30.000Z",
      "2026-04-30T00:00:01.000Z",
      JSON.stringify({ checkpointRef: "checkpoint:run_expired_target_claim" }),
      "2026-04-30T00:00:01.000Z",
      "2026-04-30T00:00:01.000Z",
      "run_expired_target_claim"
    );
    db.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_crashed',
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-04-30T00:00:30.000Z",
      "2026-04-30T00:00:01.000Z",
      "2026-04-30T00:00:01.000Z",
      JSON.stringify({ checkpointRef: "checkpoint:run_expired_target_claim" }),
      "2026-04-30T00:00:01.000Z",
      "slice_expired_target_claim_001"
    );
    db.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.claimRunnableSliceForRun({
      runId: "run_expired_target_claim",
      workerId: "worker_recovery",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:02:00.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      run: {
        runId: "run_expired_target_claim",
        status: "running",
        continuationKind: "recovery_retry"
      },
      slice: {
        runId: "run_expired_target_claim",
        status: "running",
        triggerKind: "recovery_retry",
        sliceNo: 2
      }
    });

    await expect(sliceStore.listSlicesByRun("run_expired_target_claim")).resolves.toMatchObject([
      {
        sliceId: "slice_expired_target_claim_001",
        status: "lease_expired",
        triggerKind: "operator_resume"
      },
      {
        sliceNo: 2,
        status: "running",
        triggerKind: "recovery_retry"
      }
    ]);
  });

  it("treats stale slice-claim races as lost_race and keeps run truth unchanged", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await runStore.createBackgroundTask({
      taskId: "task_race_lane",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Lane race task",
      description: "simulate stale lane claim",
      sourceTurnId: "turn_race_lane",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_race_lane",
      taskId: "task_race_lane",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "seed:run-race-lane",
      turnRequest: {
        turnId: "turn_race_lane",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_lane",
        source: "cli",
        input: "lane race",
        originTurnId: "turn_race_lane"
      },
      sourceTurnId: "turn_race_lane",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_race_lane_001",
      runId: "run_race_lane",
      taskId: "task_race_lane",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_race_target",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Target race task",
      description: "simulate stale targeted claim",
      sourceTurnId: "turn_race_target",
      now: "2026-04-30T00:00:00.030Z"
    });
    await runStore.enqueueRun({
      runId: "run_race_target",
      taskId: "task_race_target",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "seed:run-race-target",
      turnRequest: {
        turnId: "turn_race_target",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_target",
        source: "cli",
        input: "target race",
        originTurnId: "turn_race_target"
      },
      sourceTurnId: "turn_race_target",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.040Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_race_target_001",
      runId: "run_race_target",
      taskId: "task_race_target",
      lane: "background",
      now: "2026-04-30T00:00:00.050Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_run_claim_race_lane
      AFTER UPDATE OF status ON task_runs
      FOR EACH ROW
      WHEN NEW.run_id = 'run_race_lane' AND NEW.status = 'running'
      BEGIN
        UPDATE runtime_slices SET status = 'running' WHERE slice_id = 'slice_race_lane_001';
      END;
    `);
    triggerDb.exec(`
      CREATE TRIGGER trg_run_claim_race_target
      AFTER UPDATE OF status ON task_runs
      FOR EACH ROW
      WHEN NEW.run_id = 'run_race_target' AND NEW.status = 'running'
      BEGIN
        UPDATE runtime_slices SET status = 'running' WHERE slice_id = 'slice_race_target_001';
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.claimNextRunnableSlice({
      workerId: "worker_lane",
      lane: "background",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.000Z"
    })).resolves.toEqual({ status: "lost_race" });
    await expect(runStore.loadRunById("run_race_lane")).resolves.toMatchObject({ status: "queued" });

    await expect(lifecycle.claimRunnableSliceForRun({
      runId: "run_race_target",
      workerId: "worker_target",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.500Z"
    })).resolves.toEqual({ status: "lost_race" });
    await expect(runStore.loadRunById("run_race_target")).resolves.toMatchObject({ status: "queued" });
  });

  it("finalizes a yielded slice by consuming ordered controls, refreshing human-input markers, and enqueuing one next slice", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Task",
      description: "queued slice",
      sourceTurnId: "turn_001",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:00.100Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      lane: "foreground",
      now: "2026-04-30T00:00:00.200Z"
    });
    await sliceStore.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "foreground",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.300Z"
    });

    await controlStore.appendControlInput({
      controlId: "control_001",
      taskId: "task_001",
      runId: "run_001",
      kind: "steer",
      payload: { text: "narrow scope" },
      createdAt: "2026-04-30T00:00:00.350Z"
    });
    await controlStore.appendControlInput({
      controlId: "control_002",
      taskId: "task_001",
      runId: "run_001",
      kind: "continue",
      payload: { text: "keep going" },
      createdAt: "2026-04-30T00:00:00.400Z"
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      },
      decideNextAction: () => ({ decision: "continue" })
    });

    const finalized = await lifecycle.finalizeSliceResult({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      lane: "foreground",
      result: {
        terminalStatus: "yielded",
        resultSummary: "paused safely",
        continuation: {
          kind: "auto_continue",
          payload: {
            checkpointRef: "checkpoint:001"
          },
          pendingControlRef: "frame:001"
        },
        usageSummary: {
          inputTokens: 12,
          outputTokens: 5,
          totalTokens: 17,
          estimatedCost: 0.1,
          toolCallCount: 2
        }
      },
      now: "2026-04-30T00:00:01.000Z"
    });

    expect(finalized.run).toMatchObject({
      status: "queued",
      continuationKind: "auto_continue",
      pendingControlRef: "frame:001",
      autonomyWindowSliceCount: 1,
      autonomyWindowToolCallCount: 2,
      lastHumanInputAt: "2026-04-30T00:00:00.400Z"
    });
    expect(finalized.nextSlice).toMatchObject({
      sliceNo: 2,
      triggerKind: "auto_continue",
      lane: "foreground",
      status: "queued"
    });
    await expect(controlStore.listPendingControls("run_001")).resolves.toEqual([]);
    await expect(sliceStore.listSlicesByRun("run_001")).resolves.toMatchObject([
      { sliceId: "slice_001", status: "yielded" },
      { sliceId: finalized.nextSlice?.sliceId, status: "queued", triggerKind: "auto_continue" }
    ]);
  });

  it("finalizes slice state against transaction-local cancel truth before planning the next slice", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_atomic_cancel",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_atomic_cancel",
      workspaceId: "workspace_local",
      sessionId: "session_atomic_cancel",
      title: "Atomic cancel task",
      description: "cancel arrives at the slice boundary",
      sourceTurnId: "turn_atomic_cancel",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_atomic_cancel",
      taskId: "task_atomic_cancel",
      workspaceId: "workspace_local",
      sessionId: "session_atomic_cancel",
      attentionMode: "foreground_attached",
      now: "2026-04-30T00:00:00.100Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_atomic_cancel_001",
      runId: "run_atomic_cancel",
      taskId: "task_atomic_cancel",
      lane: "foreground",
      now: "2026-04-30T00:00:00.200Z"
    });
    await sliceStore.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "foreground",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:00.300Z"
    });

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_slice_boundary_inserts_cancel
      AFTER UPDATE OF status ON runtime_slices
      FOR EACH ROW
      WHEN NEW.slice_id = 'slice_atomic_cancel_001' AND NEW.status = 'yielded'
      BEGIN
        INSERT INTO run_control_inputs (
          control_id,
          task_id,
          run_id,
          kind,
          payload_json,
          created_at
        ) VALUES (
          'control_atomic_cancel_001',
          'task_atomic_cancel',
          'run_atomic_cancel',
          'cancel',
          '{"reason":"boundary cancel wins"}',
          '2026-04-30T00:00:00.350Z'
        );
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    const finalized = await lifecycle.finalizeSliceResult({
      sliceId: "slice_atomic_cancel_001",
      runId: "run_atomic_cancel",
      taskId: "task_atomic_cancel",
      lane: "foreground",
      result: {
        terminalStatus: "yielded",
        resultSummary: "paused safely",
        continuation: {
          kind: "auto_continue",
          payload: {
            checkpointRef: "checkpoint:atomic-cancel"
          },
          pendingControlRef: "frame:atomic-cancel"
        },
        usageSummary: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          estimatedCost: 0.01,
          toolCallCount: 1
        }
      },
      now: "2026-04-30T00:00:01.000Z"
    });

    expect(finalized.run).toMatchObject({
      status: "canceled",
      cancelReason: "boundary cancel wins",
      continuationKind: undefined
    });
    expect(finalized.nextSlice).toBeUndefined();
    await expect(controlStore.listPendingControls("run_atomic_cancel")).resolves.toEqual([]);
    await expect(sliceStore.listSlicesByRun("run_atomic_cancel")).resolves.toMatchObject([
      { sliceId: "slice_atomic_cancel_001", status: "yielded" }
    ]);
  });

  it("accepts cancel control with full latch truth and rolls both control + latch back on failure", async () => {
    const paths = await tempDbPaths();
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });
    const sessionStore = createSessionStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      sessionId: "session_cancel_acceptance",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_seed",
      actorId: "actor_001",
      input: "seed",
      attachments: []
    });

    for (const runId of ["run_cancel_acceptance_ok", "run_cancel_acceptance_rollback"] as const) {
      await runStore.createBackgroundTask({
        taskId: runId === "run_cancel_acceptance_ok" ? "task_cancel_acceptance_ok" : "task_cancel_acceptance_rollback",
        workspaceId: "workspace_local",
        sessionId: "session_cancel_acceptance",
        title: runId === "run_cancel_acceptance_ok" ? "Cancel acceptance ok" : "Cancel acceptance rollback",
        description: "cancel control acceptance",
        sourceTurnId: `turn_${runId}`,
        now: "2026-04-30T00:00:00.000Z"
      });
      await runStore.createRun({
        runId,
        taskId: runId === "run_cancel_acceptance_ok" ? "task_cancel_acceptance_ok" : "task_cancel_acceptance_rollback",
        workspaceId: "workspace_local",
        sessionId: "session_cancel_acceptance",
        attentionMode: "foreground_attached",
        now: "2026-04-30T00:00:00.100Z"
      });
    }

    const triggerDb = new Database(paths.tasks);
    triggerDb.exec(`
      CREATE TRIGGER trg_cancel_acceptance_require_full_latch
      BEFORE UPDATE OF cancel_requested_at ON task_runs
      FOR EACH ROW
      WHEN NEW.run_id = 'run_cancel_acceptance_ok'
        AND NEW.cancel_requested_at IS NOT NULL
        AND (NEW.cancel_requested_by IS NULL OR NEW.cancel_reason IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'cancel latch must persist actor and reason');
      END;

      CREATE TRIGGER trg_cancel_acceptance_force_rollback
      AFTER UPDATE OF cancel_requested_at ON task_runs
      FOR EACH ROW
      WHEN NEW.run_id = 'run_cancel_acceptance_rollback'
        AND NEW.cancel_requested_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'force cancel acceptance rollback');
      END;
    `);
    triggerDb.close();

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore,
      sliceStore,
      controlStore,
      sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    await expect(lifecycle.acceptMessageOrControl({
      sessionId: "session_cancel_acceptance",
      taskId: "task_cancel_acceptance_ok",
      runId: "run_cancel_acceptance_ok",
      attentionMode: "foreground_attached",
      control: {
        controlId: "control_cancel_acceptance_ok",
        kind: "cancel",
        payload: {
          actorId: "operator_alpha",
          reason: "stop now"
        }
      },
      now: "2026-04-30T00:00:01.000Z"
    })).resolves.toBeUndefined();

    await expect(runStore.loadRunById("run_cancel_acceptance_ok")).resolves.toMatchObject({
      cancelRequestedAt: "2026-04-30T00:00:01.000Z",
      cancelRequestedBy: "operator_alpha",
      cancelReason: "stop now"
    });
    await expect(controlStore.listPendingControls("run_cancel_acceptance_ok")).resolves.toEqual([
      expect.objectContaining({
        controlId: "control_cancel_acceptance_ok",
        kind: "cancel",
        payload: {
          actorId: "operator_alpha",
          reason: "stop now"
        }
      })
    ]);

    await expect(lifecycle.acceptMessageOrControl({
      sessionId: "session_cancel_acceptance",
      taskId: "task_cancel_acceptance_rollback",
      runId: "run_cancel_acceptance_rollback",
      attentionMode: "foreground_attached",
      control: {
        controlId: "control_cancel_acceptance_rollback",
        kind: "cancel",
        payload: {
          actorId: "operator_beta",
          reason: "rollback me"
        }
      },
      now: "2026-04-30T00:00:02.000Z"
    })).rejects.toThrow("force cancel acceptance rollback");

    await expect(runStore.loadRunById("run_cancel_acceptance_rollback")).resolves.toMatchObject({
      cancelRequestedAt: undefined,
      cancelRequestedBy: undefined,
      cancelReason: undefined
    });
    await expect(controlStore.listPendingControls("run_cancel_acceptance_rollback")).resolves.toEqual([]);
  });

  it("promotes the next detached continuation slice back to foreground after steer capture", async () => {
    const paths = await tempDbPaths();
    const fixture = await seedClaimedSliceFixture({
      paths,
      taskId: "task_detached_steer_resume",
      runId: "run_detached_steer_resume",
      sessionId: "session_detached_steer_resume",
      turnId: "turn_detached_steer_resume",
      triggerKind: "auto_continue",
      runContinuationKind: "auto_continue",
      runContinuationPayload: {
        checkpointRef: "checkpoint:detached_steer_resume"
      }
    });

    await fixture.sessionStore.loadOrCreate({
      turnId: "turn_detached_steer_resume_seed",
      sessionId: "session_detached_steer_resume",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });
    await fixture.sessionStore.setFocusRun({
      sessionId: "session_detached_steer_resume",
      taskId: "task_detached_steer_resume",
      runId: "run_detached_steer_resume",
      now: "2026-04-30T00:00:00.900Z"
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore: fixture.runStore,
      sliceStore: fixture.sliceStore,
      controlStore: fixture.controlStore,
      sessionStore: fixture.sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    const claimed = await lifecycle.claimRunnableSliceForRun({
      runId: "run_detached_steer_resume",
      workerId: "worker_detached_steer_resume",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.000Z"
    });
    expect(claimed).toMatchObject({
      status: "claimed",
      run: {
        runId: "run_detached_steer_resume",
        status: "running"
      },
      slice: {
        lane: "background",
        triggerKind: "auto_continue"
      }
    });

    await expect(lifecycle.acceptMessageOrControl({
      sessionId: "session_detached_steer_resume",
      taskId: "task_detached_steer_resume",
      runId: "run_detached_steer_resume",
      attentionMode: "background_detached",
      control: {
        controlId: "control_detached_steer_resume",
        kind: "steer",
        payload: {
          text: "bring this back to the foreground"
        }
      },
      reengageToForeground: true,
      now: "2026-04-30T00:00:01.100Z"
    })).resolves.toBeUndefined();

    const claimedSlice = (claimed as Extract<typeof claimed, { status: "claimed" }>).slice;
    await expect(lifecycle.finalizeSliceResult({
      sliceId: claimedSlice.sliceId,
      runId: "run_detached_steer_resume",
      taskId: "task_detached_steer_resume",
      lane: "background",
      result: {
        terminalStatus: "yielded",
        resultSummary: "paused for more guidance",
        continuation: {
          kind: "auto_continue",
          payload: {
            checkpointRef: "checkpoint:detached_steer_resume:next"
          },
          pendingControlRef: "frame:detached_steer_resume"
        },
        usageSummary: {
          inputTokens: 9,
          outputTokens: 4,
          totalTokens: 13,
          estimatedCost: 0.05
        }
      },
      now: "2026-04-30T00:00:01.300Z"
    })).resolves.toMatchObject({
      run: expect.objectContaining({
        runId: "run_detached_steer_resume",
        status: "queued",
        attentionMode: "foreground_attached",
        lastHumanInputAt: "2026-04-30T00:00:01.100Z"
      }),
      nextSlice: expect.objectContaining({
        sliceNo: 2,
        lane: "foreground",
        triggerKind: "auto_continue",
        status: "queued"
      })
    });
  });

  it("clears preserved inflight truth when a detached slice finalizes canceled after a late cancel", async () => {
    const paths = await tempDbPaths();
    const taskId = "task_detached_cancel_after_shell";
    const runId = "run_detached_cancel_after_shell";
    const sessionId = "session_detached_cancel_after_shell";
    const turnId = "turn_detached_cancel_after_shell";
    const fixture = await seedClaimedSliceFixture({
      paths,
      taskId,
      runId,
      sessionId,
      turnId,
      triggerKind: "recovery_retry",
      runContinuationKind: "recovery_retry",
      runContinuationPayload: {
        checkpointRef: "checkpoint:detached_cancel_after_shell"
      },
      sliceContinuationPayload: {
        checkpointRef: "checkpoint:detached_cancel_after_shell"
      }
    });

    await fixture.sessionStore.loadOrCreate({
      sessionId,
      workspaceId: "workspace_local",
      source: "cli",
      turnId,
      actorId: "actor_001",
      input: "resume detached slice",
      attachments: []
    });
    await fixture.sessionStore.markInflight({
      turnId: runId,
      sessionId,
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      checkpointRef: "checkpoint:detached_cancel_after_shell",
      frameRef: "frame:detached_cancel_after_shell",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:detached_cancel_after_shell",
        frameRef: "frame:detached_cancel_after_shell",
        checkpointRef: "checkpoint:detached_cancel_after_shell",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:detached_cancel_after_shell",
          checkpointRef: "checkpoint:detached_cancel_after_shell",
          turnId: runId,
          sessionId,
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "recovery_retry",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              actorId: "actor_001"
            }
          }
        }
      }
    });

    const lifecycle = createRunLifecycle({
      tasksDbPath: paths.tasks,
      runStore: fixture.runStore,
      sliceStore: fixture.sliceStore,
      controlStore: fixture.controlStore,
      sessionStore: fixture.sessionStore,
      executeTurnSlice: async () => {
        throw new Error("not used");
      },
      continueSlice: async () => {
        throw new Error("not used");
      },
      resolveApprovalSlice: async () => {
        throw new Error("not used");
      }
    });

    const claimed = await lifecycle.claimRunnableSliceForRun({
      runId,
      workerId: "worker_detached_cancel_after_shell",
      leaseDurationMs: 60_000,
      now: "2026-04-30T00:00:01.000Z"
    });
    expect(claimed).toMatchObject({
      status: "claimed",
      run: {
        runId,
        status: "running"
      },
      slice: {
        runId,
        status: "running",
        triggerKind: "recovery_retry"
      }
    });

    await fixture.runStore.requestRunCancellation({
      runId,
      actorId: "operator_cancel_after_shell",
      reason: "cancel after shell",
      now: "2026-04-30T00:00:01.100Z"
    });

    await expect(lifecycle.finalizeSliceResult({
      sliceId: (claimed as Extract<typeof claimed, { status: "claimed" }>).slice.sliceId,
      runId,
      taskId,
      lane: "background",
      result: {
        terminalStatus: "canceled",
        resultSummary: "cancel after shell"
      },
      now: "2026-04-30T00:00:01.200Z"
    })).resolves.toMatchObject({
      run: expect.objectContaining({
        runId,
        status: "canceled"
      }),
      slice: expect.objectContaining({
        sliceId: (claimed as Extract<typeof claimed, { status: "claimed" }>).slice.sliceId,
        status: "canceled"
      })
    });

    await expect(fixture.sessionStore.loadRecoveryContext(sessionId)).resolves.toBeNull();
    await expect(fixture.runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "canceled",
      recoveryTruthState: "closed"
    });
  });
});
