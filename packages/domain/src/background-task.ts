import { z } from "zod";
import { ImMessageControlMetadataSchema } from "./im-control.ts";
import { ConversationRefSchema, ModeSchema, SourceSchema, TurnRequestSchema, TurnResultStatusSchema, UsageSchema } from "./turn.ts";

export const AgentTaskStatusSchema = z.enum(["open", "queued", "running", "blocked", "done", "failed", "canceled"]);
export const LegacyTaskRunStatusSchema = z.enum([
  "queued",
  "running",
  "suspended",
  "succeeded",
  "failed",
  "interrupted",
  "cancel_requested",
  "canceled",
  "lease_expired"
]);
export const TaskRunStatusSchema = z.enum(["queued", "running", "blocked", "completed", "failed", "canceled"]);
export const TaskRunKindSchema = z.enum(["normal", "control"]);
export const RunAttentionModeSchema = z.enum(["foreground_attached", "background_detached"]);
export const SliceLaneSchema = z.enum(["foreground", "background"]);
export const SliceTriggerKindSchema = z.enum([
  "initial",
  "auto_continue",
  "user_resume",
  "approval_resume",
  "recovery_retry",
  "operator_resume",
  "legacy_cutover"
]);
export const RuntimeSliceStatusSchema = z.enum([
  "queued",
  "running",
  "yielded",
  "blocked",
  "completed",
  "failed",
  "canceled",
  "lease_expired"
]);
export const SliceTerminalStatusSchema = z.enum(["yielded", "blocked", "completed", "failed", "canceled", "lease_expired"]);
export const RunControlKindSchema = z.enum(["steer", "follow_up", "continue", "cancel"]);
export const RunContinuationKindSchema = z.enum([
  "auto_continue",
  "user_resume",
  "approval_resume",
  "operator_resume",
  "recovery_retry"
]);
export const TaskEventTypeSchema = z.enum([
  "task_created",
  "run_queued",
  "run_claimed",
  "run_started",
  "run_blocked",
  "run_completed",
  "run_failed",
  "run_canceled",
  "slice_queued",
  "slice_claimed",
  "slice_yielded",
  "slice_blocked",
  "slice_completed",
  "slice_failed",
  "slice_canceled",
  "slice_lease_expired",
  "run_detached",
  "run_refocused",
  "approval_required",
  "cancel_requested",
  "outbound_enqueued",
  "outbound_delivery_started",
  "outbound_delivered",
  "outbound_delivery_unknown",
  "run_succeeded",
  "run_interrupted",
  "run_suspended",
  "lease_expired"
]);
export const TaskEventSeveritySchema = z.enum(["info", "warning", "error"]);
export const OutboundEventKindSchema = z.enum(["ack", "final", "blocked", "failed", "interrupted", "canceled", "operator_notice"]);
export const OutboundEventStatusSchema = z.enum(["pending", "claimed", "canceled"]);
export const OutboundDeliveryStatusSchema = z.enum(["pending", "sending", "delivered", "failed", "delivery_unknown", "canceled"]);
export const OutboundTransportSchema = z.enum(["telegram", "feishu", "web", "sdk"]);

export const RunBudgetLedgerSchema = z.object({
  cumulativeInputTokens: z.number().int().nonnegative().default(0),
  cumulativeOutputTokens: z.number().int().nonnegative().default(0),
  cumulativeTotalTokens: z.number().int().nonnegative().default(0),
  cumulativeEstimatedCost: z.number().nonnegative().default(0),
  autonomyWindowSliceCount: z.number().int().nonnegative().default(0),
  autonomyWindowToolCallCount: z.number().int().nonnegative().default(0),
  foregroundBurstSliceCount: z.number().int().nonnegative().default(0),
  foregroundBurstStartedAt: z.string().optional(),
  lastHumanInputAt: z.string().optional(),
  runStartedAt: z.string().optional(),
  runDeadlineAt: z.string().optional()
});

export const RunContinuationSnapshotSchema = z.object({
  continuationKind: RunContinuationKindSchema,
  continuationPayload: z.unknown().optional(),
  continuationUpdatedAt: z.string().optional()
});

export const AgentTaskSnapshotSchema = z.object({
  taskId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  actorId: z.string().optional(),
  conversationRef: ConversationRefSchema.optional(),
  title: z.string(),
  description: z.string(),
  agentStatus: AgentTaskStatusSchema,
  blockingReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TaskRunSnapshotSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  actorId: z.string().optional(),
  conversationRef: ConversationRefSchema.optional(),
  status: TaskRunStatusSchema,
  attentionMode: RunAttentionModeSchema.default("foreground_attached"),
  runKind: TaskRunKindSchema,
  attemptNo: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  retryOfRunId: z.string().optional(),
  parentRunId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  cancelRequestedAt: z.string().optional(),
  cancelRequestedBy: z.string().optional(),
  cancelReason: z.string().optional(),
  cancelObservedSliceId: z.string().optional(),
  continuationKind: RunContinuationKindSchema.optional(),
  continuationPayload: z.unknown().optional(),
  continuationUpdatedAt: z.string().optional(),
  pendingApprovalRef: z.string().optional(),
  pendingControlRef: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.unknown().optional(),
  cumulativeInputTokens: z.number().int().nonnegative().default(0),
  cumulativeOutputTokens: z.number().int().nonnegative().default(0),
  cumulativeTotalTokens: z.number().int().nonnegative().default(0),
  cumulativeEstimatedCost: z.number().nonnegative().default(0),
  autonomyWindowSliceCount: z.number().int().nonnegative().default(0),
  autonomyWindowToolCallCount: z.number().int().nonnegative().default(0),
  foregroundBurstSliceCount: z.number().int().nonnegative().default(0),
  foregroundBurstStartedAt: z.string().optional(),
  lastHumanInputAt: z.string().optional(),
  runStartedAt: z.string().optional(),
  runDeadlineAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const RunUsageSummarySchema = UsageSchema.extend({
  toolCallCount: z.number().int().nonnegative().optional()
});

const SteerRunControlPayloadSchema = z.object({
  text: z.string().min(1),
  imControl: ImMessageControlMetadataSchema.optional()
});
const ContinueRunControlPayloadSchema = z.object({
  text: z.string().min(1).optional()
}).passthrough();
const CancelRunControlPayloadSchema = z.object({
  reason: z.string().min(1).optional()
}).passthrough();

export const RuntimeSliceSnapshotSchema = z.object({
  sliceId: z.string(),
  runId: z.string(),
  taskId: z.string(),
  sliceNo: z.number().int().positive(),
  triggerKind: SliceTriggerKindSchema,
  lane: SliceLaneSchema,
  status: RuntimeSliceStatusSchema,
  workerId: z.string().optional(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  claimedAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  budgetSnapshot: z.unknown().optional(),
  toolLoopSummary: z.unknown().optional(),
  usageSummary: RunUsageSummarySchema.optional(),
  continuationPayload: z.unknown().optional(),
  resultSummary: z.string().optional(),
  error: z.unknown().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const RunControlBaseSchema = z.object({
  controlSeq: z.number().int().positive(),
  controlId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  createdAt: z.string(),
  appliedSliceId: z.string().optional(),
  appliedAt: z.string().optional()
});

export const RunControlInputSchema = z.discriminatedUnion("kind", [
  RunControlBaseSchema.extend({
    kind: z.literal("steer"),
    payload: SteerRunControlPayloadSchema
  }),
  RunControlBaseSchema.extend({
    kind: z.literal("follow_up"),
    payload: SteerRunControlPayloadSchema.optional()
  }),
  RunControlBaseSchema.extend({
    kind: z.literal("continue"),
    payload: ContinueRunControlPayloadSchema.optional()
  }),
  RunControlBaseSchema.extend({
    kind: z.literal("cancel"),
    payload: CancelRunControlPayloadSchema.optional()
  })
]);

export const TaskEventSchema = z.object({
  eventId: z.string(),
  taskId: z.string(),
  runId: z.string().optional(),
  workspaceId: z.string(),
  seq: z.number().int().positive().optional(),
  eventType: TaskEventTypeSchema,
  severity: TaskEventSeveritySchema,
  message: z.string(),
  data: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
  createdAt: z.string()
});

export const OutboundEventSchema = z.object({
  outboundEventId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string().optional(),
  actorId: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  conversationRef: ConversationRefSchema,
  channel: OutboundTransportSchema,
  eventKind: OutboundEventKindSchema,
  renderPayload: z.unknown(),
  idempotencyKey: z.string(),
  status: OutboundEventStatusSchema,
  availableAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const OutboundDeliverySchema = z.object({
  deliveryId: z.string(),
  outboundEventId: z.string(),
  transport: OutboundTransportSchema,
  transportTarget: z.unknown(),
  status: OutboundDeliveryStatusSchema,
  claimOwner: z.string().optional(),
  claimExpiresAt: z.string().optional(),
  sendStartedAt: z.string().optional(),
  deliveredAt: z.string().optional(),
  deliveryUnknownAt: z.string().optional(),
  transportMessageId: z.string().optional(),
  error: z.unknown().optional(),
  attemptNo: z.number().int().positive(),
  idempotencyKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const TaskRunClaimResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed"), run: TaskRunSnapshotSchema }),
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("lost_race") })
]);

export const RuntimeSliceClaimResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed"), slice: RuntimeSliceSnapshotSchema }),
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("lost_race") })
]);

export const BackgroundEnqueueRequestSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  actorId: z.string().optional(),
  conversationRef: ConversationRefSchema.optional(),
  sourceTurnId: z.string(),
  title: z.string(),
  description: z.string(),
  input: z.string(),
  source: SourceSchema,
  requestedMode: ModeSchema.optional(),
  idempotencyKey: z.string(),
  maxAttempts: z.number().int().positive().default(1)
});

export const BackgroundEnqueueResultSchema = z.object({
  task: AgentTaskSnapshotSchema,
  run: TaskRunSnapshotSchema,
  created: z.boolean()
});

export const BackgroundWorkerTickResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed"), runId: z.string(), taskId: z.string(), resultStatus: TurnResultStatusSchema.optional() }),
  z.object({ status: z.literal("idle") })
]);

export const BackgroundCancelRequestSchema = z.object({
  taskId: z.string(),
  runId: z.string().optional(),
  actorId: z.string().optional(),
  reason: z.string().optional(),
  idempotencyKey: z.string().optional()
});

export const BackgroundCancelResultSchema = z.object({
  taskId: z.string(),
  runId: z.string().optional(),
  status: z.enum(["canceled", "cancel_requested", "not_found", "already_terminal"]),
  taskStatus: AgentTaskStatusSchema.optional(),
  runStatus: TaskRunStatusSchema.optional()
});

export const BackgroundInspectTaskSummarySchema = z.object({
  task: AgentTaskSnapshotSchema,
  latestRun: TaskRunSnapshotSchema.optional()
});
export const BackgroundInspectRunDetailSchema = TaskRunSnapshotSchema.extend({
  slices: z.array(RuntimeSliceSnapshotSchema).default([]),
  pendingControls: z.array(RunControlInputSchema).default([]),
  events: z.array(TaskEventSchema).default([])
});
export const BackgroundInspectOutboundStateSchema = z.object({
  outboundEvent: OutboundEventSchema,
  deliveries: z.array(OutboundDeliverySchema).default([])
});
export const BackgroundInspectTaskDetailSchema = z.object({
  task: AgentTaskSnapshotSchema,
  runs: z.array(TaskRunSnapshotSchema).default([]),
  events: z.array(TaskEventSchema).default([]),
  outbound: z.array(BackgroundInspectOutboundStateSchema).default([])
});

export const AgentTaskStatusToLegacyTaskStatusSchema = z.record(AgentTaskStatusSchema, z.enum(["active", "blocked", "done", "failed", "cancelled"]));
export const AgentTaskStatusToLegacyTaskStatus: z.infer<typeof AgentTaskStatusToLegacyTaskStatusSchema> = {
  open: "active",
  queued: "active",
  running: "active",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  canceled: "cancelled"
};

export function normalizeLegacyTaskRunStatus(status: z.infer<typeof LegacyTaskRunStatusSchema> | TaskRunStatus): TaskRunStatus {
  switch (status) {
    case "queued":
    case "running":
    case "blocked":
    case "completed":
    case "failed":
    case "canceled":
      return status;
    case "suspended":
      return "blocked";
    case "succeeded":
      return "completed";
    case "interrupted":
    case "lease_expired":
      return "failed";
    case "cancel_requested":
      return "running";
    default:
      throw new Error(`Unknown legacy task run status: ${String(status)}`);
  }
}

export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;
export type LegacyTaskRunStatus = z.infer<typeof LegacyTaskRunStatusSchema>;
export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>;
export type TaskRunKind = z.infer<typeof TaskRunKindSchema>;
export type RunAttentionMode = z.infer<typeof RunAttentionModeSchema>;
export type SliceLane = z.infer<typeof SliceLaneSchema>;
export type SliceTriggerKind = z.infer<typeof SliceTriggerKindSchema>;
export type RuntimeSliceStatus = z.infer<typeof RuntimeSliceStatusSchema>;
export type SliceTerminalStatus = z.infer<typeof SliceTerminalStatusSchema>;
export type RunControlKind = z.infer<typeof RunControlKindSchema>;
export type RunContinuationKind = z.infer<typeof RunContinuationKindSchema>;
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;
export type TaskEventSeverity = z.infer<typeof TaskEventSeveritySchema>;
export type OutboundEventKind = z.infer<typeof OutboundEventKindSchema>;
export type OutboundEventStatus = z.infer<typeof OutboundEventStatusSchema>;
export type OutboundDeliveryStatus = z.infer<typeof OutboundDeliveryStatusSchema>;
export type OutboundTransport = z.infer<typeof OutboundTransportSchema>;
export type RunBudgetLedger = z.infer<typeof RunBudgetLedgerSchema>;
export type RunUsageSummary = z.infer<typeof RunUsageSummarySchema>;
export type RunContinuationSnapshot = z.infer<typeof RunContinuationSnapshotSchema>;
export type AgentTaskSnapshot = z.infer<typeof AgentTaskSnapshotSchema>;
export type TaskRunSnapshot = z.infer<typeof TaskRunSnapshotSchema>;
export type RuntimeSliceSnapshot = z.infer<typeof RuntimeSliceSnapshotSchema>;
export type RunControlInput = z.infer<typeof RunControlInputSchema>;
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type OutboundEvent = z.infer<typeof OutboundEventSchema>;
export type OutboundDelivery = z.infer<typeof OutboundDeliverySchema>;
export type TaskRunClaimResult = z.infer<typeof TaskRunClaimResultSchema>;
export type RuntimeSliceClaimResult = z.infer<typeof RuntimeSliceClaimResultSchema>;
export type BackgroundEnqueueRequest = z.infer<typeof BackgroundEnqueueRequestSchema>;
export type BackgroundEnqueueResult = z.infer<typeof BackgroundEnqueueResultSchema>;
export type BackgroundWorkerTickResult = z.infer<typeof BackgroundWorkerTickResultSchema>;
export type BackgroundCancelRequest = z.infer<typeof BackgroundCancelRequestSchema>;
export type BackgroundCancelResult = z.infer<typeof BackgroundCancelResultSchema>;
export type BackgroundInspectTaskSummary = z.infer<typeof BackgroundInspectTaskSummarySchema>;
export type BackgroundInspectRunDetail = z.infer<typeof BackgroundInspectRunDetailSchema>;
export type BackgroundInspectOutboundState = z.infer<typeof BackgroundInspectOutboundStateSchema>;
export type BackgroundInspectTaskDetail = z.infer<typeof BackgroundInspectTaskDetailSchema>;
