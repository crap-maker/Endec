import type Database from "better-sqlite3";
import { z } from "zod";
import {
  SessionEventSearchQuerySchema,
  SessionEventSearchResultSchema,
  type ArtifactRef,
  type SessionEventSearchHit,
  type SessionEventSearchQuery,
  type SessionEventSearchResult,
  type SessionHistoryEntry
} from "@endec/domain";

type EventRow = {
  eventId: string;
  sessionId: string;
  turnId: string;
  eventKind: SessionHistoryEntry["eventKind"];
  createdAt: string;
  summary: string;
  eventText: string;
  artifactRefs: string;
  sourceRefs: string;
};

type SearchCursor = {
  createdAt: string;
  eventId: string;
};

const SearchCursorSchema = z.object({
  createdAt: z.string(),
  eventId: z.string()
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

function normalizeText(value: string) {
  return value.toLowerCase();
}

function matchesQuery(row: EventRow, queryText: string) {
  const haystack = normalizeText(`${row.summary}\n${row.eventText}`);
  const terms = normalizeText(queryText)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  return terms.every((term) => haystack.includes(term));
}

function buildSnippet(text: string, queryText: string) {
  const source = text || queryText;
  const normalizedSource = normalizeText(source);
  const normalizedQuery = normalizeText(queryText);
  let matchIndex = normalizedSource.indexOf(normalizedQuery);

  if (matchIndex < 0) {
    const firstTerm = normalizedQuery.split(/\s+/).find(Boolean) ?? normalizedQuery;
    matchIndex = normalizedSource.indexOf(firstTerm);
  }
  if (matchIndex < 0) {
    return source.slice(0, 120);
  }

  const start = Math.max(0, matchIndex - 30);
  const end = Math.min(source.length, matchIndex + Math.max(queryText.length, 30) + 30);
  return source.slice(start, end).trim();
}

function compareDescending(left: EventRow, right: EventRow) {
  if (left.createdAt === right.createdAt) {
    return right.eventId.localeCompare(left.eventId);
  }
  return right.createdAt.localeCompare(left.createdAt);
}

function mapSearchHit(row: EventRow, queryText: string): SessionEventSearchHit {
  return {
    sessionId: row.sessionId,
    turnId: row.turnId,
    eventId: row.eventId,
    eventKind: row.eventKind,
    createdAt: row.createdAt,
    summary: row.summary,
    snippet: buildSnippet(row.eventText || row.summary, queryText),
    artifactRefs: parseArtifactRefs(row.artifactRefs),
    sourceRefs: parseSourceRefs(row.sourceRefs)
  };
}

export function searchSessionEvents(db: Database.Database, input: SessionEventSearchQuery): SessionEventSearchResult {
  const query = SessionEventSearchQuerySchema.parse(input);
  const cursor = decodeCursor(query.cursor, SearchCursorSchema, "session event search");
  const filters = ["workspace_id = ?"];
  const params: Array<string | number> = [query.workspaceId];

  if (query.sessionId) {
    filters.push("session_id = ?");
    params.push(query.sessionId);
  }
  if (query.eventKinds && query.eventKinds.length > 0) {
    filters.push(`event_kind IN (${query.eventKinds.map(() => "?").join(", ")})`);
    params.push(...query.eventKinds);
  }

  const rows = db
    .prepare(`
      SELECT
        event_id as eventId,
        session_id as sessionId,
        turn_id as turnId,
        event_kind as eventKind,
        created_at as createdAt,
        summary,
        event_text as eventText,
        artifact_refs as artifactRefs,
        source_refs as sourceRefs
      FROM session_events
      WHERE ${filters.join(" AND ")}
    `)
    .all(...params) as EventRow[];

  const hits = rows
    .filter((row) => matchesQuery(row, query.queryText))
    .sort(compareDescending)
    .filter((row) => {
      if (!cursor) {
        return true;
      }
      return row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && row.eventId < cursor.eventId);
    });

  const page = hits.slice(0, query.limit);
  const next = hits[query.limit];

  return SessionEventSearchResultSchema.parse({
    hits: page.map((row) => mapSearchHit(row, query.queryText)),
    nextCursor: next
      ? encodeCursor({
          createdAt: page[page.length - 1]?.createdAt ?? next.createdAt,
          eventId: page[page.length - 1]?.eventId ?? next.eventId
        })
      : undefined
  });
}
