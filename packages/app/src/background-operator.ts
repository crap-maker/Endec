import { randomUUID } from "node:crypto";
import type {
  AgentTaskSnapshot,
  BackgroundCancelResult,
  BackgroundInspectTaskDetail,
  OutboundEvent,
  TaskEvent,
  TaskRunSnapshot
} from "@endec/domain";
import { createBackgroundOutboundRenderPayload } from "./background-outbound-renderer.ts";

type RunStore = {
  loadBackgroundTask(taskId: string): Promise<AgentTaskSnapshot | undefined>;
  listBackgroundTasks(input?: {
    workspaceId?: string;
    sessionId?: string;
    agentStatus?: AgentTaskSnapshot["agentStatus"];
    limit?: number;
  }): Promise<AgentTaskSnapshot[]>;
  listRunsByTask(taskId: string): Promise<TaskRunSnapshot[]>;
  loadRunById(runId: string): Promise<TaskRunSnapshot | undefined>;
  requestRunCancellation(input: { runId: string; actorId?: string; reason?: string; now?: string }): Promise<TaskRunSnapshot | undefined>;
  cancelQueuedOrSuspendedRun(input: { runId: string; reason?: string; now?: string }): Promise<TaskRunSnapshot | undefined>;
};

type RecoveryStore = {
  loadRecoveryContext(sessionId: string): Promise<{
    inflight: {
      turnId: string;
    };
  } | null>;
  finalize(input: { turnId: string; sessionId: string; status: "completed" | "failed" | "interrupted" | "blocked" }): Promise<string>;
};

type DetachedLifecycle = {
  cancelDetachedRun(input: {
    sessionId: string;
    taskId: string;
    runId: string;
    attentionMode?: "foreground_attached" | "background_detached";
    reason?: string;
    requestedBy?: string;
    now?: string;
  }): Promise<{ status: "canceled" | "cancel_requested" | "not_runnable" }>;
  closeBlockedRunTerminally(input: {
    sessionId: string;
    taskId: string;
    runId: string;
    attentionMode?: "foreground_attached" | "background_detached";
    terminalStatus: "failed" | "canceled";
    resultSummary?: string;
    error?: unknown;
    cancel?: {
      requestedAt?: string;
      requestedBy?: string;
      reason?: string;
    };
    control?: {
      controlId?: string;
      kind: "cancel";
      payload?: unknown;
    };
    now?: string;
  }): Promise<TaskRunSnapshot | undefined>;
};

type EventStore = {
  listEventsByTask(input: { taskId: string }): Promise<TaskEvent[]>;
  listEventsByRun(input: { runId: string }): Promise<TaskEvent[]>;
  appendTaskEvent(input: {
    taskId: string;
    runId?: string;
    workspaceId: string;
    eventType: import("@endec/domain").TaskEventType;
    severity: import("@endec/domain").TaskEventSeverity;
    message: string;
    data?: unknown;
    idempotencyKey?: string;
    now?: Date;
  }): Promise<unknown>;
};

type OutboundStore = {
  listOutboundEventsByTask(input: { taskId: string; runId?: string }): Promise<OutboundEvent[]>;
  listOutboundDeliveriesByEvent(input: { outboundEventId: string }): Promise<import("@endec/domain").OutboundDelivery[]>;
  enqueueOutboundEvent(input: {
    outboundEventId: string;
    workspaceId: string;
    sessionId: string;
    actorId?: string;
    taskId?: string;
    runId?: string;
    conversationRef: NonNullable<AgentTaskSnapshot["conversationRef"]>;
    channel: "telegram" | "feishu" | "web" | "sdk";
    eventKind: "canceled";
    renderPayload: unknown;
    idempotencyKey: string;
    availableAt?: string;
    now?: string;
  }): Promise<unknown>;
};

function latestRun(runs: TaskRunSnapshot[]) {
  return [...runs].sort((left, right) => {
    if (left.attemptNo !== right.attemptNo) {
      return right.attemptNo - left.attemptNo;
    }
    return right.createdAt.localeCompare(left.createdAt);
  })[0];
}

function deriveChannelFromRun(run: TaskRunSnapshot): "telegram" | "feishu" | "web" | "sdk" {
  const turnRequest = (run as TaskRunSnapshot & { turnRequest?: unknown }).turnRequest;
  const rawSource = turnRequest && typeof turnRequest === "object"
    ? (turnRequest as { source?: unknown }).source
    : undefined;

  switch (rawSource) {
    case "telegram":
    case "feishu":
    case "web":
    case "sdk":
      return rawSource;
    default:
      return "sdk";
  }
}

function isTerminalStatus(status: TaskRunSnapshot["status"]) {
  return status === "completed"
    || status === "failed"
    || status === "canceled";
}

function summarizeCanceled(reason: string | undefined) {
  return reason?.trim() || "background task canceled";
}

type DetachedCancelConvergence = {
  status: "canceled" | "cancel_requested" | "already_terminal";
  run: TaskRunSnapshot;
};

export function createBackgroundOperator(input: {
  runStore: RunStore;
  eventStore: EventStore;
  outboundStore: OutboundStore;
  recoveryStore?: RecoveryStore;
  detachedLifecycle?: DetachedLifecycle;
}) {
  async function closeRecoveryForCanceledRun(run: TaskRunSnapshot) {
    if (!input.recoveryStore) {
      return;
    }

    const recovery = await input.recoveryStore.loadRecoveryContext(run.sessionId);
    if (!recovery || recovery.inflight.turnId !== run.runId) {
      return;
    }

    await input.recoveryStore.finalize({
      turnId: run.runId,
      sessionId: run.sessionId,
      status: "interrupted"
    });
  }

  async function inspectBackgroundTask({ taskId }: { taskId: string }): Promise<BackgroundInspectTaskDetail | null> {
    const task = await input.runStore.loadBackgroundTask(taskId);
    if (!task) {
      return null;
    }

    const runs = await input.runStore.listRunsByTask(taskId);
    const events = await input.eventStore.listEventsByTask({ taskId });
    const outboundEvents = await input.outboundStore.listOutboundEventsByTask({ taskId });
    const outbound = await Promise.all(
      outboundEvents.map(async (outboundEvent) => ({
        outboundEvent,
        deliveries: await input.outboundStore.listOutboundDeliveriesByEvent({
          outboundEventId: outboundEvent.outboundEventId
        })
      }))
    );

    return {
      task,
      runs,
      events,
      outbound
    };
  }

  async function listBackgroundTasks(inputFilter: {
    workspaceId?: string;
    sessionId?: string;
    agentStatus?: AgentTaskSnapshot["agentStatus"];
    limit?: number;
  } = {}) {
    const tasks = await input.runStore.listBackgroundTasks(inputFilter);
    return Promise.all(tasks.map(async (task) => {
      const runs = await input.runStore.listRunsByTask(task.taskId);
      const current = latestRun(runs);
      return {
        task,
        latestRun: current
      };
    }));
  }

  function classifyDetachedCancelConvergence(run: TaskRunSnapshot): DetachedCancelConvergence | undefined {
    if (run.status === "canceled") {
      return {
        status: "canceled",
        run
      };
    }

    if (!isTerminalStatus(run.status) && run.cancelRequestedAt) {
      return {
        status: "cancel_requested",
        run
      };
    }

    if (isTerminalStatus(run.status)) {
      return {
        status: "already_terminal",
        run
      };
    }

    return undefined;
  }

  async function loadDetachedCancelConvergence(runId: string): Promise<DetachedCancelConvergence | undefined> {
    const run = await input.runStore.loadRunById(runId);
    return run ? classifyDetachedCancelConvergence(run) : undefined;
  }

  async function requestDetachedLifecycleCancel(targetRun: TaskRunSnapshot, request: {
    actorId?: string;
    reason?: string;
  }, now: string) {
    if (!input.detachedLifecycle) {
      return undefined;
    }

    const outcome = await input.detachedLifecycle.cancelDetachedRun({
      sessionId: targetRun.sessionId,
      taskId: targetRun.taskId,
      runId: targetRun.runId,
      attentionMode: targetRun.attentionMode,
      reason: request.reason,
      requestedBy: request.actorId,
      now
    });

    const convergence = await loadDetachedCancelConvergence(targetRun.runId);
    if (!convergence) {
      return undefined;
    }

    if (outcome.status === "canceled") {
      return convergence.status === "canceled"
        ? convergence
        : convergence.status === "already_terminal"
          ? convergence
          : undefined;
    }

    if (outcome.status === "cancel_requested") {
      return convergence.status === "cancel_requested"
        ? convergence
        : convergence.status === "already_terminal"
          ? convergence
          : undefined;
    }

    return convergence.status === "already_terminal" ? convergence : undefined;
  }

  async function recoverBlockedDetachedCancelRace(targetRun: TaskRunSnapshot, request: {
    actorId?: string;
    reason?: string;
  }, now: string) {
    const refreshed = await input.runStore.loadRunById(targetRun.runId);
    if (!refreshed || refreshed.attentionMode !== "background_detached") {
      return loadDetachedCancelConvergence(targetRun.runId);
    }

    if (refreshed.status === "queued" || refreshed.status === "running") {
      return requestDetachedLifecycleCancel(refreshed, request, now);
    }

    return loadDetachedCancelConvergence(targetRun.runId);
  }

  async function cancelCanonicalDetachedRun(targetRun: TaskRunSnapshot, request: {
    actorId?: string;
    reason?: string;
  }, now: string) {
    if (!input.detachedLifecycle || targetRun.attentionMode !== "background_detached") {
      return undefined;
    }

    if (targetRun.status === "queued") {
      try {
        return await requestDetachedLifecycleCancel(targetRun, request, now);
      } catch (error) {
        if (error instanceof Error && error.message.includes("without an open slice")) {
          return loadDetachedCancelConvergence(targetRun.runId);
        }
        throw error;
      }
    }

    if (targetRun.status === "blocked") {
      try {
        const closedRun = await input.detachedLifecycle.closeBlockedRunTerminally({
          sessionId: targetRun.sessionId,
          taskId: targetRun.taskId,
          runId: targetRun.runId,
          attentionMode: targetRun.attentionMode,
          terminalStatus: "canceled",
          resultSummary: request.reason,
          cancel: {
            requestedAt: now,
            requestedBy: request.actorId,
            reason: request.reason
          },
          control: {
            kind: "cancel",
            payload: {
              reason: request.reason,
              requestedBy: request.actorId
            }
          },
          now
        });
        return closedRun
          ? {
              status: "canceled",
              run: closedRun
            }
          : loadDetachedCancelConvergence(targetRun.runId);
      } catch (error) {
        if (error instanceof Error && error.message.includes("must be blocked before closing terminally")) {
          return recoverBlockedDetachedCancelRace(targetRun, request, now);
        }
        throw error;
      }
    }

    return undefined;
  }

  async function appendCancelRequestedEvent(run: TaskRunSnapshot, request: {
    actorId?: string;
    reason?: string;
  }, now: string) {
    await input.eventStore.appendTaskEvent({
      taskId: run.taskId,
      runId: run.runId,
      workspaceId: run.workspaceId,
      eventType: "cancel_requested",
      severity: "warning",
      message: summarizeCanceled(request.reason),
      data: {
        actorId: request.actorId,
        reason: request.reason
      },
      idempotencyKey: `run:${run.runId}:event:cancel_requested`,
      now: new Date(now)
    });
  }

  async function cancelBackgroundTask(request: {
    taskId: string;
    runId?: string;
    actorId?: string;
    reason?: string;
  }): Promise<BackgroundCancelResult> {
    const task = await input.runStore.loadBackgroundTask(request.taskId);
    if (!task) {
      return {
        taskId: request.taskId,
        runId: request.runId,
        status: "not_found"
      };
    }

    const runs = await input.runStore.listRunsByTask(request.taskId);
    const targetRun = request.runId
      ? await input.runStore.loadRunById(request.runId)
      : latestRun(runs);

    if (!targetRun || targetRun.taskId !== request.taskId) {
      return {
        taskId: request.taskId,
        runId: request.runId,
        status: "not_found"
      };
    }

    const now = new Date().toISOString();
    const reason = request.reason;

    if (targetRun.status === "queued" || targetRun.status === "blocked") {
      const detachedConvergence = await cancelCanonicalDetachedRun(targetRun, request, now);
      if (detachedConvergence?.status === "cancel_requested") {
        await appendCancelRequestedEvent(detachedConvergence.run, request, now);
        const refreshedTask = await input.runStore.loadBackgroundTask(detachedConvergence.run.taskId);
        return {
          taskId: detachedConvergence.run.taskId,
          runId: detachedConvergence.run.runId,
          status: "cancel_requested",
          taskStatus: refreshedTask?.agentStatus,
          runStatus: detachedConvergence.run.status
        };
      }

      if (detachedConvergence?.status === "already_terminal") {
        const refreshedTask = await input.runStore.loadBackgroundTask(detachedConvergence.run.taskId);
        return {
          taskId: detachedConvergence.run.taskId,
          runId: detachedConvergence.run.runId,
          status: "already_terminal",
          taskStatus: refreshedTask?.agentStatus,
          runStatus: detachedConvergence.run.status
        };
      }

      const canceled = detachedConvergence?.run
        ?? await input.runStore.cancelQueuedOrSuspendedRun({
          runId: targetRun.runId,
          reason,
          now
        });

      if (!canceled) {
        return {
          taskId: request.taskId,
          runId: targetRun.runId,
          status: "not_found"
        };
      }

      await closeRecoveryForCanceledRun(canceled);

      await input.eventStore.appendTaskEvent({
        taskId: canceled.taskId,
        runId: canceled.runId,
        workspaceId: canceled.workspaceId,
        eventType: "run_canceled",
        severity: "warning",
        message: summarizeCanceled(reason),
        data: {
          actorId: request.actorId,
          reason
        },
        idempotencyKey: `run:${canceled.runId}:event:run_canceled`,
        now: new Date(now)
      });

      if (canceled.conversationRef) {
        await input.outboundStore.enqueueOutboundEvent({
          outboundEventId: `outbound_${randomUUID()}`,
          workspaceId: canceled.workspaceId,
          sessionId: canceled.sessionId,
          actorId: canceled.actorId,
          taskId: canceled.taskId,
          runId: canceled.runId,
          conversationRef: canceled.conversationRef,
          channel: deriveChannelFromRun(canceled),
          eventKind: "canceled",
          renderPayload: createBackgroundOutboundRenderPayload({
            eventKind: "canceled",
            run: canceled,
            taskTitle: task.title,
            summary: summarizeCanceled(reason)
          }),
          idempotencyKey: `run:${canceled.runId}:callback:canceled`,
          now,
          availableAt: now
        });
      }

      return {
        taskId: canceled.taskId,
        runId: canceled.runId,
        status: "canceled",
        taskStatus: "canceled",
        runStatus: canceled.status
      };
    }

    if (targetRun.status === "running") {
      if (targetRun.cancelRequestedAt) {
        const refreshedTask = await input.runStore.loadBackgroundTask(targetRun.taskId);
        return {
          taskId: targetRun.taskId,
          runId: targetRun.runId,
          status: "cancel_requested",
          taskStatus: refreshedTask?.agentStatus,
          runStatus: targetRun.status
        };
      }

      const requested = await input.runStore.requestRunCancellation({
        runId: targetRun.runId,
        actorId: request.actorId,
        reason,
        now
      });

      if (!requested) {
        return {
          taskId: request.taskId,
          runId: targetRun.runId,
          status: "not_found"
        };
      }

      await appendCancelRequestedEvent(requested, request, now);

      const refreshedTask = await input.runStore.loadBackgroundTask(requested.taskId);
      return {
        taskId: requested.taskId,
        runId: requested.runId,
        status: "cancel_requested",
        taskStatus: refreshedTask?.agentStatus,
        runStatus: requested.status
      };
    }

    if (isTerminalStatus(targetRun.status)) {
      const refreshedTask = await input.runStore.loadBackgroundTask(targetRun.taskId);
      return {
        taskId: targetRun.taskId,
        runId: targetRun.runId,
        status: "already_terminal",
        taskStatus: refreshedTask?.agentStatus,
        runStatus: targetRun.status
      };
    }

    return {
      taskId: targetRun.taskId,
      runId: targetRun.runId,
      status: "not_found"
    };
  }

  async function listBackgroundOutbox(inputFilter: { taskId?: string; runId?: string }) {
    const taskId = inputFilter.taskId
      ?? (inputFilter.runId ? (await input.runStore.loadRunById(inputFilter.runId))?.taskId : undefined);

    if (!taskId) {
      return [];
    }

    const outboundEvents = await input.outboundStore.listOutboundEventsByTask({
      taskId,
      ...(inputFilter.runId ? { runId: inputFilter.runId } : {})
    });

    return Promise.all(outboundEvents.map(async (outboundEvent) => ({
      outboundEvent,
      deliveries: await input.outboundStore.listOutboundDeliveriesByEvent({
        outboundEventId: outboundEvent.outboundEventId
      })
    })));
  }

  return {
    listBackgroundTasks,
    inspectBackgroundTask,
    cancelBackgroundTask,
    listBackgroundOutbox
  };
}
