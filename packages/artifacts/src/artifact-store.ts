import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ArtifactPreviewSchema,
  ArtifactReadResultSchema,
  ArtifactRefSchema,
  type ArtifactPreview,
  type ArtifactRef,
  type ArtifactReadResult
} from "@endec/domain";
import type { ArtifactQueryPort, ArtifactSpillPort } from "@endec/core";
import { buildArtifactMetadataKey, buildArtifactPaths, resolveArtifactPath } from "./path-layout.ts";
import { createArtifactPreview, DEFAULT_ARTIFACT_PREVIEW_CHARS } from "./preview-policy.ts";
import {
  DEFAULT_ARTIFACT_PAGE_SIZE,
  encodeArtifactCursor,
  normalizeArtifactReadQuery
} from "./read-query.ts";

type ArtifactRecord = {
  ref: ArtifactRef;
  preview: ArtifactPreview;
};

export type ArtifactStore = ArtifactQueryPort & ArtifactSpillPort;

export function createArtifactStore(options: {
  rootDir: string;
  previewChars?: number;
  defaultPageSize?: number;
}): ArtifactStore {
  const previewChars = options.previewChars ?? DEFAULT_ARTIFACT_PREVIEW_CHARS;
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_ARTIFACT_PAGE_SIZE;

  async function ensureParent(path: string) {
    await mkdir(dirname(path), { recursive: true });
  }

  async function writeAtomic(path: string, content: string) {
    await ensureParent(path);
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  }

  function isArtifactNotFoundError(error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  async function loadRecord(artifactId: string): Promise<ArtifactRecord> {
    const metadataPath = resolveArtifactPath(options.rootDir, buildArtifactMetadataKey(artifactId));
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as { ref: unknown; preview: unknown };

    return {
      ref: ArtifactRefSchema.parse(parsed.ref),
      preview: ArtifactPreviewSchema.parse(parsed.preview)
    };
  }

  async function readRange(path: string, offset: number, limit: number) {
    if (limit <= 0) {
      return { content: "", bytesRead: 0 };
    }

    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await file.read(buffer, 0, limit, offset);
      return {
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        bytesRead
      };
    } finally {
      await file.close();
    }
  }

  async function buildReadResult(input: {
    artifactId: string;
    offset?: number;
    limit?: number;
    cursor?: string;
  }): Promise<ArtifactReadResult | null> {
    try {
      const normalized = normalizeArtifactReadQuery(input, defaultPageSize);
      const record = await loadRecord(normalized.artifactId);
      const contentPath = resolveArtifactPath(options.rootDir, record.ref.storageKey);
      const { content, bytesRead } = await readRange(contentPath, normalized.offset, normalized.limit);
      const eof = normalized.offset + bytesRead >= record.ref.byteLength;

      return ArtifactReadResultSchema.parse({
        artifact: record.ref,
        preview: record.preview,
        content,
        range: {
          offset: normalized.offset,
          limit: normalized.limit,
          returned: bytesRead
        },
        eof,
        nextCursor: eof
          ? undefined
          : encodeArtifactCursor({
              artifactId: record.ref.artifactId,
              offset: normalized.offset + bytesRead,
              limit: normalized.limit
            })
      });
    } catch (error) {
      if (isArtifactNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  return {
    async spillArtifact(input) {
      const artifactId = `artifact_${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const paths = buildArtifactPaths({
        rootDir: options.rootDir,
        sessionId: input.sessionId,
        turnId: input.turnId,
        artifactId,
        mimeType: input.mimeType
      });

      const ref = ArtifactRefSchema.parse({
        artifactId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        kind: input.kind,
        storageKey: paths.storageKey,
        mimeType: input.mimeType,
        byteLength: Buffer.byteLength(input.content, "utf8"),
        createdAt
      });
      const preview = createArtifactPreview({
        ref,
        content: input.content,
        maxChars: previewChars
      });

      await writeAtomic(paths.contentPath, input.content);
      await writeAtomic(paths.metadataPath, JSON.stringify({ ref, preview }, null, 2));

      return { ref, preview };
    },

    async getArtifactPreview(ref) {
      try {
        const record = await loadRecord(ref.artifactId);
        return record.preview;
      } catch (error) {
        if (isArtifactNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },

    async readArtifact(query) {
      return buildReadResult(query);
    },

    async queryArtifact(query) {
      return buildReadResult(query);
    }
  };
}
