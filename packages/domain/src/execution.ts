import { z } from "zod";
import { MEMORY_CONTEXT_TRUNCATED_CODE, TurnWarningDetailSchema } from "./diagnostics.ts";
import { ArtifactPreviewSchema, ArtifactRefSchema } from "./artifact.ts";
import {
  TypedMemoryCorrectionTargetSchema,
  WorkingSetCorrectionTargetSchema
} from "./correction.ts";
import { MemoryScopeSchema } from "./memory.ts";
import { ApprovalScopeSchema, PermissionDecisionSchema, type PermissionDecision } from "./permission.ts";
import { CurrentTurnTimeContextSchema } from "./time-context.ts";
import { DisclosureModeSchema, PersonaScopeKindSchema } from "./im-control.ts";
import { ModeSchema, SourceSchema, UsageSchema } from "./turn.ts";

export const EXECUTION_FRAME_CONTRACT_VERSION = "ws0.execution-frame.v1";
export const PENDING_EXECUTION_CONTRACT_VERSION = "ws0.pending-execution.v1";
export const TOOL_BATCH_CONTRACT_VERSION = "ws0.tool-batch.v1";
export const CONTEXT_ASSEMBLY_CONTRACT_VERSION = "ws0.context-assembly.v1";
export const EXECUTION_CONTROL_CONTRACT_VERSION = "ws0.execution-control.v1";
export const RUNTIME_SELF_AWARENESS_CONTRACT_VERSION = "ws5.runtime-self-awareness.v1";
export const AUTHORITATIVE_TURN_TRUTH_CONTRACT_VERSION = "ws6.authoritative-turn-truth.v1";

function createVersionedContractSchema<const TContractVersion extends string>(contractVersion: TContractVersion) {
  return z.object({
    schemaVersion: z.literal(1).default(1),
    contractVersion: z.literal(contractVersion).default(contractVersion)
  });
}

const TaskStatusForExecutionSchema = z.enum(["new", "planned", "active", "blocked", "waiting_input", "done", "failed", "cancelled"]);
const RuntimeContextBlockKindSchema = z.enum([
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
const RuntimeContextBlockSchema = z.object({
  blockId: z.string(),
  kind: RuntimeContextBlockKindSchema,
  title: z.string().optional(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative().optional(),
  sourceRefs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const RuntimeToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const RuntimeToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  arguments: z.unknown(),
  rationale: z.string().optional()
});
const RuntimeModelRefSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  modelTier: z.enum(["cheap", "strong"]).optional().describe("Legacy compatibility only; runtime selection must not branch on this field.")
});
const ToolLoopLimitSourceSchema = z.enum([
  "mode_default",
  "config_override",
  "global_hard_cap",
  "legacy_flat_limit",
  "runtime_request"
]);

const ToolSafetyClassificationSchema = z.enum([
  "unavailable"
]);

const RuntimeToolLoopLimitsSchema = z.object({
  configuredMaxToolCallsPerBatch: z.number().int().positive(),
  effectiveMaxToolCallsPerBatch: z.number().int().positive(),
  maxToolCallsPerBatchLimitSources: z.array(ToolLoopLimitSourceSchema),
  globalMaxToolCallsPerBatchHardCap: z.number().int().positive().default(8),

  maxToolBatchRepairAttempts: z.number().int().nonnegative().default(2),
  maxToolBatchRepairAttemptsHardCap: z.number().int().nonnegative().default(3),

  toolSafetyClassification: ToolSafetyClassificationSchema.default("unavailable"),
  toolSafetyCapApplied: z.boolean().default(false)
});

const RuntimeLimitsSchema = z.object({
  inputTokenBudget: z.number().int().positive(),
  outputTokenBudget: z.number().int().positive(),
  memoryInjectionBudget: z.number().int().nonnegative(),
  toolResultInjectionBudget: z.number().int().nonnegative(),
  maxLoopCount: z.number().int().positive(),
  maxToolCallsPerBatch: z.number().int().positive(),
  maxToolCallsPerTurn: z.number().int().positive(),
  toolLoop: RuntimeToolLoopLimitsSchema.optional()
});

export const PromptContractLayerKindSchema = z.enum([
  "system_prompt",
  "disclosure_overlay",
  "persona_overlay",
  "mode_overlay",
  "tool_use_contract_overlay",
  "recovery_overlay",
  "blocked_overlay",
  "continuation_overlay",
  "user_input"
]);

export const PromptContractLayerPlacementSchema = z.enum(["prepend", "before_user_input", "append"]);
export const PromptOverlayHookKindSchema = z.enum(["recovery", "blocked", "continuation"]);

export const PromptContractLayerSchema = z.object({
  layerId: z.string(),
  kind: PromptContractLayerKindSchema,
  title: z.string(),
  content: z.string(),
  placement: PromptContractLayerPlacementSchema,
  tokenCount: z.number().int().nonnegative(),
  optional: z.boolean().default(false),
  applied: z.boolean().default(true)
});

export const PromptOverlayHookSchema = z.object({
  kind: PromptOverlayHookKindSchema,
  available: z.literal(true),
  applied: z.boolean(),
  layerId: z.string().optional(),
  reason: z.string().optional()
});

export const PromptContractSchema = z.object({
  version: z.literal("ws1"),
  assemblyOrder: z.array(PromptContractLayerKindSchema),
  layers: z.array(PromptContractLayerSchema),
  userInputPlacement: z.object({
    kind: z.literal("dedicated_block"),
    position: z.literal("last")
  }),
  overlayHooks: z.object({
    recovery: PromptOverlayHookSchema,
    blocked: PromptOverlayHookSchema,
    continuation: PromptOverlayHookSchema
  })
});

export const ContextAssemblyBudgetSchema = z.object({
  inputTokenBudget: z.number().int().positive(),
  projectedInputTokens: z.number().int().nonnegative(),
  historyBudget: z.number().int().nonnegative(),
  historyTokensUsed: z.number().int().nonnegative(),
  historyTruncated: z.boolean(),
  memoryInjectionBudget: z.number().int().nonnegative(),
  memoryTokensUsed: z.number().int().nonnegative(),
  memoryTruncated: z.boolean(),
  toolResultInjectionBudget: z.number().int().nonnegative(),
  toolResultTokensUsed: z.number().int().nonnegative()
});

export const ContextAssemblySelectionSchema = z.object({
  recentHistoryTurnIds: z.array(z.string()),
  memorySourceRefs: z.array(z.string()),
  activeTaskId: z.string().optional(),
  evidenceIds: z.array(z.string()),
  projectionRefs: z.array(z.string()).default([]),
  typedMemoryScopes: z.array(MemoryScopeSchema).default([]),
  exposedToolNames: z.array(z.string())
});

export const ExecutionRetrievalStrategySchema = z.enum(["ordinary", "continuation", "active_task_preferred"]);
export const ActiveTaskSelectionModeSchema = z.enum(["none", "request_task", "latest_active_task"]);
export const ActiveTaskSelectionSourceSchema = z.enum(["request_task", "latest_active_task"]);

export const ExecutionActiveTaskSelectionSchema = z.object({
  mode: ActiveTaskSelectionModeSchema,
  taskId: z.string().optional()
});

export const RecentHistorySurfaceSchema = z.object({
  summary: z.string(),
  refs: z.array(z.string()),
  turnRefs: z.array(z.string()),
  carryForwardKinds: z.array(z.string()).optional()
});

export const WorkingSetSurfaceSchema = z.object({
  ref: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  summary: z.string().describe("Projection/render of the structured working set, not the sole canonical truth."),
  objective: z.string().optional(),
  recentProgress: z.array(z.string()).default([]),
  recentDecisions: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  openLoops: z.array(z.string()).default([]),
  activeMemoryRefs: z.array(z.string()).default([]),
  activeTaskRefs: z.array(z.string()).default([]),
  recentEventRefs: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([])
});

export const ActiveTaskSnapshotSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  status: TaskStatusForExecutionSchema,
  checkpointRef: z.string(),
  currentStep: z.string().optional(),
  nextAction: z.string().optional(),
  blockingReason: z.string().optional(),
  updatedAt: z.string(),
  selectedBy: ActiveTaskSelectionSourceSchema.optional()
});

export const TypedMemorySurfaceItemSchema = z.object({
  kind: z.string(),
  status: z.string(),
  scope: MemoryScopeSchema.optional(),
  memoryType: z.string().optional(),
  sourceRefs: z.array(z.string()).default([]),
  payload: z.unknown().optional()
});

export const EvidenceSurfaceItemSchema = z.object({
  ref: z.string().optional(),
  topic: z.string().optional(),
  content: z.string().optional(),
  sourceRefs: z.array(z.string()).default([])
});

export const ProjectionDerivedRefSurfaceItemSchema = z.object({
  ref: z.string().describe("Projection-derived locator/ref only; not canonical evidence truth."),
  day: z.string(),
  section: z.string(),
  summary: z.string(),
  sourceRefs: z.array(z.string()).default([]).describe("Canonical source refs that back this locator."),
  turnRefs: z.array(z.string()).default([]).describe("Turn refs that anchor the locator back to canonical truth.")
});

export const TypedMemoryBiasFamilySchema = z.enum(["fact", "preference", "procedural", "continuity"]);

export const TypedMemoryRouteBiasSchema = z.object({
  preferredFamilies: z.array(TypedMemoryBiasFamilySchema),
  preferredBuckets: z.array(z.string()).default([]),
  preferredScopes: z.array(MemoryScopeSchema).default([]),
  preferSelectedTask: z.boolean().default(false)
}).describe("Route/bias only; the memory layer owns family selection and ranking.");

export const ExecutionRetrievalPolicySchema = z.object({
  strategy: ExecutionRetrievalStrategySchema,
  reason: z.string().optional(),
  activeTaskSelection: ExecutionActiveTaskSelectionSchema,
  includeWorkingSet: z.boolean(),
  includeRecentHistory: z.boolean(),
  includeActiveTask: z.boolean(),
  includeTypedMemory: z.boolean(),
  includeEvidence: z.boolean(),
  typedMemoryBias: TypedMemoryRouteBiasSchema.optional()
});

export const MemoryContinuitySurfaceSchema = z.object({
  retrievalPolicy: ExecutionRetrievalPolicySchema.describe("Route/bias only; does not encode ranking or selection algorithms."),
  recentHistory: RecentHistorySurfaceSchema,
  workingSet: WorkingSetSurfaceSchema,
  activeTask: ActiveTaskSnapshotSchema.optional(),
  typedMemory: z.array(TypedMemorySurfaceItemSchema),
  evidence: z.array(EvidenceSurfaceItemSchema),
  projectionDerivedRefs: z.array(ProjectionDerivedRefSurfaceItemSchema).default([])
});

export const DurableMemorySelectionStatusSchema = z.enum(["selected", "not-chosen", "scope-mismatch", "corrected-out"]);
export const DurableMemoryInjectionStatusSchema = z.enum(["injected", "partial", "budget-dropped", "not-applicable"]);
export const DurableMemorySelectionItemSchema = z.object({
  memoryId: z.string().optional(),
  writeId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  scope: MemoryScopeSchema.optional(),
  memoryType: z.string(),
  family: z.string(),
  bucket: z.string(),
  route: ExecutionRetrievalStrategySchema,
  rank: z.number().int().positive().optional(),
  taskMatch: z.boolean().default(false),
  selectionStatus: DurableMemorySelectionStatusSchema,
  injectionStatus: DurableMemoryInjectionStatusSchema.default("not-applicable"),
  reasons: z.array(z.string()).default([]),
  summary: z.string().optional(),
  correctionTarget: TypedMemoryCorrectionTargetSchema.optional()
});
export const DurableMemoryObservabilitySchema = z.object({
  route: ExecutionRetrievalStrategySchema,
  preferredScopes: z.array(MemoryScopeSchema).default([]),
  preferredFamilies: z.array(TypedMemoryBiasFamilySchema).default([]),
  preferredBuckets: z.array(z.string()).default([]),
  items: z.array(DurableMemorySelectionItemSchema).default([]),
  summary: z.string().optional()
});
export const RuntimeMemoryObservabilitySchema = z.object({
  durableMemory: DurableMemoryObservabilitySchema.optional()
});

const RuntimeMemoryContextSchema = z.object({
  workingSetSummary: z.string().describe("Legacy compatibility summary. New consumers should prefer continuity.workingSet."),
  retrievedItems: z.array(z.unknown()).describe("Legacy compatibility retrieval surface; retained to avoid breaking older consumers."),
  injectionPlan: z.array(z.unknown()).describe("Legacy compatibility injection surface; retained while newer consumers read continuity/contextBlocks."),
  tokenEstimate: z.number().int().nonnegative(),
  sourceRefs: z.array(z.string()),
  continuity: MemoryContinuitySurfaceSchema.optional().describe("Structured retrieval continuity surface for canonical working-set / typed-memory / evidence truth plus projection locators."),
  contextBlocks: z.array(RuntimeContextBlockSchema).optional(),
  observability: RuntimeMemoryObservabilitySchema.optional()
});

export const ContinuityBlockSelectionStatusSchema = z.enum(["selected", "not-selected", "missing"]);
export const ContinuityBlockInjectionStatusSchema = z.enum(["full", "skeleton", "partial", "dropped", "not-requested"]);
export const ContinuityBlockObservabilitySchema = z.object({
  blockId: z.string().optional(),
  title: z.string().optional(),
  selectionStatus: ContinuityBlockSelectionStatusSchema,
  injectionStatus: ContinuityBlockInjectionStatusSchema,
  reason: z.string().optional(),
  sourceRefs: z.array(z.string()).default([]),
  carryForwardKinds: z.array(z.string()).default([]),
  selectedBy: ActiveTaskSelectionSourceSchema.optional(),
  correctionTarget: WorkingSetCorrectionTargetSchema.optional()
});
export const ContextAssemblyTruthObservabilitySchema = z.object({
  packet: z.lazy(() => AuthoritativeTurnTruthSchema),
  summary: z.object({
    replyPath: z.lazy(() => RuntimeReplyPathSchema),
    guaranteedToolNames: z.array(z.string()).default([]),
    approvalRequiredCapabilities: z.array(z.string()).default([]),
    notGuaranteedCapabilities: z.array(z.string()).default([]),
    actionAuthorizations: z.array(z.lazy(() => TurnActionAuthorizationSchema)).default([]),
    antiDriftRules: z.array(z.string()).default([])
  }),
  consistency: z.object({
    exposedToolsMatchSelection: z.boolean(),
    replyPathMatchesSelfAwareness: z.boolean(),
    constraintCodesMatch: z.boolean()
  })
});
export const ContextAssemblyContinuityObservabilitySchema = z.object({
  route: ExecutionRetrievalStrategySchema,
  blocks: z.object({
    activeTask: ContinuityBlockObservabilitySchema,
    workingSet: ContinuityBlockObservabilitySchema,
    recentHistory: ContinuityBlockObservabilitySchema
  })
});
export const ContextAssemblyTruncationItemSchema = z.object({
  blockId: z.string(),
  title: z.string().optional(),
  layer: z.enum(["authoritative_truth", "time_context", "continuity_core", "durable_memory", "evidence", "supplement"]),
  outcome: z.enum(["full", "skeleton", "partial", "dropped"]),
  reason: z.string()
});
export const ContextAssemblyTruncationObservabilitySchema = z.object({
  memoryInjectionBudget: z.number().int().nonnegative(),
  memoryTokensUsed: z.number().int().nonnegative(),
  memoryTruncated: z.boolean(),
  items: z.array(ContextAssemblyTruncationItemSchema).default([])
});
export const BudgetProfileSchema = z.enum(["conservative", "balanced", "high-memory"]);
export const BudgetProfileSourceSchema = z.enum(["profile_default", "deployment_override", "user_override"]);
export const BudgetFieldSourceSchema = z.enum([
  "historical_fallback",
  "profile_default",
  "provider_model_override",
  "mode_override",
  "profile_override",
  "deployment_override",
  "user_override"
]);
export const MaxContextTokensSourceSchema = z.enum(["provider_capability", "provider_model_override", "deployment_override", "unknown"]);
export const BudgetUnestimatedComponentSchema = z.enum(["outputReserveTokens", "toolSchemaTokenEstimate", "safetyReserveTokens"]);
export const BudgetCapHitSchema = z.enum(["input_min", "input_max", "input_usable_context", "memory_min", "memory_max", "memory_share_of_input"]);
export const BudgetCapReasonSchema = z.enum([
  "usable_context_cap",
  "small_model_context_cap",
  "memory_share_of_input",
  "input_max",
  "memory_max"
]);
export const BudgetFallbackReasonSchema = z.enum([
  "model_context_unknown",
  "usable_context_cap",
  "small_model_context_cap"
]);
export const BudgetOverrideAppliedSchema = z.object({
  source: z.string(),
  field: z.string(),
  value: z.union([z.number(), z.string(), z.boolean()])
});
export const BudgetResolutionDebugSchema = z.object({
  mode: ModeSchema,
  budgetProfile: BudgetProfileSchema,
  budgetProfileSource: BudgetProfileSourceSchema,
  inputBudgetSource: BudgetFieldSourceSchema,
  memoryBudgetSource: BudgetFieldSourceSchema,
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  protocolFamily: z.string().optional(),
  maxContextTokens: z.number().int().positive().optional(),
  maxContextTokensSource: MaxContextTokensSourceSchema,
  usableContext: z.number().int().nonnegative().optional(),
  outputReserveTokens: z.number().int().nonnegative().optional(),
  toolSchemaTokenEstimate: z.number().int().nonnegative().optional(),
  safetyReserveTokens: z.number().int().nonnegative().optional(),
  unestimatedComponents: z.array(BudgetUnestimatedComponentSchema).default([]),
  effectiveInputTokenBudget: z.number().int().nonnegative(),
  effectiveMemoryInjectionBudget: z.number().int().nonnegative(),
  maxMemoryShareOfInput: z.number().nonnegative(),
  capHits: z.array(BudgetCapHitSchema).default([]),
  capReasons: z.array(BudgetCapReasonSchema).default([]),
  fallbackReason: BudgetFallbackReasonSchema.optional(),
  overridesApplied: z.array(BudgetOverrideAppliedSchema).default([])
});
export const PromptBlockObservabilityLayerSchema = z.enum([
  "authoritative_truth",
  "time_context",
  "continuity_core",
  "durable_memory",
  "evidence",
  "supplement",
  "tool_schema",
  "tool_result",
  "user_input",
  "system_instruction"
]);
export const PromptBlockObservabilityStatusSchema = z.enum(["included", "partial", "dropped"]);
export const PromptBlockObservabilitySchema = z.object({
  blockId: z.string(),
  kind: z.string(),
  layer: PromptBlockObservabilityLayerSchema,
  title: z.string().optional(),
  estimatedTokens: z.number().int().nonnegative(),
  status: PromptBlockObservabilityStatusSchema,
  reason: z.string().optional()
});
export const ToolSchemaAccountingSchema = z.object({
  status: z.enum(["estimated", "unestimated"]),
  totalTokens: z.number().int().nonnegative().optional(),
  perTool: z.array(z.object({
    toolName: z.string(),
    estimatedTokens: z.number().int().nonnegative()
  })).default([])
});
export const ContextBudgetObservabilitySchema = z.object({
  budgetResolution: BudgetResolutionDebugSchema,
  selectedMemoryCount: z.number().int().nonnegative(),
  injectedMemoryCount: z.number().int().nonnegative(),
  droppedMemoryCount: z.number().int().nonnegative(),
  selectedMemorySourceRefs: z.array(z.string()).default([]),
  injectedMemorySourceRefs: z.array(z.string()).default([]),
  droppedMemorySourceRefs: z.array(z.string()).default([]),
  promptBlocks: z.array(PromptBlockObservabilitySchema).default([]),
  projectedInputTokensBeforeFitting: z.number().int().nonnegative().optional(),
  projectedInputTokensAfterFitting: z.number().int().nonnegative(),
  projectedMemoryTokensBeforeFitting: z.number().int().nonnegative().optional(),
  projectedMemoryTokensAfterFitting: z.number().int().nonnegative(),
  remainingHeadroomEstimate: z.number().int().nonnegative().optional(),
  toolSchemaAccounting: ToolSchemaAccountingSchema
});
export const DriftDiagnosticSeveritySchema = z.enum(["info", "warning"]);
export const DriftDiagnosticSchema = z.object({
  code: z.string(),
  severity: DriftDiagnosticSeveritySchema,
  message: z.string(),
  evidence: z.record(z.string(), z.unknown()).default({})
});
export const ContextAssemblyObservabilitySchema = z.object({
  authoritativeTruth: ContextAssemblyTruthObservabilitySchema,
  continuity: ContextAssemblyContinuityObservabilitySchema,
  durableMemory: DurableMemoryObservabilitySchema,
  truncation: ContextAssemblyTruncationObservabilitySchema,
  driftDiagnostics: z.object({
    issues: z.array(DriftDiagnosticSchema).default([])
  }),
  diagnostics: z.array(TurnWarningDetailSchema).default([]),
  imBoundary: z.object({
    disclosureMode: DisclosureModeSchema,
    borrowedConversationKeys: z.array(z.string()).default([]),
    personaScopeKind: PersonaScopeKindSchema.optional()
  }).optional(),
  contextBudget: ContextBudgetObservabilitySchema.optional(),
  humanSummary: z.string().optional()
});

const RuntimeTurnContextSchema = z.object({
  memory: RuntimeMemoryContextSchema,
  selfAwareness: z.lazy(() => RuntimeSelfAwarenessSurfaceSchema).optional(),
  authoritativeTruth: z.lazy(() => AuthoritativeTurnTruthSchema).optional(),
  timeContext: CurrentTurnTimeContextSchema.optional(),
  observability: ContextAssemblyObservabilitySchema.optional()
});

export const BashTurnTrustSchema = z.object({
  toolName: z.literal("bash").default("bash"),
  scope: z.literal("turn"),
  decisionId: z.string(),
  approverId: z.string().optional()
});

export const ToolBatchPermissionContextSchema = z.object({
  approvedDecisionIds: z.array(z.string()).default([]),
  approverId: z.string().optional(),
  bashTrust: BashTurnTrustSchema.optional()
});

const RuntimeApprovedToolBatchSchema = ToolBatchPermissionContextSchema.extend({
  requestedToolCalls: z.array(RuntimeToolCallSchema).default([]),
  priorLoopCount: z.number().int().nonnegative().default(0),
  priorToolCallCount: z.number().int().nonnegative().default(0)
});

const RuntimeContinuationSchema = z.object({
  approvedToolBatch: RuntimeApprovedToolBatchSchema.optional()
});

const RuntimeRequestSchema = z.object({
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
  limits: RuntimeLimitsSchema
});

export const RuntimeReplyPathSchema = z.enum(["normal", "continuation", "blocked"]);
export const RuntimeConstraintSurfaceSchema = z.object({
  code: z.string(),
  summary: z.string(),
  blocking: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export const TurnActionAuthorizationLevelSchema = z.enum(["guaranteed", "approval-required", "blocked", "not-guaranteed"]);
export const TurnActionAuthorizationSchema = z.object({
  actionClass: z.string(),
  toolName: z.string().optional(),
  authorizationLevel: TurnActionAuthorizationLevelSchema,
  boundaryReason: z.string(),
  approvalPath: z.string().optional(),
  examples: z.array(z.string()).default([])
});
export const CapabilityTruthSchema = z.object({
  visibleToolNames: z.array(z.string()).default([]),
  guaranteedToolNames: z.array(z.string()).default([]),
  guaranteedCapabilities: z.array(z.string()).default([]),
  approvalRequiredCapabilities: z.array(z.string()).default([]),
  notGuaranteedCapabilities: z.array(z.string()).default([]),
  actionAuthorizations: z.array(TurnActionAuthorizationSchema).default([])
});
export const TurnBoundarySurfaceSchema = z.object({
  workspace: z.object({
    root: z.string(),
    kind: z.enum(["isolated_worktree", "workspace_root", "session_workspace", "unknown"]),
    summary: z.string()
  })
});
export const AuthoritativeTurnTruthSchema = createVersionedContractSchema(AUTHORITATIVE_TURN_TRUTH_CONTRACT_VERSION).extend({
  source: SourceSchema,
  channel: SourceSchema,
  mode: ModeSchema,
  replyPath: RuntimeReplyPathSchema,
  boundary: TurnBoundarySurfaceSchema,
  capabilityTruth: CapabilityTruthSchema,
  constraints: z.array(RuntimeConstraintSurfaceSchema).default([]),
  antiDriftRules: z.array(z.string()).default([])
});

export const RuntimeSelfAwarenessSurfaceSchema = createVersionedContractSchema(RUNTIME_SELF_AWARENESS_CONTRACT_VERSION).extend({
  source: SourceSchema,
  channel: SourceSchema,
  mode: ModeSchema,
  currentModel: RuntimeModelRefSchema.optional().describe("Fresh runtime self-awareness writes include the current model; legacy persisted snapshots may omit it."),
  exposedToolNames: z.array(z.string()).default([]),
  replyPath: RuntimeReplyPathSchema,
  constraints: z.array(RuntimeConstraintSurfaceSchema).default([])
});

export const ExecutionActionSchema = z.enum(["approve", "deny", "resume", "cancel"]);
export const ExecutionPhaseSchema = z.enum([
  "bootstrap",
  "runtime",
  "tool_batch",
  "awaiting_permission",
  "awaiting_operator",
  "completed"
]);

export const ExecutionContinuationSchema = z.object({
  continuationKind: z.enum(["none", "awaiting_operator", "resume"]),
  allowedActions: z.array(ExecutionActionSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const ExecutionFrameSchema = createVersionedContractSchema(EXECUTION_FRAME_CONTRACT_VERSION).extend({
  frameRef: z.string(),
  checkpointRef: z.string().optional(),
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  phase: ExecutionPhaseSchema,
  step: z.string().min(1),
  pendingToolCalls: z.array(RuntimeToolCallSchema).default([]),
  pendingPermissionDecisions: z.array(PermissionDecisionSchema).default([]),
  loopCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  usage: UsageSchema,
  continuation: ExecutionContinuationSchema,
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const PendingExecutionStatusSchema = z.enum(["inflight", "blocked", "ready"]);

export const PendingExecutionSchema = createVersionedContractSchema(PENDING_EXECUTION_CONTRACT_VERSION).extend({
  pendingExecutionId: z.string(),
  frameRef: z.string(),
  checkpointRef: z.string().optional(),
  status: PendingExecutionStatusSchema,
  frame: ExecutionFrameSchema,
  runtimeSelfAwareness: RuntimeSelfAwarenessSurfaceSchema.optional(),
  authoritativeTruth: AuthoritativeTurnTruthSchema.optional(),
  observability: ContextAssemblyObservabilitySchema.optional(),
  sessionStateRef: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const NormalizedToolResultPayloadSchema = z.object({
  contentType: z.enum(["text", "json", "empty"]),
  value: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const ToolExecutionStateSchema = z.enum(["allow", "deny", "ask", "executed", "error", "spilled"]);

export const ToolExecutionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.unknown().optional()
});

export const ToolExecutionResultSchema = z.object({
  resultId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  state: ToolExecutionStateSchema,
  permissionDecision: PermissionDecisionSchema.optional(),
  normalizedPayload: NormalizedToolResultPayloadSchema.optional(),
  artifactRef: ArtifactRefSchema.optional(),
  preview: ArtifactPreviewSchema.optional(),
  error: ToolExecutionErrorSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const ToolBatchResultSchema = createVersionedContractSchema(TOOL_BATCH_CONTRACT_VERSION).extend({
  batchId: z.string(),
  turnId: z.string(),
  requestedToolCalls: z.array(RuntimeToolCallSchema),
  permissionDecisions: z.array(PermissionDecisionSchema),
  executionResults: z.array(ToolExecutionResultSchema)
});

export const ContextAssemblyBudgetingSchema = z.object({
  inputTokenBudget: z.number().int().positive(),
  outputTokenBudget: z.number().int().positive(),
  memoryInjectionBudget: z.number().int().nonnegative(),
  toolResultInjectionBudget: z.number().int().nonnegative()
});

export const ContextToolExposureSchema = z.object({
  exposureSource: z.enum(["preset", "policy", "lazy"]),
  exposedTools: z.array(RuntimeToolDefinitionSchema),
  hiddenToolNames: z.array(z.string()).default([])
});

export const ContextAssemblyResultSchema = createVersionedContractSchema(CONTEXT_ASSEMBLY_CONTRACT_VERSION).extend({
  assemblyId: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  resolvedMode: ModeSchema,
  runtimeContextBlocks: z.array(RuntimeContextBlockSchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
  budgeting: ContextAssemblyBudgetingSchema,
  toolExposure: ContextToolExposureSchema,
  promptContract: PromptContractSchema,
  runtimeRequest: RuntimeRequestSchema,
  budget: ContextAssemblyBudgetSchema,
  selection: ContextAssemblySelectionSchema,
  observability: ContextAssemblyObservabilitySchema.optional(),
  warnings: z.array(z.string()).default([])
});

const ExecutionTargetSchema = createVersionedContractSchema(EXECUTION_CONTROL_CONTRACT_VERSION).extend({
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  turnId: z.string().optional(),
  frameRef: z.string().optional()
});

export const ResumeExecutionInputSchema = ExecutionTargetSchema.extend({
  action: z.literal("resume"),
  input: z.string().optional()
});

export const ApprovalResolutionInputSchema = ExecutionTargetSchema.extend({
  action: z.enum(["approve", "deny"]),
  decisionId: z.string(),
  scope: ApprovalScopeSchema.optional(),
  approverId: z.string().optional()
});

export const CancelExecutionInputSchema = ExecutionTargetSchema.extend({
  action: z.literal("cancel"),
  reason: z.string().optional()
});

export const ExecutionControlInputSchema = z.discriminatedUnion("action", [
  ResumeExecutionInputSchema,
  ApprovalResolutionInputSchema,
  CancelExecutionInputSchema
]);

export type PromptContractLayerKind = z.infer<typeof PromptContractLayerKindSchema>;
export type PromptContractLayerPlacement = z.infer<typeof PromptContractLayerPlacementSchema>;
export type PromptOverlayHookKind = z.infer<typeof PromptOverlayHookKindSchema>;
export type PromptContractLayer = z.infer<typeof PromptContractLayerSchema>;
export type PromptOverlayHook = z.infer<typeof PromptOverlayHookSchema>;
export type PromptContract = z.infer<typeof PromptContractSchema>;
export type ContextAssemblyBudget = z.infer<typeof ContextAssemblyBudgetSchema>;
export type ContextAssemblySelection = z.infer<typeof ContextAssemblySelectionSchema>;
export type ExecutionRetrievalStrategy = z.infer<typeof ExecutionRetrievalStrategySchema>;
export type ActiveTaskSelectionMode = z.infer<typeof ActiveTaskSelectionModeSchema>;
export type ActiveTaskSelectionSource = z.infer<typeof ActiveTaskSelectionSourceSchema>;
export type ExecutionActiveTaskSelection = z.infer<typeof ExecutionActiveTaskSelectionSchema>;
export type RecentHistorySurface = z.infer<typeof RecentHistorySurfaceSchema>;
export type WorkingSetSurface = z.infer<typeof WorkingSetSurfaceSchema>;
export type ActiveTaskSnapshot = z.infer<typeof ActiveTaskSnapshotSchema>;
export type TypedMemorySurfaceItem = z.infer<typeof TypedMemorySurfaceItemSchema>;
export type EvidenceSurfaceItem = z.infer<typeof EvidenceSurfaceItemSchema>;
export type ProjectionDerivedRefSurfaceItem = z.infer<typeof ProjectionDerivedRefSurfaceItemSchema>;
export type ExecutionRetrievalPolicy = z.infer<typeof ExecutionRetrievalPolicySchema>;
export type MemoryContinuitySurface = z.infer<typeof MemoryContinuitySurfaceSchema>;
export type DurableMemorySelectionStatus = z.infer<typeof DurableMemorySelectionStatusSchema>;
export type DurableMemoryInjectionStatus = z.infer<typeof DurableMemoryInjectionStatusSchema>;
export type DurableMemorySelectionItem = z.infer<typeof DurableMemorySelectionItemSchema>;
export type DurableMemoryObservability = z.infer<typeof DurableMemoryObservabilitySchema>;
export type RuntimeMemoryObservability = z.infer<typeof RuntimeMemoryObservabilitySchema>;
export type RuntimeReplyPath = z.infer<typeof RuntimeReplyPathSchema>;
export type RuntimeConstraintSurface = z.infer<typeof RuntimeConstraintSurfaceSchema>;
export type TurnActionAuthorizationLevel = z.infer<typeof TurnActionAuthorizationLevelSchema>;
export type TurnActionAuthorization = z.infer<typeof TurnActionAuthorizationSchema>;
export type CapabilityTruth = z.infer<typeof CapabilityTruthSchema>;
export type TurnBoundarySurface = z.infer<typeof TurnBoundarySurfaceSchema>;
export type AuthoritativeTurnTruth = z.infer<typeof AuthoritativeTurnTruthSchema>;
export type ContinuityBlockSelectionStatus = z.infer<typeof ContinuityBlockSelectionStatusSchema>;
export type ContinuityBlockInjectionStatus = z.infer<typeof ContinuityBlockInjectionStatusSchema>;
export type ContinuityBlockObservability = z.infer<typeof ContinuityBlockObservabilitySchema>;
export type ContextAssemblyTruthObservability = z.infer<typeof ContextAssemblyTruthObservabilitySchema>;
export type ContextAssemblyContinuityObservability = z.infer<typeof ContextAssemblyContinuityObservabilitySchema>;
export type ContextAssemblyTruncationItem = z.infer<typeof ContextAssemblyTruncationItemSchema>;
export type ContextAssemblyTruncationObservability = z.infer<typeof ContextAssemblyTruncationObservabilitySchema>;
export type BudgetProfile = z.infer<typeof BudgetProfileSchema>;
export type BudgetProfileSource = z.infer<typeof BudgetProfileSourceSchema>;
export type BudgetFieldSource = z.infer<typeof BudgetFieldSourceSchema>;
export type MaxContextTokensSource = z.infer<typeof MaxContextTokensSourceSchema>;
export type BudgetUnestimatedComponent = z.infer<typeof BudgetUnestimatedComponentSchema>;
export type BudgetCapHit = z.infer<typeof BudgetCapHitSchema>;
export type BudgetCapReason = z.infer<typeof BudgetCapReasonSchema>;
export type BudgetOverrideApplied = z.infer<typeof BudgetOverrideAppliedSchema>;
export type BudgetResolutionDebug = z.infer<typeof BudgetResolutionDebugSchema>;
export type PromptBlockObservabilityLayer = z.infer<typeof PromptBlockObservabilityLayerSchema>;
export type PromptBlockObservabilityStatus = z.infer<typeof PromptBlockObservabilityStatusSchema>;
export type PromptBlockObservability = z.infer<typeof PromptBlockObservabilitySchema>;
export type ToolSchemaAccounting = z.infer<typeof ToolSchemaAccountingSchema>;
export type ContextBudgetObservability = z.infer<typeof ContextBudgetObservabilitySchema>;
export type DriftDiagnosticSeverity = z.infer<typeof DriftDiagnosticSeveritySchema>;
export type DriftDiagnostic = z.infer<typeof DriftDiagnosticSchema>;
export type ContextAssemblyObservability = z.infer<typeof ContextAssemblyObservabilitySchema>;
export type RuntimeSelfAwarenessSurface = z.infer<typeof RuntimeSelfAwarenessSurfaceSchema>;
export type ExecutionAction = z.infer<typeof ExecutionActionSchema>;
export type ExecutionPhase = z.infer<typeof ExecutionPhaseSchema>;
export type ExecutionContinuation = z.infer<typeof ExecutionContinuationSchema>;
export type ExecutionFrame = z.infer<typeof ExecutionFrameSchema>;
export type PendingExecutionStatus = z.infer<typeof PendingExecutionStatusSchema>;
export type PendingExecution = z.infer<typeof PendingExecutionSchema>;
export type NormalizedToolResultPayload = z.infer<typeof NormalizedToolResultPayloadSchema>;
export type ToolExecutionState = z.infer<typeof ToolExecutionStateSchema>;
export type ToolExecutionError = z.infer<typeof ToolExecutionErrorSchema>;
export type ToolExecutionResult = z.infer<typeof ToolExecutionResultSchema>;
export type BashTurnTrust = z.infer<typeof BashTurnTrustSchema>;
export type ToolBatchPermissionContext = z.infer<typeof ToolBatchPermissionContextSchema>;
export type ToolBatchResult = z.infer<typeof ToolBatchResultSchema>;
export type ContextAssemblyBudgeting = z.infer<typeof ContextAssemblyBudgetingSchema>;
export type ContextToolExposure = z.infer<typeof ContextToolExposureSchema>;
export type ContextAssemblyResult = z.infer<typeof ContextAssemblyResultSchema>;
export type ResumeExecutionInput = z.infer<typeof ResumeExecutionInputSchema>;
export type ApprovalResolutionInput = z.infer<typeof ApprovalResolutionInputSchema>;
export type CancelExecutionInput = z.infer<typeof CancelExecutionInputSchema>;
export type ExecutionControlInput = z.infer<typeof ExecutionControlInputSchema>;

export function resolvePendingPermissionDecision(input: {
  permissionDecisions: PermissionDecision[];
  pendingApprovalRef?: string;
}): PermissionDecision | undefined {
  if (input.pendingApprovalRef) {
    const matchedDecision = input.permissionDecisions.find((decision) => decision.decisionId === input.pendingApprovalRef);
    if (matchedDecision) {
      return matchedDecision;
    }
  }

  return input.permissionDecisions.find((decision) => decision.behavior === "ask");
}

export function projectPendingToolBatch(input: {
  requestedToolCalls: z.infer<typeof RuntimeToolCallSchema>[];
  permissionDecisions: PermissionDecision[];
  pendingApprovalRef?: string;
}) {
  const pendingDecision = resolvePendingPermissionDecision({
    permissionDecisions: input.permissionDecisions,
    pendingApprovalRef: input.pendingApprovalRef
  });

  if (!pendingDecision) {
    return {
      pendingDecision: undefined,
      pendingToolCalls: input.requestedToolCalls,
      pendingPermissionDecisions: input.permissionDecisions
    };
  }

  const pendingToolCallIndex = input.requestedToolCalls.findIndex((toolCall) => toolCall.toolCallId === pendingDecision.decisionId);
  if (pendingToolCallIndex < 0) {
    return {
      pendingDecision,
      pendingToolCalls: input.requestedToolCalls,
      pendingPermissionDecisions: input.permissionDecisions
    };
  }

  const pendingToolCalls = input.requestedToolCalls.slice(pendingToolCallIndex);
  const pendingToolCallIds = new Set(pendingToolCalls.map((toolCall) => toolCall.toolCallId));

  return {
    pendingDecision,
    pendingToolCalls,
    pendingPermissionDecisions: input.permissionDecisions.filter((decision) => pendingToolCallIds.has(decision.decisionId))
  };
}
