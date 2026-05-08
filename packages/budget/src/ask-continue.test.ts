import { describe, expect, it } from "vitest";
import { createBudgetService } from "./budget-service";

describe("ask-continue", () => {
  it("returns ask-continue for soft limit overflow", () => {
    const service = createBudgetService();

    const decision = service.evaluateBudget({
      resolvedMode: "act",
      projectedTotalTokens: 11_000,
      hardLimitTokens: 20_000
    });

    expect(decision.kind).toBe("ask_continue");
    expect(decision.status).toBe("blocked");
    expect(decision.stopReason).toBe("soft_limit");
  });

  it("returns hard-stop for hard limit overflow", () => {
    const service = createBudgetService();

    const decision = service.evaluateBudget({
      resolvedMode: "act",
      projectedTotalTokens: 20_001,
      hardLimitTokens: 20_000
    });

    expect(decision.kind).toBe("hard_stop");
    expect(decision.status).toBe("interrupted");
    expect(decision.stopReason).toBe("hard_limit");
  });
});
