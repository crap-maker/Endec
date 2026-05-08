import type { ProviderCompletion, ProviderEvent, RuntimeToolCall } from "@endec/domain";
import {
  asAsyncIterable,
  createAssistantMessages,
  createCompletionEvent,
  createMessageDeltaEvent,
  createProviderStreamIncompleteEvents,
  createToolCallEvent,
  createUsageEvent,
  extractProviderStreamRootCauseMessage,
  normalizeUsage,
  parseToolArguments,
  renderContext,
  toAnthropicMessages,
  toAnthropicTools,
  type ProtocolBuildInput,
  type ProtocolRequest,
  type ProtocolStreamContext,
  type SyncOrAsyncIterable
} from "./shared.ts";

function mapStopReason(stopReason: string | undefined): ProviderCompletion["finishReason"] {
  if (stopReason === "tool_use") {
    return "tool_calls";
  }
  if (stopReason === "max_tokens") {
    return "max_tokens";
  }
  return "stop";
}

function extractText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
  }

  return "";
}

type AccumulatedToolCall = RuntimeToolCall & {
  emitted?: boolean;
  rawArguments: string;
};

export function buildAnthropicMessagesRequest(input: ProtocolBuildInput): ProtocolRequest {
  const rendered = renderContext(input.invocation);
  const tools = toAnthropicTools(input.invocation);

  return {
    baseUrl: input.baseUrl,
    path: "/v1/messages",
    method: "POST",
    headers: input.headers,
    body: {
      model: input.invocation.model.modelId,
      ...(rendered.system ? { system: rendered.system } : {}),
      messages: toAnthropicMessages(input.invocation),
      ...(tools ? { tools } : {}),
      ...(input.invocation.outputTokenBudget ? { max_tokens: input.invocation.outputTokenBudget } : {}),
      stream: input.supportsStreaming ?? true
    }
  };
}

export async function* normalizeAnthropicMessagesStream(
  stream: SyncOrAsyncIterable<any>,
  context: ProtocolStreamContext
): AsyncIterable<ProviderEvent> {
  let sequence = context.initialSequence ?? 0;
  let text = "";
  let usage = normalizeUsage(undefined);
  let finishReason: ProviderCompletion["finishReason"] = "stop";
  let completed = false;
  let observedEventCount = 0;
  let rootCauseMessage: string | undefined;
  const toolCalls = new Map<number, AccumulatedToolCall>();

  for await (const event of asAsyncIterable(stream)) {
    observedEventCount += 1;
    rootCauseMessage ??= extractProviderStreamRootCauseMessage(event);
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
      text += event.delta.text;
      yield createMessageDeltaEvent(context, ++sequence, event.delta.text);
    }

    if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
      const index = event.index ?? toolCalls.size;
      const rawInput = JSON.stringify(event.content_block.input ?? {});
      const toolCall: AccumulatedToolCall = {
        toolCallId: event.content_block.id,
        toolName: event.content_block.name,
        arguments: parseToolArguments(rawInput),
        rawArguments: rawInput === "{}" ? "" : rawInput
      };
      toolCalls.set(index, toolCall);

      if (!toolCall.emitted && typeof toolCall.arguments === "object" && Object.keys(toolCall.arguments as object).length > 0) {
        toolCall.emitted = true;
        yield createToolCallEvent(context, ++sequence, {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          arguments: toolCall.arguments
        });
      }
    }

    if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      const index = event.index ?? 0;
      const current = toolCalls.get(index);
      if (!current) {
        continue;
      }

      current.rawArguments += event.delta.partial_json ?? "";
      current.arguments = parseToolArguments(current.rawArguments);

      if (!current.emitted && typeof current.arguments === "object") {
        current.emitted = true;
        yield createToolCallEvent(context, ++sequence, {
          toolCallId: current.toolCallId,
          toolName: current.toolName,
          arguments: current.arguments
        });
      }
    }

    if (event?.type === "message_delta") {
      finishReason = mapStopReason(event.delta?.stop_reason);
      usage = normalizeUsage(event.usage);
      yield createUsageEvent(context, ++sequence, usage);
    }

    if (Array.isArray(event?.content) && event?.type === "message") {
      text = extractText(event.content);
    }

    if (event?.type === "message_stop") {
      completed = true;
      for (const current of toolCalls.values()) {
        if (!current.emitted) {
          current.emitted = true;
          yield createToolCallEvent(context, ++sequence, {
            toolCallId: current.toolCallId,
            toolName: current.toolName,
            arguments: current.arguments
          });
        }
      }

      yield createCompletionEvent(context, ++sequence, {
        invocationId: context.invocationId,
        finishReason,
        messages: createAssistantMessages(text),
        toolCalls: [...toolCalls.values()].map(({ toolCallId, toolName, arguments: parsedArguments }) => ({
          toolCallId,
          toolName,
          arguments: parsedArguments
        })),
        usage,
        warnings: [...(context.initialWarnings ?? [])]
      });
    }
  }

  if (!completed) {
    for (const event of createProviderStreamIncompleteEvents({
      context,
      nextSequence: () => ++sequence,
      usage,
      protocolFamily: "anthropic_messages",
      observedEventCount,
      rootCauseMessage
    })) {
      yield event;
    }
  }
}
