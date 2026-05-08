import { describe, expect, it } from "vitest";
import {
  LEGACY_MEMORY_CONTEXT_TRUNCATED_WARNING,
  MEMORY_CONTEXT_TRUNCATED_CODE,
  classifyTurnWarning,
  isMemoryContextDiagnosticWarning,
  isOrdinaryUserWarning
} from "./diagnostics.ts";

describe("warning diagnostics classification", () => {
  it("classifies stable and legacy memory truncation warnings as operator debug diagnostics", () => {
    expect(classifyTurnWarning(MEMORY_CONTEXT_TRUNCATED_CODE)).toEqual({
      code: MEMORY_CONTEXT_TRUNCATED_CODE,
      message: "Memory selection was truncated to fit the memory injection budget.",
      category: "memory_budget",
      audience: "operator_debug",
      severity: "info",
      metadata: {}
    });
    expect(classifyTurnWarning(LEGACY_MEMORY_CONTEXT_TRUNCATED_WARNING)).toEqual({
      code: MEMORY_CONTEXT_TRUNCATED_CODE,
      message: "Memory selection was truncated to fit the memory injection budget.",
      category: "memory_budget",
      audience: "operator_debug",
      severity: "info",
      metadata: {}
    });
    expect(isMemoryContextDiagnosticWarning(MEMORY_CONTEXT_TRUNCATED_CODE)).toBe(true);
    expect(isMemoryContextDiagnosticWarning(LEGACY_MEMORY_CONTEXT_TRUNCATED_WARNING)).toBe(true);
    expect(isOrdinaryUserWarning(MEMORY_CONTEXT_TRUNCATED_CODE)).toBe(false);
    expect(isOrdinaryUserWarning(LEGACY_MEMORY_CONTEXT_TRUNCATED_WARNING)).toBe(false);
  });

  it("leaves unrelated legacy warnings visible to ordinary users by default", () => {
    expect(classifyTurnWarning("permission required")).toEqual({
      code: "legacy_warning",
      message: "permission required",
      category: "other",
      audience: "ordinary_user",
      severity: "warning",
      metadata: {}
    });
    expect(isOrdinaryUserWarning("permission required")).toBe(true);
    expect(isMemoryContextDiagnosticWarning("permission required")).toBe(false);
  });
});
