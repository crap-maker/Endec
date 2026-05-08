import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDailyMemoryProjection } from "./daily-memory-renderer.ts";
import { resolveDailyMemoryProjectionPath } from "./memory-file-projection.ts";
import { createMemoryStore } from "./memory-store.ts";
import type { MaterializedTypedMemoryRecord } from "./typed-memory.ts";

const tempDirs = new Set<string>();

async function createTempProjectionDir() {
  const directory = await mkdtemp(join(tmpdir(), "endec-daily-memory-"));
  tempDirs.add(directory);
  return directory;
}

function projectionPath(rootDir: string, workspaceId: string, day: string) {
  return resolveDailyMemoryProjectionPath({ rootDir, workspaceId, day });
}

afterEach(async () => {
  vi.useRealTimers();

  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

function createProjectionRecord(overrides: Partial<MaterializedTypedMemoryRecord>): MaterializedTypedMemoryRecord {
  return {
    memoryId: "typed_memory:session_001:memory_001",
    writeId: "write_001",
    sourceTurnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    taskId: undefined,
    scope: "workspace",
    importance: 0.5,
    kind: "typed_upsert",
    status: "materialized",
    selectionState: "active",
    memoryType: "preference",
    summary: "Default summary",
    content: "summary: Default summary",
    payload: {
      summary: "Default summary"
    },
    evidenceRefs: [],
    borrowedConversationKeys: [],
    transientBorrowed: false,
    createdAt: "2026-04-16T08:30:00.000Z",
    updatedAt: "2026-04-16T08:30:00.000Z",
    ...overrides
  };
}

describe("daily memory projection", () => {
  it("keeps dot-dot workspace ids confined under the projection root", () => {
    const filename = projectionPath("/projection/root", "..", "2026-04-16");
    const relativePath = relative("/projection/root", filename);

    expect(relativePath === ".." || relativePath.startsWith(`..${sep}`)).toBe(false);
    expect(relativePath.split(sep)).toHaveLength(2);
  });

  it("maps dot workspace ids to a distinct workspace directory", () => {
    const filename = projectionPath("/projection/root", ".", "2026-04-16");
    const relativePath = relative("/projection/root", filename);

    expect(relativePath).not.toBe("2026-04-16.md");
    expect(relativePath.split(sep)).toHaveLength(2);
    expect(relativePath.split(sep)[0]).not.toBe(".");
    expect(relativePath.split(sep)[0]).not.toBe("..");
  });

  it("avoids collisions between slash and underscore workspace ids", () => {
    expect(projectionPath("/projection/root", "foo/bar", "2026-04-16")).not.toBe(
      projectionPath("/projection/root", "foo_bar", "2026-04-16")
    );
  });

  it("resolves the same workspace id to the same path every time", () => {
    expect(projectionPath("/projection/root", "foo/bar", "2026-04-16")).toBe(
      projectionPath("/projection/root", "foo/bar", "2026-04-16")
    );
  });

  it("keeps stable projection paths for existing safe workspace ids", () => {
    expect(projectionPath("/projection/root", "workspace_local", "2026-04-16")).toBe(
      join("/projection/root", "workspace_local", "2026-04-16.md")
    );
  });

  it("builds projection-derived refs directly from canonical memory without markdown read-back", () => {
    const built = buildDailyMemoryProjection({
      workspaceId: "workspace_local",
      day: "2026-04-16",
      records: [
        createProjectionRecord({
          memoryId: "typed_memory:session_001:decision:editor",
          writeId: "write_decision_001",
          sourceTurnId: "turn_001",
          taskId: "task_001",
          scope: "workspace",
          importance: 0.9,
          memoryType: "decision",
          summary: "Use helix as the default terminal editor.",
          content: "summary: Use helix as the default terminal editor.\nvalue: helix",
          payload: {
            summary: "Use helix as the default terminal editor.",
            value: "helix"
          },
          evidenceRefs: ["evidence:editor_001", "turn_010"]
        }),
        createProjectionRecord({
          memoryId: "typed_memory:session_001:follow_up:editor-docs",
          writeId: "write_follow_up_001",
          sourceTurnId: "turn_002",
          scope: "workspace",
          importance: 0.8,
          memoryType: "follow_up",
          summary: "Document the terminal editor setup.",
          content: "summary: Document the terminal editor setup.\nnextAction: Add helix setup notes to onboarding.",
          payload: {
            summary: "Document the terminal editor setup.",
            nextAction: "Add helix setup notes to onboarding."
          },
          evidenceRefs: ["turn_011"],
          createdAt: "2026-04-16T08:35:00.000Z",
          updatedAt: "2026-04-16T08:35:00.000Z"
        })
      ]
    });

    expect(built.content).toContain("# Daily Memory Projection");
    expect(built.projectionDerivedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "projection:workspace_local:2026-04-16",
          day: "2026-04-16",
          section: "day",
          sourceRefs: [
            "evidence:editor_001",
            "typed_memory:session_001:decision:editor",
            "typed_memory:session_001:follow_up:editor-docs"
          ],
          turnRefs: ["turn_001", "turn_002", "turn_010", "turn_011"]
        }),
        expect.objectContaining({
          ref: "projection:workspace_local:2026-04-16#decisions",
          day: "2026-04-16",
          section: "decisions",
          summary: "Use helix as the default terminal editor.",
          sourceRefs: ["evidence:editor_001", "typed_memory:session_001:decision:editor"],
          turnRefs: ["turn_001", "turn_010"]
        }),
        expect.objectContaining({
          ref: "projection:workspace_local:2026-04-16#followUps",
          day: "2026-04-16",
          section: "followUps",
          summary: "Document the terminal editor setup.",
          sourceRefs: ["typed_memory:session_001:follow_up:editor-docs"],
          turnRefs: ["turn_002", "turn_011"]
        })
      ])
    );
  });

  it("generates deterministic daily markdown from materialized canonical memory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T08:30:00.000Z"));
    const projectionDir = await createTempProjectionDir();
    const store = createMemoryStore({
      filename: ":memory:",
      dailyMemoryProjectionDir: projectionDir
    });

    await store.enqueueWrites([
      {
        writeId: "write_decision_001",
        sourceTurnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_001"],
        proposedMemoryType: "decision",
        dedupeKey: "decision:editor",
        content: {
          summary: "Use helix as the default terminal editor.",
          value: "helix"
        }
      },
      {
        writeId: "write_follow_up_001",
        sourceTurnId: "turn_002",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_002"],
        proposedMemoryType: "follow_up",
        dedupeKey: "follow_up:editor-docs",
        content: {
          summary: "Document the terminal editor setup.",
          nextAction: "Add helix setup notes to onboarding."
        }
      }
    ]);

    await store.drainOutbox({ maxItems: 10 });

    const markdown = await readFile(
      projectionPath(projectionDir, "workspace_local", "2026-04-16"),
      "utf8"
    );

    expect(markdown).toContain("# Daily Memory Projection");
    expect(markdown).toContain("- workspace_id: workspace_local");
    expect(markdown).toContain("- day: 2026-04-16");
    expect(markdown).toContain("- source: canonical typed memory materialization");
    expect(markdown).toContain("## Decisions");
    expect(markdown).toContain("- [decision] Use helix as the default terminal editor.");
    expect(markdown).toContain("## Follow-ups");
    expect(markdown).toContain("- [follow_up] Document the terminal editor setup.");
    expect(markdown).toContain("## Durable facts / preferences");
    expect(markdown).toContain("_No entries._");
    expect(markdown).toContain("## Source refs / turn refs");
    expect(markdown).toContain("- typed_memory:session_001:decision:editor");
    expect(markdown).toContain("- turn_001");
    expect(markdown).toContain("- turn_002");
  });

  it("updates the same daily file for multiple writes on the same day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T09:00:00.000Z"));
    const projectionDir = await createTempProjectionDir();
    const store = createMemoryStore({
      filename: ":memory:",
      dailyMemoryProjectionDir: projectionDir
    });

    await store.enqueueWrites([
      {
        writeId: "write_pref_001",
        sourceTurnId: "turn_010",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_010"],
        proposedMemoryType: "preference",
        dedupeKey: "preference:editor",
        content: {
          summary: "Preferred editor is helix.",
          value: "helix"
        }
      }
    ]);

    await store.drainOutbox({ maxItems: 10 });

    const sameDayPath = projectionPath(projectionDir, "workspace_local", "2026-04-16");
    const firstVersion = await readFile(sameDayPath, "utf8");

    vi.setSystemTime(new Date("2026-04-16T13:45:00.000Z"));

    await store.enqueueWrites([
      {
        writeId: "write_pref_002",
        sourceTurnId: "turn_011",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_011"],
        proposedMemoryType: "preference",
        dedupeKey: "preference:editor",
        content: {
          summary: "Preferred editor is now neovim.",
          value: "neovim"
        }
      }
    ]);

    await store.drainOutbox({ maxItems: 10 });

    const secondVersion = await readFile(sameDayPath, "utf8");

    expect(firstVersion).toContain("Preferred editor is helix.");
    expect(secondVersion).toContain("Preferred editor is now neovim.");
    expect(secondVersion).not.toContain("Preferred editor is helix.");
  });

  it("adds projection-derived refs to continuity without polluting evidence or top-level source refs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T10:10:00.000Z"));
    const projectionDir = await createTempProjectionDir();
    const store = createMemoryStore({
      filename: ":memory:",
      dailyMemoryProjectionDir: projectionDir
    });

    await store.appendEvidence({
      evidenceId: "evidence:approval_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      topic: "approval",
      content: "Approval is blocking the shell-facing release."
    });

    await store.enqueueWrites([
      {
        writeId: "write_blocker_001",
        sourceTurnId: "turn_020",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["evidence:approval_001", "turn_020"],
        proposedMemoryType: "blocker",
        taskId: "task_approval",
        scope: "workspace",
        importance: 0.95,
        dedupeKey: "blocker:approval",
        content: {
          summary: "Waiting on shell approval for destructive command.",
          blockingReason: "approval required"
        }
      }
    ]);

    await store.drainOutbox({ maxItems: 10 });

    const pack = await store.retrieve({
      queryId: "query_projection_refs_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      purpose: "turn_context",
      memoryTypes: ["typed_memory", "evidence"],
      maxItems: 10,
      maxInjectTokens: 256,
      queryText: "approval"
    });

    expect(pack.continuity?.projectionDerivedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "projection:workspace_local:2026-04-16",
          section: "day",
          sourceRefs: ["evidence:approval_001", "typed_memory:session_001:blocker:approval"],
          turnRefs: ["turn_020"]
        }),
        expect.objectContaining({
          ref: "projection:workspace_local:2026-04-16#blockers",
          section: "blockers",
          sourceRefs: ["evidence:approval_001", "typed_memory:session_001:blocker:approval"],
          turnRefs: ["turn_020"]
        })
      ])
    );
    expect(pack.continuity?.evidence).toEqual([
      expect.objectContaining({
        ref: "evidence:approval_001",
        topic: "approval"
      })
    ]);
    expect(pack.continuity?.typedMemory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryType: "blocker"
        })
      ])
    );
    expect(pack.sourceRefs).toContain("evidence:approval_001");
    expect(pack.sourceRefs).toContain("typed_memory:session_001:blocker:approval");
    expect(pack.sourceRefs.some((ref) => ref.startsWith("projection:"))).toBe(false);
    expect(pack.continuity?.evidence.some((item) => item.ref?.startsWith("projection:"))).toBe(false);
    expect(pack.continuity?.typedMemory.some((item) => item.sourceRefs.some((ref) => ref.startsWith("projection:")))).toBe(false);
    expect(pack.contextBlocks?.some((block) => block.content.includes("projection:"))).toBe(false);
  });

  it("rewrites arbitrary markdown into canonical projection structure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T10:15:00.000Z"));
    const projectionDir = await createTempProjectionDir();
    const targetPath = projectionPath(projectionDir, "workspace_local", "2026-04-16");
    const store = createMemoryStore({
      filename: ":memory:",
      dailyMemoryProjectionDir: projectionDir
    });

    await mkdir(join(projectionDir, "workspace_local"), { recursive: true });
    await writeFile(targetPath, "# arbitrary notes\n\nthis should be replaced\n", "utf8");

    await store.enqueueWrites([
      {
        writeId: "write_blocker_001",
        sourceTurnId: "turn_020",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_020"],
        proposedMemoryType: "blocker",
        dedupeKey: "blocker:approval",
        content: {
          summary: "Waiting on shell approval for destructive command.",
          blockingReason: "approval required"
        }
      }
    ]);

    await store.drainOutbox({ maxItems: 10 });

    const markdown = await readFile(targetPath, "utf8");

    expect(markdown).not.toContain("arbitrary notes");
    expect(markdown).toContain("## Blockers");
    expect(markdown).toContain("- [blocker] Waiting on shell approval for destructive command.");
    expect(markdown).toContain("approval required");
  });

  it("ignores manual markdown edits when serving projection-derived continuity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T10:45:00.000Z"));
    const projectionDir = await createTempProjectionDir();
    const targetPath = projectionPath(projectionDir, "workspace_local", "2026-04-16");
    const store = createMemoryStore({
      filename: ":memory:",
      dailyMemoryProjectionDir: projectionDir
    });

    await store.enqueueWrites([
      {
        writeId: "write_pref_003",
        sourceTurnId: "turn_030",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_030"],
        proposedMemoryType: "preference",
        scope: "workspace",
        importance: 0.7,
        dedupeKey: "preference:shell",
        content: {
          summary: "Preferred shell is fish.",
          value: "fish"
        }
      }
    ]);

    await store.drainOutbox({ maxItems: 10 });
    await writeFile(
      targetPath,
      [
        "# hand edited notes",
        "",
        "- fake source ref: typed_memory:session_fake:fake",
        "- fake turn ref: turn_fake"
      ].join("\n"),
      "utf8"
    );

    const pack = await store.retrieve({
      queryId: "query_projection_refs_002",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      purpose: "turn_context",
      memoryTypes: ["typed_memory", "evidence"],
      maxItems: 10,
      maxInjectTokens: 256
    });

    expect(pack.continuity?.projectionDerivedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "projection:workspace_local:2026-04-16",
          sourceRefs: ["typed_memory:session_001:preference:shell"],
          turnRefs: ["turn_030"]
        })
      ])
    );
    expect(pack.sourceRefs).toContain("typed_memory:session_001:preference:shell");
    expect(pack.sourceRefs).not.toContain("typed_memory:session_fake:fake");
    expect(pack.sourceRefs).not.toContain("turn_fake");
    expect(pack.continuity?.projectionDerivedRefs.some((ref) => ref.sourceRefs.includes("typed_memory:session_fake:fake") || ref.turnRefs.includes("turn_fake"))).toBe(false);
  });

  it("keeps durable truth committed when markdown projection fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T11:00:00.000Z"));
    const projectionDir = await createTempProjectionDir();
    await writeFile(join(projectionDir, "workspace_local"), "not-a-directory", "utf8");
    const store = createMemoryStore({
      filename: ":memory:",
      dailyMemoryProjectionDir: projectionDir
    });

    await store.enqueueWrites([
      {
        writeId: "write_truth_001",
        sourceTurnId: "turn_030",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_030"],
        proposedMemoryType: "preference",
        dedupeKey: "preference:shell",
        content: {
          summary: "Preferred shell is fish.",
          value: "fish"
        }
      }
    ]);

    const drain = await store.drainOutbox({ maxItems: 10 });
    const outbox = await store.listOutbox();
    const typedMemory = await store.listTypedMemory({
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });

    expect(drain).toMatchObject({
      processedCount: 1,
      failedCount: 0
    });
    expect(outbox).toEqual([
      expect.objectContaining({
        writeId: "write_truth_001",
        status: "processed"
      })
    ]);
    expect(typedMemory).toEqual([
      expect.objectContaining({
        writeId: "write_truth_001",
        summary: "Preferred shell is fish."
      })
    ]);
  });
});
