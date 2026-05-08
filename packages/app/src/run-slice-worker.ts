import { randomUUID } from "node:crypto";
import {
  DEFAULT_ERROR_EXPOSURE_MODE,
  type ErrorExposureMode,
  type OutboundEventKind,
  type TaskEventType,
  type TurnRequest,
  type TurnResult
} from "@endec/domain";
import type { TaskRunStore } from "@endec/tasks";
import { createCanceledBackgroundResult, extractBlockedSuspendRefs, classifyBackgroundTurnResult, isResumableInterruptedTurnResult } from "./background-result.ts";
import type { BackgroundWorkerRunResult } from "./background-worker.ts";
import type { createRunLifecycle } from "./run-lifecycle.ts";
import { createBackgroundOutboundRenderPayload } from "./background-outbound-renderer.ts";

type RunLifecycle = ReturnType<typeof createRunLifecycle>;

type OutboundStore = {
  loadById?(taskId: string): Promise<import("@endec/domain").TaskState | undefined>;
  upsertTask?(input: {
    taskId: string;
    workspaceId: string;
    sessionId: string;
    title: string;
    description: string;
    kind: import("@endec/domain").TaskState["kind"];
    status: import("@endec/domain").TaskState["status"];
    lastTurnId: string;
    checkpointRef: string;
    plan?: string[];
    currentStep?: string;
    nextAction?: string;
    artifacts?: unknown[];
    blockingReason?: string;
  }): Promise<unknown>;
  enqueueOutboundEvent(input: {
    outboundEventId: string;
    workspaceId: string;
    sessionId: string;
    actorId?: string;
    taskId?: string;
    runId?: string;
    conversationRef: NonNullable<TurnRequest["conversationRef"]>;
    channel: "telegram" | "feishu" | "web" | "sdk";
    eventKind: OutboundEventKind;
    renderPayload: unknown;
    idempotencyKey: string;
    availableAt?: string;
    now?: string;
  }): Promise<unknown>;
  listOutboundEventsByTask?(input: { taskId?: string; runId?: string }): Promise<import("@endec/domain").OutboundEvent[]>;
};

type TaskEventStore = {
  appendTaskEvent(input: {
    taskId: string;
    runId?: string;
    workspaceId: string;
    eventType: TaskEventType;
    severity: import("@endec/domain").TaskEventSeverity;
    message: string;
    data?: unknown;
    idempotencyKey?: string;
    now?: Date;
  }): Promise<unknown>;
};

type ShellPort = {
  executeTurn(request: TurnRequest): Promise<TurnResult>;
};

type TaskRunStoreRunLike = Awaited<ReturnType<TaskRunStore["loadRunById"]>> extends infer T ? NonNullable<T> : never;

type NowPort = () => string;

function toIso(now?: string) {
  return now ?? new Date().toISOString();
}

function deriveChannelFromSource(source: TurnRequest["source"]): "telegram" | "feishu" | "sdk" | "web" {
  switch (source) {
    case "telegram":
    case "feishu":
    case "web":
    case "sdk":
      return source;
    default:
      return "sdk";
  }
}

function reconstructTurnRequest(run: TaskRunStoreRunLike): TurnRequest {
  const stored = run.turnRequest as Record<string, unknown>;
  const originTurnId = typeof stored.originTurnId === "string"
    ? stored.originTurnId
    : typeof stored.turnId === "string"
      ? stored.turnId
      : run.sourceTurnId ?? run.runId;

  return {
    turnId: run.runId,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    source: stored.source === "telegram"
      || stored.source === "feishu"
      || stored.source === "cli"
      || stored.source === "tui"
      || stored.source === "web"
      || stored.source === "sdk"
      ? stored.source
      : "sdk",
    actorId: typeof stored.actorId === "string" ? stored.actorId : run.actorId ?? "system:background-worker",
    input: typeof stored.input === "string" ? stored.input : "",
    attachments: Array.isArray(stored.attachments) ? stored.attachments : [],
    requestedMode: stored.requestedMode === "chat"
      || stored.requestedMode === "plan"
      || stored.requestedMode === "act"
      || stored.requestedMode === "review"
      || stored.requestedMode === "task"
      ? stored.requestedMode
      : undefined,
    conversationRef: run.conversationRef,
    taskId: run.taskId,
    channelContext: {
      ...(stored.channelContext && typeof stored.channelContext === "object" && !Array.isArray(stored.channelContext)
        ? stored.channelContext as Record<string, unknown>
        : {}),
      backgroundTask: {
        schemaVersion: 1,
        contractVersion: "im.background-turn.v1",
        taskId: run.taskId,
        runId: run.runId,
        attemptNo: run.attemptNo,
        originTurnId,
        executionRole: "background_worker"
      }
    }
  };
}

async function enqueueTerminalCallback(input: {
  taskStore: OutboundStore;
  run: TaskRunStoreRunLike;
  taskTitle?: string;
  callbackKind: Extract<OutboundEventKind, "final" | "failed" | "interrupted" | "canceled" | "blocked">;
  summary: string;
  turnResultStatus?: TurnResult["status"];
  now: string;
  source: TurnRequest["source"];
}) {
  if (!input.run.conversationRef) {
    return undefined;
  }

  return input.taskStore.enqueueOutboundEvent({
    outboundEventId: `outbound_${randomUUID()}`,
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sessionId,
    actorId: input.run.actorId,
    taskId: input.run.taskId,
    runId: input.run.runId,
    conversationRef: input.run.conversationRef,
    channel: deriveChannelFromSource(input.source),
    eventKind: input.callbackKind,
    renderPayload: createBackgroundOutboundRenderPayload({
      eventKind: input.callbackKind,
      run: input.run,
      taskTitle: input.taskTitle,
      summary: input.summary,
      turnResultStatus: input.turnResultStatus
    }),
    idempotencyKey: `run:${input.run.runId}:callback:${input.callbackKind}`,
    now: input.now,
    availableAt: input.now
  });
}

async function persistBlockedTaskTruth(input: {
  taskStore: OutboundStore;
  run: TaskRunStoreRunLike;
  blockedBy?: string;
  checkpointRef?: string;
}) {
  if (!input.taskStore.upsertTask) {
    return;
  }

  const existing = input.taskStore.loadById
    ? await input.taskStore.loadById(input.run.taskId)
    : undefined;

  await input.taskStore.upsertTask({
    taskId: input.run.taskId,
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sessionId,
    title: existing?.title ?? "Background task",
    description: existing?.description ?? "",
    kind: existing?.kind ?? "background",
    status: "blocked",
    lastTurnId: input.run.sourceTurnId ?? input.run.runId,
    checkpointRef: input.checkpointRef ?? existing?.checkpointRef ?? "",
    plan: existing?.plan,
    currentStep: existing?.currentStep,
    nextAction: existing?.nextAction,
    artifacts: existing?.artifacts,
    blockingReason: input.blockedBy
  });
}

function continuationKindForResumableSliceTrigger(triggerKind: "initial" | "legacy_cutover" | "auto_continue" | "user_resume" | "approval_resume" | "operator_resume" | "recovery_retry") {
  switch (triggerKind) {
    case "approval_resume":
      return "operator_resume" as const;
    case "auto_continue":
    case "user_resume":
    case "operator_resume":
    case "recovery_retry":
      return triggerKind;
    case "initial":
    case "legacy_cutover":
    default:
      return "auto_continue" as const;
  }
}

function mapTurnUsageToSliceUsageSummary(turnResult: TurnResult) {
  return {
    inputTokens: turnResult.usage.inputTokens,
    outputTokens: turnResult.usage.outputTokens,
    totalTokens: turnResult.usage.totalTokens,
    estimatedCost: turnResult.usage.estimatedCost,
    cacheReadTokens: turnResult.usage.cacheReadTokens,
    cacheWriteTokens: turnResult.usage.cacheWriteTokens,
    contextUsedTokens: turnResult.usage.contextUsedTokens,
    maxContextTokens: turnResult.usage.maxContextTokens,
    toolCallCount: turnResult.toolEvents.length
  };
}

function mapClassifiedResultToSliceResult(input: {
  classified: ReturnType<typeof classifyBackgroundTurnResult>;
  turnResult: TurnResult;
  triggerKind: "initial" | "legacy_cutover" | "auto_continue" | "user_resume" | "approval_resume" | "operator_resume" | "recovery_retry";
}) {
  switch (input.classified.outcome) {
    case "succeeded":
      return {
        terminalStatus: "completed" as const,
        resultSummary: input.classified.resultSummary,
        usageSummary: mapTurnUsageToSliceUsageSummary(input.turnResult)
      };
    case "failed":
      return {
        terminalStatus: "failed" as const,
        resultSummary: input.classified.resultSummary,
        error: input.classified.error,
        usageSummary: mapTurnUsageToSliceUsageSummary(input.turnResult)
      };
    case "interrupted": {
      if (isResumableInterruptedTurnResult(input.turnResult)) {
        const refs = extractBlockedSuspendRefs(input.turnResult);
        return {
          terminalStatus: "yielded" as const,
          resultSummary: input.classified.resultSummary,
          continuation: {
            kind: continuationKindForResumableSliceTrigger(input.triggerKind),
            payload: input.turnResult.continuation,
            pendingControlRef: refs.pendingControlRef
          },
          usageSummary: mapTurnUsageToSliceUsageSummary(input.turnResult)
        };
      }

      return {
        terminalStatus: "failed" as const,
        resultSummary: input.classified.resultSummary,
        error: input.classified.error,
        usageSummary: mapTurnUsageToSliceUsageSummary(input.turnResult)
      };
    }
    case "canceled":
      return {
        terminalStatus: "canceled" as const,
        resultSummary: input.classified.resultSummary,
        usageSummary: mapTurnUsageToSliceUsageSummary(input.turnResult)
      };
    case "suspended": {
      const refs = extractBlockedSuspendRefs(input.turnResult);
      return {
        terminalStatus: "blocked" as const,
        resultSummary: input.classified.resultSummary,
        error: input.classified.error,
        continuation: {
          kind: refs.pendingApprovalRef ? "approval_resume" as const : "operator_resume" as const,
          payload: input.turnResult.continuation,
          pendingApprovalRef: refs.pendingApprovalRef,
          pendingControlRef: refs.pendingControlRef,
          blockedBy: refs.blockedBy
        },
        usageSummary: mapTurnUsageToSliceUsageSummary(input.turnResult)
      };
    }
  }
}

function mapSliceTerminalStatusToWorkerPresentation(input: {
  classified: ReturnType<typeof classifyBackgroundTurnResult>;
  terminalStatus: "yielded" | "blocked" | "completed" | "failed" | "canceled";
}) {
  switch (input.terminalStatus) {
    case "yielded":
      return {
        outcome: undefined,
        callbackKind: undefined,
        summary: input.classified.resultSummary,
        turnResultStatus: input.classified.turnResultStatus
      };
    case "blocked":
      return {
        outcome: "suspended" as const,
        callbackKind: "blocked" as const,
        summary: input.classified.resultSummary,
        turnResultStatus: input.classified.turnResultStatus
      };
    case "completed":
      return {
        outcome: "succeeded" as const,
        callbackKind: "final" as const,
        summary: input.classified.resultSummary,
        turnResultStatus: input.classified.turnResultStatus
      };
    case "failed":
      return {
        outcome: "failed" as const,
        callbackKind: "failed" as const,
        summary: input.classified.resultSummary,
        turnResultStatus: input.classified.turnResultStatus
      };
    case "canceled":
      return {
        outcome: "canceled" as const,
        callbackKind: "canceled" as const,
        summary: input.classified.resultSummary,
        turnResultStatus: input.classified.turnResultStatus
      };
  }
}

export function createRunSliceWorker(input: {
  lifecycle: RunLifecycle;
  runStore: TaskRunStore;
  taskStore: OutboundStore;
  eventStore?: TaskEventStore;
  shell: ShellPort;
  lane: "background" | "foreground";
  errorExposureMode?: ErrorExposureMode;
  now?: NowPort;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const errorExposureMode = input.errorExposureMode ?? DEFAULT_ERROR_EXPOSURE_MODE;

  return {
    async runOnce(runInput: {
      workerId: string;
      leaseDurationMs: number;
      now?: string;
      onClaimedRun?: (input: { runId: string; taskId: string }) => Promise<void> | void;
      onAfterShell?: (input: { runId: string; taskId: string; turnResult: TurnResult }) => Promise<void> | void;
    }): Promise<BackgroundWorkerRunResult> {
      const claimNow = toIso(runInput.now);
      const claimed = await input.lifecycle.claimNextRunnableSlice({
        workerId: runInput.workerId,
        lane: input.lane,
        leaseDurationMs: runInput.leaseDurationMs,
        now: claimNow
      });

      if (claimed.status !== "claimed") {
        return { status: "idle" };
      }

      await runInput.onClaimedRun?.({ runId: claimed.run.runId, taskId: claimed.run.taskId });

      const refreshedRun = await input.runStore.loadRunById(claimed.run.runId) as TaskRunStoreRunLike | undefined;
      if (!refreshedRun) {
        throw new Error(`background worker lost run ${claimed.run.runId} after claim`);
      }

      if (refreshedRun.cancelRequestedAt) {
        const finalized = await input.lifecycle.finalizeSliceResult({
          sliceId: claimed.slice.sliceId,
          runId: refreshedRun.runId,
          taskId: refreshedRun.taskId,
          lane: claimed.slice.lane,
          result: {
            terminalStatus: "canceled",
            resultSummary: refreshedRun.cancelReason ?? "background task canceled"
          },
          now: now()
        });
        const finalRun = finalized.run as TaskRunStoreRunLike;
        const callbackNow = now();
        await enqueueTerminalCallback({
          taskStore: input.taskStore,
          run: finalRun,
          callbackKind: "canceled",
          summary: finalRun.cancelReason ?? "background task canceled",
          now: callbackNow,
          source: reconstructTurnRequest(finalRun).source
        });
        return {
          status: "claimed",
          taskId: finalRun.taskId,
          runId: finalRun.runId,
          outcome: "canceled",
          callbackKind: "canceled",
          turnResultStatus: "interrupted",
          shellExecuted: false
        };
      }

      const execution = await input.lifecycle.executeClaimedSlice({
        run: refreshedRun,
        slice: claimed.slice
      });
      await runInput.onAfterShell?.({
        runId: refreshedRun.runId,
        taskId: refreshedRun.taskId,
        turnResult: execution.turnResult
      });

      const runAfterShell = await input.runStore.loadRunById(refreshedRun.runId) as TaskRunStoreRunLike | undefined;
      const canceledAfterShell = runAfterShell?.cancelRequestedAt;
      const classified = canceledAfterShell
        ? createCanceledBackgroundResult({
            reason: runAfterShell?.cancelReason,
            turnResultStatus: execution.turnResult.status
          })
        : classifyBackgroundTurnResult(execution.turnResult, errorExposureMode);

      const sliceResult = canceledAfterShell
        ? {
            terminalStatus: "canceled" as const,
            resultSummary: classified.resultSummary,
            usageSummary: {
              inputTokens: execution.turnResult.usage.inputTokens,
              outputTokens: execution.turnResult.usage.outputTokens,
              totalTokens: execution.turnResult.usage.totalTokens,
              estimatedCost: execution.turnResult.usage.estimatedCost,
              toolCallCount: execution.turnResult.toolEvents.length
            }
          }
        : mapClassifiedResultToSliceResult({
            classified,
            turnResult: execution.turnResult,
            triggerKind: claimed.slice.triggerKind
          });
      const finalized = await input.lifecycle.finalizeSliceResult({
        sliceId: claimed.slice.sliceId,
        runId: refreshedRun.runId,
        taskId: refreshedRun.taskId,
        lane: claimed.slice.lane,
        result: sliceResult,
        now: now()
      });

      const finalRun = finalized.run as TaskRunStoreRunLike;
      if (sliceResult.terminalStatus === "blocked" && finalRun) {
        const refs = extractBlockedSuspendRefs(execution.turnResult);
        await persistBlockedTaskTruth({
          taskStore: input.taskStore,
          run: finalRun,
          blockedBy: refs.blockedBy,
          checkpointRef: execution.turnResult.checkpointRef
        });
      }

      if (sliceResult.terminalStatus === "blocked" && input.eventStore) {
        const refs = extractBlockedSuspendRefs(execution.turnResult);
        const eventIdBase = refreshedRun.runId;
        await input.eventStore.appendTaskEvent({
          taskId: refreshedRun.taskId,
          runId: refreshedRun.runId,
          workspaceId: refreshedRun.workspaceId,
          eventType: "approval_required",
          severity: "warning",
          message: `background run blocked: ${execution.turnResult.blockedBy ?? "unknown reason"}; operator/CLI action required`,
          data: {
            blockedBy: execution.turnResult.blockedBy,
            pendingApprovalRef: refs.pendingApprovalRef,
            pendingControlRef: refs.pendingControlRef
          },
          idempotencyKey: `run:${eventIdBase}:event:approval_required`,
          now: new Date(now())
        });
        await input.eventStore.appendTaskEvent({
          taskId: refreshedRun.taskId,
          runId: refreshedRun.runId,
          workspaceId: refreshedRun.workspaceId,
          eventType: "run_suspended",
          severity: "info",
          message: `background run suspended: ${classified.resultSummary}`,
          data: {
            blockedBy: execution.turnResult.blockedBy,
            pendingApprovalRef: refs.pendingApprovalRef,
            pendingControlRef: refs.pendingControlRef
          },
          idempotencyKey: `run:${eventIdBase}:event:run_suspended`,
          now: new Date(now())
        });
      }

      const presentation = mapSliceTerminalStatusToWorkerPresentation({
        classified,
        terminalStatus: sliceResult.terminalStatus
      });

      if (presentation.callbackKind) {
        const callbackNow = now();
        await enqueueTerminalCallback({
          taskStore: input.taskStore,
          run: finalRun,
          callbackKind: presentation.callbackKind,
          summary: presentation.summary,
          turnResultStatus: presentation.turnResultStatus,
          now: callbackNow,
          source: execution.request.source
        });
      }

      return {
        status: "claimed",
        taskId: finalRun.taskId,
        runId: finalRun.runId,
        outcome: presentation.outcome,
        callbackKind: presentation.callbackKind,
        turnResultStatus: presentation.turnResultStatus,
        shellExecuted: true
      };
    }
  };
}
