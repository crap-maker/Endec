import { z } from "zod";

export const MEMORY_CONTEXT_TRUNCATED_CODE = "memory_context_truncated";
export const LEGACY_MEMORY_CONTEXT_TRUNCATED_WARNING = "memory selection truncated to fit budget";

export const TurnWarningCategorySchema = z.enum(["runtime_terminal", "provider", "tool", "memory_budget", "budget", "other"]);
export const TurnWarningAudienceSchema = z.enum(["ordinary_user", "operator_debug"]);
export const TurnWarningSeveritySchema = z.enum(["info", "warning", "error"]);

export const TurnWarningDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
  category: TurnWarningCategorySchema,
  audience: TurnWarningAudienceSchema,
  severity: TurnWarningSeveritySchema,
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type TurnWarningCategory = z.infer<typeof TurnWarningCategorySchema>;
export type TurnWarningAudience = z.infer<typeof TurnWarningAudienceSchema>;
export type TurnWarningSeverity = z.infer<typeof TurnWarningSeveritySchema>;
export type TurnWarningDetail = z.infer<typeof TurnWarningDetailSchema>;

export function classifyTurnWarning(warning: string | TurnWarningDetail): TurnWarningDetail {
  if (typeof warning !== "string") {
    return TurnWarningDetailSchema.parse(warning);
  }

  const normalized = warning.trim();
  if (
    normalized === MEMORY_CONTEXT_TRUNCATED_CODE
    || normalized === LEGACY_MEMORY_CONTEXT_TRUNCATED_WARNING
  ) {
    return {
      code: MEMORY_CONTEXT_TRUNCATED_CODE,
      message: "Memory selection was truncated to fit the memory injection budget.",
      category: "memory_budget",
      audience: "operator_debug",
      severity: "info",
      metadata: {}
    };
  }

  return {
    code: normalized.length > 0 ? "legacy_warning" : "legacy_warning",
    message: warning,
    category: "other",
    audience: "ordinary_user",
    severity: "warning",
    metadata: {}
  };
}

export function isMemoryContextDiagnosticWarning(warning: string | TurnWarningDetail): boolean {
  return classifyTurnWarning(warning).code === MEMORY_CONTEXT_TRUNCATED_CODE;
}

export function isOrdinaryUserWarning(warning: string | TurnWarningDetail): boolean {
  return classifyTurnWarning(warning).audience === "ordinary_user";
}
