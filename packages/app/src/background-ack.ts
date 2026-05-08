import type { TurnResult } from "@endec/domain";

export function createBackgroundAckTurnResult(input: {
  turnId: string;
  sessionId: string;
  resolvedMode: TurnResult["resolvedMode"];
  checkpointRef: string;
  taskId: string;
  summary: string;
}): TurnResult {
  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    resolvedMode: input.resolvedMode,
    status: "completed",
    messages: [
      {
        role: "assistant",
        content: `收到，已创建后台任务：${input.summary}\n任务 ID：${input.taskId}\n已排队，完成后我会回到这里通知你。`
      }
    ],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    },
    warnings: [],
    checkpointRef: input.checkpointRef,
    nextSessionStateRef: `session_state_ref:${input.turnId}`
  };
}
