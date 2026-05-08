import { z } from "zod";
import {
  ConversationBoundaryDescriptorSchema,
  ImActivationKindSchema,
  ImCommandIntentSchema,
  ImMessageControlMetadataSchema,
  ImMessageModeSchema,
  ResolvedPersonaSchema
} from "./im-control.ts";

export const SourceSchema = z.enum(["cli", "tui", "telegram", "feishu", "web", "sdk"]);
export const ModeSchema = z.enum(["chat", "plan", "act", "review", "task"]);

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  contextUsedTokens: z.number().int().nonnegative().optional(),
  maxContextTokens: z.number().int().positive().optional()
});

export const ConversationPeerKindSchema = z.enum(["dm", "group", "channel", "unknown"]);

export const ConversationRefSchema = z.object({
  accountId: z.string(),
  conversationId: z.string(),
  peerId: z.string(),
  peerKind: ConversationPeerKindSchema,
  parentConversationId: z.string().optional(),
  baseConversationId: z.string().optional(),
  threadId: z.string().optional(),
  topicId: z.string().optional(),
  senderScope: z.string().optional()
});

export const BackgroundTurnMarkerSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  contractVersion: z.literal("im.background-turn.v1").default("im.background-turn.v1"),
  taskId: z.string(),
  runId: z.string(),
  attemptNo: z.number().int().positive(),
  originTurnId: z.string(),
  executionRole: z.enum(["background_worker", "background_control"])
});

export const TurnControlIntentKindSchema = z.enum([
  "steer",
  "follow_up",
  "continue",
  "cancel",
  "approval_resume",
  "operator_resume"
]);

export const TurnControlIntentSchema = z.object({
  kind: TurnControlIntentKindSchema,
  taskId: z.string().optional(),
  runId: z.string().optional(),
  continuationRef: z.string().optional(),
  focusRunId: z.string().optional(),
  imControl: ImMessageControlMetadataSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const TurnRequestSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  source: SourceSchema,
  actorId: z.string(),
  input: z.string(),
  attachments: z.array(z.unknown()),
  requestedMode: ModeSchema.optional(),
  conversationRef: ConversationRefSchema.optional(),
  channelContext: z.record(z.string(), z.unknown()).optional(),
  imContext: z
    .object({
      activationKind: ImActivationKindSchema,
      boundary: ConversationBoundaryDescriptorSchema,
      commandIntent: ImCommandIntentSchema.optional(),
      resolvedPersona: ResolvedPersonaSchema.optional(),
      messageMode: ImMessageModeSchema.optional()
    })
    .optional(),
  taskId: z.string().optional(),
  resumeFrom: z.string().optional(),
  requestedCapabilities: z.array(z.string()).optional(),
  controlIntent: TurnControlIntentSchema.optional()
});

export const TurnResultStatusSchema = z.enum(["completed", "blocked", "interrupted", "failed"]);
export const TurnContinuationActionSchema = z.enum(["approve", "deny", "resume", "cancel"]);
export const TurnContinuationSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  contractVersion: z.literal("ws0.execution-control.v1").default("ws0.execution-control.v1"),
  frameRef: z.string(),
  checkpointRef: z.string().optional(),
  continuationKind: z.enum(["awaiting_operator", "resume"]),
  allowedActions: z.array(TurnContinuationActionSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const TurnResultSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  resolvedMode: ModeSchema,
  status: TurnResultStatusSchema,
  messages: z.array(z.unknown()),
  toolEvents: z.array(z.unknown()),
  taskUpdates: z.array(z.unknown()),
  usage: UsageSchema,
  warnings: z.array(z.string()),
  checkpointRef: z.string(),
  frameRef: z.string().optional(),
  continuation: TurnContinuationSchema.optional(),
  memoryWrites: z.array(z.unknown()).optional(),
  artifacts: z.array(z.unknown()).optional(),
  approvals: z.array(z.unknown()).optional(),
  costRecord: z.string().optional(),
  nextSessionStateRef: z.string().optional(),
  blockedBy: z.string().optional()
});

export type Source = z.infer<typeof SourceSchema>;
export type Mode = z.infer<typeof ModeSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type ConversationPeerKind = z.infer<typeof ConversationPeerKindSchema>;
export type ConversationRef = z.infer<typeof ConversationRefSchema>;
export type BackgroundTurnMarker = z.infer<typeof BackgroundTurnMarkerSchema>;
export type TurnControlIntentKind = z.infer<typeof TurnControlIntentKindSchema>;
export type TurnControlIntent = z.infer<typeof TurnControlIntentSchema>;
export type TurnRequest = z.infer<typeof TurnRequestSchema>;
export type TurnContinuationAction = z.infer<typeof TurnContinuationActionSchema>;
export type TurnContinuation = z.infer<typeof TurnContinuationSchema>;
export type TurnResult = z.infer<typeof TurnResultSchema>;
