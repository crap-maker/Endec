import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactStore } from "./index.ts";

describe("artifact store", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTempDir() {
    const dir = await mkdtemp(join(tmpdir(), "endec-artifacts-"));
    tempDirs.push(dir);
    return dir;
  }

  it("spills content as preview plus ref and supports paged reread via offset/cursor", async () => {
    const rootDir = await createTempDir();
    const store = createArtifactStore({
      rootDir,
      previewChars: 16,
      defaultPageSize: 6
    });

    const content = "alpha\nbeta\ngamma\ndelta";
    const spilled = await store.spillArtifact({
      turnId: "turn_001",
      sessionId: "session_001",
      kind: "tool_result",
      mimeType: "text/plain",
      content
    });

    expect(spilled.ref.storageKey).toMatch(/^artifacts\/session_001\/turn_001\//);
    expect(spilled.ref.storageKey.startsWith(rootDir)).toBe(false);
    expect(spilled.ref.byteLength).toBe(Buffer.byteLength(content, "utf8"));
    expect(spilled.preview).toEqual({
      artifactId: spilled.ref.artifactId,
      ref: spilled.ref,
      previewText: "alpha\nbeta\n",
      truncated: true,
      byteLength: Buffer.byteLength(content, "utf8"),
      sourceRange: {
        offset: 0,
        length: Buffer.byteLength("alpha\nbeta\n", "utf8")
      }
    });

    const firstPage = await store.readArtifact({
      artifactId: spilled.ref.artifactId,
      offset: 0,
      limit: 6
    });

    expect(firstPage).not.toBeNull();
    if (!firstPage) {
      throw new Error("expected spilled artifact read to succeed");
    }

    expect(firstPage).toMatchObject({
      artifact: spilled.ref,
      preview: spilled.preview,
      content: "alpha\n",
      range: {
        offset: 0,
        limit: 6,
        returned: 6
      },
      eof: false
    });
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await store.queryArtifact({
      artifactId: spilled.ref.artifactId,
      cursor: firstPage.nextCursor
    });

    expect(secondPage).not.toBeNull();
    if (!secondPage) {
      throw new Error("expected cursor artifact read to succeed");
    }

    expect(secondPage).toMatchObject({
      artifact: spilled.ref,
      preview: spilled.preview,
      content: "beta\ng",
      range: {
        offset: 6,
        limit: 6,
        returned: 6
      },
      eof: false
    });
    expect(secondPage.nextCursor).toBeTruthy();
  });

  it("reloads preview and full body from durable on-disk metadata after reopening the store", async () => {
    const rootDir = await createTempDir();
    const store = createArtifactStore({ rootDir, previewChars: 12, defaultPageSize: 32 });

    const spilled = await store.spillArtifact({
      turnId: "turn_002",
      sessionId: "session_002",
      kind: "runtime_output",
      mimeType: "application/json",
      content: '{"status":"ok","items":[1,2,3,4]}'
    });

    const reopened = createArtifactStore({ rootDir, previewChars: 12, defaultPageSize: 32 });
    const preview = await reopened.getArtifactPreview({ artifactId: spilled.ref.artifactId });
    const full = await reopened.readArtifact({ artifactId: spilled.ref.artifactId, limit: 64 });

    expect(preview).toEqual(spilled.preview);
    expect(full).not.toBeNull();
    if (!full) {
      throw new Error("expected durable artifact reread to succeed");
    }
    expect(full).toMatchObject({
      artifact: spilled.ref,
      preview: spilled.preview,
      content: '{"status":"ok","items":[1,2,3,4]}',
      eof: true,
      nextCursor: undefined
    });
  });

  it("returns null for missing preview and read lookups instead of surfacing ENOENT", async () => {
    const rootDir = await createTempDir();
    const store = createArtifactStore({ rootDir, defaultPageSize: 16 });

    await expect(store.getArtifactPreview({ artifactId: "artifact_missing" })).resolves.toBeNull();
    await expect(store.readArtifact({ artifactId: "artifact_missing", limit: 16 })).resolves.toBeNull();
  });

  it("rejects cursor queries that do not match the requested artifact id", async () => {
    const rootDir = await createTempDir();
    const store = createArtifactStore({ rootDir, defaultPageSize: 8 });

    const first = await store.spillArtifact({
      turnId: "turn_003",
      sessionId: "session_003",
      kind: "tool_result",
      content: "first artifact body"
    });
    const second = await store.spillArtifact({
      turnId: "turn_004",
      sessionId: "session_003",
      kind: "tool_result",
      content: "second artifact body"
    });
    const page = await store.readArtifact({ artifactId: first.ref.artifactId, offset: 0, limit: 8 });

    expect(page).not.toBeNull();
    if (!page) {
      throw new Error("expected initial artifact page to exist");
    }

    await expect(
      store.queryArtifact({
        artifactId: second.ref.artifactId,
        cursor: page.nextCursor
      })
    ).rejects.toThrow(/artifact id/i);
  });
});
