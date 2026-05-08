import type { ConversationRef, OutboundEventKind, OutboundTransport, TaskRunSnapshot, TurnResult } from "@endec/domain";

export interface BackgroundOutboundRenderPayload {
  schemaVersion: 1;
  contractVersion: "im.background-callback.v1";
  eventKind: OutboundEventKind;
  taskId: string;
  runId: string;
  attemptNo: number;
  taskTitle?: string;
  summary: string;
  turnResultStatus?: TurnResult["status"];
}

export function resolveBackgroundOutboundTransport(source: TurnResult["resolvedMode"] | ConversationRef | undefined, fallbackSource?: OutboundTransport): OutboundTransport {
  void source;
  return fallbackSource ?? "telegram";
}

export function createBackgroundOutboundRenderPayload(input: {
  eventKind: Extract<OutboundEventKind, "final" | "failed" | "interrupted" | "canceled" | "blocked">;
  run: Pick<TaskRunSnapshot, "taskId" | "runId" | "attemptNo">;
  summary: string;
  taskTitle?: string;
  turnResultStatus?: TurnResult["status"];
}): BackgroundOutboundRenderPayload {
  return {
    schemaVersion: 1,
    contractVersion: "im.background-callback.v1",
    eventKind: input.eventKind,
    taskId: input.run.taskId,
    runId: input.run.runId,
    attemptNo: input.run.attemptNo,
    taskTitle: input.taskTitle,
    summary: input.summary,
    turnResultStatus: input.turnResultStatus
  };
}
