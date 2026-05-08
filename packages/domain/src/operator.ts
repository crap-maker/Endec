import { z } from "zod";
import {
  AuthoritativeTurnTruthSchema,
  ContextAssemblyObservabilitySchema,
  RuntimeConstraintSurfaceSchema,
  RuntimeReplyPathSchema,
  TurnActionAuthorizationSchema
} from "./execution.ts";
import { WorkingSetCorrectionTargetSchema } from "./correction.ts";
import { PermissionDecisionSchema } from "./permission.ts";
import {
  AgentTaskStatusSchema,
  OutboundDeliveryStatusSchema,
  OutboundEventStatusSchema,
  RunBudgetLedgerSchema,
  RunContinuationKindSchema,
  RunControlInputSchema,
  RunAttentionModeSchema,
  RuntimeSliceSnapshotSchema,
  TaskEventSchema,
  TaskRunStatusSchema
} from "./background-task.ts";
import { TurnResultStatusSchema } from "./turn.ts";

export const OperatorActionHintKindSchema = z.enum([
  "inspect",
  "detail",
  "correct",
  "correction",
  "approve",
  "deny",
  "resume",
  "cancel",
  "retry",
  "escalate",
  "wait",
  "noop"
]);

export const OperatorRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export const OperatorExplanationSeveritySchema = z.enum(["info", "warning", "error"]);

export const OperatorActionHintSchema = z.object({
  code: z.string(),
  kind: OperatorActionHintKindSchema,
  summary: z.string(),
  detail: z.string().optional(),
  targetRef: z.string().optional(),
  relatedRefs: z.array(z.string()).optional(),
  riskLevel: OperatorRiskLevelSchema.optional(),
  requiresApproval: z.boolean().optional()
});

export const OperatorExplanationItemSchema = z.object({
  code: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  relatedRefs: z.array(z.string()).optional(),
  subjectRef: z.string().optional(),
  severity: OperatorExplanationSeveritySchema.optional()
});

export const OperatorContextSummarySchema = z.object({
  headline: z.string(),
  truthSummary: z.string(),
  continuitySummary: z.string(),
  durableMemorySummary: z.string(),
  truncationSummary: z.string(),
  driftDiagnosticsSummary: z.string(),
  budgetSummary: z.string().optional(),
  continuationSummary: z.string().optional(),
  correctionSummary: z.string().optional(),
  selectedBy: z.array(z.string()).optional()
});

export const OperatorCorrectionTargetKindSchema = z.enum(["working_set", "typed_memory"]);
export const OperatorCorrectionRecommendedOperationSchema = z.enum([
  "refresh_working_set",
  "rewrite_working_set",
  "mark_memory_stale",
  "mark_memory_superseded",
  "disable_memory",
  "restore_memory"
]);

export const OperatorCorrectionTargetHintSchema = z.object({
  targetId: z.string(),
  targetKind: OperatorCorrectionTargetKindSchema,
  summary: z.string(),
  reason: z.string(),
  status: z.string().optional(),
  detailRef: z.string().optional(),
  sourceRefs: z.array(z.string()).optional(),
  recommendedOperation: OperatorCorrectionRecommendedOperationSchema.optional()
});

export const OperatorContinuationStateSchema = z.enum([
  "idle",
  "normal",
  "continuation",
  "blocked",
  "recoverable",
  "awaiting_permission",
  "awaiting_user_decision",
  "ready"
]);

export const OperatorContinuationInspectionSchema = z.object({
  state: OperatorContinuationStateSchema,
  replyPath: RuntimeReplyPathSchema,
  allowedActions: z.array(OperatorActionHintSchema),
  blockedBy: z.string().optional(),
  waitingReason: z.string().optional(),
  pendingExecutionId: z.string().optional(),
  frameRef: z.string().optional(),
  checkpointRef: z.string().optional(),
  pendingDecision: PermissionDecisionSchema.optional(),
  constraints: z.array(RuntimeConstraintSurfaceSchema).optional(),
  actionAuthorization: TurnActionAuthorizationSchema.optional(),
  activeTaskSummary: z.string().optional(),
  workingSetSummary: z.string().optional(),
  correctionHints: z.array(OperatorCorrectionTargetHintSchema).optional()
});

export const OperatorExplanationSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  nextActions: z.array(OperatorActionHintSchema),
  explanations: z.array(OperatorExplanationItemSchema)
});

export const OperatorTurnInspectionTargetSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  actorId: z.string().optional(),
  turnId: z.string().optional(),
  frameRef: z.string().optional()
});

export const OperatorTurnInspectionSummaryStateSchema = z.enum(["normal", "continuation", "blocked", "recoverable"]);
export const OperatorTurnInspectionSummarySchema = z.object({
  state: OperatorTurnInspectionSummaryStateSchema,
  headline: z.string()
});

export const OperatorTurnInspectionDetailVerbositySchema = z.enum(["compact", "full"]);
export const OperatorTurnInspectionDetailSectionSchema = z.enum([
  "continuity",
  "durableMemory",
  "truncation",
  "driftDiagnostics",
  "budget",
  "continuation",
  "correction"
]);

export const InspectOperatorTurnRequestSchema = z.object({
  target: OperatorTurnInspectionTargetSchema,
  detail: z.object({
    verbosity: OperatorTurnInspectionDetailVerbositySchema.optional(),
    sections: z.array(OperatorTurnInspectionDetailSectionSchema).optional()
  }).optional()
});

export const OperatorTurnInspectionCorrectionSchema = z.object({
  available: z.boolean(),
  workingSetTarget: WorkingSetCorrectionTargetSchema.optional(),
  typedMemoryTargetCount: z.number().int().nonnegative(),
  recommendedTargets: z.array(OperatorCorrectionTargetHintSchema)
});

export const OperatorTurnInspectionSchema = z.object({
  target: OperatorTurnInspectionTargetSchema,
  summary: OperatorTurnInspectionSummarySchema,
  explanation: OperatorExplanationSchema,
  truth: AuthoritativeTurnTruthSchema,
  context: z.object({
    observability: ContextAssemblyObservabilitySchema,
    summary: OperatorContextSummarySchema
  }),
  continuation: OperatorContinuationInspectionSchema.optional(),
  correction: OperatorTurnInspectionCorrectionSchema
});

export const OperatorBackgroundTaskSummarySchema = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  status: AgentTaskStatusSchema,
  latestRunId: z.string().optional(),
  latestRunStatus: TaskRunStatusSchema.optional(),
  updatedAt: z.string()
});

export const OperatorBackgroundRunDetailSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  status: TaskRunStatusSchema,
  attentionMode: RunAttentionModeSchema.optional(),
  continuationKind: RunContinuationKindSchema.optional(),
  budgetLedger: RunBudgetLedgerSchema.optional(),
  latestSlice: RuntimeSliceSnapshotSchema.optional(),
  pendingControls: z.array(RunControlInputSchema).default([]),
  attemptNo: z.number().int().positive(),
  retryOfRunId: z.string().optional(),
  events: z.array(TaskEventSchema).default([])
});

export const OperatorBackgroundOutboundStateSchema = z.object({
  outboundEventId: z.string(),
  status: OutboundEventStatusSchema,
  deliveryStatuses: z.array(OutboundDeliveryStatusSchema).default([])
});

export const OperatorBackgroundCancellationResultSchema = z.object({
  taskId: z.string(),
  runId: z.string().optional(),
  taskStatus: AgentTaskStatusSchema.optional(),
  runStatus: TaskRunStatusSchema.optional(),
  result: z.enum(["canceled", "cancel_requested", "not_found", "already_terminal"])
});

export const OperatorStatusCacheStateSchema = z.enum(["available", "not_reported", "unavailable", "unknown"]);
export const OperatorStatusContextStateSchema = z.enum(["available", "estimated", "not_reported", "unavailable", "unknown"]);

export const OperatorStatusCacheSchema = z.object({
  state: OperatorStatusCacheStateSchema,
  readTokens: z.number().int().nonnegative().optional(),
  writeTokens: z.number().int().nonnegative().optional()
}).superRefine((value, context) => {
  if (value.state === "available" && value.readTokens === undefined && value.writeTokens === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "available cache status requires readTokens or writeTokens"
    });
  }
});

export const OperatorStatusContextSchema = z.object({
  state: OperatorStatusContextStateSchema,
  usedTokens: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional()
}).superRefine((value, context) => {
  if ((value.state === "available" || value.state === "estimated") && value.usedTokens === undefined && value.maxTokens === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.state} context status requires usedTokens or maxTokens`
    });
  }
});

export const OperatorStatusUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  estimatedCost: z.number().nonnegative().optional(),
  cache: OperatorStatusCacheSchema.optional(),
  context: OperatorStatusContextSchema.optional()
});

export const OperatorActiveRunStatusSchema = z.object({
  state: z.enum(["active", "none", "unknown"]),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  runStatus: TaskRunStatusSchema.optional(),
  attentionMode: RunAttentionModeSchema.optional(),
  latestSlice: RuntimeSliceSnapshotSchema.optional(),
  pendingControlCount: z.number().int().nonnegative().optional(),
  lastHumanInputAt: z.string().optional(),
  usage: OperatorStatusUsageSchema.optional()
}).superRefine((value, context) => {
  if (value.state === "active") {
    if (!value.taskId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "active run status requires taskId" });
    }
    if (!value.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "active run status requires runId" });
    }
    if (!value.runStatus) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "active run status requires runStatus" });
    }
  }
});

export const OperatorLastTurnStatusSchema = z.object({
  state: z.enum(["available", "none", "unknown"]),
  turnId: z.string().optional(),
  status: TurnResultStatusSchema.optional(),
  blockedBy: z.string().optional(),
  completedAt: z.string().optional(),
  usage: OperatorStatusUsageSchema.optional()
}).superRefine((value, context) => {
  if (value.state === "available") {
    if (!value.turnId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "available last-turn status requires turnId" });
    }
    if (!value.status) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "available last-turn status requires status" });
    }
  }
});

export type OperatorActionHintKind = z.infer<typeof OperatorActionHintKindSchema>;
export type OperatorRiskLevel = z.infer<typeof OperatorRiskLevelSchema>;
export type OperatorExplanationSeverity = z.infer<typeof OperatorExplanationSeveritySchema>;
export type OperatorActionHint = z.infer<typeof OperatorActionHintSchema>;
export type OperatorExplanationItem = z.infer<typeof OperatorExplanationItemSchema>;
export type OperatorContextSummary = z.infer<typeof OperatorContextSummarySchema>;
export type OperatorCorrectionTargetKind = z.infer<typeof OperatorCorrectionTargetKindSchema>;
export type OperatorCorrectionRecommendedOperation = z.infer<typeof OperatorCorrectionRecommendedOperationSchema>;
export type OperatorCorrectionTargetHint = z.infer<typeof OperatorCorrectionTargetHintSchema>;
export type OperatorContinuationState = z.infer<typeof OperatorContinuationStateSchema>;
export type OperatorContinuationInspection = z.infer<typeof OperatorContinuationInspectionSchema>;
export type OperatorExplanation = z.infer<typeof OperatorExplanationSchema>;
export type OperatorTurnInspectionTarget = z.infer<typeof OperatorTurnInspectionTargetSchema>;
export type OperatorTurnInspectionSummaryState = z.infer<typeof OperatorTurnInspectionSummaryStateSchema>;
export type OperatorTurnInspectionSummary = z.infer<typeof OperatorTurnInspectionSummarySchema>;
export type OperatorTurnInspectionDetailVerbosity = z.infer<typeof OperatorTurnInspectionDetailVerbositySchema>;
export type OperatorTurnInspectionDetailSection = z.infer<typeof OperatorTurnInspectionDetailSectionSchema>;
export type InspectOperatorTurnRequest = z.infer<typeof InspectOperatorTurnRequestSchema>;
export type InspectOperatorTurnRequestInput = z.input<typeof InspectOperatorTurnRequestSchema>;
export type OperatorTurnInspectionCorrection = z.infer<typeof OperatorTurnInspectionCorrectionSchema>;
export type OperatorTurnInspection = z.infer<typeof OperatorTurnInspectionSchema>;
export type OperatorBackgroundTaskSummary = z.infer<typeof OperatorBackgroundTaskSummarySchema>;
export type OperatorBackgroundRunDetail = z.infer<typeof OperatorBackgroundRunDetailSchema>;
export type OperatorBackgroundOutboundState = z.infer<typeof OperatorBackgroundOutboundStateSchema>;
export type OperatorBackgroundCancellationResult = z.infer<typeof OperatorBackgroundCancellationResultSchema>;
export type OperatorStatusCacheState = z.infer<typeof OperatorStatusCacheStateSchema>;
export type OperatorStatusContextState = z.infer<typeof OperatorStatusContextStateSchema>;
export type OperatorStatusCache = z.infer<typeof OperatorStatusCacheSchema>;
export type OperatorStatusContext = z.infer<typeof OperatorStatusContextSchema>;
export type OperatorStatusUsage = z.infer<typeof OperatorStatusUsageSchema>;
export type OperatorActiveRunStatus = z.infer<typeof OperatorActiveRunStatusSchema>;
export type OperatorLastTurnStatus = z.infer<typeof OperatorLastTurnStatusSchema>;
