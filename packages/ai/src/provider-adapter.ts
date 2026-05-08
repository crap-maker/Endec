import type {
  ProviderEvent,
  ProviderInvocation,
  ProviderModelMetadata,
  ProviderProtocolFamily,
  RuntimeWarning
} from "@endec/domain";
import { resolveAuth, type ResolveAuthOptions } from "./auth.ts";
import { DEFAULT_PROVIDER_CATALOG, type ProviderCatalog } from "./provider-catalog.ts";
import {
  buildAnthropicMessagesRequest,
  normalizeAnthropicMessagesStream
} from "./protocols/anthropic-messages.ts";
import {
  buildChatCompletionsRequest,
  normalizeChatCompletionsStream
} from "./protocols/chat-completions.ts";
import { buildResponsesRequest, normalizeResponsesStream } from "./protocols/responses.ts";
import {
  createWarningEvent,
  type ProtocolRequest,
  type ProtocolStreamContext,
  type SyncOrAsyncIterable
} from "./protocols/shared.ts";

export interface ProviderTransportRequest extends ProtocolRequest {
  providerId: string;
  modelId: string;
  protocolFamily: ProviderProtocolFamily;
}

export interface ProviderTransport {
  stream(request: ProviderTransportRequest): SyncOrAsyncIterable<unknown>;
}

export interface ProviderAdapterOptions {
  catalog?: ProviderCatalog;
  transport: ProviderTransport;
  env?: Record<string, string | undefined>;
  clock?: {
    now(): string;
  };
}

const BUILDERS = {
  chat_completions: buildChatCompletionsRequest,
  responses: buildResponsesRequest,
  anthropic_messages: buildAnthropicMessagesRequest
} as const;

const NORMALIZERS = {
  chat_completions: normalizeChatCompletionsStream,
  responses: normalizeResponsesStream,
  anthropic_messages: normalizeAnthropicMessagesStream
} as const;

type SupportedProtocolFamily = keyof typeof BUILDERS;

function asSupportedProtocolFamily(protocolFamily: ProviderProtocolFamily): SupportedProtocolFamily {
  if (protocolFamily === "custom") {
    throw new Error("Custom protocol families are not implemented in the provider adapter");
  }

  return protocolFamily;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readAuthOverride(value: unknown): ResolveAuthOptions | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const apiKey = typeof record.apiKey === "string" ? record.apiKey : undefined;
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : undefined;
  const headersRecord = asRecord(record.headers);
  const headers = headersRecord
    ? Object.fromEntries(
        Object.entries(headersRecord)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      )
    : undefined;

  if (!apiKey && !baseUrl && !headers) {
    return undefined;
  }

  return {
    apiKey,
    baseUrl,
    headers
  };
}

function readInvocationAuthOverride(input: ProviderInvocation) {
  const metadataOverride = readAuthOverride(input.metadata);

  for (const block of input.contextBlocks) {
    const blockMetadata = asRecord(block.metadata);
    const blockOverride = readAuthOverride(blockMetadata?.providerAuthOverride);
    if (!blockOverride) {
      continue;
    }

    return {
      ...metadataOverride,
      ...blockOverride,
      headers: {
        ...(metadataOverride?.headers ?? {}),
        ...(blockOverride.headers ?? {})
      }
    } satisfies ResolveAuthOptions;
  }

  return metadataOverride;
}

function isProviderAuthOverrideBlock(input: ProviderInvocation["contextBlocks"][number]) {
  return readAuthOverride(asRecord(input.metadata)?.providerAuthOverride) !== undefined;
}

function prepareInvocation(input: ProviderInvocation, metadata: ProviderModelMetadata) {
  const warnings: RuntimeWarning[] = [];
  let tools = input.tools;

  if (!metadata.capabilities.supportsTools && input.tools.length > 0) {
    warnings.push({
      code: "provider_tools_unsupported",
      message: `Model ${metadata.providerId}/${metadata.modelId} does not advertise tool support; requested tools were omitted.`
    });
    tools = [];
  }

  return {
    invocation: {
      ...input,
      contextBlocks: input.contextBlocks.filter((block) => !isProviderAuthOverrideBlock(block)),
      tools
    },
    warnings
  };
}

function formatProviderInvocationError(input: {
  providerId: string;
  modelId: string;
  protocolFamily: SupportedProtocolFamily;
  cause: unknown;
}) {
  const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
  return new Error(
    `Provider invocation failed for ${input.providerId}/${input.modelId} via ${input.protocolFamily}: ${message}`
  );
}

export function createProviderAdapter(options: ProviderAdapterOptions) {
  const catalog = options.catalog ?? DEFAULT_PROVIDER_CATALOG;
  const env = options.env ?? process.env;
  const clock = options.clock ?? { now: () => new Date().toISOString() };

  return {
    async *invoke(input: ProviderInvocation): AsyncIterable<ProviderEvent> {
      const resolvedModel = catalog.resolveModel({
        providerId: input.model.providerId,
        modelId: input.model.modelId
      });
      const auth = resolveAuth(resolvedModel, {
        env,
        ...readInvocationAuthOverride(input)
      });

      if (resolvedModel.auth.type !== "none" && !auth.apiKey) {
        throw new Error(`Missing API key for provider ${resolvedModel.metadata.providerId}`);
      }

      const protocolFamily = asSupportedProtocolFamily(resolvedModel.metadata.protocolFamily);
      const buildRequest = BUILDERS[protocolFamily];
      const normalize = NORMALIZERS[protocolFamily];
      const prepared = prepareInvocation(input, resolvedModel.metadata);
      const request = buildRequest({
        invocation: prepared.invocation,
        baseUrl: auth.baseUrl,
        headers: auth.headers,
        supportsStreaming: resolvedModel.metadata.capabilities.supportsStreaming
      });
      const timestamp = clock.now();
      let preludeSequence = 0;

      for (const warning of prepared.warnings) {
        yield createWarningEvent(
          {
            invocationId: input.invocationId,
            timestamp
          },
          ++preludeSequence,
          warning
        );
      }

      const streamContext: ProtocolStreamContext = {
        invocationId: input.invocationId,
        timestamp,
        initialSequence: preludeSequence,
        initialWarnings: prepared.warnings,
        protocolFamily
      };

      try {
        const stream = options.transport.stream({
          ...request,
          providerId: resolvedModel.metadata.providerId,
          modelId: resolvedModel.metadata.modelId,
          protocolFamily
        });

        for await (const event of normalize(stream, streamContext)) {
          yield event;
        }
      } catch (error) {
        throw formatProviderInvocationError({
          providerId: resolvedModel.metadata.providerId,
          modelId: resolvedModel.metadata.modelId,
          protocolFamily,
          cause: error
        });
      }
    },

    async describeModel(input: Pick<ProviderModelMetadata, "providerId" | "modelId">) {
      return catalog.findModel(input)?.metadata ?? null;
    }
  };
}
