import type Database from "better-sqlite3";
import { z } from "zod";
import {
  SessionBrowseResultSchema,
  SessionEventLookupResultSchema,
  SessionHistoryQuerySchema,
  SessionListQuerySchema,
  SessionListResultSchema,
  type ArtifactRef,
  type SessionBrowseResult,
  type SessionEventLookupQuery,
  type SessionEventLookupResult,
  type SessionHistoryEntry,
  type SessionHistoryQuery,
  type SessionListQuery,
  type SessionListResult,
  type SessionSummary
} from "@endec/domain";

type SessionRow = {
  sessionId: string;
  workspaceId: string;
  source: SessionSummary["source"];
  mode: SessionSummary["mode"];
  status: SessionSummary["status"];
  currentGoal: string;
  lastTurnAt: string;
  createdAt: string;
};

type EventRow = {
  eventId: string;
  sessionId: string;
  turnId: string;
  eventKind: SessionHistoryEntry["eventKind"];
  createdAt: string;
  summary: string;
  artifactRefs: string;
  sourceRefs: string;
  seq: number;
};

type SessionListCursor = {
  lastTurnAt: string;
  sessionId: string;
};

const SessionListCursorSchema = z.object({
  lastTurnAt: z.string(),
  sessionId: z.string()
});

type HistoryCursor = {
  beforeSeq: number;
};

const HistoryCursorSchema = z.object({
  beforeSeq: z.number().int().nonnegative()
});

function encodeCursor<T>(cursor: T) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor<T>(
  cursor: string | undefined,
  schema: z.ZodType<T>,
  surface: string
): T | null {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return schema.parse(decoded);
  } catch {
    throw new Error(`invalid ${surface} cursor`);
  }
}

function parseArtifactRefs(value: string): ArtifactRef[] | undefined {
  const parsed = JSON.parse(value) as ArtifactRef[];
  return parsed.length > 0 ? parsed : undefined;
}

function parseSourceRefs(value: string): string[] | undefined {
  const parsed = JSON.parse(value) as string[];
  return parsed.length > 0 ? parsed : undefined;
}

function mapHistoryEntry(row: EventRow): SessionHistoryEntry {
  return {
    sessionId: row.sessionId,
    turnId: row.turnId,
    eventId: row.eventId,
    eventKind: row.eventKind,
    createdAt: row.createdAt,
    summary: row.summary,
    artifactRefs: parseArtifactRefs(row.artifactRefs),
    sourceRefs: parseSourceRefs(row.sourceRefs)
  };
}

export function listSessions(db: Database.Database, input: SessionListQuery): SessionListResult {
  const safeInput = SessionListQuerySchema.parse(input);
  const cursor = decodeCursor(safeInput.cursor, SessionListCursorSchema, "session list");

  const params: Array<string | number> = [];
  const filters = ["1 = 1"];

  if (safeInput.workspaceId) {
    filters.push("workspace_id = ?");
    params.push(safeInput.workspaceId);
  }
  if (safeInput.source) {
    filters.push("last_source = ?");
    params.push(safeInput.source);
  }
  if (safeInput.status) {
    filters.push("status = ?");
    params.push(safeInput.status);
  }
  if (safeInput.mode) {
    filters.push("mode = ?");
    params.push(safeInput.mode);
  }
  if (cursor) {
    filters.push("(last_turn_at < ? OR (last_turn_at = ? AND session_id < ?))");
    params.push(cursor.lastTurnAt, cursor.lastTurnAt, cursor.sessionId);
  }

  params.push(safeInput.limit + 1);
  const rows = db
    .prepare(`
      SELECT
        session_id as sessionId,
        workspace_id as workspaceId,
        last_source as source,
        mode,
        status,
        current_goal as currentGoal,
        last_turn_at as lastTurnAt,
        created_at as createdAt
      FROM sessions
      WHERE ${filters.join(" AND ")}
      ORDER BY last_turn_at DESC, session_id DESC
      LIMIT ?
    `)
    .all(...params) as SessionRow[];

  const page = rows.slice(0, safeInput.limit).map((row) => ({
    ...row,
    currentGoal: row.currentGoal || undefined
  }));
  const next = rows[safeInput.limit];

  return SessionListResultSchema.parse({
    items: page,
    nextCursor: next
      ? encodeCursor({
          lastTurnAt: page[page.length - 1]?.lastTurnAt ?? next.lastTurnAt,
          sessionId: page[page.length - 1]?.sessionId ?? next.sessionId
        })
      : undefined
  });
}

export function browseSessionHistory(db: Database.Database, input: SessionHistoryQuery): SessionBrowseResult {
  const query = SessionHistoryQuerySchema.parse(input);
  const cursor = decodeCursor(query.cursor, HistoryCursorSchema, "session history");
  let beforeExclusiveSeq = cursor?.beforeSeq;

  if (beforeExclusiveSeq === undefined && query.beforeTurnId) {
    const turnBoundary = db
      .prepare(`SELECT MIN(seq) as seq FROM session_events WHERE session_id = ? AND turn_id = ?`)
      .get(query.sessionId, query.beforeTurnId) as { seq: number | null } | undefined;
    if (turnBoundary?.seq != null) {
      beforeExclusiveSeq = turnBoundary.seq;
    }
  }

  const filters = ["session_id = ?"];
  const params: Array<string | number> = [query.sessionId];
  if (beforeExclusiveSeq !== undefined) {
    filters.push("seq < ?");
    params.push(beforeExclusiveSeq);
  }
  params.push(query.limit + 1);

  const rows = db
    .prepare(`
      SELECT
        event_id as eventId,
        session_id as sessionId,
        turn_id as turnId,
        event_kind as eventKind,
        created_at as createdAt,
        summary,
        artifact_refs as artifactRefs,
        source_refs as sourceRefs,
        seq
      FROM session_events
      WHERE ${filters.join(" AND ")}
      ORDER BY seq DESC
      LIMIT ?
    `)
    .all(...params) as EventRow[];

  const page = rows.slice(0, query.limit);
  const next = rows[query.limit];

  return SessionBrowseResultSchema.parse({
    items: page.map(mapHistoryEntry),
    nextCursor: next
      ? encodeCursor({
          beforeSeq: page[page.length - 1]?.seq ?? next.seq
        })
      : undefined
  });
}

export function lookupSessionEvent(db: Database.Database, input: SessionEventLookupQuery): SessionEventLookupResult {
  let row: EventRow | undefined;

  if (input.eventId) {
    row = db
      .prepare(`
        SELECT
          event_id as eventId,
          session_id as sessionId,
          turn_id as turnId,
          event_kind as eventKind,
          created_at as createdAt,
          summary,
          artifact_refs as artifactRefs,
          source_refs as sourceRefs,
          seq
        FROM session_events
        WHERE session_id = ? AND event_id = ? AND (? IS NULL OR turn_id = ?)
        ORDER BY seq DESC
        LIMIT 1
      `)
      .get(input.sessionId, input.eventId, input.turnId ?? null, input.turnId ?? null) as EventRow | undefined;
  } else if (input.turnId) {
    row = db
      .prepare(`
        SELECT
          event_id as eventId,
          session_id as sessionId,
          turn_id as turnId,
          event_kind as eventKind,
          created_at as createdAt,
          summary,
          artifact_refs as artifactRefs,
          source_refs as sourceRefs,
          seq
        FROM session_events
        WHERE session_id = ? AND turn_id = ?
        ORDER BY seq DESC
        LIMIT 1
      `)
      .get(input.sessionId, input.turnId) as EventRow | undefined;
  }

  return SessionEventLookupResultSchema.parse({
    entry: row ? mapHistoryEntry(row) : undefined
  });
}
