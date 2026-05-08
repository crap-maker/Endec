import { describe, expect, it } from "vitest";
import type { TurnResult } from "@endec/domain";
import { classifyBackgroundTurnResult } from "./background-result.ts";

function createFailedTurnResult(warnings: string[]): TurnResult {
  return {
    turnId: "turn_bg_fail_001",
    sessionId: "session_bg_fail_001",
    resolvedMode: "chat",
    status: "failed",
    messages: [],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    },
    warnings,
    checkpointRef: "checkpoint:turn_bg_fail_001",
    nextSessionStateRef: "session_state_ref:turn_bg_fail_001"
  };
}

describe("classifyBackgroundTurnResult", () => {
  it("defaults failed summaries to passthrough text", () => {
    const turnResult = createFailedTurnResult([
      "Provider stream ended without a completed event for invocation invoke_bg_001"
    ]);

    expect(classifyBackgroundTurnResult(turnResult).resultSummary)
      .toBe("Provider stream ended without a completed event for invocation invoke_bg_001");
    expect(classifyBackgroundTurnResult(turnResult, "sanitized").resultSummary)
      .toBe("模型响应流提前结束，本轮已安全停止，请重试。");
  });

  it("uses the passthrough retry fallback when no meaningful warning exists", () => {
    expect(classifyBackgroundTurnResult(createFailedTurnResult([])).resultSummary)
      .toBe("请求失败，请重试。");
  });
});
