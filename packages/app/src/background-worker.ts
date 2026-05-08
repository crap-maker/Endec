import {
  DEFAULT_ERROR_EXPOSURE_MODE,
  type ErrorExposureMode,
  type TurnResult
} from "@endec/domain";
import { createRunControlStore, createRuntimeSliceStore, type TaskRunStore } from "@endec/tasks";
import type { EndecApp } from "./types.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import { createRunSliceWorker } from "./run-slice-worker.ts";

export interface BackgroundWorkerRunResult {
  status: "idle" | "claimed";
  taskId?: string;
  runId?: string;
  outcome?: "succeeded" | "failed" | "interrupted" | "canceled" | "suspended";
  callbackKind?: "final" | "failed" | "interrupted" | "canceled" | "blocked";
  turnResultStatus?: TurnResult["status"];
  shellExecuted?: boolean;
}

export interface BackgroundWorker {
  runOnce(input: {
    workerId: string;
    leaseDurationMs: number;
    now?: string;
    onClaimedRun?: (input: { runId: string; taskId: string }) => Promise<void> | void;
    onAfterShell?: (input: { runId: string; taskId: string; turnResult: TurnResult }) => Promise<void> | void;
  }): Promise<BackgroundWorkerRunResult>;
}

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
    conversationRef: NonNullable<import("@endec/domain").TurnRequest["conversationRef"]>;
    channel: "telegram" | "feishu" | "web" | "sdk";
    eventKind: import("@endec/domain").OutboundEventKind;
    renderPayload: unknown;
    idempotencyKey: string;
    availableAt?: string;
    now?: string;
  }): Promise<unknown>;
  listOutboundEventsByTask?(input: { taskId?: string; runId?: string }): Promise<import("@endec/domain").OutboundEvent[]>;
};

type ShellPort = Pick<EndecApp["shell"], "executeTurn">;

type NowPort = () => string;

type TaskEventStore = {
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

type SessionStoreLike = {
  setFocusRun?(input: { sessionId: string; taskId: string; runId: string; now?: string }): Promise<unknown>;
  clearFocusRun?(input: { sessionId: string; now?: string }): Promise<unknown>;
  loadFocusRun?(sessionId: string): Promise<{ taskId: string; runId: string; updatedAt?: string } | undefined>;
};

export function createBackgroundWorker(input: {
  tasksDbPath: string;
  runStore: TaskRunStore;
  taskStore: OutboundStore;
  eventStore?: TaskEventStore;
  sessionStore?: SessionStoreLike;
  shell: ShellPort;
  continueSlice?: Parameters<typeof createRunLifecycle>[0]["continueSlice"];
  resolveApprovalSlice?: Parameters<typeof createRunLifecycle>[0]["resolveApprovalSlice"];
  lifecycle?: ReturnType<typeof createRunLifecycle>;
  errorExposureMode?: ErrorExposureMode;
  now?: NowPort;
}): BackgroundWorker {
  const lifecycle = input.lifecycle ?? (() => {
    const sliceStore = createRuntimeSliceStore({ filename: input.tasksDbPath });
    const controlStore = createRunControlStore({ filename: input.tasksDbPath });
    return createRunLifecycle({
      tasksDbPath: input.tasksDbPath,
      runStore: input.runStore,
      sliceStore,
      controlStore,
      sessionStore: input.sessionStore,
      executeTurnSlice: async (request) => input.shell.executeTurn(request),
      continueSlice: input.continueSlice,
      resolveApprovalSlice: input.resolveApprovalSlice
    });
  })();
  const worker = createRunSliceWorker({
    lifecycle,
    runStore: input.runStore,
    taskStore: input.taskStore,
    eventStore: input.eventStore,
    shell: input.shell,
    lane: "background",
    errorExposureMode: input.errorExposureMode ?? DEFAULT_ERROR_EXPOSURE_MODE,
    now: input.now
  });

  return {
    runOnce(runInput) {
      return worker.runOnce(runInput);
    }
  };
}
