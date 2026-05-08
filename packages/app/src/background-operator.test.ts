import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderTransport } from "@endec/ai";
import { createTaskEventStore, createTaskRunStore, createTaskStore } from "@endec/tasks";
import { createEndecApp } from "./index.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";

function createProviderTransport(): ProviderTransport {
  return {
    async *stream() {
      yield {
        choices: [
          {
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
    }
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
    turnId: "turn_bg_operator_origin_001",
    sessionId: "session_bg_operator_001",
    workspaceId: "workspace_local",
    source: "telegram" as const,
    actorId: "actor_telegram_001",
    input: "investigate background operator task",
    requestedMode: "chat" as const,
    conversationRef: {
      accountId: "telegram_bot",
      conversationId: "group:100:thread:200",
      peerId: "100",
      peerKind: "group" as const,
      threadId: "200"
    },
    channelContext: {
      messageId: "msg_operator_001",
      chatType: "group"
    },
    ...overrides
  };
}

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-app-bg-operator-"));
}

const tempDirs = new Set<string>();

afterEach(async () => {
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
  const taskId = overrides.turnId ? `task_${overrides.turnId}` : "task_bg_operator_001";
  const runId = overrides.turnId ? `run_${overrides.turnId}` : "run_bg_operator_001";

  await runStore.createBackgroundTask({
    taskId,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    actorId: stored.actorId,
    conversationRef: stored.conversationRef,
    title: "Investigate background operator task",
    description: stored.input,
    sourceTurnId: stored.turnId,
    now: "2026-04-27T00:00:00.000Z"
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
    now: "2026-04-27T00:00:00.000Z"
  });

  return { paths, runStore, taskStore, eventStore, taskId, runId, stored };
}

async function moveRunToRunning(runStore: ReturnType<typeof createTaskRunStore>, runId: string) {
  const claim = await runStore.claimNextRun({
    workerId: "worker_001",
    leaseDurationMs: 60_000,
    now: "2026-04-27T00:00:01.000Z"
  });

  expect(claim).toMatchObject({ status: "claimed" });
  expect(claim.status === "claimed" ? claim.run.runId : undefined).toBe(runId);
}

async function createApp(dataDir: string) {
  return createEndecApp({
    dataDir,
    providerTransport: createProviderTransport()
  });
}

describe("background operator", () => {
  it("inspect returns task + run summary for queued background task", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { taskId, runId, stored } = await seedQueuedRun(dataDir);

    const inspection = await app.operator.inspectBackgroundTask({ taskId });

    expect(inspection).toMatchObject({
      task: {
        taskId,
        workspaceId: stored.workspaceId,
        sessionId: stored.sessionId,
        title: "Investigate background operator task",
        description: stored.input,
        agentStatus: "queued"
      },
      runs: [
        {
          runId,
          taskId,
          status: "queued",
          attemptNo: 1,
          maxAttempts: 1
        }
      ],
      events: [],
      outbound: []
    });
  });

  it("inspect returns blocked refs and blocking_reason for blocked run", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { runStore, taskId, runId } = await seedQueuedRun(dataDir);

    await moveRunToRunning(runStore, runId);
    await runStore.suspendRun({
      runId,
      pendingApprovalRef: "approval_001",
      pendingControlRef: "frame:blocked_001",
      blockedBy: "permission",
      resultSummary: "blocked: permission; operator action required",
      now: "2026-04-27T00:00:02.000Z"
    });

    const inspection = await app.operator.inspectBackgroundTask({ taskId });

    expect(inspection).toMatchObject({
      task: {
        taskId,
        agentStatus: "blocked",
        blockingReason: "permission"
      },
      runs: [
        {
          runId,
          status: "blocked",
          pendingApprovalRef: "approval_001",
          pendingControlRef: "frame:blocked_001",
          resultSummary: "blocked: permission; operator action required"
        }
      ]
    });
  });

  it("inspect includes outbound callback state summary if available", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { taskStore, taskId, runId, stored } = await seedQueuedRun(dataDir);

    await taskStore.enqueueOutboundEvent({
      outboundEventId: "outbound_bg_operator_001",
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      actorId: stored.actorId,
      taskId,
      runId,
      conversationRef: stored.conversationRef,
      channel: "telegram",
      eventKind: "blocked",
      renderPayload: {
        schemaVersion: 1,
        contractVersion: "im.background-callback.v1",
        eventKind: "blocked",
        taskId,
        runId,
        attemptNo: 1,
        summary: "callback summary"
      },
      idempotencyKey: `run:${runId}:callback:blocked`,
      now: "2026-04-27T00:00:03.000Z",
      availableAt: "2026-04-27T00:00:03.000Z"
    });

    await taskStore.createOutboundDelivery({
      deliveryId: "delivery_bg_operator_001",
      outboundEventId: "outbound_bg_operator_001",
      transport: "telegram",
      transportTarget: {
        chatId: "100",
        threadId: "200"
      },
      idempotencyKey: "delivery:telegram:1",
      now: "2026-04-27T00:00:04.000Z"
    });

    await taskStore.markDeliverySending({
      deliveryId: "delivery_bg_operator_001",
      claimOwner: "telegram-drain-1",
      sendStartedAt: "2026-04-27T00:00:05.000Z"
    });

    await taskStore.markDeliveryDelivered({
      deliveryId: "delivery_bg_operator_001",
      deliveredAt: "2026-04-27T00:00:06.000Z",
      transportMessageId: "12345"
    });

    const inspection = await app.operator.inspectBackgroundTask({ taskId });

    expect(inspection?.outbound).toMatchObject([
      {
        outboundEvent: {
          outboundEventId: "outbound_bg_operator_001",
          eventKind: "blocked",
          status: "pending"
        },
        deliveries: [
          {
            deliveryId: "delivery_bg_operator_001",
            status: "delivered",
            transport: "telegram",
            transportMessageId: "12345"
          }
        ]
      }
    ]);
  });

  it("cancel blocked run callback uses persisted source truth even when accountId is misleading", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir, {
      source: "feishu",
      conversationRef: {
        accountId: "telegram_bot_but_not_truth",
        conversationId: "chat:generic:001",
        peerId: "generic-peer",
        peerKind: "group",
        threadId: "thread-1"
      }
    });

    await moveRunToRunning(runStore, runId);
    await runStore.suspendRun({
      runId,
      pendingApprovalRef: "approval_misleading_001",
      pendingControlRef: "frame:blocked_misleading_001",
      blockedBy: "permission",
      resultSummary: "blocked summary",
      now: "2026-04-27T00:00:02.000Z"
    });

    await app.operator.cancelBackgroundTask({
      taskId,
      runId,
      actorId: "operator_001",
      reason: "cancel with misleading account id"
    });

    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventKind: "canceled",
        channel: "feishu"
      })
    ]));
  });

  it("listBackgroundOutbox supports runId-only queries", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { taskStore, taskId, runId, stored } = await seedQueuedRun(dataDir, {
      source: "telegram",
      conversationRef: {
        accountId: "generic-account",
        conversationId: "chat:generic:002",
        peerId: "generic-peer",
        peerKind: "group",
        threadId: "thread-2"
      }
    });

    await taskStore.enqueueOutboundEvent({
      outboundEventId: "outbound_bg_operator_run_only_001",
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      actorId: stored.actorId,
      taskId,
      runId,
      conversationRef: stored.conversationRef,
      channel: "telegram",
      eventKind: "blocked",
      renderPayload: {
        schemaVersion: 1,
        contractVersion: "im.background-callback.v1",
        eventKind: "blocked",
        taskId,
        runId,
        attemptNo: 1,
        summary: "run-only query payload"
      },
      idempotencyKey: `run:${runId}:callback:blocked`,
      now: "2026-04-27T00:00:03.000Z",
      availableAt: "2026-04-27T00:00:03.000Z"
    });

    await expect(app.operator.listBackgroundOutbox({ runId })).resolves.toEqual([
      expect.objectContaining({
        outboundEvent: expect.objectContaining({
          outboundEventId: "outbound_bg_operator_run_only_001",
          taskId,
          runId,
          channel: "telegram"
        }),
        deliveries: []
      })
    ]);
  });

  it("cancel queued run marks canceled", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { runStore, taskStore, eventStore, taskId, runId } = await seedQueuedRun(dataDir);

    const result = await app.operator.cancelBackgroundTask({
      taskId,
      runId,
      actorId: "operator_001",
      reason: "operator canceled queued run"
    });

    expect(result).toMatchObject({
      taskId,
      runId,
      status: "canceled",
      taskStatus: "canceled",
      runStatus: "canceled"
    });
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled queued run"
    });
    await expect(runStore.loadBackgroundTask(taskId)).resolves.toMatchObject({
      agentStatus: "canceled"
    });
    await expect(taskStore.loadById(taskId)).resolves.toMatchObject({
      status: "cancelled"
    });
    await expect(eventStore.listEventsByRun({ runId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "run_canceled",
        message: expect.stringContaining("operator canceled queued run")
      })
    ]));
    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventKind: "canceled"
      })
    ]));
  });

  it("cancel blocked run marks canceled", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    await moveRunToRunning(runStore, runId);
    await runStore.suspendRun({
      runId,
      pendingApprovalRef: "approval_002",
      pendingControlRef: "frame:blocked_002",
      blockedBy: "permission",
      resultSummary: "blocked summary",
      now: "2026-04-27T00:00:02.000Z"
    });

    const result = await app.operator.cancelBackgroundTask({
      taskId,
      runId,
      actorId: "operator_001",
      reason: "operator canceled blocked run"
    });

    expect(result).toMatchObject({
      taskId,
      runId,
      status: "canceled",
      taskStatus: "canceled",
      runStatus: "canceled"
    });
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled blocked run"
    });
    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKind: "canceled" })
    ]));
  });

  it("cancel running run latches cancellation requester identity while run stays running", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { runStore, taskStore, eventStore, taskId, runId } = await seedQueuedRun(dataDir);

    await moveRunToRunning(runStore, runId);

    const result = await app.operator.cancelBackgroundTask({
      taskId,
      runId,
      actorId: "operator_001",
      reason: "operator requested cancellation"
    });

    expect(result).toMatchObject({
      taskId,
      runId,
      status: "cancel_requested",
      taskStatus: "running",
      runStatus: "running"
    });
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "running",
      cancelRequestedBy: "operator_001",
      cancelReason: "operator requested cancellation"
    });
    await expect(eventStore.listEventsByRun({ runId })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "cancel_requested"
      })
    ]));
    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toEqual([]);
  });

  it("cancel terminal run is stable no-op / already terminal", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { runStore, taskStore, taskId, runId } = await seedQueuedRun(dataDir);

    await moveRunToRunning(runStore, runId);
    await runStore.completeRun({
      runId,
      resultSummary: "finished already",
      now: "2026-04-27T00:00:03.000Z"
    });

    const beforeOutbound = await taskStore.listOutboundEventsByTask({ taskId, runId });
    const result = await app.operator.cancelBackgroundTask({
      taskId,
      runId,
      actorId: "operator_001",
      reason: "too late"
    });

    expect(result).toMatchObject({
      taskId,
      runId,
      status: "already_terminal",
      taskStatus: "done",
      runStatus: "completed"
    });
    await expect(runStore.loadRunById(runId)).resolves.toMatchObject({
      status: "completed",
      resultSummary: "finished already"
    });
    await expect(taskStore.listOutboundEventsByTask({ taskId, runId })).resolves.toEqual(beforeOutbound);
  });

  it("inspect missing task returns safe not-found result", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);

    await expect(app.operator.inspectBackgroundTask({ taskId: "task_missing" })).resolves.toBeNull();
  });

  it("inspect uses durable store truth, not callback summary text only", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = await createApp(dataDir);
    const { runStore, taskStore, taskId, runId, stored } = await seedQueuedRun(dataDir);

    await moveRunToRunning(runStore, runId);
    await runStore.completeRun({
      runId,
      resultSummary: "durable run summary",
      now: "2026-04-27T00:00:03.000Z"
    });

    await taskStore.enqueueOutboundEvent({
      outboundEventId: "outbound_bg_operator_truth_001",
      workspaceId: stored.workspaceId,
      sessionId: stored.sessionId,
      actorId: stored.actorId,
      taskId,
      runId,
      conversationRef: stored.conversationRef,
      channel: "telegram",
      eventKind: "final",
      renderPayload: {
        schemaVersion: 1,
        contractVersion: "im.background-callback.v1",
        eventKind: "final",
        taskId,
        runId,
        attemptNo: 1,
        summary: "callback summary should not replace durable truth"
      },
      idempotencyKey: `run:${runId}:callback:final`,
      now: "2026-04-27T00:00:04.000Z",
      availableAt: "2026-04-27T00:00:04.000Z"
    });

    const inspection = await app.operator.inspectBackgroundTask({ taskId });

    expect(inspection?.runs[0]?.resultSummary).toBe("durable run summary");
    expect(inspection?.outbound[0]?.outboundEvent.renderPayload).toMatchObject({
      summary: "callback summary should not replace durable truth"
    });
  });
});
