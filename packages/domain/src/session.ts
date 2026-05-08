import { z } from "zod";
import {
  AuthoritativeTurnTruthSchema,
  ContextAssemblyObservabilitySchema,
  ExecutionActionSchema,
  PendingExecutionSchema,
  RUNTIME_SELF_AWARENESS_CONTRACT_VERSION,
  RuntimeSelfAwarenessSurfaceSchema
} from "./execution.ts";
import { PermissionDecisionSchema } from "./permission.ts";
import { ModeSchema, SourceSchema } from "./turn.ts";

export const OPERATOR_RECOVERY_SNAPSHOT_CONTRACT_VERSION = "ws5.operator-recovery-snapshot.v1";

export const SessionStatusSchema = z.enum(["active", "waiting_input", "waiting_approval", "paused", "ended"]);
export const TaskKindSchema = z.enum(["plan", "act", "review", "background"]);
export const TaskStatusSchema = z.enum(["new", "planned", "active", "blocked", "waiting_input", "done", "failed", "cancelled"]);
export const WaitingReasonSchema = z.enum(["permission", "user_decision", "retry_backoff", "recovery"]);
export const ResumePolicySchema = z.enum(["resume", "restart_loop", "abort"]);
export const InflightStateSchema = z.enum(["awaiting_permission", "awaiting_user_decision"]);
export const OperatorRecoveryStateSchema = z.enum(["idle", "awaiting_permission", "awaiting_user_decision", "ready"]);

export const RecoveryContextSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  source: SourceSchema,
  mode: ModeSchema,
  currentGoal: z.string().optional(),
  activeTaskIds: z.array(z.string()).default([]),
  recentTurnRefs: z.array(z.string()).default([])
});

export const OperatorRecoverySnapshotSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  contractVersion: z.literal(OPERATOR_RECOVERY_SNAPSHOT_CONTRACT_VERSION).default(OPERATOR_RECOVERY_SNAPSHOT_CONTRACT_VERSION),
  runtimeAwarenessContractVersion: z.literal(RUNTIME_SELF_AWARENESS_CONTRACT_VERSION).default(RUNTIME_SELF_AWARENESS_CONTRACT_VERSION),
  sessionId: z.string(),
  workspaceId: z.string(),
  recoverable: z.boolean(),
  hasPendingExecution: z.boolean(),
  turnId: z.string().optional(),
  frameRef: z.string().optional(),
  pendingExecutionId: z.string().optional(),
  blockedBy: z.string().optional(),
  waitingReason: WaitingReasonSchema.optional(),
  state: OperatorRecoveryStateSchema,
  allowedActions: z.array(ExecutionActionSchema).default([]),
  pendingApprovalRef: z.string().optional(),
  pendingDecision: PermissionDecisionSchema.optional(),
  checkpointRef: z.string().optional(),
  contextSummary: RecoveryContextSummarySchema.optional(),
  runtimeSelfAwareness: RuntimeSelfAwarenessSurfaceSchema.optional(),
  authoritativeTruth: AuthoritativeTurnTruthSchema.optional(),
  observability: ContextAssemblyObservabilitySchema.optional()
});

export const SessionStateSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  createdFrom: SourceSchema,
  lastSource: SourceSchema,
  mode: ModeSchema,
  status: SessionStatusSchema,
  currentGoal: z.string(),
  workingSetRef: z.string(),
  workingSetVersion: z.number().int().nonnegative(),
  activeTaskIds: z.array(z.string()),
  recentTurnRefs: z.array(z.string()),
  lastEventSeq: z.number().int().nonnegative(),
  lastTurnAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  focusTaskId: z.string().optional(),
  focusRunId: z.string().optional(),
  focusUpdatedAt: z.string().optional(),
  toolPolicy: z.unknown().optional(),
  modelPolicy: z.unknown().optional(),
  lastCheckpointRef: z.string().optional(),
  memoryRefs: z.array(z.string()).optional(),
  costToDate: z.number().nonnegative().optional()
});

export const TaskStateSchema = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  description: z.string(),
  kind: TaskKindSchema,
  status: TaskStatusSchema,
  lastTurnId: z.string(),
  checkpointRef: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  plan: z.array(z.string()).optional(),
  currentStep: z.string().optional(),
  nextAction: z.string().optional(),
  artifacts: z.array(z.unknown()).optional(),
  blockingReason: z.string().optional()
});

export const InflightTurnSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  state: InflightStateSchema,
  waitingReason: WaitingReasonSchema,
  resumePolicy: ResumePolicySchema,
  loopCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  pendingApprovalRef: z.string().optional(),
  checkpointRef: z.string(),
  frameRef: z.string().optional(),
  contractVersion: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pendingExecution: PendingExecutionSchema.optional(),
  pendingToolCalls: z.array(z.unknown()).optional(),
  lastRuntimeFrameRef: z.string().optional(),
  stopCandidateReason: z.string().optional()
});

export type SessionState = z.infer<typeof SessionStateSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type InflightTurn = z.infer<typeof InflightTurnSchema>;
export type OperatorRecoveryState = z.infer<typeof OperatorRecoveryStateSchema>;
export type RecoveryContextSummary = z.infer<typeof RecoveryContextSummarySchema>;
export type OperatorRecoverySnapshot = z.infer<typeof OperatorRecoverySnapshotSchema>;
