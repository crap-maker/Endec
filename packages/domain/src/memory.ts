import { z } from "zod";
import { DisclosureModeSchema } from "./im-control.ts";

export const MemoryQueryPurposeSchema = z.enum(["turn_context", "explicit_search", "task_resume", "summary_refresh"]);
export const MemoryScopeSchema = z.enum(["session", "workspace", "user"]);
export const MemoryVisibilitySchema = z.enum(["owner_private", "conversation_local", "global_config"]);

export const MemoryQuerySchema = z.object({
  queryId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  actorId: z.string().optional(),
  purpose: MemoryQueryPurposeSchema,
  memoryTypes: z.array(z.string()),
  maxItems: z.number().int().positive(),
  maxInjectTokens: z.number().int().positive(),
  queryText: z.string().optional(),
  taskId: z.string().optional(),
  resumeFrom: z.string().optional(),
  topicHints: z.array(z.string()).optional(),
  timeRange: z
    .object({
      start: z.string(),
      end: z.string()
    })
    .optional(),
  scopeFilter: MemoryScopeSchema.optional(),
  conversationBoundaryKey: z.string().optional(),
  disclosureMode: DisclosureModeSchema.optional(),
  targetConversationKeys: z.array(z.string()).optional(),
  borrowedConversationKeys: z.array(z.string()).optional(),
  transientBorrowed: z.boolean().optional(),
  visibility: MemoryVisibilitySchema.optional()
});

export const MemoryWriteRequestSchema = z.object({
  writeId: z.string(),
  sourceTurnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  actorId: z.string().optional(),
  writeKind: z.enum(["candidate_extract", "typed_upsert"]),
  evidenceRefs: z.array(z.string()),
  taskId: z.string().optional(),
  scope: MemoryScopeSchema.optional(),
  proposedMemoryType: z.string().optional(),
  content: z.unknown().optional(),
  importance: z.number().nonnegative().optional(),
  dedupeKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  conversationBoundaryKey: z.string().optional(),
  disclosureMode: DisclosureModeSchema.optional(),
  targetConversationKeys: z.array(z.string()).optional(),
  borrowedConversationKeys: z.array(z.string()).optional(),
  transientBorrowed: z.boolean().optional(),
  visibility: MemoryVisibilitySchema.optional()
});

export const EvidenceRecordSchema = z.object({
  evidenceId: z.string(),
  sessionId: z.string(),
  topic: z.string(),
  content: z.string(),
  createdAt: z.string()
});

export const EvidenceSearchQuerySchema = z.object({
  workspaceId: z.string(),
  queryText: z.string(),
  maxItems: z.number().int().positive()
});

export const EvidenceSearchResultSchema = z.object({
  items: z.array(EvidenceRecordSchema)
});

export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequestSchema>;
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type EvidenceSearchQuery = z.infer<typeof EvidenceSearchQuerySchema>;
export type EvidenceSearchResult = z.infer<typeof EvidenceSearchResultSchema>;
