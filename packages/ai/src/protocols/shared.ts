import type {
  ProviderCompletion,
  ProviderEvent,
  ProviderInvocation,
  RuntimeContextBlock,
  RuntimeMessage,
  RuntimeToolCall,
  RuntimeWarning,
  Usage
} from "@endec/domain";

export interface ProtocolRequest {
  baseUrl: string;
  path: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, any>;
}

export interface ProtocolStreamContext {
  invocationId: string;
  timestamp: string;
  initialSequence?: number;
  initialWarnings?: RuntimeWarning[];
  protocolFamily?: string;
}

export interface ProtocolBuildInput {
  invocation: ProviderInvocation;
  baseUrl: string;
  headers: Record<string, string>;
  supportsStreaming?: boolean;
}

export type SyncOrAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

type OpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
};

type ResponsesInputItem =
  | {
      role: "user" | "assistant" | "system";
      content: Array<{
        type: "input_text" | "output_text";
        text: string;
      }>;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

type AnthropicMessage = {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | {
            type: "text";
            text: string;
          }
        | {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          }
      >;
};

const SYSTEM_CONTEXT_KINDS = new Set(["system", "instruction", "runtime_repair", "memory", "task", "resource"]);
const HISTORY_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

function formatBlock(block: ProviderInvocation["contextBlocks"][number]) {
  const label = block.title ?? block.kind.replaceAll("_", " ");
  return `### ${label}\n${block.content}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractNestedMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const message = value.message;
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

export function extractProviderStreamRootCauseMessage(event: unknown): string | undefined {
  if (!isRecord(event) || typeof event.type !== "string") {
    return undefined;
  }

  if (event.type === "response.failed") {
    return extractNestedMessage(isRecord(event.response) ? event.response.error : undefined)
      ?? extractNestedMessage(event.error)
      ?? extractNestedMessage(event.response);
  }

  if (event.type === "error") {
    return extractNestedMessage(event.error) ?? extractNestedMessage(event);
  }

  return undefined;
}

function getBlockRole(block: RuntimeContextBlock) {
  const role = isRecord(block.metadata) ? block.metadata.role : undefined;
  return typeof role === "string" && HISTORY_MESSAGE_ROLES.has(role) ? role : undefined;
}

function getToolCallId(block: RuntimeContextBlock) {
  const toolCallId = isRecord(block.metadata) ? block.metadata.toolCallId : undefined;
  return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : block.blockId;
}

function getToolName(block: RuntimeContextBlock) {
  const toolName = isRecord(block.metadata) ? block.metadata.toolName : undefined;
  return typeof toolName === "string" && toolName.length > 0 ? toolName : block.title;
}

function getToolStatus(block: RuntimeContextBlock) {
  const status = isRecord(block.metadata) ? block.metadata.status : undefined;
  return typeof status === "string" && status.length > 0 ? status : undefined;
}

function getRenderableText(block: RuntimeContextBlock) {
  if (block.kind === "user_input" || block.kind === "history" || block.kind === "tool_result") {
    return block.content;
  }

  return formatBlock(block);
}

function renderSystemText(invocation: ProviderInvocation) {
  return invocation.contextBlocks
    .filter((block) => SYSTEM_CONTEXT_KINDS.has(block.kind))
    .map(formatBlock)
    .join("\n\n");
}

export function renderContext(invocation: ProviderInvocation) {
  const systemBlocks = invocation.contextBlocks.filter((block) => SYSTEM_CONTEXT_KINDS.has(block.kind));
  const userBlocks = invocation.contextBlocks.filter((block) => !SYSTEM_CONTEXT_KINDS.has(block.kind));

  return {
    system: systemBlocks.map(formatBlock).join("\n\n"),
    user: userBlocks.map(formatBlock).join("\n\n")
  };
}

export function toOpenAIChatMessages(invocation: ProviderInvocation): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [];
  const system = renderSystemText(invocation);

  if (system) {
    messages.push({
      role: "system",
      content: system
    });
  }

  for (const block of invocation.contextBlocks) {
    if (SYSTEM_CONTEXT_KINDS.has(block.kind)) {
      continue;
    }

    if (block.kind === "history") {
      const role = getBlockRole(block);
      if (role === "system" || role === "user" || role === "assistant") {
        messages.push({
          role,
          content: getRenderableText(block)
        });
        continue;
      }

      if (role === "tool") {
        messages.push({
          role: "tool",
          content: getRenderableText(block),
          tool_call_id: getToolCallId(block),
          ...(getToolName(block) ? { name: getToolName(block) } : {})
        });
        continue;
      }
    }

    if (block.kind === "tool_result") {
      messages.push({
        role: "tool",
        content: getRenderableText(block),
        tool_call_id: getToolCallId(block),
        ...(getToolName(block) ? { name: getToolName(block) } : {})
      });
      continue;
    }

    messages.push({
      role: "user",
      content: getRenderableText(block)
    });
  }

  return messages;
}

export function toResponsesInput(invocation: ProviderInvocation): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  for (const block of invocation.contextBlocks) {
    if (SYSTEM_CONTEXT_KINDS.has(block.kind)) {
      continue;
    }

    if (block.kind === "history") {
      const role = getBlockRole(block);
      if (role === "assistant" || role === "user" || role === "system") {
        input.push({
          role,
          content: [
            {
              type: role === "assistant" ? "output_text" : "input_text",
              text: getRenderableText(block)
            }
          ]
        });
        continue;
      }
    }

    if (block.kind === "tool_result") {
      input.push({
        type: "function_call_output",
        call_id: getToolCallId(block),
        output: getRenderableText(block)
      });
      continue;
    }

    input.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text: getRenderableText(block)
        }
      ]
    });
  }

  return input;
}

export function toAnthropicMessages(invocation: ProviderInvocation): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const block of invocation.contextBlocks) {
    if (SYSTEM_CONTEXT_KINDS.has(block.kind)) {
      continue;
    }

    if (block.kind === "history") {
      const role = getBlockRole(block);
      if (role === "assistant" || role === "user") {
        messages.push({
          role,
          content: getRenderableText(block)
        });
        continue;
      }
    }

    if (block.kind === "tool_result") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: getToolCallId(block),
            content: getRenderableText(block),
            ...(getToolStatus(block) && getToolStatus(block) !== "success" ? { is_error: true } : {})
          }
        ]
      });
      continue;
    }

    messages.push({
      role: "user",
      content: getRenderableText(block)
    });
  }

  return messages;
}

export function toOpenAITools(invocation: ProviderInvocation) {
  if (invocation.tools.length === 0) {
    return undefined;
  }

  return invocation.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

export function toResponsesTools(invocation: ProviderInvocation) {
  if (invocation.tools.length === 0) {
    return undefined;
  }

  return invocation.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }));
}

export function toAnthropicTools(invocation: ProviderInvocation) {
  if (invocation.tools.length === 0) {
    return undefined;
  }

  return invocation.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

export function parseToolArguments(argumentsText: unknown) {
  if (typeof argumentsText !== "string") {
    return argumentsText ?? {};
  }

  if (!argumentsText.trim()) {
    return {};
  }

  try {
    return JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
}

export function normalizeUsage(
  raw:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
        };
        input_tokens_details?: {
          cached_tokens?: number;
        };
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | null
    | undefined
): Usage {
  const inputTokens = raw?.prompt_tokens ?? raw?.input_tokens ?? 0;
  const outputTokens = raw?.completion_tokens ?? raw?.output_tokens ?? 0;
  const totalTokens = raw?.total_tokens ?? inputTokens + outputTokens;
  const cacheReadTokens = raw?.prompt_tokens_details?.cached_tokens
    ?? raw?.input_tokens_details?.cached_tokens
    ?? raw?.cache_read_input_tokens;
  const cacheWriteTokens = raw?.cache_creation_input_tokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost: 0,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {})
  };
}

export async function* asAsyncIterable<T>(stream: SyncOrAsyncIterable<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in Object(stream)) {
    for await (const item of stream as AsyncIterable<T>) {
      yield item;
    }
    return;
  }

  for (const item of stream as Iterable<T>) {
    yield item;
  }
}

export function createMessageDeltaEvent(
  context: ProtocolStreamContext,
  sequence: number,
  delta: string
): ProviderEvent {
  return {
    invocationId: context.invocationId,
    sequence,
    timestamp: context.timestamp,
    kind: "message_delta",
    delta
  };
}

export function createToolCallEvent(
  context: ProtocolStreamContext,
  sequence: number,
  toolCall: RuntimeToolCall
): ProviderEvent {
  return {
    invocationId: context.invocationId,
    sequence,
    timestamp: context.timestamp,
    kind: "tool_call",
    toolCall
  };
}

export function createUsageEvent(
  context: ProtocolStreamContext,
  sequence: number,
  usage: Usage
): ProviderEvent {
  return {
    invocationId: context.invocationId,
    sequence,
    timestamp: context.timestamp,
    kind: "usage",
    usage
  };
}

export function createWarningEvent(
  context: ProtocolStreamContext,
  sequence: number,
  warning: RuntimeWarning
): ProviderEvent {
  return {
    invocationId: context.invocationId,
    sequence,
    timestamp: context.timestamp,
    kind: "warning",
    warning
  };
}

export function createProviderStreamIncompleteWarning(input: {
  invocationId: string;
  protocolFamily?: string;
  observedEventCount?: number;
  finishReason?: string;
  stopReason?: string;
  rootCauseMessage?: string;
}): RuntimeWarning {
  return {
    code: "provider_stream_incomplete",
    message: "Provider stream ended before emitting its required terminal completion event.",
    metadata: {
      invocationId: input.invocationId,
      ...(input.protocolFamily ? { protocolFamily: input.protocolFamily } : {}),
      ...(input.observedEventCount !== undefined ? { observedEventCount: input.observedEventCount } : {}),
      ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
      ...(input.rootCauseMessage ? { rootCauseMessage: input.rootCauseMessage } : {})
    }
  };
}

export function createProviderStreamIncompleteEvents(input: {
  context: ProtocolStreamContext;
  nextSequence: () => number;
  usage: Usage;
  protocolFamily?: string;
  observedEventCount?: number;
  rootCauseMessage?: string;
}): ProviderEvent[] {
  const warning = createProviderStreamIncompleteWarning({
    invocationId: input.context.invocationId,
    protocolFamily: input.protocolFamily ?? input.context.protocolFamily,
    observedEventCount: input.observedEventCount,
    finishReason: "failed",
    stopReason: "provider_stream_incomplete",
    rootCauseMessage: input.rootCauseMessage
  });

  return [
    createWarningEvent(input.context, input.nextSequence(), warning),
    createCompletionEvent(input.context, input.nextSequence(), {
      invocationId: input.context.invocationId,
      finishReason: "failed",
      messages: [],
      toolCalls: [],
      usage: input.usage,
      warnings: [...(input.context.initialWarnings ?? []), warning]
    })
  ];
}

export function createCompletionEvent(
  context: ProtocolStreamContext,
  sequence: number,
  completion: ProviderCompletion
): ProviderEvent {
  return {
    invocationId: context.invocationId,
    sequence,
    timestamp: context.timestamp,
    kind: "completed",
    completion
  };
}

export function createAssistantMessages(text: string): RuntimeMessage[] {
  return text
    ? [
        {
          role: "assistant",
          content: text
        }
      ]
    : [];
}
