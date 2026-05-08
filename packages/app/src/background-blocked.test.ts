import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnContinuation, TurnResult } from "@endec/domain";
import { createTaskEventStore, createTaskRunStore, createTaskStore } from "@endec/tasks";
import { createBackgroundWorker } from "./background-worker.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";

function createContinuation(overrides: Partial<TurnContinuation> = {}): TurnContinuation {
  return {
    schemaVersion: 1,
    contractVersion: "ws0.execution-control.v1",
    frameRef: "frame:blocked_default",
    continuationKind: "awaiting_operator",
    allowedActions: ["approve", "deny"],
    metadata: {},
    ...overrides
  };
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
    turnId: "turn_origin_blocked_001",
    sessionId: "session_bg_blocked_001",
    workspaceId: "workspace_local",
    source: "telegram" as const,
    actorId: "actor_telegram_001",
    input: "investigate blocked flow",
    requestedMode: "chat" as const,
    conversationRef: {
      accountId: "telegram_bot",
      conversationId: "group:100:thread:200",
      peerId: "100",
      peerKind: "group" as const,
      threadId: "200"
    },
    channelContext: {
      messageId: "msg_blocked_001",
      chatType: "group"
    },
    ...overrides
  };
}

function createTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    turnId: "turn_exec_blocked_001",
    sessionId: "session_bg_blocked_001",
    resolvedMode: "chat",
    status: "completed",
    messages: [],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCost: 0
    },
    warnings: [],
    checkpointRef: "checkpoint:turn_exec_blocked_001",
    nextSessionStateRef: "session_state_ref:turn_exec_blocked_001",
    ...overrides
  };
}

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-app-bg-blocked-"));
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
  const eventStore = createTaskEventStore({ filename: paths.tasksDbPath });
  const stored = createStoredTurnRequest(overrides);
  const taskId = "task_bg_blocked_001";
  const runId = "run_bg_blocked_001";

  await runStore.createBackgroundTask({
    taskId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    actorId: stored.actorId,
    conversationRef: stored.conversationRef,
    title: "Investigate blocked flow",
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

  return { paths, runStore, taskStore, eventStore, taskId, runId, stored };
}

describe("background blocked/canonical blocked integration", () => {
  it("blocked turn marks run blocked, not failed", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      messages: [],
      warnings: ["needs approval"],
      blockedBy: "permission",
      checkpointRef: "checkpoint:blocked_001",
      frameRef: "frame:blocked_001",
      continuation: createContinuation({
        frameRef: "frame:blocked_001",
        checkpointRef: "checkpoint:blocked_001",
        metadata: {
          pendingExecutionId: "pending_exec_001"
        }
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    const result = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    expect(result).toMatchObject({
      status: "claimed",
      outcome: "suspended",
      callbackKind: "blocked",
      turnResultStatus: "blocked",
      shellExecuted: true
    });
    expect(result.outcome).not.toBe("interrupted");
    expect(result.callbackKind).not.toBe("interrupted");

    const run = await runStore.loadRunById("run_bg_blocked_001");
    expect(run?.status).toBe("blocked");
    expect(run?.status).not.toBe("failed");
  });

  it("blocked turn keeps task agentStatus blocked and persists blocking reason", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      checkpointRef: "checkpoint:blocked_002",
      continuation: createContinuation({
        frameRef: "frame:blocked_002",
        checkpointRef: "checkpoint:blocked_002"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const backgroundTask = await runStore.loadBackgroundTask("task_bg_blocked_001");
    expect(backgroundTask?.agentStatus).toBe("blocked");
    expect(backgroundTask?.agentStatus).not.toBe("failed");
    expect(backgroundTask?.agentStatus).not.toBe("done");

    const taskTruth = await taskStore.loadById(taskId);
    expect(taskTruth?.status).toBe("blocked");
    expect(taskTruth?.blockingReason).toBe("permission");
  });

  it("blocked turn persists pending refs: frameRef, checkpointRef, pendingApprovalRef, pendingControlRef, blockedBy", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      warnings: ["approval required for bash execution"],
      checkpointRef: "checkpoint:blocked_003",
      frameRef: "frame:blocked_003",
      continuation: createContinuation({
        frameRef: "frame:blocked_003",
        checkpointRef: "checkpoint:blocked_003",
        metadata: {
          pendingExecutionId: "pending_exec_003"
        }
      }),
      approvals: [
        {
          decisionId: "tool_call_bash_003",
          behavior: "ask",
          scope: "once",
          reasonCode: "bash_action_requires_approval",
          reasonText: "git push crosses approval boundary",
          issuedAt: "2026-04-26T00:00:01.000Z",
          requestedBy: "turn_exec_blocked_001"
        }
      ]
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const run = await runStore.loadRunById("run_bg_blocked_001");
    expect(run).toMatchObject({
      status: "blocked",
      pendingApprovalRef: "tool_call_bash_003",
      pendingControlRef: "frame:blocked_003",
      resultSummary: expect.stringContaining("permission")
    });
    expect(run?.pendingApprovalRef).toBeTruthy();
    expect(run?.pendingControlRef).toBeTruthy();

    const taskTruth = await taskStore.loadById(taskId);
    expect(taskTruth?.blockingReason).toBe("permission");
  });

  it("blocked turn enqueues blocked callback event, not interrupted callback", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      warnings: ["needs approval"],
      checkpointRef: "checkpoint:blocked_004",
      continuation: createContinuation({
        frameRef: "frame:blocked_004"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.eventKind).toBe("blocked");
    expect(outbound[0]?.eventKind).not.toBe("interrupted");
    expect(outbound[0]?.renderPayload).toMatchObject({
      eventKind: "blocked",
      taskId,
      runId,
      summary: expect.stringContaining("permission")
    });
  });

  it("blocked run is not auto-reclaimed by normal worker execute path", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      checkpointRef: "checkpoint:blocked_005",
      continuation: createContinuation({
        frameRef: "frame:blocked_005"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    const firstResult = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    expect(firstResult.outcome).toBe("suspended");

    // Now try to claim again with a fresh store to simulate a new worker tick
    const freshRunStore = createTaskRunStore({ filename: ensureEndecDataLayout(dataDir).tasksDbPath });
    const freshTaskStore = createTaskStore({ filename: ensureEndecDataLayout(dataDir).tasksDbPath });
    const secondExecuteTurn = vi.fn(async () => createTurnResult({ status: "completed" }));
    const worker2 = createBackgroundWorker({
      tasksDbPath: ensureEndecDataLayout(dataDir).tasksDbPath,
      runStore: freshRunStore,
      taskStore: freshTaskStore,
      shell: { executeTurn: secondExecuteTurn }
    });

    const secondResult = await worker2.runOnce({
      workerId: "worker_002",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:10.000Z"
    });

    expect(secondResult.status).toBe("idle");
    expect(secondExecuteTurn).not.toHaveBeenCalled();
  });

  it("blocked callback payload does not claim Telegram inline approval exists", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      warnings: ["approval required for bash execution"],
      checkpointRef: "checkpoint:blocked_006",
      continuation: createContinuation({
        frameRef: "frame:blocked_006"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    expect(outbound).toHaveLength(1);
    const payload = outbound[0]?.renderPayload as Record<string, unknown>;

    // The payload must be transport-neutral
    expect(payload).toMatchObject({
      eventKind: "blocked",
      taskId,
      runId,
      summary: expect.any(String)
    });

    // Must NOT contain Telegram-specific approval claims
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("inline_button");
    expect(serialized).not.toContain("telegram_approval");
    expect(serialized).not.toContain("inline_keyboard");
  });

  it("blocked callback payload includes operator/CLI action guidance", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      warnings: ["bash tool needs approval"],
      checkpointRef: "checkpoint:blocked_007",
      continuation: createContinuation({
        frameRef: "frame:blocked_007"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const outbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    const payload = outbound[0]?.renderPayload as Record<string, unknown>;
    const summary = payload.summary as string;

    expect(summary).toContain("permission");
    // Should mention operator/CLI action is required
    expect(summary.toLowerCase()).toMatch(/operator|cli|action|required/i);
  });

  it("approval/control is not executed automatically for blocked run", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      checkpointRef: "checkpoint:blocked_008",
      continuation: createContinuation({
        frameRef: "frame:blocked_008"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    const result = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    // Shell should have been called exactly once (for the original execution)
    expect(executeTurn).toHaveBeenCalledTimes(1);

    // The run is blocked, not completed/failed
    expect(result.outcome).toBe("suspended");

    // Run remains blocked
    const run = await runStore.loadRunById("run_bg_blocked_001");
    expect(run?.status).toBe("blocked");
  });

  it("blocked turn with continuation metadata stores the actual approval decision id as pendingApprovalRef", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "user_decision",
      checkpointRef: "checkpoint:blocked_009",
      frameRef: "frame:blocked_009",
      continuation: createContinuation({
        frameRef: "frame:blocked_009",
        checkpointRef: "checkpoint:blocked_009",
        allowedActions: ["approve", "deny", "cancel"],
        metadata: {
          pendingExecutionId: "pending_exec_009"
        }
      }),
      approvals: [
        {
          decisionId: "budget:turn_exec_blocked_001",
          behavior: "ask",
          scope: "once",
          reasonCode: "budget_requires_confirmation",
          reasonText: "budget needs confirmation before continuing",
          issuedAt: "2026-04-26T00:00:01.000Z",
          requestedBy: "turn_exec_blocked_001"
        }
      ]
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const run = await runStore.loadRunById("run_bg_blocked_001");
    expect(run?.pendingApprovalRef).toBe("budget:turn_exec_blocked_001");
    expect(run?.pendingApprovalRef).not.toBe("pending_exec_009");
    expect(run?.pendingControlRef).toBe("frame:blocked_009");
  });

  it("blocked turn without continuation still blocks with blockedBy reason and persists task blocking reason", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, taskId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "rate_limit",
      warnings: ["rate limit exceeded"],
      checkpointRef: "checkpoint:blocked_010"
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, shell: { executeTurn } });

    const result = await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    expect(result.outcome).toBe("suspended");
    expect(result.callbackKind).toBe("blocked");

    const run = await runStore.loadRunById("run_bg_blocked_001");
    expect(run?.status).toBe("blocked");
    expect(run?.resultSummary).toContain("rate_limit");

    const taskTruth = await taskStore.loadById(taskId);
    expect(taskTruth?.blockingReason).toBe("rate_limit");
  });

  it("blocked turn appends approval_required task event", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, eventStore, taskId, runId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      checkpointRef: "checkpoint:blocked_011",
      continuation: createContinuation({
        frameRef: "frame:blocked_011"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, eventStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const events = await eventStore.listEventsByRun({ runId });
    const approvalEvent = events.find((e) => e.eventType === "approval_required");
    expect(approvalEvent).toMatchObject({
      eventType: "approval_required",
      taskId,
      runId,
      message: expect.stringContaining("permission")
    });
  });

  it("blocked turn appends run_suspended task event", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const { paths, runStore, taskStore, eventStore, taskId, runId } = await seedQueuedRun(dataDir);

    const executeTurn = vi.fn(async () => createTurnResult({
      status: "blocked",
      blockedBy: "permission",
      checkpointRef: "checkpoint:blocked_012",
      continuation: createContinuation({
        frameRef: "frame:blocked_012"
      })
    }));

    const worker = createBackgroundWorker({ tasksDbPath: paths.tasksDbPath, runStore, taskStore, eventStore, shell: { executeTurn } });

    await worker.runOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-26T00:00:01.000Z"
    });

    const events = await eventStore.listEventsByRun({ runId });
    const suspendedEvent = events.find((e) => e.eventType === "run_suspended");
    expect(suspendedEvent).toMatchObject({
      eventType: "run_suspended",
      taskId,
      runId
    });
  });
});
