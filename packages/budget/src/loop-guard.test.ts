import { describe, expect, it } from "vitest";
import { DEFAULT_MODE_BUDGETS } from "./defaults";

describe("runtime execution budget defaults", () => {
  it("preserves historical fallback memory budgets for unknown/small-model paths", () => {
    expect(DEFAULT_MODE_BUDGETS).toMatchObject({
      chat: { memoryInjectionBudget: 600 },
      plan: { memoryInjectionBudget: 900 },
      act: { memoryInjectionBudget: 1000 },
      review: { memoryInjectionBudget: 700 },
      task: { memoryInjectionBudget: 1100 }
    });
  });

  it("keeps loop, per-batch, and per-turn limits explicit for chat", () => {
    expect(DEFAULT_MODE_BUDGETS.chat).toMatchObject({
      maxLoopCount: 4,
      maxToolCallsPerBatch: 4,
      maxToolCallsPerTurn: 8
    });
  });

  it("keeps review readonly and tighter than act", () => {
    expect(DEFAULT_MODE_BUDGETS.review).toMatchObject({
      maxLoopCount: 2,
      maxToolCallsPerBatch: 2,
      maxToolCallsPerTurn: 2
    });
    expect(DEFAULT_MODE_BUDGETS.act).toMatchObject({
      maxLoopCount: 6,
      maxToolCallsPerBatch: 3,
      maxToolCallsPerTurn: 6
    });
  });
});
