import { z } from "zod";

export const DisclosureModeSchema = z.enum(["local_only", "owner_targeted", "owner_cross_group"]);
export const ImCommandNameSchema = z.enum(["help", "status", "model", "models", "persona", "recall", "history", "trust", "provider", "inspect", "reload", "restart"]);
export const PersonaScopeKindSchema = z.enum(["owner_direct", "shared_default", "conversation_override"]);
export const ImActivationKindSchema = z.enum(["interactive_turn", "command_execution", "passive_ingest"]);
export const ImMessageModeSchema = z.enum(["turn", "steer", "follow_up"]);
export const ImMessageControlSourceSchema = z.enum(["telegram", "feishu"]);
export const ConversationBoundaryConversationScopeSchema = z.enum(["direct", "shared", "broadcast", "unknown"]);

export const ImMessageControlMetadataSchema = z.object({
  messageMode: ImMessageModeSchema,
  source: ImMessageControlSourceSchema,
  messageId: z.string(),
  senderId: z.string().optional(),
  text: z.string().min(1).optional(),
  capturedAt: z.string().optional()
});

export const ConversationBoundaryDescriptorSchema = z.object({
  boundaryKey: z.string(),
  conversationScope: ConversationBoundaryConversationScopeSchema,
  disclosureMode: DisclosureModeSchema,
  targetConversationKeys: z.array(z.string()).default([]),
  borrowedConversationKeys: z.array(z.string()).default([]),
  transientBorrowed: z.boolean().default(false)
});

export const ImCommandIntentSchema = z.object({
  name: ImCommandNameSchema,
  subcommand: z.string().optional(),
  args: z.array(z.string()).default([]),
  options: z.record(z.string(), z.unknown()).default({}),
  rawText: z.string(),
  helpRequested: z.boolean().default(false)
});

export const ResolvedPersonaSchema = z.object({
  scopeKind: PersonaScopeKindSchema,
  styleInstructions: z.string(),
  behaviorInstructions: z.string(),
  sourceRefs: z.array(z.string()).default([])
});

export const ConversationDirectoryEntrySchema = z.object({
  source: z.enum(["cli", "tui", "telegram", "feishu", "web", "sdk"]),
  accountId: z.string(),
  conversationKey: z.string(),
  baseConversationKey: z.string().optional(),
  conversationLabel: z.string().optional(),
  latestSessionId: z.string().optional(),
  observedAt: z.string()
});

export const ModelOverrideRecordSchema = z.object({
  source: z.enum(["cli", "tui", "telegram", "feishu", "web", "sdk"]),
  accountId: z.string(),
  modelTier: z.enum(["cheap", "strong"]),
  providerId: z.string(),
  modelId: z.string(),
  updatedByActorId: z.string(),
  updatedAt: z.string()
});

export type DisclosureMode = z.infer<typeof DisclosureModeSchema>;
export type ImCommandName = z.infer<typeof ImCommandNameSchema>;
export type PersonaScopeKind = z.infer<typeof PersonaScopeKindSchema>;
export type ImActivationKind = z.infer<typeof ImActivationKindSchema>;
export type ImMessageMode = z.infer<typeof ImMessageModeSchema>;
export type ImMessageControlSource = z.infer<typeof ImMessageControlSourceSchema>;
export type ImMessageControlMetadata = z.infer<typeof ImMessageControlMetadataSchema>;
export type ConversationBoundaryConversationScope = z.infer<typeof ConversationBoundaryConversationScopeSchema>;
export type ConversationBoundaryDescriptor = z.infer<typeof ConversationBoundaryDescriptorSchema>;
export type ImCommandIntent = z.infer<typeof ImCommandIntentSchema>;
export type ResolvedPersona = z.infer<typeof ResolvedPersonaSchema>;
export type ConversationDirectoryEntry = z.infer<typeof ConversationDirectoryEntrySchema>;
export type ModelOverrideRecord = z.infer<typeof ModelOverrideRecordSchema>;
