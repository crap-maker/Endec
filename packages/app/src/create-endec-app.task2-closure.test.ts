import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderTransport } from "@endec/ai";
import { createSessionStore } from "@endec/sessions";
import {
  createRunControlStore,
  createRuntimeSliceStore,
  createTaskEventStore,
  createTaskRunStore,
  createTaskStore
} from "@endec/tasks";
import { createBackgroundOperator } from "./background-operator.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";
import { createEndecApp } from "./index.ts";
import * as runLifecycleModule from "./run-lifecycle.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";

type JsonObject = Record<string, unknown>;

function createChatCompletionTransport(responses: Array<Array<JsonObject>>): ProviderTransport {
  let index = 0;

  return {
    async *stream() {
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
  };
}

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-app-task2-closure-"));
}

const tempDirs = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...tempDirs].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    tempDirs.delete(directory);
  }));
});

function buildDetachedOperatorRecoveryPayload(input: {
  runId: string;
  sessionId: string;
  workspaceId: string;
  mode?: "chat" | "act";
}) {
  return {
    checkpointRef: `checkpoint:${input.runId}`,
    recovery: {
      schemaVersion: 1 as const,
      contractVersion: "im.task2.slice-recovery.v1" as const,
      turnId: input.runId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      source: "cli" as const,
      mode: input.mode ?? "chat",
      checkpointRef: `checkpoint:${input.runId}`,
      frameRef: `frame:${input.runId}`,
      pendingExecution: {
        schemaVersion: 1 as const,
        contractVersion: "ws0.pending-execution.v1" as const,
        pendingExecutionId: `pending:${input.runId}`,
        frameRef: `frame:${input.runId}`,
        checkpointRef: `checkpoint:${input.runId}`,
        status: "ready" as const,
        frame: {
          schemaVersion: 1 as const,
          contractVersion: "ws0.execution-frame.v1" as const,
          frameRef: `frame:${input.runId}`,
          checkpointRef: `checkpoint:${input.runId}`,
          turnId: input.runId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          phase: "awaiting_operator" as const,
          step: "confirmation",
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
            continuationKind: "resume" as const,
            allowedActions: ["resume", "cancel"] as Array<"resume" | "cancel">,
            metadata: {
              actorId: "actor_cli"
            }
          }
        }
      }
    }
  };
}

async function seedFreshQueuedDetachedRun(input: {
  dataDir: string;
  taskId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  mode?: "chat" | "act";
}) {
  const paths = ensureEndecDataLayout(input.dataDir);
  const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
  const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
  const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

  await sessionStore.loadOrCreate({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    source: "cli"
  });
  await runStore.createBackgroundTask({
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    actorId: "actor_cli",
    title: `Task ${input.taskId}`,
    description: `Fresh detached fixture for ${input.runId}`,
    sourceTurnId: `turn_${input.runId}_origin`,
    now: "2026-05-01T00:00:00.000Z"
  });
  await runStore.enqueueRun({
    runId: input.runId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    actorId: "actor_cli",
    idempotencyKey: `seed:${input.runId}`,
    turnRequest: {
      turnId: `turn_${input.runId}_origin`,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      actorId: "actor_cli",
      source: "cli" as const,
      input: `continue ${input.runId}`,
      requestedMode: input.mode ?? "chat",
      originTurnId: `turn_${input.runId}_origin`
    },
    sourceTurnId: `turn_${input.runId}_origin`,
    maxAttempts: 1,
    seedInitialSlice: true,
    now: "2026-05-01T00:00:00.010Z"
  });

  return {
    paths,
    sessionStore,
    runStore,
    sliceStore
  };
}

async function seedQueuedDetachedOperatorSlice(input: {
  dataDir: string;
  taskId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  mode?: "chat" | "act";
}) {
  const paths = ensureEndecDataLayout(input.dataDir);
  const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
  const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
  const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
  const controlStore = createRunControlStore({ filename: paths.tasksDbPath });

  await sessionStore.loadOrCreate({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    source: "cli"
  });
  await runStore.createBackgroundTask({
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    actorId: "actor_cli",
    title: `Task ${input.taskId}`,
    description: `Detached Task 2 fixture for ${input.runId}`,
    sourceTurnId: `turn_${input.runId}_origin`,
    now: "2026-05-01T00:00:00.000Z"
  });
  await runStore.enqueueRun({
    runId: input.runId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    actorId: "actor_cli",
    idempotencyKey: `seed:${input.runId}`,
    turnRequest: {
      turnId: `turn_${input.runId}_origin`,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      actorId: "actor_cli",
      source: "cli" as const,
      input: `continue ${input.runId}`,
      requestedMode: input.mode ?? "chat",
      originTurnId: `turn_${input.runId}_origin`
    },
    sourceTurnId: `turn_${input.runId}_origin`,
    maxAttempts: 1,
    now: "2026-05-01T00:00:00.010Z"
  });

  const continuationPayload = buildDetachedOperatorRecoveryPayload({
    runId: input.runId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    mode: input.mode
  });
  await sliceStore.enqueueNextSlice({
    sliceId: `slice_${input.runId}_001`,
    runId: input.runId,
    taskId: input.taskId,
    triggerKind: "operator_resume",
    lane: "background",
    now: "2026-05-01T00:00:00.020Z"
  });

  const taskDb = new Database(paths.tasksDbPath);
  taskDb.prepare(`
    UPDATE task_runs
    SET continuation_kind = 'operator_resume',
        continuation_payload_json = ?,
        continuation_updated_at = ?,
        pending_control_ref = ?,
        updated_at = ?
    WHERE run_id = ?
  `).run(
    JSON.stringify(continuationPayload),
    "2026-05-01T00:00:00.020Z",
    `frame:${input.runId}`,
    "2026-05-01T00:00:00.020Z",
    input.runId
  );
  taskDb.prepare(`
    UPDATE runtime_slices
    SET continuation_payload_json = ?,
        updated_at = ?
    WHERE slice_id = ?
  `).run(
    JSON.stringify(continuationPayload),
    "2026-05-01T00:00:00.020Z",
    `slice_${input.runId}_001`
  );
  taskDb.close();

  return {
    paths,
    sessionStore,
    runStore,
    sliceStore,
    controlStore,
    continuationPayload
  };
}

async function seedBlockedDetachedRun(input: {
  dataDir: string;
  taskId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  mode?: "chat" | "act";
}) {
  const seeded = await seedFreshQueuedDetachedRun(input);
  const continuationPayload = buildDetachedOperatorRecoveryPayload({
    runId: input.runId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    mode: input.mode
  });
  const blockedNow = "2026-05-01T00:00:00.020Z";
  const pendingApprovalRef = `approval:${input.runId}`;
  const pendingControlRef = `frame:${input.runId}`;

  const taskDb = new Database(seeded.paths.tasksDbPath);
  taskDb.prepare(`
    UPDATE task_runs
    SET status = 'blocked',
        continuation_kind = 'approval_resume',
        continuation_payload_json = ?,
        continuation_updated_at = ?,
        pending_approval_ref = ?,
        pending_control_ref = ?,
        result_summary = ?,
        updated_at = ?
    WHERE run_id = ?
  `).run(
    JSON.stringify(continuationPayload),
    blockedNow,
    pendingApprovalRef,
    pendingControlRef,
    "blocked: permission",
    blockedNow,
    input.runId
  );
  taskDb.prepare(`
    UPDATE tasks
    SET agent_status = 'blocked',
        status = 'blocked',
        blocking_reason = 'permission',
        updated_at = ?
    WHERE task_id = ?
  `).run(
    blockedNow,
    input.taskId
  );
  taskDb.prepare(`
    UPDATE runtime_slices
    SET status = 'blocked',
        continuation_payload_json = ?,
        result_summary = ?,
        finished_at = ?,
        updated_at = ?
    WHERE slice_id = ?
  `).run(
    JSON.stringify(continuationPayload),
    "blocked: permission",
    blockedNow,
    blockedNow,
    `slice_${input.runId}_001`
  );
  taskDb.close();

  await seeded.sessionStore.markInflight({
    turnId: input.runId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    state: "awaiting_permission",
    waitingReason: "permission",
    resumePolicy: "resume",
    loopCount: 0,
    toolCallCount: 0,
    pendingApprovalRef,
    checkpointRef: continuationPayload.recovery.checkpointRef,
    frameRef: continuationPayload.recovery.frameRef,
    contractVersion: "ws0.pending-execution.v1",
    pendingExecution: continuationPayload.recovery.pendingExecution
  });

  return {
    ...seeded,
    continuationPayload,
    pendingApprovalRef,
    pendingControlRef
  };
}

async function seedBlockedDetachedResumeRun(input: {
  dataDir: string;
  taskId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  mode?: "chat" | "act";
}) {
  const seeded = await seedFreshQueuedDetachedRun(input);
  const continuationPayload = buildDetachedOperatorRecoveryPayload({
    runId: input.runId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    mode: input.mode
  });
  const blockedNow = "2026-05-01T00:00:00.020Z";
  const pendingControlRef = `frame:${input.runId}`;

  const taskDb = new Database(seeded.paths.tasksDbPath);
  taskDb.prepare(`
    UPDATE task_runs
    SET status = 'blocked',
        continuation_kind = 'operator_resume',
        continuation_payload_json = ?,
        continuation_updated_at = ?,
        pending_approval_ref = NULL,
        pending_control_ref = ?,
        result_summary = ?,
        updated_at = ?
    WHERE run_id = ?
  `).run(
    JSON.stringify(continuationPayload),
    blockedNow,
    pendingControlRef,
    "blocked: resume",
    blockedNow,
    input.runId
  );
  taskDb.prepare(`
    UPDATE tasks
    SET agent_status = 'blocked',
        status = 'blocked',
        blocking_reason = 'user_decision',
        updated_at = ?
    WHERE task_id = ?
  `).run(
    blockedNow,
    input.taskId
  );
  taskDb.prepare(`
    UPDATE runtime_slices
    SET status = 'blocked',
        continuation_payload_json = ?,
        result_summary = ?,
        finished_at = ?,
        updated_at = ?
    WHERE slice_id = ?
  `).run(
    JSON.stringify(continuationPayload),
    "blocked: resume",
    blockedNow,
    blockedNow,
    `slice_${input.runId}_001`
  );
  taskDb.close();

  await seeded.sessionStore.markInflight({
    turnId: input.runId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    state: "awaiting_user_decision",
    waitingReason: "user_decision",
    resumePolicy: "resume",
    loopCount: 0,
    toolCallCount: 0,
    checkpointRef: continuationPayload.recovery.checkpointRef,
    frameRef: continuationPayload.recovery.frameRef,
    contractVersion: "ws0.pending-execution.v1",
    pendingExecution: continuationPayload.recovery.pendingExecution
  });

  return {
    ...seeded,
    continuationPayload,
    pendingControlRef
  };
}

function taskAgentStatusForTerminalRun(status: "completed" | "failed" | "canceled") {
  switch (status) {
    case "completed":
      return "done" as const;
    case "failed":
      return "failed" as const;
    case "canceled":
      return "canceled" as const;
  }
}

function taskLegacyStatusForTerminalRun(status: "completed" | "failed" | "canceled") {
  switch (status) {
    case "completed":
      return "done" as const;
    case "failed":
      return "failed" as const;
    case "canceled":
      return "cancelled" as const;
  }
}

async function forceDetachedRunTerminalState(input: {
  tasksDbPath: string;
  taskId: string;
  runId: string;
  terminalStatus: "completed" | "failed" | "canceled";
  resultSummary: string;
}) {
  const now = "2026-05-01T00:00:00.090Z";
  const taskDb = new Database(input.tasksDbPath);
  taskDb.prepare(`
    UPDATE task_runs
    SET status = ?,
        worker_id = NULL,
        claimed_at = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        continuation_kind = NULL,
        continuation_payload_json = NULL,
        continuation_updated_at = NULL,
        pending_approval_ref = NULL,
        pending_control_ref = NULL,
        result_summary = ?,
        finished_at = ?,
        updated_at = ?
    WHERE run_id = ?
  `).run(
    input.terminalStatus,
    input.resultSummary,
    now,
    now,
    input.runId
  );
  taskDb.prepare(`
    UPDATE tasks
    SET agent_status = ?,
        status = ?,
        blocking_reason = NULL,
        updated_at = ?
    WHERE task_id = ?
  `).run(
    taskAgentStatusForTerminalRun(input.terminalStatus),
    taskLegacyStatusForTerminalRun(input.terminalStatus),
    now,
    input.taskId
  );
  taskDb.prepare(`
    UPDATE runtime_slices
    SET status = ?,
        result_summary = ?,
        finished_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = ?
    WHERE run_id = ? AND status IN ('queued', 'running', 'blocked')
  `).run(
    input.terminalStatus,
    input.resultSummary,
    now,
    now,
    input.runId
  );
  taskDb.close();
}

describe("createEndecApp Task 2 final closure", () => {
  it("cancels a fresh detached queued run before any worker claim or legacy cutover migration", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { runStore, sliceStore } = await seedFreshQueuedDetachedRun({
      dataDir,
      taskId: "task_detached_fresh_cancel",
      runId: "run_detached_fresh_cancel",
      sessionId: "session_detached_fresh_cancel",
      workspaceId: "workspace_local"
    });

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_detached_fresh_cancel",
      workspaceId: "workspace_local",
      turnId: "run_detached_fresh_cancel",
      reason: "operator canceled fresh detached run"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_detached_fresh_cancel",
      warnings: ["operator canceled fresh detached run"]
    });

    await expect(runStore.loadRunById("run_detached_fresh_cancel")).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled fresh detached run"
    });
    await expect(sliceStore.listSlicesByRun("run_detached_fresh_cancel")).resolves.toEqual([
      expect.objectContaining({
        triggerKind: "initial",
        lane: "background",
        status: "canceled"
      })
    ]);
  });

  it("routes detached queued cancel through durable Task 2 run truth", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { runStore, sliceStore } = await seedQueuedDetachedOperatorSlice({
      dataDir,
      taskId: "task_detached_queued_cancel",
      runId: "run_detached_queued_cancel",
      sessionId: "session_detached_queued_cancel",
      workspaceId: "workspace_local"
    });

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_detached_queued_cancel",
      workspaceId: "workspace_local",
      turnId: "run_detached_queued_cancel",
      reason: "operator canceled queued detached run"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_detached_queued_cancel",
      warnings: ["operator canceled queued detached run"]
    });

    await expect(runStore.loadRunById("run_detached_queued_cancel")).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled queued detached run",
      continuationKind: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_detached_queued_cancel")).resolves.toMatchObject([
      {
        sliceId: "slice_run_detached_queued_cancel_001",
        status: "canceled",
        triggerKind: "operator_resume"
      }
    ]);
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_detached_queued_cancel" })).resolves.toBeNull();
  });

  it("cancels a detached queued run without requiring continuation payload truth", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { paths, runStore, sliceStore } = await seedQueuedDetachedOperatorSlice({
      dataDir,
      taskId: "task_detached_queued_cancel_without_payload",
      runId: "run_detached_queued_cancel_without_payload",
      sessionId: "session_detached_queued_cancel_without_payload",
      workspaceId: "workspace_local"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET continuation_kind = NULL,
          continuation_payload_json = NULL,
          continuation_updated_at = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-05-01T00:00:00.025Z",
      "run_detached_queued_cancel_without_payload"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = NULL,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-05-01T00:00:00.025Z",
      "slice_run_detached_queued_cancel_without_payload_001"
    );
    taskDb.close();

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_detached_queued_cancel_without_payload",
      workspaceId: "workspace_local",
      turnId: "run_detached_queued_cancel_without_payload",
      reason: "operator canceled queued detached run without payload"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_detached_queued_cancel_without_payload",
      warnings: ["operator canceled queued detached run without payload"]
    });

    await expect(runStore.loadRunById("run_detached_queued_cancel_without_payload")).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled queued detached run without payload",
      continuationKind: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_detached_queued_cancel_without_payload")).resolves.toMatchObject([
      {
        sliceId: "slice_run_detached_queued_cancel_without_payload_001",
        status: "canceled",
        triggerKind: "operator_resume"
      }
    ]);
  });

  it("returns completed truth when detached queued cancel loses the race to terminal completion", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const originalCreateRunLifecycle = runLifecycleModule.createRunLifecycle;
    vi.spyOn(runLifecycleModule, "createRunLifecycle").mockImplementation((input) => {
      const lifecycle = originalCreateRunLifecycle(input);
      return {
        ...lifecycle,
        async cancelDetachedRun(cancelInput) {
          await forceDetachedRunTerminalState({
            tasksDbPath: input.tasksDbPath,
            taskId: cancelInput.taskId,
            runId: cancelInput.runId,
            terminalStatus: "completed",
            resultSummary: "detached run completed before cancel won"
          });
          return lifecycle.cancelDetachedRun(cancelInput);
        }
      };
    });

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { runStore } = await seedQueuedDetachedOperatorSlice({
      dataDir,
      taskId: "task_detached_cancel_terminal_race",
      runId: "run_detached_cancel_terminal_race",
      sessionId: "session_detached_cancel_terminal_race",
      workspaceId: "workspace_local"
    });

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_detached_cancel_terminal_race",
      workspaceId: "workspace_local",
      turnId: "run_detached_cancel_terminal_race",
      reason: "operator canceled after completion won"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_detached_cancel_terminal_race",
      warnings: []
    });

    await expect(runStore.loadRunById("run_detached_cancel_terminal_race")).resolves.toMatchObject({
      status: "completed",
      resultSummary: "detached run completed before cancel won"
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_detached_cancel_terminal_race" })).resolves.toBeNull();
  });

  it("skips deny interruption persistence when detached deny loses the race to terminal completion", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const originalCreateRunLifecycle = runLifecycleModule.createRunLifecycle;
    vi.spyOn(runLifecycleModule, "createRunLifecycle").mockImplementation((input) => {
      const lifecycle = originalCreateRunLifecycle(input);
      return {
        ...lifecycle,
        async closeBlockedRunTerminally(closeInput) {
          await forceDetachedRunTerminalState({
            tasksDbPath: input.tasksDbPath,
            taskId: closeInput.taskId,
            runId: closeInput.runId,
            terminalStatus: "completed",
            resultSummary: "detached run completed before deny won"
          });
          return lifecycle.closeBlockedRunTerminally(closeInput);
        }
      };
    });

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { runStore, pendingApprovalRef } = await seedBlockedDetachedRun({
      dataDir,
      taskId: "task_detached_deny_terminal_race",
      runId: "run_detached_deny_terminal_race",
      sessionId: "session_detached_deny_terminal_race",
      workspaceId: "workspace_local"
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_detached_deny_terminal_race",
      turnId: "run_detached_deny_terminal_race",
      decisionId: pendingApprovalRef,
      approved: false,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_detached_deny_terminal_race",
      warnings: []
    });

    await expect(runStore.loadRunById("run_detached_deny_terminal_race")).resolves.toMatchObject({
      status: "completed",
      resultSummary: "detached run completed before deny won"
    });

    const history = await app.operator.browseSessionHistory({
      sessionId: "session_detached_deny_terminal_race",
      limit: 20
    });
    expect(history.items.some((item) => item.turnId.startsWith("deny_run_detached_deny_terminal_race_"))).toBe(false);
    expect(history.items.some((item) => item.summary.includes("approval rejected for"))).toBe(false);
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_detached_deny_terminal_race" })).resolves.toBeNull();
  });

  it("returns accepted detached cancel truth when blocked cancel loses the race to approval resume", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const originalCreateRunLifecycle = runLifecycleModule.createRunLifecycle;
    vi.spyOn(runLifecycleModule, "createRunLifecycle").mockImplementation((input) => {
      const lifecycle = originalCreateRunLifecycle(input);
      return {
        ...lifecycle,
        async closeBlockedRunTerminally(closeInput) {
          await lifecycle.transitionBlockedRunToQueuedSlice({
            sessionId: closeInput.sessionId,
            taskId: closeInput.taskId,
            runId: closeInput.runId,
            attentionMode: "background_detached",
            triggerKind: "approval_resume",
            lane: "background",
            control: {
              kind: "continue",
              payload: {
                action: "approve",
                decisionId: `approval:${closeInput.runId}`
              }
            },
            continuationPayload: {
              approvedBy: "race-winner"
            },
            now: "2026-05-01T00:00:00.050Z"
          });
          await lifecycle.claimNextRunnableSlice({
            workerId: "worker_approval_resume_race",
            lane: "background",
            leaseDurationMs: 60_000,
            now: "2026-05-01T00:00:00.060Z"
          });
          await lifecycle.acceptMessageOrControl({
            sessionId: closeInput.sessionId,
            taskId: closeInput.taskId,
            runId: closeInput.runId,
            attentionMode: "background_detached",
            control: closeInput.control,
            now: "2026-05-01T00:00:00.070Z"
          });
          return undefined;
        }
      };
    });

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { paths, runStore } = await seedBlockedDetachedRun({
      dataDir,
      taskId: "task_detached_cancel_approval_race",
      runId: "run_detached_cancel_approval_race",
      sessionId: "session_detached_cancel_approval_race",
      workspaceId: "workspace_local"
    });
    const controlStore = createRunControlStore({ filename: paths.tasksDbPath });

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_detached_cancel_approval_race",
      workspaceId: "workspace_local",
      turnId: "run_detached_cancel_approval_race",
      reason: "operator canceled blocked detached run after approval won"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_detached_cancel_approval_race",
      warnings: ["operator canceled blocked detached run after approval won"]
    });

    await expect(runStore.loadRunById("run_detached_cancel_approval_race")).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "system:execution-control:cancel",
      cancelReason: "operator canceled blocked detached run after approval won"
    });
    await expect(controlStore.listPendingControls("run_detached_cancel_approval_race")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "cancel",
          payload: {
            reason: "operator canceled blocked detached run after approval won",
            requestedBy: "system:execution-control:cancel"
          }
        })
      ])
    );

    const history = await app.operator.browseSessionHistory({
      sessionId: "session_detached_cancel_approval_race",
      limit: 20
    });
    expect(history.items.some((item) => item.turnId.startsWith("cancel_run_detached_cancel_approval_race_"))).toBe(false);
  });

  it("returns accepted approval truth when detached deny loses the race to approval resume", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const originalCreateRunLifecycle = runLifecycleModule.createRunLifecycle;
    vi.spyOn(runLifecycleModule, "createRunLifecycle").mockImplementation((input) => {
      const lifecycle = originalCreateRunLifecycle(input);
      return {
        ...lifecycle,
        async closeBlockedRunTerminally(closeInput) {
          await lifecycle.transitionBlockedRunToQueuedSlice({
            sessionId: closeInput.sessionId,
            taskId: closeInput.taskId,
            runId: closeInput.runId,
            attentionMode: "background_detached",
            triggerKind: "approval_resume",
            lane: "background",
            control: {
              kind: "continue",
              payload: {
                action: "approve",
                decisionId: `approval:${closeInput.runId}`
              }
            },
            continuationPayload: {
              approvedBy: "race-winner"
            },
            now: "2026-05-01T00:00:00.050Z"
          });
          await lifecycle.claimNextRunnableSlice({
            workerId: "worker_approval_resume_race",
            lane: "background",
            leaseDurationMs: 60_000,
            now: "2026-05-01T00:00:00.060Z"
          });
          return undefined;
        }
      };
    });

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { runStore, pendingApprovalRef } = await seedBlockedDetachedRun({
      dataDir,
      taskId: "task_detached_deny_approval_race",
      runId: "run_detached_deny_approval_race",
      sessionId: "session_detached_deny_approval_race",
      workspaceId: "workspace_local"
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_detached_deny_approval_race",
      turnId: "run_detached_deny_approval_race",
      decisionId: pendingApprovalRef,
      approved: false,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_detached_deny_approval_race",
      warnings: [expect.stringContaining("Approval already accepted")]
    });

    await expect(runStore.loadRunById("run_detached_deny_approval_race")).resolves.toMatchObject({
      status: "running"
    });

    const history = await app.operator.browseSessionHistory({
      sessionId: "session_detached_deny_approval_race",
      limit: 20
    });
    expect(history.items.some((item) => item.turnId.startsWith("deny_run_detached_deny_approval_race_"))).toBe(false);
  });

  it.each([
    {
      action: "resume" as const,
      runId: "run_detached_resume_terminal_race",
      sessionId: "session_detached_resume_terminal_race",
      invoke: (app: ReturnType<typeof createEndecApp>) => app.shell.resumeTurn({
        sessionId: "session_detached_resume_terminal_race",
        workspaceId: "workspace_local",
        turnId: "run_detached_resume_terminal_race",
        input: "continue"
      }),
      seed: (dataDir: string) => seedBlockedDetachedResumeRun({
        dataDir,
        taskId: "task_detached_resume_terminal_race",
        runId: "run_detached_resume_terminal_race",
        sessionId: "session_detached_resume_terminal_race",
        workspaceId: "workspace_local"
      })
    },
    {
      action: "approve" as const,
      runId: "run_detached_approve_terminal_race",
      sessionId: "session_detached_approve_terminal_race",
      invoke: (app: ReturnType<typeof createEndecApp>, decisionId: string) => app.shell.resolveApproval({
        sessionId: "session_detached_approve_terminal_race",
        turnId: "run_detached_approve_terminal_race",
        decisionId,
        approved: true,
        approverId: "operator_001"
      }),
      seed: (dataDir: string) => seedBlockedDetachedRun({
        dataDir,
        taskId: "task_detached_approve_terminal_race",
        runId: "run_detached_approve_terminal_race",
        sessionId: "session_detached_approve_terminal_race",
        workspaceId: "workspace_local"
      })
    }
  ])("returns durable terminal truth when detached $action loses the blocked transition race", async ({ invoke, seed, runId, sessionId }) => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const originalCreateRunLifecycle = runLifecycleModule.createRunLifecycle;
    vi.spyOn(runLifecycleModule, "createRunLifecycle").mockImplementation((input) => {
      const lifecycle = originalCreateRunLifecycle(input);
      return {
        ...lifecycle,
        async transitionBlockedRunToQueuedSlice(transitionInput) {
          await forceDetachedRunTerminalState({
            tasksDbPath: input.tasksDbPath,
            taskId: transitionInput.taskId,
            runId: transitionInput.runId,
            terminalStatus: "completed",
            resultSummary: `${transitionInput.triggerKind} lost to terminal completion`
          });
          return lifecycle.transitionBlockedRunToQueuedSlice(transitionInput);
        }
      };
    });

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const seeded = await seed(dataDir);
    const decisionId = "pendingApprovalRef" in seeded && typeof seeded.pendingApprovalRef === "string"
      ? seeded.pendingApprovalRef
      : "unused";

    await expect(invoke(app, decisionId)).resolves.toMatchObject({
      status: "completed",
      turnId: runId,
      warnings: []
    });

    await expect(seeded.runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "completed",
      resultSummary: expect.stringContaining("lost to terminal completion")
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId })).resolves.toBeNull();
    await expect(app.operator.browseSessionHistory({ sessionId, limit: 20 })).resolves.toMatchObject({
      items: expect.not.arrayContaining([
        expect.objectContaining({
          turnId: expect.stringMatching(new RegExp(`^(resume|approve)_${runId}_`))
        })
      ])
    });
  });

  it("routes operator cancel for fresh detached queued runs through canonical Task 2 slice cancellation", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { runStore, sliceStore } = await seedFreshQueuedDetachedRun({
      dataDir,
      taskId: "task_operator_detached_fresh_cancel",
      runId: "run_operator_detached_fresh_cancel",
      sessionId: "session_operator_detached_fresh_cancel",
      workspaceId: "workspace_local"
    });

    await expect(app.operator.cancelBackgroundTask({
      taskId: "task_operator_detached_fresh_cancel",
      runId: "run_operator_detached_fresh_cancel",
      actorId: "operator_001",
      reason: "operator canceled fresh detached run"
    })).resolves.toMatchObject({
      status: "canceled",
      taskStatus: "canceled",
      runStatus: "canceled"
    });

    await expect(runStore.loadRunById("run_operator_detached_fresh_cancel")).resolves.toMatchObject({
      status: "canceled",
      cancelRequestedBy: "operator_001",
      cancelReason: "operator canceled fresh detached run"
    });
    const canceledSlices = await sliceStore.listSlicesByRun("run_operator_detached_fresh_cancel");
    expect(canceledSlices).toEqual([
      expect.objectContaining({
        sliceId: "slice_run_operator_detached_fresh_cancel_001",
        triggerKind: "initial",
        lane: "background",
        status: "canceled"
      })
    ]);
    expect(canceledSlices.some((slice) => slice.status === "queued" || slice.status === "running")).toBe(false);
  });

  it("routes operator cancel for blocked detached runs through canonical Task 2 blocked closure", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { sessionStore, runStore, sliceStore } = await seedBlockedDetachedRun({
      dataDir,
      taskId: "task_operator_detached_blocked_cancel",
      runId: "run_operator_detached_blocked_cancel",
      sessionId: "session_operator_detached_blocked_cancel",
      workspaceId: "workspace_local"
    });

    await expect(app.operator.cancelBackgroundTask({
      taskId: "task_operator_detached_blocked_cancel",
      runId: "run_operator_detached_blocked_cancel",
      actorId: "operator_001",
      reason: "operator canceled blocked detached run"
    })).resolves.toMatchObject({
      status: "canceled",
      taskStatus: "canceled",
      runStatus: "canceled"
    });

    await expect(runStore.loadRunById("run_operator_detached_blocked_cancel")).resolves.toMatchObject({
      status: "canceled",
      cancelRequestedBy: "operator_001",
      cancelReason: "operator canceled blocked detached run",
      continuationKind: undefined,
      continuationPayload: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sessionStore.loadRecoveryContext("session_operator_detached_blocked_cancel")).resolves.toBeNull();
    const blockedSlices = await sliceStore.listSlicesByRun("run_operator_detached_blocked_cancel");
    expect(blockedSlices).toEqual([
      expect.objectContaining({
        sliceId: "slice_run_operator_detached_blocked_cancel_001",
        status: "blocked"
      })
    ]);
    expect(blockedSlices.some((slice) => slice.status === "queued" || slice.status === "running")).toBe(false);
  });

  it("returns cancel_requested when operator cancel races with detached queued claim", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const seeded = await seedFreshQueuedDetachedRun({
      dataDir,
      taskId: "task_operator_detached_queued_race_cancel",
      runId: "run_operator_detached_queued_race_cancel",
      sessionId: "session_operator_detached_queued_race_cancel",
      workspaceId: "workspace_local"
    });

    const taskStore = createTaskStore({ filename: seeded.paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: seeded.paths.tasksDbPath });
    const controlStore = createRunControlStore({ filename: seeded.paths.tasksDbPath });
    const lifecycle = createRunLifecycle({
      tasksDbPath: seeded.paths.tasksDbPath,
      runStore: seeded.runStore,
      sliceStore: seeded.sliceStore,
      controlStore,
      sessionStore: seeded.sessionStore,
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

    const operator = createBackgroundOperator({
      runStore: seeded.runStore,
      eventStore,
      outboundStore: taskStore,
      recoveryStore: seeded.sessionStore,
      detachedLifecycle: {
        ...lifecycle,
        async cancelDetachedRun(input) {
          await lifecycle.claimNextRunnableSlice({
            workerId: "worker_operator_cancel_race",
            lane: "background",
            leaseDurationMs: 60_000,
            now: "2026-05-01T00:00:00.050Z"
          });
          return lifecycle.cancelDetachedRun(input);
        }
      }
    });

    await expect(operator.cancelBackgroundTask({
      taskId: "task_operator_detached_queued_race_cancel",
      runId: "run_operator_detached_queued_race_cancel",
      actorId: "operator_001",
      reason: "operator canceled queued detached run after worker claim"
    })).resolves.toMatchObject({
      status: "cancel_requested",
      taskStatus: "running",
      runStatus: "running"
    });

    await expect(seeded.runStore.loadRunById("run_operator_detached_queued_race_cancel")).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "operator_001",
      cancelReason: "operator canceled queued detached run after worker claim"
    });
    await expect(controlStore.listPendingControls("run_operator_detached_queued_race_cancel")).resolves.toEqual([
      expect.objectContaining({
        kind: "cancel",
        payload: {
          reason: "operator canceled queued detached run after worker claim",
          requestedBy: "operator_001"
        }
      })
    ]);
    await expect(eventStore.listEventsByRun({ runId: "run_operator_detached_queued_race_cancel" })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "cancel_requested",
          message: expect.stringContaining("operator canceled queued detached run after worker claim")
        })
      ])
    );
  });

  it("converges blocked detached operator cancel onto canonical running cancel after resume race", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const seeded = await seedBlockedDetachedRun({
      dataDir,
      taskId: "task_operator_detached_blocked_race_cancel",
      runId: "run_operator_detached_blocked_race_cancel",
      sessionId: "session_operator_detached_blocked_race_cancel",
      workspaceId: "workspace_local"
    });

    const taskStore = createTaskStore({ filename: seeded.paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: seeded.paths.tasksDbPath });
    const controlStore = createRunControlStore({ filename: seeded.paths.tasksDbPath });
    const lifecycle = createRunLifecycle({
      tasksDbPath: seeded.paths.tasksDbPath,
      runStore: seeded.runStore,
      sliceStore: seeded.sliceStore,
      controlStore,
      sessionStore: seeded.sessionStore,
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

    let resumed = false;
    const operator = createBackgroundOperator({
      runStore: seeded.runStore,
      eventStore,
      outboundStore: taskStore,
      recoveryStore: seeded.sessionStore,
      detachedLifecycle: {
        ...lifecycle,
        async closeBlockedRunTerminally(input) {
          if (!resumed) {
            resumed = true;
            await lifecycle.transitionBlockedRunToQueuedSlice({
              sessionId: input.sessionId,
              taskId: input.taskId,
              runId: input.runId,
              attentionMode: "background_detached",
              triggerKind: "approval_resume",
              lane: "background",
              continuationPayload: {
                resumedBy: "race-winner"
              },
              now: "2026-05-01T00:00:00.050Z"
            });
            await lifecycle.claimNextRunnableSlice({
              workerId: "worker_resume_race",
              lane: "background",
              leaseDurationMs: 60_000,
              now: "2026-05-01T00:00:00.060Z"
            });
          }
          return lifecycle.closeBlockedRunTerminally(input);
        }
      }
    });

    await expect(operator.cancelBackgroundTask({
      taskId: "task_operator_detached_blocked_race_cancel",
      runId: "run_operator_detached_blocked_race_cancel",
      actorId: "operator_001",
      reason: "operator canceled blocked detached run after resume race"
    })).resolves.toMatchObject({
      status: "cancel_requested",
      taskStatus: "running",
      runStatus: "running"
    });

    await expect(seeded.runStore.loadRunById("run_operator_detached_blocked_race_cancel")).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "operator_001",
      cancelReason: "operator canceled blocked detached run after resume race"
    });
    await expect(controlStore.listPendingControls("run_operator_detached_blocked_race_cancel")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "cancel",
          payload: {
            reason: "operator canceled blocked detached run after resume race",
            requestedBy: "operator_001"
          }
        })
      ])
    );
    await expect(eventStore.listEventsByRun({ runId: "run_operator_detached_blocked_race_cancel" })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "cancel_requested",
          message: expect.stringContaining("operator canceled blocked detached run after resume race")
        })
      ])
    );
  });

  it("returns already_terminal when operator cancel loses the race to detached terminal failure", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);

    const seeded = await seedBlockedDetachedRun({
      dataDir,
      taskId: "task_operator_detached_terminal_race_cancel",
      runId: "run_operator_detached_terminal_race_cancel",
      sessionId: "session_operator_detached_terminal_race_cancel",
      workspaceId: "workspace_local"
    });

    const taskStore = createTaskStore({ filename: seeded.paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: seeded.paths.tasksDbPath });
    const controlStore = createRunControlStore({ filename: seeded.paths.tasksDbPath });
    const lifecycle = createRunLifecycle({
      tasksDbPath: seeded.paths.tasksDbPath,
      runStore: seeded.runStore,
      sliceStore: seeded.sliceStore,
      controlStore,
      sessionStore: seeded.sessionStore,
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

    const operator = createBackgroundOperator({
      runStore: seeded.runStore,
      eventStore,
      outboundStore: taskStore,
      recoveryStore: seeded.sessionStore,
      detachedLifecycle: {
        ...lifecycle,
        async closeBlockedRunTerminally(input) {
          await forceDetachedRunTerminalState({
            tasksDbPath: seeded.paths.tasksDbPath,
            taskId: input.taskId,
            runId: input.runId,
            terminalStatus: "failed",
            resultSummary: "detached run failed before operator cancel won"
          });
          return lifecycle.closeBlockedRunTerminally(input);
        }
      }
    });

    await expect(operator.cancelBackgroundTask({
      taskId: "task_operator_detached_terminal_race_cancel",
      runId: "run_operator_detached_terminal_race_cancel",
      actorId: "operator_001",
      reason: "operator canceled after failure won"
    })).resolves.toMatchObject({
      status: "already_terminal",
      taskStatus: "failed",
      runStatus: "failed"
    });

    await expect(seeded.runStore.loadRunById("run_operator_detached_terminal_race_cancel")).resolves.toMatchObject({
      status: "failed",
      resultSummary: "detached run failed before operator cancel won"
    });
    await expect(eventStore.listEventsByRun({ runId: "run_operator_detached_terminal_race_cancel" })).resolves.toEqual([]);
  });

  it("routes detached running cancel through durable Task 2 cancellation truth", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { paths, runStore, sliceStore, controlStore } = await seedQueuedDetachedOperatorSlice({
      dataDir,
      taskId: "task_detached_running_cancel",
      runId: "run_detached_running_cancel",
      sessionId: "session_detached_running_cancel",
      workspaceId: "workspace_local"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_active',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          run_started_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:01:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "run_detached_running_cancel"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_active',
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-05-01T00:01:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "slice_run_detached_running_cancel_001"
    );
    taskDb.close();

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_detached_running_cancel",
      workspaceId: "workspace_local",
      turnId: "run_detached_running_cancel",
      reason: "operator canceled running detached run"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_detached_running_cancel",
      warnings: ["operator canceled running detached run"]
    });

    await expect(runStore.loadRunById("run_detached_running_cancel")).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "system:execution-control:cancel",
      cancelReason: "operator canceled running detached run"
    });
    await expect(controlStore.listPendingControls("run_detached_running_cancel")).resolves.toEqual([
      expect.objectContaining({
        kind: "cancel",
        payload: {
          reason: "operator canceled running detached run",
          requestedBy: "system:execution-control:cancel"
        }
      })
    ]);
    await expect(sliceStore.listSlicesByRun("run_detached_running_cancel")).resolves.toMatchObject([
      {
        sliceId: "slice_run_detached_running_cancel_001",
        status: "running",
        triggerKind: "operator_resume"
      }
    ]);
  });

  it("cancels a detached running run without requiring continuation payload truth", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const { paths, runStore, sliceStore, controlStore } = await seedQueuedDetachedOperatorSlice({
      dataDir,
      taskId: "task_detached_running_cancel_without_payload",
      runId: "run_detached_running_cancel_without_payload",
      sessionId: "session_detached_running_cancel_without_payload",
      workspaceId: "workspace_local"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_active',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = NULL,
          continuation_payload_json = NULL,
          continuation_updated_at = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:01:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "run_detached_running_cancel_without_payload"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_active',
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = NULL,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-05-01T00:01:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "2026-05-01T00:00:01.000Z",
      "slice_run_detached_running_cancel_without_payload_001"
    );
    taskDb.close();

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_detached_running_cancel_without_payload",
      workspaceId: "workspace_local",
      turnId: "run_detached_running_cancel_without_payload",
      reason: "operator canceled running detached run without payload"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_detached_running_cancel_without_payload",
      warnings: ["operator canceled running detached run without payload"]
    });

    await expect(runStore.loadRunById("run_detached_running_cancel_without_payload")).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "system:execution-control:cancel",
      cancelReason: "operator canceled running detached run without payload"
    });
    await expect(controlStore.listPendingControls("run_detached_running_cancel_without_payload")).resolves.toEqual([
      expect.objectContaining({
        kind: "cancel",
        payload: {
          reason: "operator canceled running detached run without payload",
          requestedBy: "system:execution-control:cancel"
        }
      })
    ]);
    await expect(sliceStore.listSlicesByRun("run_detached_running_cancel_without_payload")).resolves.toMatchObject([
      {
        sliceId: "slice_run_detached_running_cancel_without_payload_001",
        status: "running",
        triggerKind: "operator_resume"
      }
    ]);
  });

  it("clears stale Task 2 session focus and inflight truth before detached resume re-reads durable slices", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "resumed from durable Task 2 slice after stale session cleanup"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20
            }
          }
        ]
      ])
    });

    const { sessionStore, runStore, sliceStore } = await seedQueuedDetachedOperatorSlice({
      dataDir,
      taskId: "task_stale_session_cleanup",
      runId: "run_stale_session_cleanup",
      sessionId: "session_stale_session_cleanup",
      workspaceId: "workspace_local"
    });

    await sessionStore.markInflight({
      turnId: "run_stale_session_cleanup",
      sessionId: "session_stale_session_cleanup",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      pendingApprovalRef: "approval_stale_session_cleanup_001",
      checkpointRef: "checkpoint:stale_session_cleanup",
      frameRef: "frame:stale_session_cleanup",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1 as const,
        contractVersion: "ws0.pending-execution.v1" as const,
        pendingExecutionId: "pending:stale_session_cleanup",
        frameRef: "frame:stale_session_cleanup",
        checkpointRef: "checkpoint:stale_session_cleanup",
        status: "ready",
        frame: {
          schemaVersion: 1 as const,
          contractVersion: "ws0.execution-frame.v1" as const,
          frameRef: "frame:stale_session_cleanup",
          checkpointRef: "checkpoint:stale_session_cleanup",
          turnId: "run_stale_session_cleanup",
          sessionId: "session_stale_session_cleanup",
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
            allowedActions: ["approve", "deny", "cancel"] as Array<"approve" | "deny" | "cancel">,
            metadata: {
              actorId: "actor_cli"
            }
          }
        }
      }
    });
    await sessionStore.setFocusRun({
      sessionId: "session_stale_session_cleanup",
      taskId: "task_stale_session_cleanup",
      runId: "run_stale_session_cleanup",
      now: "2026-05-01T00:00:00.030Z"
    });

    await expect(app.shell.resumeTurn({
      sessionId: "session_stale_session_cleanup",
      workspaceId: "workspace_local",
      turnId: "run_stale_session_cleanup",
      input: "continue"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_stale_session_cleanup",
      messages: [
        expect.objectContaining({
          content: "resumed from durable Task 2 slice after stale session cleanup"
        })
      ]
    });

    await expect(sessionStore.loadRecoveryContext("session_stale_session_cleanup")).resolves.toBeNull();
    await expect(sessionStore.loadFocusRun("session_stale_session_cleanup")).resolves.toBeUndefined();
    await expect(runStore.loadRunById("run_stale_session_cleanup")).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_stale_session_cleanup")).resolves.toMatchObject([
      {
        sliceId: "slice_run_stale_session_cleanup_001",
        status: "completed",
        triggerKind: "operator_resume"
      }
    ]);
  });
});
