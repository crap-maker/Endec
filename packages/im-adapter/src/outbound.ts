import {
  AuthorityControlPayloadSchema,
  isOrdinaryUserWarning,
  sanitizeRuntimeWarningText,
  type ConversationRef,
  type ErrorExposureMode,
  type OutboundEvent,
  type TurnResult
} from "@endec/domain";
import type {
  DurableOutboundMessage,
  OutboundDispatchReceipt,
  OutboundDispatcher,
  OutboundMessage
} from "./types.ts";

const DEFAULT_ERROR_EXPOSURE_MODE: ErrorExposureMode = "passthrough";
const TerminalToolFallbackTexts = new Set([
  sanitizeRuntimeWarningText("tool_turn_limit"),
  sanitizeRuntimeWarningText("tool_batch_limit"),
  sanitizeRuntimeWarningText("tool_batch_limit_retry_exhausted")
]);

function collectFallbackWarnings(
  turnResult: Pick<TurnResult, "warnings">,
  errorExposureMode: ErrorExposureMode
) {
  const renderedWarnings = turnResult.warnings.flatMap((warning) => {
    if (!isOrdinaryUserWarning(warning) || typeof warning !== "string") {
      return [];
    }

    const trimmed = warning.trim();
    if (trimmed.length === 0) {
      return [];
    }

    return [errorExposureMode === "sanitized" ? sanitizeRuntimeWarningText(trimmed) : trimmed];
  });

  return [...new Set(renderedWarnings)];
}

function hasTerminalToolFallbackWarning(turnResult: Pick<TurnResult, "warnings">) {
  return turnResult.warnings.some((warning) => {
    if (!isOrdinaryUserWarning(warning) || typeof warning !== "string") {
      return false;
    }

    const trimmed = warning.trim();
    if (trimmed.length === 0) {
      return false;
    }

    if (/tool_turn_limit|maxToolCallsPerTurn|tool_batch_limit_retry_exhausted|tool_batch_limit|maxToolCallsPerBatch/i.test(trimmed)) {
      return true;
    }

    return TerminalToolFallbackTexts.has(sanitizeRuntimeWarningText(trimmed));
  });
}

export function createFallbackOutboundText(
  turnResult: Pick<TurnResult, "status" | "warnings" | "blockedBy" | "continuation">,
  errorExposureMode: ErrorExposureMode = DEFAULT_ERROR_EXPOSURE_MODE
) {
  const ordinaryWarnings = collectFallbackWarnings(turnResult, errorExposureMode);

  if (turnResult.status === "blocked") {
    return turnResult.blockedBy
      ? `Blocked: waiting for ${turnResult.blockedBy}.`
      : "Blocked: waiting for external input.";
  }

  if (ordinaryWarnings.length > 0) {
    return errorExposureMode === "passthrough"
      ? ordinaryWarnings[0]!
      : ordinaryWarnings.join("\n");
  }

  if (turnResult.status === "failed") {
    return errorExposureMode === "passthrough"
      ? "请求失败，请重试。"
      : "The turn failed before an outbound reply could be rendered.";
  }

  if (turnResult.status === "interrupted") {
    return errorExposureMode === "passthrough"
      ? "请求失败，请重试。"
      : "The turn was interrupted before an outbound reply could be rendered.";
  }

  return "The turn completed without an assistant text reply.";
}

function summarizeToolFallbackPayload(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return String(value).trim();
  }
}

function renderCompletedToolFallback(turnResult: Pick<TurnResult, "toolEvents">) {
  const renderedOutputs = turnResult.toolEvents.flatMap((toolEvent) => {
    if (!toolEvent || typeof toolEvent !== "object") {
      return [];
    }

    const record = toolEvent as {
      toolName?: unknown;
      state?: unknown;
      normalizedPayload?: { value?: unknown } | unknown;
      preview?: { previewText?: unknown } | unknown;
      error?: { message?: unknown } | unknown;
      output?: unknown;
    };

    const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
    const output = summarizeToolFallbackPayload(
      record.output
      ?? (record.normalizedPayload && typeof record.normalizedPayload === "object" && !Array.isArray(record.normalizedPayload)
        ? (record.normalizedPayload as { value?: unknown }).value
        : undefined)
      ?? (record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
        ? (record.preview as { previewText?: unknown }).previewText
        : undefined)
      ?? (record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as { message?: unknown }).message
        : undefined)
    );

    if (!output) {
      return [];
    }

    return [`[${toolName}]\n${output}`];
  });

  if (renderedOutputs.length > 0) {
    return [
      "The turn completed after using tools, but the model did not send a final text reply.",
      renderedOutputs.slice(0, 2).join("\n\n")
    ].join("\n\n");
  }

  const executedToolNames = [...new Set(turnResult.toolEvents.flatMap((toolEvent) => {
    if (!toolEvent || typeof toolEvent !== "object") {
      return [];
    }

    const record = toolEvent as { toolName?: unknown; state?: unknown };
    return typeof record.toolName === "string" && typeof record.state === "string" && ["executed", "spilled", "deny"].includes(record.state)
      ? [record.toolName]
      : [];
  }))];

  if (executedToolNames.length > 0) {
    return `The turn completed after using tools (${executedToolNames.join(", ")}), but the model did not send a final text reply.`;
  }

  return undefined;
}

function extractAssistantTexts(
  turnResult: TurnResult,
  errorExposureMode: ErrorExposureMode = DEFAULT_ERROR_EXPOSURE_MODE
) {
  if (turnResult.status !== "completed" && hasTerminalToolFallbackWarning(turnResult)) {
    return [createFallbackOutboundText(turnResult, errorExposureMode)];
  }

  const assistantTexts = turnResult.messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }

    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;

    if (role === "assistant" && typeof content === "string" && content.trim().length > 0) {
      return [content];
    }

    return [];
  });

  if (assistantTexts.length > 0) {
    return assistantTexts;
  }

  const completedToolFallback = turnResult.status === "completed"
    ? renderCompletedToolFallback(turnResult)
    : undefined;
  if (completedToolFallback) {
    return [completedToolFallback];
  }

  return [createFallbackOutboundText(turnResult, errorExposureMode)];
}

function renderDurableOutboundText(event: OutboundEvent) {
  const payload = event.renderPayload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const authorityNotice = AuthorityControlPayloadSchema.safeParse(payload);
    if (authorityNotice.success) {
      return authorityNotice.data.message;
    }

    const record = payload as Record<string, unknown>;
    const taskTitle = typeof record.taskTitle === "string" && record.taskTitle.trim().length > 0
      ? record.taskTitle.trim()
      : undefined;
    const taskId = typeof record.taskId === "string" ? record.taskId : event.taskId;
    const runId = typeof record.runId === "string" ? record.runId : event.runId;
    const summary = typeof record.summary === "string" && record.summary.trim().length > 0
      ? record.summary.trim()
      : undefined;

    const lines = [
      taskTitle ? `Background task: ${taskTitle}` : undefined,
      taskId ? `Task ID: ${taskId}` : undefined,
      runId ? `Run ID: ${runId}` : undefined,
      summary
    ].filter((line): line is string => typeof line === "string" && line.length > 0);

    if (lines.length > 0) {
      return lines.join("\n");
    }
  }

  return typeof event.renderPayload === "string"
    ? event.renderPayload
    : `Background callback: ${event.eventKind}`;
}

export function renderDurableOutboundEventToMessages(input: {
  event: OutboundEvent;
}) {
  return [{
    outboundEventId: input.event.outboundEventId,
    sessionId: input.event.sessionId,
    conversationRef: input.event.conversationRef,
    text: renderDurableOutboundText(input.event),
    metadata: {
      eventKind: input.event.eventKind,
      channel: input.event.channel
    }
  }] satisfies DurableOutboundMessage[];
}

export function renderTurnResultToOutboundMessages(input: {
  turnResult: TurnResult;
  sessionId: string;
  conversationRef: ConversationRef;
  replyToMessageId?: string;
  errorExposureMode?: ErrorExposureMode;
}) {
  const errorExposureMode = input.errorExposureMode ?? DEFAULT_ERROR_EXPOSURE_MODE;

  return extractAssistantTexts(input.turnResult, errorExposureMode).map<OutboundMessage>((text, index) => ({
    turnId: input.turnResult.turnId,
    sessionId: input.sessionId,
    conversationRef: input.conversationRef,
    text,
    replyToMessageId: input.replyToMessageId,
    metadata: {
      sequence: index,
      status: input.turnResult.status
    }
  }));
}

export async function dispatchRenderedMessages(input: {
  dispatcher: OutboundDispatcher;
  turnResult: TurnResult;
  sessionId: string;
  conversationRef: ConversationRef;
  replyToMessageId?: string;
  errorExposureMode?: ErrorExposureMode;
  recordOutboundSessionBinding?(binding: {
    sessionId: string;
    conversationRef: ConversationRef;
    turnId: string;
  }): Promise<void> | void;
}) {
  const messages = renderTurnResultToOutboundMessages({
    turnResult: input.turnResult,
    sessionId: input.sessionId,
    conversationRef: input.conversationRef,
    replyToMessageId: input.replyToMessageId,
    errorExposureMode: input.errorExposureMode ?? input.dispatcher.errorExposureMode
  });

  const receipts: OutboundDispatchReceipt[] = messages.length > 0
    ? await input.dispatcher.dispatch(messages)
    : [];

  if (messages.length > 0) {
    await input.recordOutboundSessionBinding?.({
      sessionId: input.sessionId,
      conversationRef: input.conversationRef,
      turnId: input.turnResult.turnId
    });
  }

  return {
    messages,
    receipts
  };
}
