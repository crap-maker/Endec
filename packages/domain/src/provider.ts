import { z } from "zod";
import {
  RuntimeContextBlockSchema,
  RuntimeMessageSchema,
  RuntimeModelRefSchema,
  RuntimeToolCallSchema,
  RuntimeToolDefinitionSchema,
  RuntimeWarningSchema
} from "./runtime.ts";
import { ModeSchema, UsageSchema } from "./turn.ts";

export const ProviderProtocolFamilySchema = z.enum(["chat_completions", "responses", "anthropic_messages", "custom"]);

export const ProviderCapabilitySchema = z.object({
  supportsTools: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsImages: z.boolean().optional(),
  maxContextTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional()
});

export const ProviderModelMetadataSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string().optional(),
  protocolFamily: ProviderProtocolFamilySchema,
  capabilities: ProviderCapabilitySchema
});

export const ProviderInvocationSchema = z.object({
  invocationId: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  mode: ModeSchema,
  model: RuntimeModelRefSchema,
  contextBlocks: z.array(RuntimeContextBlockSchema),
  tools: z.array(RuntimeToolDefinitionSchema),
  outputTokenBudget: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const ProviderCompletionSchema = z.object({
  invocationId: z.string(),
  finishReason: z.enum(["stop", "tool_calls", "max_tokens", "cancelled", "failed"]),
  messages: z.array(RuntimeMessageSchema),
  toolCalls: z.array(RuntimeToolCallSchema),
  usage: UsageSchema,
  warnings: z.array(RuntimeWarningSchema)
});

export const ProviderEventSchema = z.object({
  invocationId: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
  kind: z.enum(["status", "message_delta", "message", "tool_call", "usage", "warning", "completed"]),
  statusText: z.string().optional(),
  delta: z.string().optional(),
  message: RuntimeMessageSchema.optional(),
  toolCall: RuntimeToolCallSchema.optional(),
  usage: UsageSchema.optional(),
  warning: RuntimeWarningSchema.optional(),
  completion: ProviderCompletionSchema.optional()
});

export type ProviderProtocolFamily = z.infer<typeof ProviderProtocolFamilySchema>;
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
export type ProviderModelMetadata = z.infer<typeof ProviderModelMetadataSchema>;
export type ProviderInvocation = z.infer<typeof ProviderInvocationSchema>;
export type ProviderCompletion = z.infer<typeof ProviderCompletionSchema>;
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
