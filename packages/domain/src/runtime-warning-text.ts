import type { RuntimeWarning } from "./runtime.ts";

export type ErrorExposureMode = "sanitized" | "passthrough";

export const DEFAULT_ERROR_EXPOSURE_MODE: ErrorExposureMode = "passthrough";
const DEFAULT_PASSTHROUGH_ERROR_TEXT = "请求失败，请重试。";
const GENERIC_SANITIZED_RUNTIME_ERROR_TEXT = "模型或运行时暂时异常，本轮已安全停止，请稍后重试。";
const REDACTED_CREDENTIAL_TEXT = "[redacted credential]";

export const RuntimeHardeningWarningCodes = {
  providerStreamIncomplete: "provider_stream_incomplete",
  toolBatchLimitRepair: "tool_batch_limit_repair",
  toolBatchLimitRetryExhausted: "tool_batch_limit_retry_exhausted",
  toolBatchLimit: "tool_batch_limit",
  toolTurnLimit: "tool_turn_limit"
} as const;

export type RuntimeHardeningWarningCode =
  typeof RuntimeHardeningWarningCodes[keyof typeof RuntimeHardeningWarningCodes];

export const RuntimeFriendlyWarningText: Record<RuntimeHardeningWarningCode, string> = {
  provider_stream_incomplete: "模型响应流提前结束，本轮已安全停止，请重试。",
  tool_batch_limit_repair: "模型一次请求了过多工具，已要求模型减少本轮工具调用。",
  tool_batch_limit_retry_exhausted: "模型一次请求了过多工具，本轮已安全停止，请重试或拆分任务。",
  tool_batch_limit: "模型一次请求了过多工具，本轮已安全停止，请重试或拆分任务。",
  tool_turn_limit: "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume."
};

const RuntimeCanonicalPassthroughWarningText: Partial<Record<RuntimeHardeningWarningCode, string>> = {
  provider_stream_incomplete: "Provider stream ended without a completed event",
  tool_batch_limit_repair: "Provider requested too many tool calls in one batch",
  tool_batch_limit_retry_exhausted: "Provider requested too many tool calls after one repair retry",
  tool_batch_limit: "Provider requested too many tool calls in one batch",
  tool_turn_limit: "Reached maxToolCallsPerTurn before executing the next tool batch"
};

const RejectedPassthroughWrapperTextSet = new Set([
  ...Object.values(RuntimeFriendlyWarningText),
  GENERIC_SANITIZED_RUNTIME_ERROR_TEXT,
  DEFAULT_PASSTHROUGH_ERROR_TEXT
]);

const CredentialBearingFragmentPatterns = [
  /(?:["'])?Authorization(?:["'])?\s*:\s*(?:["'])?(?:Bearer|Basic)\s+[^"'\s,;}\]]+(?:["'])?/gi,
  /(?:["'])?(?:X-API-Key|Api-Key)(?:["'])?\s*:\s*(?:["'])?[^"'\s,;}\]]+(?:["'])?/gi,
  /(?:["'])?(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password)(?:["'])?\s*(?:=|:)\s*(?:["'])?[^"'\s,;}\]]+(?:["'])?/gi
];

export function resolveErrorExposureMode(value: string | undefined): ErrorExposureMode {
  return value === "sanitized" ? "sanitized" : DEFAULT_ERROR_EXPOSURE_MODE;
}

export function friendlyRuntimeWarningTextForCode(code: string): string | undefined {
  return RuntimeFriendlyWarningText[code as RuntimeHardeningWarningCode];
}

export function friendlyRuntimeWarningText(warning: Pick<RuntimeWarning, "code" | "message">): string {
  return friendlyRuntimeWarningTextForCode(warning.code) ?? warning.message;
}

export function renderRuntimeWarningText(
  warning: Pick<RuntimeWarning, "code" | "message" | "metadata">,
  mode: ErrorExposureMode
): string {
  if (mode === "sanitized") {
    return sanitizeRuntimeWarningText(friendlyRuntimeWarningText(warning));
  }

  const rootCauseMessage = normalizePassthroughWarningRootCauseText(warning);
  if (rootCauseMessage !== undefined) {
    return rootCauseMessage;
  }

  const message = normalizePassthroughErrorText(warning.message);
  if (message !== undefined) {
    return message;
  }

  const canonicalText = canonicalPassthroughWarningTextForCode(warning.code);
  if (canonicalText !== undefined) {
    return canonicalText;
  }

  return DEFAULT_PASSTHROUGH_ERROR_TEXT;
}

export function sanitizeRuntimeWarningText(text: string): string {
  if (/provider_stream_incomplete|Provider stream ended without a completed event/i.test(text)) {
    return RuntimeFriendlyWarningText.provider_stream_incomplete;
  }
  if (/tool_turn_limit|Reached maxToolCallsPerTurn/i.test(text)) {
    return RuntimeFriendlyWarningText.tool_turn_limit;
  }
  if (/tool_batch_limit_retry_exhausted|tool_batch_limit|maxToolCallsPerBatch|Provider requested \d+ tool calls in one batch/i.test(text)) {
    return RuntimeFriendlyWarningText.tool_batch_limit_retry_exhausted;
  }
  if (isProviderRuntimeInternalDiagnosticText(text)) {
    return GENERIC_SANITIZED_RUNTIME_ERROR_TEXT;
  }

  return text;
}

export function renderRuntimeErrorText(input: {
  mode: ErrorExposureMode;
  error: unknown;
}): string {
  if (input.mode === "sanitized") {
    return sanitizeRuntimeErrorForUser(input.error);
  }

  return resolveDeepestPassthroughErrorText(input.error) ?? DEFAULT_PASSTHROUGH_ERROR_TEXT;
}

export function sanitizeRuntimeErrorForUser(error: unknown): string {
  return sanitizeRuntimeWarningText(extractPrimaryErrorText(error));
}

export function isProviderRuntimeInternalDiagnosticText(text: string): boolean {
  return /provider(?:_|\s+(?:stream|invocation|transport|adapter|runtime|client))|transport|fetch|ECONN|ETIMEDOUT|socket|stack|at \S+ \(|https?:\/\/|Provider invocation failed|adapter|runtime (?:internal|exception|failure|error)/i.test(text);
}

export function renderRuntimeWarningsForOrdinaryUser(warnings: RuntimeWarning[]): string[] {
  const hasTerminalProviderOrToolCode = warnings.some((warning) =>
    warning.code === RuntimeHardeningWarningCodes.providerStreamIncomplete
    || warning.code === RuntimeHardeningWarningCodes.toolBatchLimitRetryExhausted
    || warning.code === RuntimeHardeningWarningCodes.toolBatchLimit
    || warning.code === RuntimeHardeningWarningCodes.toolTurnLimit
  );

  const rendered = warnings.flatMap((warning) => {
    if (warning.code === RuntimeHardeningWarningCodes.toolBatchLimitRepair) {
      return hasTerminalProviderOrToolCode ? [] : [];
    }
    return [renderRuntimeWarningText(warning, "sanitized")];
  });

  return [...new Set(rendered)];
}

function resolveDeepestPassthroughErrorText(error: unknown): string | undefined {
  const messages = collectErrorMessages(error);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = normalizePassthroughErrorText(messages[index]);
    if (message !== undefined) {
      return message;
    }
  }

  return undefined;
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);

    const message = extractOptionalMessage(current);
    if (message !== undefined) {
      messages.push(message);
    }

    current = extractCause(current);
  }

  return messages;
}

function extractPrimaryErrorText(error: unknown): string {
  return extractOptionalMessage(error) ?? String(error);
}

function extractOptionalMessage(error: unknown): string | undefined {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (
    error !== null
    && typeof error === "object"
    && "message" in error
    && typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return undefined;
}

function extractCause(error: unknown): unknown {
  if (error instanceof Error) {
    return (error as Error & { cause?: unknown }).cause;
  }

  if (error !== null && typeof error === "object" && "cause" in error) {
    return (error as { cause?: unknown }).cause;
  }

  return undefined;
}

function normalizePassthroughErrorText(text: string): string | undefined {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  if (RejectedPassthroughWrapperTextSet.has(trimmed)) {
    return undefined;
  }

  const redacted = redactCredentialBearingText(trimmed);
  if (redacted === undefined) {
    return undefined;
  }

  const reducedStructuredDump = reducePrefixedStructuredDump(redacted);
  if (reducedStructuredDump !== undefined) {
    return reducedStructuredDump;
  }

  if (redacted === "[object Object]" || looksLikeStructuredDump(redacted)) {
    return undefined;
  }

  if (looksLikeStackTrace(redacted) || looksLikeSql(redacted) || looksLikeFilePathOrUrl(redacted)) {
    return undefined;
  }

  return redacted;
}

function reducePrefixedStructuredDump(text: string): string | undefined {
  const match = /^(?<prefix>[\s\S]*?\S)\s*[:：-]\s*(?<payload>[\[{][\s\S]*[\]}])$/s.exec(text);
  const prefix = match?.groups?.prefix;
  const payload = match?.groups?.payload;

  if (prefix === undefined || payload === undefined || !looksLikeStructuredDump(payload)) {
    return undefined;
  }

  return normalizePassthroughPrefix(prefix);
}

function normalizePassthroughPrefix(text: string): string | undefined {
  const trimmed = text.trim().replace(/[:：-]+$/u, "").trim();

  if (trimmed.length === 0 || RejectedPassthroughWrapperTextSet.has(trimmed)) {
    return undefined;
  }

  if (trimmed === "[object Object]" || looksLikeStructuredDump(trimmed)) {
    return undefined;
  }

  if (looksLikeStackTrace(trimmed) || looksLikeSql(trimmed) || looksLikeFilePathOrUrl(trimmed)) {
    return undefined;
  }

  return redactCredentialBearingText(trimmed);
}

function normalizePassthroughWarningRootCauseText(
  warning: Pick<RuntimeWarning, "metadata">
): string | undefined {
  const rootCauseMessage = warning.metadata?.rootCauseMessage;
  return typeof rootCauseMessage === "string"
    ? normalizePassthroughErrorText(rootCauseMessage)
    : undefined;
}

function canonicalPassthroughWarningTextForCode(code: string): string | undefined {
  return RuntimeCanonicalPassthroughWarningText[code as RuntimeHardeningWarningCode];
}

function looksLikeStructuredDump(text: string): boolean {
  return /^[\[{].*[\]}]$/s.test(text) && /[:",]/.test(text);
}

function looksLikeStackTrace(text: string): boolean {
  return /(?:^|\n)\s*at\s+\S+/i.test(text);
}

function looksLikeSql(text: string): boolean {
  return /\bSQLSTATE\b|\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[\s\S]{0,160}\b(?:FROM|INTO|TABLE|VALUES|SET)\b/i.test(text);
}

function looksLikeFilePathOrUrl(text: string): boolean {
  return /https?:\/\/\S+|(?:^|\s)(?:\/[\w.-][^\s]*|[A-Za-z]:\\[^\s]+)/.test(text);
}

function redactCredentialBearingText(text: string): string | undefined {
  let redacted = text;

  for (const pattern of CredentialBearingFragmentPatterns) {
    redacted = redacted.replace(pattern, REDACTED_CREDENTIAL_TEXT);
  }

  if (redacted === text) {
    return text;
  }

  const normalized = redacted
    .replace(/\{\s*\[redacted credential\]\s*\}/g, REDACTED_CREDENTIAL_TEXT)
    .replace(/\s{2,}/g, " ")
    .trim();
  if (normalized.length === 0 || isPlaceholderOnlyText(normalized)) {
    return undefined;
  }

  return normalized;
}

function isPlaceholderOnlyText(text: string): boolean {
  return text
    .replaceAll(REDACTED_CREDENTIAL_TEXT, " ")
    .replace(/[\s:;,.!?()\[\]{}\-]+/g, " ")
    .trim().length === 0;
}
