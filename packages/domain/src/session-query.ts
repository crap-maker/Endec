import { z } from "zod";
import { ArtifactRefSchema } from "./artifact.ts";
import { ModeSchema, SourceSchema } from "./turn.ts";
import { SessionStatusSchema } from "./session.ts";

export const SessionEventKindSchema = z.enum([
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "approval",
  "warning",
  "system"
]);

export const SessionListQuerySchema = z.object({
  workspaceId: z.string().optional(),
  source: SourceSchema.optional(),
  status: SessionStatusSchema.optional(),
  mode: ModeSchema.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive()
});

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  source: SourceSchema,
  mode: ModeSchema,
  status: SessionStatusSchema,
  currentGoal: z.string().optional(),
  lastTurnAt: z.string(),
  createdAt: z.string()
});

export const SessionListResultSchema = z.object({
  items: z.array(SessionSummarySchema),
  nextCursor: z.string().optional()
});

export const SessionHistoryQuerySchema = z.object({
  sessionId: z.string(),
  cursor: z.string().optional(),
  beforeTurnId: z.string().optional(),
  limit: z.number().int().positive()
});

export const SessionHistoryEntrySchema = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  eventId: z.string(),
  eventKind: SessionEventKindSchema,
  createdAt: z.string(),
  summary: z.string(),
  artifactRefs: z.array(ArtifactRefSchema).optional(),
  sourceRefs: z.array(z.string()).optional()
});

export const SessionBrowseResultSchema = z.object({
  items: z.array(SessionHistoryEntrySchema),
  nextCursor: z.string().optional()
});

export const SessionEventSearchQuerySchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string().optional(),
  queryText: z.string(),
  eventKinds: z.array(SessionEventKindSchema).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive()
});

export const SessionEventSearchHitSchema = SessionHistoryEntrySchema.extend({
  snippet: z.string()
});

export const SessionEventSearchResultSchema = z.object({
  hits: z.array(SessionEventSearchHitSchema),
  nextCursor: z.string().optional()
});

export const SessionEventLookupQuerySchema = z.object({
  sessionId: z.string(),
  turnId: z.string().optional(),
  eventId: z.string().optional()
});

export const SessionEventLookupResultSchema = z.object({
  entry: SessionHistoryEntrySchema.optional()
});

export type SessionEventKind = z.infer<typeof SessionEventKindSchema>;
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionListResult = z.infer<typeof SessionListResultSchema>;
export type SessionHistoryQuery = z.infer<typeof SessionHistoryQuerySchema>;
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntrySchema>;
export type SessionBrowseResult = z.infer<typeof SessionBrowseResultSchema>;
export type SessionEventSearchQuery = z.infer<typeof SessionEventSearchQuerySchema>;
export type SessionEventSearchHit = z.infer<typeof SessionEventSearchHitSchema>;
export type SessionEventSearchResult = z.infer<typeof SessionEventSearchResultSchema>;
export type SessionEventLookupQuery = z.infer<typeof SessionEventLookupQuerySchema>;
export type SessionEventLookupResult = z.infer<typeof SessionEventLookupResultSchema>;
