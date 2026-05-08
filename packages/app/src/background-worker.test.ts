import { mkdtemp, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderTransport, ProviderTransportRequest } from "@endec/ai";
import type { TurnResult } from "@endec/domain";
import { createTaskRunStore, createTaskStore, createRuntimeSliceStore } from "@endec/tasks";
import { createSessionStore } from "@endec/sessions";
import { createEndecApp } from "./index.ts";
import { createBackgroundWorker } from "./background-worker.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";

function createChatCompletionTransport(
  responses: Array<Array<Record<string, unknown>>>,
  onRequest?: (request: ProviderTransportRequest) => void
): ProviderTransport {
  let index = 0;

  return {
    async *stream(request) {
      onRequest?.(request);
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
  };
}

function createCompletedTransportResponse(text: string) {
  return [
    {
      choices: [
        {
          delta: {
            content: text
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
        completion_tokens: 6,
        total_tokens: 18
      }
    }
  ];
}

function createStoredTurnRequest(overrides: Partial<{
  turnId: string;
  sessionId: string;
  workspaceId: string;
  source: "telegram" | "feishu" | "cli" | "tui" | "web" | "sdk";
  actorId: string;
  input: string;
  requestedMode: "chat" | "plan" | "act" | "review" | "task";
  channelContext: Record<string, unknown>;
}> = {}) {
  return {
    turnId: "turn_origin_001",
    sessionId: "session_bg_worker_001",
    workspaceId: "workspace_local",
    source: "telegram" as const,
    actorId: "actor_telegram_001",
    input: "investigate flaky integration test",
    requestedMode: "chat" as const,
    conversationRef: {
      accountId: "telegram_bot",
      conversationId: "group:100:thread:200",
      peerId: "100",
      peerKind: "group" as const,
      threadId: "200"
    },
    channelContext: {
      messageId: "msg_001",
      chatType: "group"
    },
    ...overrides
  };
}

function createTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    turnId: "turn_exec_001",
    sessionId: "session_bg_worker_001",
    resolvedMode: "chat",
    status: "completed",
    messages: [
      {
        role: "assistant",
        content: "background work finished"
      }
    ],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCost: 0
    },
    warnings: [],
    checkpointRef: "checkpoint:turn_exec_001",
    nextSessionStateRef: "session_state_ref:turn_exec_001",
    ...overrides
  };
}

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-app-bg-worker-"));
}

const tempDirs = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();

  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

async function seedQueuedRun(dataDir: string, overrides: Partial<ReturnType<typeof createStoredTurnRequest>> = {}) {
  const paths = ensureEndecDataLayout(dataDir);
  const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
  const taskStore = createTaskStore({ filename: paths.tasksDbPath });
  const stored = createStoredTurnRequest(overrides);
  const taskId = "task_bg_worker_001";
  const runId = "run_bg_worker_001";

  await runStore.createBackgroundTask({
    taskId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    actorId: stored.actorId,
    conversationRef: stored.conversationRef,
    title: "Investigate flaky integration test",
    description: stored.input,
    sourceTurnId: stored.turnId,
    now: "2026-04-26T00:00:00.000Z"
  });

  await runStore.enqueueRun({
    runId,
    taskId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    actorId: stored.actorId,
    conversationRef: stored.conversationRef,
    idempotencyKey: `seed:${runId}`,
    turnRequest: {
      turnId: stored.turnId,
      sessionId: stored.sessionId,
      workspaceId: stored.workspaceId,
      actorId: stored.actorId,
      source: stored.source,
      input: stored.input,
      requestedMode: stored.requestedMode,
      conversationRef: stored.conversationRef,
      channelContext: stored.channelContext,
      originTurnId: stored.turnId
    },
    sourceTurnId: stored.turnId,
    maxAttempts: 1,
    now: "2026-04-26T00:00:00.000Z"
  });

  return { paths, runStore, taskStore, taskId, runId, stored };
}

async function seedContinuationSlice(dataDir: string, input: {
  continuationKind: "recovery_retry" | "approval_resume";
  continuationPayload: Record<string, unknown>;
  pendingApprovalRef?: string;
  pendingControlRef?: string;
}) {
  const seeded = await seedQueuedRun(dataDir, {
    turnId: `turn_${input.continuationKind}_origin`,
    sessionId: `session_${input.continuationKind}`,
    input: `continue ${input.continuationKind}`
  });
  const sliceStore = createRuntimeSliceStore({ filename: seeded.paths.tasksDbPath });
  const continuationUpdatedAt = "2026-04-27T00:00:00.020Z";
  const db = new Database(seeded.paths.tasksDbPath);

  db.prepare(`
    UPDATE task_runs
    SET continuation_kind = ?,
        continuation_payload_json = ?,
        continuation_updated_at = ?,
        pending_approval_ref = ?,
        pending_control_ref = ?,
        updated_at = ?
    WHERE run_id = ?
  `).run(
    input.continuationKind,
    JSON.stringify(input.continuationPayload),
    continuationUpdatedAt,
    input.pendingApprovalRef ?? null,
    input.pendingControlRef ?? null,
    continuationUpdatedAt,
    seeded.runId
  );
  db.close();

  const sliceId = `slice_${input.continuationKind}_001`;
  await sliceStore.enqueueNextSlice({
    sliceId,
    runId: seeded.runId,
    taskId: seeded.taskId,
    triggerKind: input.continuationKind,
    lane: "background",
    now: "2026-04-27T00:00:00.030Z"
  });

  const sliceDb = new Database(seeded.paths.tasksDbPath);
  sliceDb.prepare(`
    UPDATE runtime_slices
    SET continuation_payload_json = ?,
        updated_at = ?
    WHERE slice_id = ?
  `).run(
    JSON.stringify(input.continuationPayload),
    "2026-04-27T00:00:00.031Z",
    sliceId
  );
  sliceDb.close();

  return { ...seeded, sliceStore, sliceId };
}

describe("background worker", () => {
  it("worker executes claimed run through app.shell.executeTurn with background marker and never touches runtime.run", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const { runStore, taskId, runId, stored } = await seedQueuedRun(dataDir);

    const fakeRuntime = { run: vi.fn() };
    const executeTurn = vi.fn(async (request: Parameters<typeof app.shell.executeTurn>[0]) =>
      createTurnResult({
        turnId: request.turnId,
        sessionId: request.sessionId,
        status: "completed"
      })
    );
    app.shell.executeTurn = executeTurn;

    const result = await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    expect(result).toMatchObject({
      status: "claimed",
      taskId,
      runId,
      outcome: "succeeded",
      turnResultStatus: "completed",
      callbackKind: "final"
    });
    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(executeTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: stored.sessionId,
      workspaceId: stored.workspaceId,
      actorId: stored.actorId,
      source: stored.source,
      input: stored.input,
      requestedMode: stored.requestedMode,
      taskId,
      attachments: [],
      conversationRef: stored.conversationRef,
      channelContext: expect.objectContaining({
        messageId: "msg_001",
        chatType: "group",
        backgroundTask: expect.objectContaining({
          executionRole: "background_worker",
          taskId,
          runId,
          attemptNo: 1,
          originTurnId: stored.turnId
        })
      })
    }));
    expect(fakeRuntime.run).not.toHaveBeenCalled();

    const run = await runStore.loadRunById(runId);
    expect(run?.status).toBe("completed");
  });

  it("completed turn marks run completed task done and enqueues one final outbound", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const { runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "completed",
      messages: [{ role: "assistant", content: "done summary" }]
    }));

    await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "completed",
      resultSummary: "done summary"
    });
    await expect(runStore.loadBackgroundTask(taskId)).resolves.toMatchObject({
      agentStatus: "done"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      eventKind: "final",
      status: "pending",
      taskId,
      runId,
      conversationRef: expect.objectContaining({ peerId: "100", threadId: "200" }),
      renderPayload: expect.objectContaining({
        eventKind: "final",
        taskId,
        runId,
        attemptNo: 1,
        summary: "done summary"
      })
    });
  });

  it("failed turn marks run failed and enqueues failed outbound", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const { runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "failed",
      messages: [],
      warnings: ["provider failed"]
    }));

    await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "failed",
      resultSummary: "provider failed"
    });
    await expect(runStore.loadBackgroundTask(taskId)).resolves.toMatchObject({
      agentStatus: "failed"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      eventKind: "failed",
      renderPayload: expect.objectContaining({
        eventKind: "failed",
        summary: "provider failed"
      })
    });
  });

  it("terminal interrupted turn marks run failed and enqueues failed outbound", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const { runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "interrupted",
      messages: [],
      warnings: ["loop interrupted"]
    }));

    await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "failed",
      resultSummary: "loop interrupted"
    });
    await expect(runStore.loadBackgroundTask(taskId)).resolves.toMatchObject({
      agentStatus: "failed"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      eventKind: "failed",
      renderPayload: expect.objectContaining({
        eventKind: "failed",
        summary: "loop interrupted"
      })
    });
  });

  it("cancel requested before shell call marks run canceled without shell execution", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);
    const executeTurn = vi.fn(async () => createTurnResult({ status: "completed" }));
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: { executeTurn }
    });

    const result = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z",
      onClaimedRun: async ({ runId: claimedRunId }) => {
        const otherStore = createTaskRunStore({ filename: paths.tasksDbPath });
        await otherStore.requestRunCancellation({
          runId: claimedRunId,
          reason: "operator canceled",
          now: "2026-04-26T00:00:01.100Z"
        });
      }
    });

    expect(result).toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "canceled",
      callbackKind: "canceled",
      shellExecuted: false
    });
    expect(executeTurn).not.toHaveBeenCalled();
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.eventKind).toBe("canceled");
  });

  it("cancel requested after shell returns marks run canceled and enqueues canceled callback", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);
    const executeTurn = vi.fn(async () => createTurnResult({
      status: "completed",
      messages: [{ role: "assistant", content: "late completion" }]
    }));
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: { executeTurn }
    });

    const result = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z",
      onAfterShell: async ({ runId: claimedRunId }) => {
        const otherStore = createTaskRunStore({ filename: paths.tasksDbPath });
        await otherStore.requestRunCancellation({
          runId: claimedRunId,
          reason: "operator canceled",
          now: "2026-04-26T00:00:01.200Z"
        });
      }
    });

    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "canceled",
      callbackKind: "canceled",
      shellExecuted: true
    });
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      eventKind: "canceled",
      renderPayload: expect.objectContaining({
        eventKind: "canceled",
        summary: "operator canceled"
      })
    });
  });

  it("background marker prevents recursive enqueue when stored input still looks like /background command", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("actual execution happened")
      ], (request) => transportRequests.push(request))
    });
    const { runStore, taskStore, taskId, runId, stored } = await seedQueuedRun(dataDir, {
      input: "/background investigate recursion safely"
    });

    const result = await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    expect(result).toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "succeeded",
      callbackKind: "final"
    });
    expect(transportRequests).toHaveLength(1);
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({ status: "completed" });
    await expect(taskStore.listActiveBySession(stored.sessionId)).resolves.toEqual([]);
  });

  it("duplicate worker execution on an already-claimed slice does not execute twice", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const { paths, taskId, runId } = await seedQueuedRun(dataDir);
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
    const executeTurn = vi.fn(async () => createTurnResult({ status: "completed" }));
    app.shell.executeTurn = executeTurn;

    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_preclaimed_001",
      runId,
      taskId,
      lane: "background",
      now: "2026-04-26T00:00:00.900Z"
    });
    const claim = await sliceStore.claimNextRunnableSlice({
      workerId: "other_worker",
      lane: "background",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });
    expect(claim.status).toBe("claimed");

    await expect(app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:02.000Z"
    })).resolves.toEqual({ status: "idle" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("terminal timestamps and callback availability use post-shell time instead of claim time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T00:00:01.000Z"));

    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    const shellReturnedAt = "2026-04-26T00:00:05.000Z";
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: {
        executeTurn: vi.fn(async () => {
          vi.setSystemTime(new Date(shellReturnedAt));
          return createTurnResult({
            status: "completed",
            messages: [{ role: "assistant", content: "completed after shell time advanced" }]
          });
        })
      }
    });

    const result = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    expect(result).toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "succeeded",
      callbackKind: "final"
    });

    const run = await runStore.loadRunById(runId);
    expect(run).toMatchObject({
      status: "completed",
      finishedAt: shellReturnedAt,
      updatedAt: shellReturnedAt
    });
    expect(run?.startedAt).toBe("2026-04-26T00:00:01.000Z");
    expect(run?.finishedAt).not.toBe("2026-04-26T00:00:01.000Z");
    expect(run?.updatedAt).not.toBe("2026-04-26T00:00:01.000Z");

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      eventKind: "final",
      availableAt: shellReturnedAt,
      createdAt: shellReturnedAt,
      updatedAt: shellReturnedAt
    });
    expect(outbound[0]?.availableAt).not.toBe("2026-04-26T00:00:01.000Z");
  });

  it("late cancel after a completed slice stays terminal and does not override completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T00:00:01.000Z"));

    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-04-26T00:00:05.000Z"));
      return createTurnResult({
        status: "completed",
        messages: [{ role: "assistant", content: "normal completion ignores later cancel" }]
      });
    });
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: { executeTurn }
    });

    const result = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const otherStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const cancelAttempt = await otherStore.requestRunCancellation({
      runId,
      reason: "operator canceled too late",
      now: "2026-04-26T00:00:06.000Z"
    });

    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "succeeded",
      callbackKind: "final",
      shellExecuted: true
    });
    expect(cancelAttempt).toBeUndefined();

    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "completed",
      resultSummary: "normal completion ignores later cancel",
      cancelReason: undefined
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      eventKind: "final",
      renderPayload: expect.objectContaining({
        eventKind: "final",
        summary: "normal completion ignores later cancel"
      })
    });
  });

  it("default worker lifecycle routes recovery-retry with durable continuation truth through continueSlice without fresh shell fallback", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, runId, taskId, sliceStore } = await seedContinuationSlice(dataDir, {
      continuationKind: "recovery_retry",
      continuationPayload: {
        checkpointRef: "checkpoint:run_bg_recovery_retry",
        recovery: {
          checkpointRef: "checkpoint:run_bg_recovery_retry"
        }
      },
      pendingControlRef: "frame:run_bg_recovery_retry"
    });

    const executeTurn = vi.fn(async () => {
      throw new Error("fresh executeTurn fallback must not run for recovery_retry");
    });
    const continueSlice = vi.fn(async () => createTurnResult({
      turnId: runId,
      sessionId: "session_recovery_retry",
      status: "completed",
      messages: [{ role: "assistant", content: "continued recovery slice" }],
      checkpointRef: "checkpoint:run_bg_recovery_retry"
    }));
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: { executeTurn },
      continueSlice
    });

    await expect(worker.runOnce({
      workerId: "worker_recovery_retry",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "succeeded",
      callbackKind: "final",
      turnResultStatus: "completed"
    });
    expect(continueSlice).toHaveBeenCalledTimes(1);
    expect(executeTurn).not.toHaveBeenCalled();
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun(runId)).resolves.toMatchObject([
      {
        sliceId: "slice_recovery_retry_001",
        triggerKind: "recovery_retry",
        status: "completed"
      }
    ]);
  });

  it("default worker lifecycle falls back to fresh shell execution for recovery-retry slices without durable continuation truth", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, runId, taskId, sliceStore } = await seedContinuationSlice(dataDir, {
      continuationKind: "recovery_retry",
      continuationPayload: {
        checkpointRef: "checkpoint:run_bg_recovery_retry_fresh"
      }
    });

    const executeTurn = vi.fn(async () => createTurnResult({
      turnId: runId,
      sessionId: "session_recovery_retry",
      status: "completed",
      messages: [{ role: "assistant", content: "fresh recovery retry completion" }],
      checkpointRef: "checkpoint:run_bg_recovery_retry_fresh"
    }));
    const continueSlice = vi.fn(async () => {
      throw new Error("continueSlice must not run without durable recovery truth");
    });
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: { executeTurn },
      continueSlice
    });

    await expect(worker.runOnce({
      workerId: "worker_recovery_retry_fresh",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "succeeded",
      callbackKind: "final",
      turnResultStatus: "completed"
    });
    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(continueSlice).not.toHaveBeenCalled();
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun(runId)).resolves.toMatchObject([
      {
        sliceId: "slice_recovery_retry_001",
        triggerKind: "recovery_retry",
        status: "completed"
      }
    ]);
  });

  it("default worker lifecycle routes approval-resume through resolveApprovalSlice without fresh shell fallback", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, runId, taskId, sliceStore } = await seedContinuationSlice(dataDir, {
      continuationKind: "approval_resume",
      continuationPayload: {
        control: {
          action: "approve",
          decisionId: "approval_bg_worker_001"
        }
      },
      pendingApprovalRef: "approval_bg_worker_001",
      pendingControlRef: "frame:approval_bg_worker_001"
    });

    const executeTurn = vi.fn(async () => {
      throw new Error("fresh executeTurn fallback must not run for approval_resume");
    });
    const resolveApprovalSlice = vi.fn(async () => createTurnResult({
      turnId: runId,
      sessionId: "session_approval_resume",
      status: "completed",
      messages: [{ role: "assistant", content: "continued approval slice" }],
      checkpointRef: "checkpoint:run_bg_approval_resume"
    }));
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: { executeTurn },
      resolveApprovalSlice
    });

    await expect(worker.runOnce({
      workerId: "worker_approval_resume",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "succeeded",
      callbackKind: "final",
      turnResultStatus: "completed"
    });
    expect(resolveApprovalSlice).toHaveBeenCalledTimes(1);
    expect(executeTurn).not.toHaveBeenCalled();
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun(runId)).resolves.toMatchObject([
      {
        sliceId: "slice_approval_resume_001",
        triggerKind: "approval_resume",
        status: "completed"
      }
    ]);
  });

  it.each([
    {
      continuationKind: "recovery_retry" as const,
      continuationPayload: {
        checkpointRef: "checkpoint:run_bg_recovery_retry_missing_handler",
        recovery: {
          checkpointRef: "checkpoint:run_bg_recovery_retry_missing_handler"
        }
      },
      pendingControlRef: "frame:run_bg_recovery_retry_missing_handler",
      expectedSummary: "background worker cannot continue recovery_retry without continueSlice; refusing fresh executeTurn fallback"
    },
    {
      continuationKind: "approval_resume" as const,
      continuationPayload: {
        control: {
          action: "approve",
          decisionId: "approval_bg_worker_missing_handler"
        }
      },
      pendingApprovalRef: "approval_bg_worker_missing_handler",
      pendingControlRef: "frame:approval_bg_worker_missing_handler",
      expectedSummary: "background worker cannot continue approval_resume without resolveApprovalSlice; refusing fresh executeTurn fallback"
    }
  ])("default worker lifecycle fails %s without falling back to fresh shell execution", async ({ continuationKind, continuationPayload, pendingApprovalRef, pendingControlRef, expectedSummary }) => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, runId, taskId } = await seedContinuationSlice(dataDir, {
      continuationKind,
      continuationPayload,
      pendingApprovalRef,
      pendingControlRef
    });

    const executeTurn = vi.fn(async () => {
      throw new Error(`fresh executeTurn fallback must not run for ${continuationKind}`);
    });
    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      shell: { executeTurn }
    });

    await expect(worker.runOnce({
      workerId: `worker_${continuationKind}_missing_handler`,
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "failed",
      callbackKind: "failed",
      turnResultStatus: "failed"
    });
    expect(executeTurn).not.toHaveBeenCalled();
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "failed",
      resultSummary: expectedSummary
    });
    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toMatchObject([
      expect.objectContaining({
        eventKind: "failed",
        renderPayload: expect.objectContaining({
          summary: expectedSummary
        })
      })
    ]);
  });

  it("blocked turn is blocked and enqueues blocked callback", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const { runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      messages: [],
      warnings: ["needs approval"],
      blockedBy: "permission"
    }));

    const result = await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    expect(result).toMatchObject({
      status: "claimed",
      runId,
      taskId,
      outcome: "suspended",
      turnResultStatus: "blocked",
      callbackKind: "blocked"
    });
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "blocked",
      resultSummary: expect.stringContaining("permission")
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      eventKind: "blocked",
      renderPayload: expect.objectContaining({
        eventKind: "blocked",
        turnResultStatus: "blocked"
      })
    });
  });

  it("background failed provider incomplete callback defaults to passthrough summary", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: {
        async *stream() {
          throw new Error("Provider stream ended without a completed event for invocation invoke_bg_001");
        }
      }
    });
    const { taskStore, taskId, runId } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_provider_incomplete",
      sessionId: "session_bg_provider_incomplete",
      input: "background investigate incomplete provider"
    });

    const workerResult = await app.background.runWorkerOnce({
      workerId: "worker_provider_incomplete",
      leaseDurationMs: 30_000
    });

    expect(workerResult).toMatchObject({
      status: "claimed",
      outcome: "failed",
      callbackKind: "failed",
      shellExecuted: true
    });
    const outbounds = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect((outbounds.at(-1)?.renderPayload as { summary?: string } | undefined)?.summary)
      .toContain("Provider stream ended without a completed event for invocation invoke_bg_001");
    expect((outbounds.at(-1)?.renderPayload as { summary?: string } | undefined)?.summary)
      .not.toContain("模型响应流提前结束，本轮已安全停止，请重试。");
  });

  it("background failed provider incomplete callback honors sanitized mode", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_ERROR_EXPOSURE_MODE: "sanitized"
      },
      providerTransport: {
        async *stream() {
          throw new Error("Provider stream ended without a completed event for invocation invoke_bg_001");
        }
      }
    });
    const { taskStore, taskId, runId } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_provider_incomplete_sanitized",
      sessionId: "session_bg_provider_incomplete_sanitized",
      input: "background investigate incomplete provider"
    });

    const workerResult = await app.background.runWorkerOnce({
      workerId: "worker_provider_incomplete_sanitized",
      leaseDurationMs: 30_000
    });

    expect(workerResult).toMatchObject({
      status: "claimed",
      outcome: "failed",
      callbackKind: "failed",
      shellExecuted: true
    });
    const outbounds = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbounds.at(-1)?.renderPayload).toMatchObject({
      summary: "模型响应流提前结束，本轮已安全停止，请重试。"
    });
    expect(JSON.stringify(outbounds)).not.toContain("Provider stream ended without a completed event");
  });

  it("clears stale inflight recovery after a yielded background auto-continue slice", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId, stored } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_inflight_cleanup",
      sessionId: "session_bg_inflight_cleanup",
      input: "pause safely and continue later"
    });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });

    await sessionStore.loadOrCreate({
      sessionId: stored.sessionId,
      workspaceId: stored.workspaceId,
      source: stored.source,
      turnId: stored.turnId,
      actorId: stored.actorId,
      input: stored.input,
      attachments: []
    });
    await sessionStore.markInflight({
      turnId: runId,
      sessionId: stored.sessionId,
      workspaceId: stored.workspaceId,
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 2,
      checkpointRef: "checkpoint:turn_bg_inflight_cleanup",
      frameRef: "frame:turn_bg_inflight_cleanup",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:turn_bg_inflight_cleanup",
        frameRef: "frame:turn_bg_inflight_cleanup",
        checkpointRef: "checkpoint:turn_bg_inflight_cleanup",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:turn_bg_inflight_cleanup",
          checkpointRef: "checkpoint:turn_bg_inflight_cleanup",
          turnId: runId,
          sessionId: stored.sessionId,
          workspaceId: stored.workspaceId,
          phase: "tool_batch",
          step: "tool_batch",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 1,
          toolCallCount: 2,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {}
          }
        }
      }
    });

    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      sessionStore,
      shell: {
        executeTurn: vi.fn(async () => createTurnResult({
          turnId: runId,
          sessionId: stored.sessionId,
          status: "interrupted",
          messages: [],
          warnings: ["tool_turn_limit"],
          continuation: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-control.v1",
            frameRef: "frame:turn_bg_inflight_cleanup",
            checkpointRef: "checkpoint:turn_bg_inflight_cleanup",
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              pendingExecutionId: "pending:turn_bg_inflight_cleanup"
            }
          }
        }))
      }
    });

    const workerResult = await worker.runOnce({
      workerId: "worker_bg_inflight_cleanup",
      leaseDurationMs: 30_000
    });

    expect(workerResult).toMatchObject({
      status: "claimed",
      turnResultStatus: "interrupted",
      shellExecuted: true
    });
    expect(workerResult.outcome).toBeUndefined();
    expect(workerResult.callbackKind).toBeUndefined();

    await expect(sessionStore.loadRecoveryContext(stored.sessionId)).resolves.toBeNull();
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "queued",
      continuationKind: "auto_continue",
      pendingApprovalRef: undefined,
      pendingControlRef: "frame:turn_bg_inflight_cleanup",
      continuationPayload: expect.objectContaining({
        continuationKind: "resume",
        frameRef: "frame:turn_bg_inflight_cleanup",
        checkpointRef: "checkpoint:turn_bg_inflight_cleanup"
      })
    });
    await expect(sliceStore.listSlicesByRun(runId)).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "yielded",
        triggerKind: "legacy_cutover"
      },
      {
        sliceNo: 2,
        status: "queued",
        triggerKind: "auto_continue"
      }
    ]);
    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toHaveLength(0);
  });

  it("keeps inflight recovery truth for genuinely blocked background continuations", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, runId, stored } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_blocked_truth",
      sessionId: "session_bg_blocked_truth",
      input: "wait for approval"
    });
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });

    await sessionStore.loadOrCreate({
      sessionId: stored.sessionId,
      workspaceId: stored.workspaceId,
      source: stored.source,
      turnId: stored.turnId,
      actorId: stored.actorId,
      input: stored.input,
      attachments: []
    });
    await sessionStore.markInflight({
      turnId: runId,
      sessionId: stored.sessionId,
      workspaceId: stored.workspaceId,
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 1,
      pendingApprovalRef: "approval:turn_bg_blocked_truth",
      checkpointRef: "checkpoint:turn_bg_blocked_truth",
      frameRef: "frame:turn_bg_blocked_truth",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:turn_bg_blocked_truth",
        frameRef: "frame:turn_bg_blocked_truth",
        checkpointRef: "checkpoint:turn_bg_blocked_truth",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:turn_bg_blocked_truth",
          checkpointRef: "checkpoint:turn_bg_blocked_truth",
          turnId: runId,
          sessionId: stored.sessionId,
          workspaceId: stored.workspaceId,
          phase: "awaiting_permission",
          step: "approval",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 1,
          toolCallCount: 1,
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            totalTokens: 1,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["approve", "deny", "cancel"],
            metadata: {}
          }
        }
      }
    });

    const worker = createBackgroundWorker({
      tasksDbPath: paths.tasksDbPath,
      runStore,
      taskStore,
      sessionStore,
      shell: {
        executeTurn: vi.fn(async () => createTurnResult({
          turnId: runId,
          sessionId: stored.sessionId,
          status: "blocked",
          messages: [],
          warnings: ["needs approval"],
          blockedBy: "permission",
          checkpointRef: "checkpoint:turn_bg_blocked_truth",
          frameRef: "frame:turn_bg_blocked_truth",
          continuation: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-control.v1",
            frameRef: "frame:turn_bg_blocked_truth",
            checkpointRef: "checkpoint:turn_bg_blocked_truth",
            continuationKind: "awaiting_operator",
            allowedActions: ["approve", "deny", "cancel"],
            metadata: {
              pendingExecutionId: "pending:turn_bg_blocked_truth"
            }
          },
          approvals: [
            {
              decisionId: "approval:turn_bg_blocked_truth",
              behavior: "ask",
              scope: "once",
              reasonCode: "bash_action_requires_approval",
              reasonText: "approval required",
              issuedAt: "2026-04-26T00:00:01.000Z",
              requestedBy: runId
            }
          ]
        }))
      }
    });

    await expect(worker.runOnce({
      workerId: "worker_bg_blocked_truth",
      leaseDurationMs: 30_000
    })).resolves.toMatchObject({
      status: "claimed",
      outcome: "suspended",
      callbackKind: "blocked",
      shellExecuted: true
    });

    await expect(sessionStore.loadRecoveryContext(stored.sessionId)).resolves.toMatchObject({
      inflight: expect.objectContaining({
        turnId: runId,
        pendingApprovalRef: "approval:turn_bg_blocked_truth",
        frameRef: "frame:turn_bg_blocked_truth"
      })
    });
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "blocked",
      pendingApprovalRef: "approval:turn_bg_blocked_truth",
      pendingControlRef: "frame:turn_bg_blocked_truth"
    });
  });

  it("background yielded tool-turn-limit slice suppresses callbacks while keeping friendly pause summary", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({ dataDir, providerTransport: createChatCompletionTransport([]) });
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_tool_turn_limit_pause",
      sessionId: "session_bg_tool_turn_limit_pause",
      input: "background inspect many files until paused"
    });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "interrupted",
      messages: [],
      warnings: ["tool_turn_limit"],
      continuation: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        frameRef: "frame:turn_bg_tool_turn_limit_pause",
        checkpointRef: "checkpoint:turn_bg_tool_turn_limit_pause",
        continuationKind: "resume",
        allowedActions: ["resume", "cancel"],
        metadata: {
          pendingExecutionId: "pending:turn_bg_tool_turn_limit_pause"
        }
      }
    }));

    const workerResult = await app.background.runWorkerOnce({
      workerId: "worker_tool_turn_limit_pause",
      leaseDurationMs: 30_000
    });

    expect(workerResult).toMatchObject({
      status: "claimed",
      turnResultStatus: "interrupted",
      shellExecuted: true
    });
    expect(workerResult.outcome).toBeUndefined();
    expect(workerResult.callbackKind).toBeUndefined();
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "queued",
      continuationKind: "auto_continue",
      pendingControlRef: "frame:turn_bg_tool_turn_limit_pause",
      resultSummary: "paused at a safe checkpoint after hitting this turn’s tool-step safety limit. No tools from the paused step were run. Resume from this chat or via operator/CLI.",
      continuationPayload: expect.objectContaining({
        continuationKind: "resume",
        frameRef: "frame:turn_bg_tool_turn_limit_pause",
        checkpointRef: "checkpoint:turn_bg_tool_turn_limit_pause"
      })
    });
    await expect(sliceStore.listSlicesByRun(runId)).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "yielded",
        triggerKind: "legacy_cutover"
      },
      {
        sliceNo: 2,
        status: "queued",
        triggerKind: "auto_continue"
      }
    ]);
    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toHaveLength(0);
  });

  it("background terminal interrupted tool-batch callback uses failed summary", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_ERROR_EXPOSURE_MODE: "sanitized"
      },
      providerTransport: createChatCompletionTransport([])
    });
    const { taskStore, taskId, runId } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_tool_batch_exhausted",
      sessionId: "session_bg_tool_batch_exhausted",
      input: "background inspect many files"
    });
    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "interrupted",
      messages: [],
      warnings: ["tool_batch_limit_retry_exhausted"]
    }));

    const workerResult = await app.background.runWorkerOnce({
      workerId: "worker_tool_batch_exhausted",
      leaseDurationMs: 30_000
    });

    expect(workerResult).toMatchObject({
      status: "claimed",
      outcome: "failed",
      callbackKind: "failed",
      shellExecuted: true
    });
    const outbounds = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbounds.at(-1)?.renderPayload).toMatchObject({
      summary: "模型一次请求了过多工具，本轮已安全停止，请重试或拆分任务。"
    });
  });
  it("background callbacks suppress memory diagnostics while preserving ordinary warnings", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({ dataDir, providerTransport: createChatCompletionTransport([]) });
    const { taskStore, taskId, runId } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_memory_warning_hidden",
      sessionId: "session_bg_memory_warning_hidden",
      input: "background investigate warning filtering"
    });
    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "failed",
      messages: [],
      warnings: ["memory_context_truncated", "memory selection truncated to fit budget", "rate limit exceeded"]
    }));

    const workerResult = await app.background.runWorkerOnce({
      workerId: "worker_bg_memory_warning_hidden",
      leaseDurationMs: 30_000
    });

    expect(workerResult).toMatchObject({
      status: "claimed",
      outcome: "failed",
      callbackKind: "failed",
      shellExecuted: true
    });

    const outbounds = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbounds.at(-1)?.renderPayload).toMatchObject({
      summary: "rate limit exceeded"
    });
    expect(JSON.stringify(outbounds)).not.toContain("memory_context_truncated");
    expect(JSON.stringify(outbounds)).not.toContain("memory selection truncated to fit budget");
  });

  it("background retry-exhausted callback ignores invalid assistant text candidate", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_ERROR_EXPOSURE_MODE: "sanitized"
      },
      providerTransport: createChatCompletionTransport([])
    });
    const { taskStore, taskId, runId } = await seedQueuedRun(dataDir, {
      turnId: "turn_bg_retry_exhausted_warning_priority",
      sessionId: "session_bg_retry_exhausted_warning_priority",
      input: "background inspect too many files"
    });
    app.shell.executeTurn = vi.fn(async () => createTurnResult({
      status: "interrupted",
      messages: [{ role: "assistant", content: "oversized attempt 2" }],
      warnings: ["tool_batch_limit_retry_exhausted"]
    }));

    await app.background.runWorkerOnce({ workerId: "worker_retry_exhausted_warning_priority", leaseDurationMs: 30_000 });

    const outbounds = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(JSON.stringify(outbounds)).toContain("模型一次请求了过多工具，本轮已安全停止，请重试或拆分任务。");
    expect(JSON.stringify(outbounds)).not.toContain("oversized attempt 2");
  });
});

