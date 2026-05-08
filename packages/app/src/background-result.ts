import {
  DEFAULT_ERROR_EXPOSURE_MODE,
  PermissionDecisionSchema,
  RuntimeHardeningWarningCodes,
  isOrdinaryUserWarning,
  resolvePendingPermissionDecision,
  sanitizeRuntimeWarningText,
  type ErrorExposureMode,
  type TurnResult
} from "@endec/domain";

export type BackgroundCallbackKind = "final" | "failed" | "interrupted" | "canceled" | "blocked";
export type BackgroundTerminalOutcome = "succeeded" | "failed" | "interrupted" | "canceled" | "suspended";

export interface ClassifiedBackgroundTurnResult {
  outcome: BackgroundTerminalOutcome;
  callbackKind: BackgroundCallbackKind;
  resultSummary: string;
  turnResultStatus: TurnResult["status"];
  error?: unknown;
}

function firstAssistantMessageText(messages: unknown[]) {
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const record = message as { role?: unknown; content?: unknown };
    if (record.role === "assistant" && typeof record.content === "string" && record.content.trim().length > 0) {
      return record.content.trim();
    }
  }

  return undefined;
}

function summarizeWarnings(warnings: string[], errorExposureMode: ErrorExposureMode) {
  const compact = warnings
    .filter(isOrdinaryUserWarning)
    .map((warning) => warning.trim())
    .map((warning) => errorExposureMode === "sanitized" ? sanitizeRuntimeWarningText(warning) : warning)
    .map((warning) => warning.trim())
    .filter((warning, index, all) => warning.length > 0 && all.indexOf(warning) === index);
  return compact.length > 0 ? compact.join("; ") : undefined;
}

function summarizeBlockedResult(blockedBy: string | undefined, warningSummary: string | undefined): string {
  const parts: string[] = [];
  parts.push(`blocked: ${blockedBy ?? "unknown reason"}`);
  if (warningSummary) {
    parts.push(warningSummary);
  }
  parts.push("operator/CLI action required to resume");
  return parts.join("; ");
}

export interface BlockedSuspendRefs {
  pendingApprovalRef?: string;
  pendingControlRef?: string;
  blockedBy?: string;
}

function extractPendingApprovalRef(turnResult: TurnResult) {
  const approvals = Array.isArray(turnResult.approvals)
    ? turnResult.approvals
        .map((approval) => PermissionDecisionSchema.safeParse(approval))
        .flatMap((parsed) => parsed.success ? [parsed.data] : [])
    : [];

  return resolvePendingPermissionDecision({
    permissionDecisions: approvals
  })?.decisionId;
}

export function extractBlockedSuspendRefs(turnResult: TurnResult): BlockedSuspendRefs {
  const continuation = turnResult.continuation;
  const refs: BlockedSuspendRefs = {
    blockedBy: turnResult.blockedBy
  };

  if (continuation) {
    refs.pendingControlRef = continuation.frameRef;
  }

  const pendingApprovalRef = extractPendingApprovalRef(turnResult);
  if (pendingApprovalRef) {
    refs.pendingApprovalRef = pendingApprovalRef;
  }

  return refs;
}

function hasResumablePauseSemantics(turnResult: TurnResult) {
  return turnResult.warnings.some((warning) =>
    warning.includes(RuntimeHardeningWarningCodes.toolTurnLimit)
    || /maxToolCallsPerTurn|tool_turn_limit/i.test(warning)
    || /tool-step safety limit/i.test(warning)
    || /paused safely before the next step/i.test(warning)
    || /reply\s+"continue"\s+to\s+resume/i.test(warning)
  );
}

export function isResumableInterruptedTurnResult(turnResult: TurnResult) {
  return turnResult.status === "interrupted"
    && turnResult.continuation?.continuationKind === "resume"
    && hasResumablePauseSemantics(turnResult);
}

function defaultFailureSummary(errorExposureMode: ErrorExposureMode) {
  return errorExposureMode === "passthrough" ? "请求失败，请重试。" : "background task failed";
}

function summarizeInterruptedResult(
  turnResult: TurnResult,
  warningSummary: string | undefined,
  errorExposureMode: ErrorExposureMode
): string {
  if (isResumableInterruptedTurnResult(turnResult)) {
    return "paused at a safe checkpoint after hitting this turn’s tool-step safety limit. No tools from the paused step were run. Resume from this chat or via operator/CLI.";
  }

  return warningSummary ?? (errorExposureMode === "passthrough" ? "请求失败，请重试。" : "background task interrupted");
}

export function classifyBackgroundTurnResult(
  turnResult: TurnResult,
  errorExposureMode: ErrorExposureMode = DEFAULT_ERROR_EXPOSURE_MODE
): ClassifiedBackgroundTurnResult {
  const assistantSummary = turnResult.status === "completed" ? firstAssistantMessageText(turnResult.messages) : undefined;
  const warningSummary = summarizeWarnings(turnResult.warnings, errorExposureMode);

  switch (turnResult.status) {
    case "completed":
      return {
        outcome: "succeeded",
        callbackKind: "final",
        resultSummary: assistantSummary ?? warningSummary ?? "background task completed",
        turnResultStatus: turnResult.status
      };

    case "failed":
      return {
        outcome: "failed",
        callbackKind: "failed",
        resultSummary: warningSummary ?? assistantSummary ?? defaultFailureSummary(errorExposureMode),
        turnResultStatus: turnResult.status,
        error: {
          warnings: turnResult.warnings,
          blockedBy: turnResult.blockedBy
        }
      };

    case "interrupted":
      return {
        outcome: "interrupted",
        callbackKind: "interrupted",
        resultSummary: summarizeInterruptedResult(turnResult, warningSummary, errorExposureMode),
        turnResultStatus: turnResult.status
      };

    case "blocked":
      return {
        outcome: "suspended",
        callbackKind: "blocked",
        resultSummary: summarizeBlockedResult(turnResult.blockedBy, warningSummary),
        turnResultStatus: turnResult.status,
        error: {
          blockedBy: turnResult.blockedBy,
          warnings: turnResult.warnings
        }
      };
  }
}

export function createCanceledBackgroundResult(input: {
  reason?: string;
  turnResultStatus?: TurnResult["status"];
}): ClassifiedBackgroundTurnResult {
  return {
    outcome: "canceled",
    callbackKind: "canceled",
    resultSummary: input.reason?.trim() || "background task canceled",
    turnResultStatus: input.turnResultStatus ?? "interrupted"
  };
}
