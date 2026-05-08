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
  toResponsesInput,
  toResponsesTools,
  type ProtocolBuildInput,
  type ProtocolRequest,
  type ProtocolStreamContext,
  type SyncOrAsyncIterable
} from "./shared.ts";

function inferFinishReason(output: any[]): ProviderCompletion["finishReason"] {
  return output.some((item) => item?.type === "function_call") ? "tool_calls" : "stop";
}

function extractCompletion(output: any[]) {
  const messages = output
    .filter((item) => item?.type === "message")
    .flatMap((item) => item?.content ?? [])
    .filter((content) => content?.type === "output_text")
    .map((content) => content.text)
    .join("");

  const toolCalls = output
    .filter((item) => item?.type === "function_call")
    .map(
      (item): RuntimeToolCall => ({
        toolCallId: item.call_id,
        toolName: item.name,
        arguments: parseToolArguments(item.arguments)
      })
    );

  return {
    messages: createAssistantMessages(messages),
    toolCalls
  };
}

function asCompletedResponse(event: any) {
  if (event?.type === "response.completed") {
    return event.response;
  }

  if (Array.isArray(event?.output)) {
    return event;
  }

  return null;
}

export function buildResponsesRequest(input: ProtocolBuildInput): ProtocolRequest {
  const rendered = renderContext(input.invocation);
  const tools = toResponsesTools(input.invocation);

  return {
    baseUrl: input.baseUrl,
    path: "/responses",
    method: "POST",
    headers: input.headers,
    body: {
      model: input.invocation.model.modelId,
      ...(rendered.system ? { instructions: rendered.system } : {}),
      input: toResponsesInput(input.invocation),
      ...(tools ? { tools } : {}),
      ...(input.invocation.outputTokenBudget ? { max_output_tokens: input.invocation.outputTokenBudget } : {}),
      stream: input.supportsStreaming ?? true
    }
  };
}

export async function* normalizeResponsesStream(
  stream: SyncOrAsyncIterable<any>,
  context: ProtocolStreamContext
): AsyncIterable<ProviderEvent> {
  let sequence = context.initialSequence ?? 0;
  let text = "";
  let usage = normalizeUsage(undefined);
  let completed = false;
  let observedEventCount = 0;
  let rootCauseMessage: string | undefined;
  const toolCalls = new Map<string, RuntimeToolCall>();

  for await (const event of asAsyncIterable(stream)) {
    observedEventCount += 1;
    rootCauseMessage ??= extractProviderStreamRootCauseMessage(event);
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      yield createMessageDeltaEvent(context, ++sequence, event.delta);
    }

    if (event?.type === "response.output_item.done" && event.item?.type === "function_call") {
      const toolCall: RuntimeToolCall = {
        toolCallId: event.item.call_id,
        toolName: event.item.name,
        arguments: parseToolArguments(event.item.arguments)
      };
      toolCalls.set(toolCall.toolCallId, toolCall);
      yield createToolCallEvent(context, ++sequence, toolCall);
    }

    const completedResponse = asCompletedResponse(event);
    if (!completedResponse) {
      continue;
    }

    const output = completedResponse.output ?? [];
    const completion = extractCompletion(output);
    usage = normalizeUsage(completedResponse.usage);
    completed = true;

    yield createUsageEvent(context, ++sequence, usage);
    yield createCompletionEvent(context, ++sequence, {
      invocationId: context.invocationId,
      finishReason: inferFinishReason(output),
      messages: completion.messages.length > 0 ? completion.messages : createAssistantMessages(text),
      toolCalls: completion.toolCalls.length > 0 ? completion.toolCalls : [...toolCalls.values()],
      usage,
      warnings: [...(context.initialWarnings ?? [])]
    });
  }

  if (!completed) {
    for (const event of createProviderStreamIncompleteEvents({
      context,
      nextSequence: () => ++sequence,
      usage,
      protocolFamily: "responses",
      observedEventCount,
      rootCauseMessage
    })) {
      yield event;
    }
  }
}
