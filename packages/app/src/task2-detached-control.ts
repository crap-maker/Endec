import type { Mode, RuntimeSliceSnapshot, SliceTriggerKind, TaskRunSnapshot, TurnResult } from "@endec/domain";

type DetachedTask2ControlAction = "approve" | "resume" | "cancel";
type DetachedTask2AcceptedControlReplay = {
  action: Extract<DetachedTask2ControlAction, "approve" | "resume">;
  turnId?: string;
  sessionId?: string;
  frameRef?: string;
  decisionId?: string;
};
type DetachedTask2AcceptedContinuationSlice = Pick<RuntimeSliceSnapshot, "sliceNo" | "status" | "triggerKind" | "continuationPayload" | "leaseExpiresAt">;

type DetachedTask2AckTurnResultInput = {
  turnId: string;
  sessionId: string;
  resolvedMode: Mode;
  checkpointRef: string;
  frameRef?: string;
  warning: string;
};

export function createDetachedTask2AckTurnResult(input: DetachedTask2AckTurnResultInput): TurnResult {
  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    resolvedMode: input.resolvedMode,
    status: "interrupted",
    messages: [],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    },
    warnings: [input.warning],
    checkpointRef: input.checkpointRef,
    frameRef: input.frameRef
  };
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readDetachedTask2RecoveryControl(payload: unknown): DetachedTask2AcceptedControlReplay | undefined {
  const control = asObjectRecord(asObjectRecord(payload)?.control);
  if (control?.action !== "approve" && control?.action !== "resume") {
    return undefined;
  }

  return {
    action: control.action,
    turnId: typeof control.turnId === "string" ? control.turnId : undefined,
    sessionId: typeof control.sessionId === "string" ? control.sessionId : undefined,
    frameRef: typeof control.frameRef === "string" ? control.frameRef : undefined,
    decisionId: typeof control.decisionId === "string" ? control.decisionId : undefined
  };
}

function matchesDetachedTask2RecoveryControl(input: {
  control: DetachedTask2AcceptedControlReplay;
  storedControl: DetachedTask2AcceptedControlReplay | undefined;
}): boolean {
  if (!input.storedControl || input.storedControl.action !== input.control.action) {
    return false;
  }

  const comparisons: Array<[expected: string | undefined, actual: string | undefined]> = [
    [input.control.turnId, input.storedControl.turnId],
    [input.control.sessionId, input.storedControl.sessionId],
    [input.control.frameRef, input.storedControl.frameRef],
    [input.control.action === "approve" ? input.control.decisionId : undefined, input.control.action === "approve" ? input.storedControl.decisionId : undefined]
  ];

  return comparisons.every(([expected, actual]) => expected === undefined || actual === expected);
}

export function isAcceptedDetachedTask2ContinuationHead(input: {
  control: DetachedTask2AcceptedControlReplay;
  expectedTriggerKind: Extract<SliceTriggerKind, "approval_resume" | "operator_resume">;
  slice: DetachedTask2AcceptedContinuationSlice;
}): boolean {
  if (input.slice.triggerKind === input.expectedTriggerKind) {
    return true;
  }

  if (input.slice.triggerKind !== "recovery_retry") {
    return false;
  }

  return matchesDetachedTask2RecoveryControl({
    control: input.control,
    storedControl: readDetachedTask2RecoveryControl(input.slice.continuationPayload)
  });
}

export function resolveAcceptedDetachedTask2ClaimRace(input: {
  control: DetachedTask2AcceptedControlReplay;
  turnId: string;
  sessionId: string;
  resolvedMode: Mode;
  checkpointRef: string;
  frameRef?: string;
  expectedTriggerKind: Extract<SliceTriggerKind, "approval_resume" | "operator_resume">;
  runStatus: TaskRunSnapshot["status"];
  slices: Array<DetachedTask2AcceptedContinuationSlice>;
  allowOriginalRunningAck?: boolean;
}): TurnResult | undefined {
  if (input.runStatus !== "queued" && input.runStatus !== "running") {
    return undefined;
  }

  const openSlice = [...input.slices]
    .filter((slice) => slice.status === "queued" || slice.status === "running")
    .sort((left, right) => left.sliceNo - right.sliceNo)
    .at(0);

  if (!openSlice || !isAcceptedDetachedTask2ContinuationHead({
    control: input.control,
    expectedTriggerKind: input.expectedTriggerKind,
    slice: openSlice
  })) {
    return undefined;
  }

  if (input.allowOriginalRunningAck === false
    && openSlice.status === "running"
    && openSlice.triggerKind === input.expectedTriggerKind) {
    return undefined;
  }

  const actionLabel = input.control.action === "approve" ? "Approval" : "Resume";
  const sliceState = openSlice.status === "running" ? "already running" : "queued";
  const warning = `${actionLabel} already accepted for detached background run ${input.turnId}; the ${openSlice.triggerKind} slice is ${sliceState}.`;

  return createDetachedTask2AckTurnResult({
    turnId: input.turnId,
    sessionId: input.sessionId,
    resolvedMode: input.resolvedMode,
    checkpointRef: input.checkpointRef,
    frameRef: input.frameRef,
    warning
  });
}
