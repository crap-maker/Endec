import { z } from "zod";
import {
  AuthoritativeTurnTruthSchema,
  ContextAssemblyObservabilitySchema,
  MemoryContinuitySurfaceSchema,
  RuntimeMemoryObservabilitySchema,
  ToolBatchPermissionContextSchema,
  ToolExecutionResultSchema
} from "./execution.ts";
import { PermissionDecisionSchema } from "./permission.ts";
import {
  CurrentTurnTimeContextSchema,
  CurrentTurnTimeDayPartSchema,
  CurrentTurnTimeGapKindSchema,
  CurrentTurnTimeTimezoneSourceSchema,
  CurrentTurnTimeWeekdaySchema
} from "./time-context.ts";
import { ModeSchema, SourceSchema, UsageSchema } from "./turn.ts";
import { SliceTriggerKindSchema } from "./background-task.ts";
import { ArtifactPreviewSchema, ArtifactRefSchema } from "./artifact.ts";

export {
  CurrentTurnTimeContextSchema,
  CurrentTurnTimeDayPartSchema,
  CurrentTurnTimeGapKindSchema,
  CurrentTurnTimeTimezoneSourceSchema,
  CurrentTurnTimeWeekdaySchema
} from "./time-context.ts";
export type {
  CurrentTurnTimeContext,
  CurrentTurnTimeDayPart,
  CurrentTurnTimeGapKind,
  CurrentTurnTimeTimezoneSource,
  CurrentTurnTimeWeekday
} from "./time-context.ts";

export const RuntimeContextBlockKindSchema = z.enum([
  "system",
  "instruction",
  "runtime_repair",
  "history",
  "user_input",
  "memory",
  "task",
  "tool_result",
  "resource"
]);

export const RuntimeContextBlockSchema = z.object({
  blockId: z.string(),
  kind: RuntimeContextBlockKindSchema,
  title: z.string().optional(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative().optional(),
  sourceRefs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const RuntimeToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const RuntimeToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  arguments: z.unknown(),
  rationale: z.string().optional()
});

export const RuntimeToolResultSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["success", "error", "denied"]),
  output: z.unknown().optional(),
  artifact: ArtifactRefSchema.optional(),
  preview: ArtifactPreviewSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const RuntimeMessageSchema = z.object({
  role: z.enum(["assistant", "system", "tool"]),
  content: z.string(),
  artifactRefs: z.array(ArtifactRefSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const RuntimeWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const RuntimeModelRefSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  modelTier: z.enum(["cheap", "strong"]).optional().describe("Legacy compatibility only; runtime selection must not branch on this field.")
});

export const RuntimeSliceMetadataSchema = z.object({
  runId: z.string(),
  sliceId: z.string(),
  sliceTriggerKind: SliceTriggerKindSchema,
  lane: z.enum(["foreground", "background"]).optional()
});

export const ToolLoopLimitSourceSchema = z.enum([
  "mode_default",
  "config_override",
  "global_hard_cap",
  "legacy_flat_limit",
  "runtime_request"
]);

export const ToolSafetyClassificationSchema = z.enum(["unavailable"]);

export const RuntimeToolLoopLimitsSchema = z.object({
  configuredMaxToolCallsPerBatch: z.number().int().positive(),
  effectiveMaxToolCallsPerBatch: z.number().int().positive(),
  maxToolCallsPerBatchLimitSources: z.array(ToolLoopLimitSourceSchema),
  globalMaxToolCallsPerBatchHardCap: z.number().int().positive().default(8),
  maxToolBatchRepairAttempts: z.number().int().nonnegative().default(2),
  maxToolBatchRepairAttemptsHardCap: z.number().int().nonnegative().default(3),
  toolSafetyClassification: ToolSafetyClassificationSchema.default("unavailable"),
  toolSafetyCapApplied: z.boolean().default(false)
});

export const RuntimeLimitsSchema = z.object({
  inputTokenBudget: z.number().int().positive(),
  outputTokenBudget: z.number().int().positive(),
  memoryInjectionBudget: z.number().int().nonnegative(),
  toolResultInjectionBudget: z.number().int().nonnegative(),
  maxLoopCount: z.number().int().positive(),
  maxToolCallsPerBatch: z.number().int().positive(),
  maxToolCallsPerSlice: z.number().int().positive().optional(),
  maxToolCallsPerTurn: z.number().int().positive(),
  toolLoop: RuntimeToolLoopLimitsSchema.optional()
});

export const RuntimeMemoryContextSchema = z.object({
  workingSetSummary: z.string().describe("Legacy compatibility summary. New consumers should prefer continuity.workingSet."),
  retrievedItems: z.array(z.unknown()).describe("Legacy compatibility retrieval surface; retained to avoid breaking older consumers."),
  injectionPlan: z.array(z.unknown()).describe("Legacy compatibility injection surface; retained while newer consumers read continuity/contextBlocks."),
  tokenEstimate: z.number().int().nonnegative(),
  sourceRefs: z.array(z.string()),
  continuity: MemoryContinuitySurfaceSchema.optional().describe("Structured retrieval continuity surface for canonical working-set / typed-memory / evidence truth plus projection locators."),
  contextBlocks: z.array(RuntimeContextBlockSchema).optional(),
  observability: RuntimeMemoryObservabilitySchema.optional()
});

export const RuntimeTurnContextSchema = z.object({
  memory: RuntimeMemoryContextSchema,
  authoritativeTruth: AuthoritativeTurnTruthSchema.optional(),
  timeContext: CurrentTurnTimeContextSchema.optional(),
  observability: ContextAssemblyObservabilitySchema.optional()
});

export const RuntimeApprovedToolBatchSchema = ToolBatchPermissionContextSchema.extend({
  requestedToolCalls: z.array(RuntimeToolCallSchema).default([]),
  priorLoopCount: z.number().int().nonnegative().default(0),
  priorToolCallCount: z.number().int().nonnegative().default(0)
});

export const RuntimeContinuationSchema = z.object({
  approvedToolBatch: RuntimeApprovedToolBatchSchema.optional()
});

export const RuntimeRequestSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  resolvedMode: ModeSchema,
  correlation: z.object({
    source: SourceSchema,
    actorId: z.string(),
    traceId: z.string().optional()
  }),
  userInput: z.object({
    text: z.string(),
    attachments: z.array(z.unknown())
  }),
  model: RuntimeModelRefSchema,
  toolSchemas: z.array(RuntimeToolDefinitionSchema),
  contextBlocks: z.array(RuntimeContextBlockSchema),
  turnContext: RuntimeTurnContextSchema.optional(),
  continuation: RuntimeContinuationSchema.optional(),
  slice: RuntimeSliceMetadataSchema.optional(),
  limits: RuntimeLimitsSchema
});

export const RuntimeEventSchema = z.object({
  eventId: z.string(),
  turnId: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
  kind: z.enum(["status", "assistant_delta", "assistant_message", "tool_call", "tool_result", "warning"]),
  statusText: z.string().optional(),
  delta: z.string().optional(),
  message: RuntimeMessageSchema.optional(),
  toolCall: RuntimeToolCallSchema.optional(),
  toolResult: RuntimeToolResultSchema.optional(),
  warning: RuntimeWarningSchema.optional()
});

export const RuntimeResultSchema = z.object({
  turnId: z.string(),
  messages: z.array(RuntimeMessageSchema),
  requestedToolCalls: z.array(RuntimeToolCallSchema),
  loopCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  toolResultTokensUsed: z.number().int().nonnegative().default(0),
  usage: UsageSchema,
  warnings: z.array(RuntimeWarningSchema),
  stopReason: z.string().min(1),
  permissionDecisions: z.array(PermissionDecisionSchema).default([]),
  toolExecutionResults: z.array(ToolExecutionResultSchema).default([]),
  artifacts: z.array(ArtifactRefSchema).default([])
});

export type RuntimeContextBlockKind = z.infer<typeof RuntimeContextBlockKindSchema>;
export type RuntimeContextBlock = z.infer<typeof RuntimeContextBlockSchema>;
export type RuntimeToolDefinition = z.infer<typeof RuntimeToolDefinitionSchema>;
export type RuntimeToolCall = z.infer<typeof RuntimeToolCallSchema>;
export type RuntimeToolResult = z.infer<typeof RuntimeToolResultSchema>;
export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;
export type RuntimeWarning = z.infer<typeof RuntimeWarningSchema>;
export type RuntimeModelRef = z.infer<typeof RuntimeModelRefSchema>;
export type RuntimeSliceMetadata = z.infer<typeof RuntimeSliceMetadataSchema>;
export type RuntimeLimits = z.infer<typeof RuntimeLimitsSchema>;
export type ToolLoopLimitSource = z.infer<typeof ToolLoopLimitSourceSchema>;
export type ToolSafetyClassification = z.infer<typeof ToolSafetyClassificationSchema>;
export type RuntimeToolLoopLimits = z.infer<typeof RuntimeToolLoopLimitsSchema>;
export type RuntimeMemoryContext = z.infer<typeof RuntimeMemoryContextSchema>;
export type RuntimeTurnContext = z.infer<typeof RuntimeTurnContextSchema>;
export type RuntimeApprovedToolBatch = z.infer<typeof RuntimeApprovedToolBatchSchema>;
export type RuntimeContinuation = z.infer<typeof RuntimeContinuationSchema>;
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
export type RuntimeResult = z.infer<typeof RuntimeResultSchema>;
