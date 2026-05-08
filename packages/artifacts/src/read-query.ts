import { ArtifactReadQuerySchema, type ArtifactReadQuery } from "@endec/domain";

export const DEFAULT_ARTIFACT_PAGE_SIZE = 4_096;

export type ArtifactCursorPayload = {
  artifactId: string;
  offset: number;
  limit: number;
};

export type NormalizedArtifactReadQuery = {
  artifactId: string;
  offset: number;
  limit: number;
};

export function encodeArtifactCursor(payload: ArtifactCursorPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeArtifactCursor(cursor: string): ArtifactCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`invalid artifact cursor: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as ArtifactCursorPayload).artifactId !== "string" ||
    typeof (parsed as ArtifactCursorPayload).offset !== "number" ||
    typeof (parsed as ArtifactCursorPayload).limit !== "number"
  ) {
    throw new Error("invalid artifact cursor payload");
  }

  return parsed as ArtifactCursorPayload;
}

export function normalizeArtifactReadQuery(query: ArtifactReadQuery, defaultPageSize = DEFAULT_ARTIFACT_PAGE_SIZE): NormalizedArtifactReadQuery {
  const parsed = ArtifactReadQuerySchema.parse(query);

  if (parsed.cursor) {
    if (parsed.offset !== undefined) {
      throw new Error("artifact cursor queries cannot also specify an offset");
    }

    const payload = decodeArtifactCursor(parsed.cursor);
    if (payload.artifactId !== parsed.artifactId) {
      throw new Error("artifact id must match artifact cursor");
    }
    if (parsed.limit !== undefined && parsed.limit !== payload.limit) {
      throw new Error("artifact limit must match artifact cursor");
    }

    return {
      artifactId: parsed.artifactId,
      offset: payload.offset,
      limit: payload.limit
    };
  }

  return {
    artifactId: parsed.artifactId,
    offset: parsed.offset ?? 0,
    limit: parsed.limit ?? defaultPageSize
  };
}
