import type { ProviderCompletion, ProviderEvent, RuntimeToolCall } from "@endec/domain";
import {
  asAsyncIterable,
  createAssistantMessages,
  createCompletionEvent,
  createMessageDeltaEvent,
  createToolCallEvent,
  createUsageEvent,
  normalizeUsage,
  parseToolArguments,
  toOpenAIChatMessages,
  toOpenAITools,
  type ProtocolBuildInput,
  type ProtocolRequest,
  type ProtocolStreamContext,
  type SyncOrAsyncIterable
} from "./shared.ts";

function mapFinishReason(finishReason: string | null | undefined): ProviderCompletion["finishReason"] {
  if (finishReason === "tool_calls") {
    return "tool_calls";
  }
  if (finishReason === "length") {
    return "max_tokens";
  }
  if (finishReason === "cancelled") {
    return "cancelled";
  }
  if (finishReason === "failed") {
    return "failed";
  }
  return "stop";
}

function appendMessageContent(text: string, content: unknown) {
  if (typeof content === "string") {
    return text + content;
  }

  if (Array.isArray(content)) {
    return (
      text +
      content
        .filter((item) => typeof item?.text === "string")
        .map((item) => item.text)
        .join("")
    );
  }

  return text;
}

export function buildChatCompletionsRequest(input: ProtocolBuildInput): ProtocolRequest {
  return {
    baseUrl: input.baseUrl,
    path: "/chat/completions",
    method: "POST",
    headers: input.headers,
    body: {
      model: input.invocation.model.modelId,
      stream: input.supportsStreaming ?? true,
      messages: toOpenAIChatMessages(input.invocation),
      ...(toOpenAITools(input.invocation) ? { tools: toOpenAITools(input.invocation) } : {}),
      ...(input.invocation.outputTokenBudget ? { max_tokens: input.invocation.outputTokenBudget } : {})
    }
  };
}

type AccumulatedToolCall = RuntimeToolCall & {
  emitted?: boolean;
  rawArguments: string;
};

export async function* normalizeChatCompletionsStream(
  stream: SyncOrAsyncIterable<any>,
  context: ProtocolStreamContext
): AsyncIterable<ProviderEvent> {
  let sequence = context.initialSequence ?? 0;
  let text = "";
  let usage = normalizeUsage(undefined);
  let finishReason: ProviderCompletion["finishReason"] = "stop";
  const toolCalls = new Map<number, AccumulatedToolCall>();

  for await (const chunk of asAsyncIterable(stream)) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    const message = choice?.message;

    if (typeof delta?.content === "string" && delta.content.length > 0) {
      text += delta.content;
      yield createMessageDeltaEvent(context, ++sequence, delta.content);
    }

    if (message?.content) {
      text = appendMessageContent(text, message.content);
    }

    const partialToolCalls = Array.isArray(delta?.tool_calls)
      ? delta.tool_calls
      : Array.isArray(message?.tool_calls)
        ? message.tool_calls
        : [];

    for (const partial of partialToolCalls) {
      const index = partial.index ?? toolCalls.size;
      const current: AccumulatedToolCall = toolCalls.get(index) ?? {
        toolCallId: partial.id ?? `tool_call_${index}`,
        toolName: partial.function?.name ?? "tool",
        arguments: {},
        rawArguments: ""
      };

      current.toolCallId = partial.id ?? current.toolCallId;
      current.toolName = partial.function?.name ?? current.toolName;
      current.rawArguments += partial.function?.arguments ?? "";
      current.arguments = parseToolArguments(current.rawArguments);
      toolCalls.set(index, current);

      if (!current.emitted && typeof current.arguments === "object") {
        current.emitted = true;
        yield createToolCallEvent(context, ++sequence, {
          toolCallId: current.toolCallId,
          toolName: current.toolName,
          arguments: current.arguments
        });
      }
    }

    if (choice?.finish_reason) {
      finishReason = mapFinishReason(choice.finish_reason);
    }

    if (chunk?.usage) {
      usage = normalizeUsage(chunk.usage);
      yield createUsageEvent(context, ++sequence, usage);
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
