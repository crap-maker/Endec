import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

describe("drainOutbox", () => {
  it("materializes durable typed memory and evidence from outbox work items", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await store.enqueueWrites([
      {
        writeId: "write_extract_001",
        sourceTurnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "candidate_extract",
        evidenceRefs: ["turn_001"],
        proposedMemoryType: "turn_summary",
        content: {
          summary: "User prefers helix for terminal editing.",
          topic: "editor_preference",
          evidence: "The user said they prefer helix for terminal editing."
        }
      },
      {
        writeId: "write_upsert_001",
        sourceTurnId: "turn_002",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_001", "turn_002"],
        proposedMemoryType: "preference",
        dedupeKey: "preference:editor",
        content: {
          summary: "Preferred editor is helix.",
          value: "helix"
        }
      }
    ]);

    const drain = await store.drainOutbox({ maxItems: 10 });
    const outbox = await store.listOutbox();
    const typedMemory = await store.listTypedMemory({
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });
    const evidence = await store.searchEvidence({
      workspaceId: "workspace_local",
      queryText: "helix editor",
      maxItems: 10
    });
    const retrieved = await store.retrieve({
      query: {
        queryId: "query_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        purpose: "turn_context",
        memoryTypes: ["typed_memory", "evidence"],
        queryText: "helix editor",
        maxItems: 10,
        maxInjectTokens: 256
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      }
    });

    expect(drain).toMatchObject({
      processedCount: 2,
      failedCount: 0
    });
    expect(outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          writeId: "write_extract_001",
          status: "processed"
        }),
        expect.objectContaining({
          writeId: "write_upsert_001",
          status: "processed"
        })
      ])
    );
    expect(typedMemory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          writeId: "write_extract_001",
          memoryType: "turn_summary",
          kind: "candidate_extract",
          summary: expect.stringContaining("helix")
        }),
        expect.objectContaining({
          memoryId: "typed_memory:session_001:preference:editor",
          writeId: "write_upsert_001",
          memoryType: "preference",
          kind: "typed_upsert",
          summary: expect.stringContaining("Preferred editor is helix")
        })
      ])
    );
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "editor_preference",
          content: expect.stringContaining("helix")
        })
      ])
    );
    expect(retrieved.continuity?.typedMemory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "workspace",
          memoryType: "preference",
          payload: expect.objectContaining({
            summary: expect.stringContaining("Preferred editor is helix")
          })
        })
      ])
    );
    const preferenceBlock = retrieved.contextBlocks?.find(
      (block) => block.title === "workspace durable memory" && block.content.includes("Preferred editor is helix.")
    );
    expect(preferenceBlock?.content.match(/Preferred editor is helix\./g)).toHaveLength(1);
    expect(preferenceBlock?.content).toContain("value: helix");
    expect(retrieved.continuity?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "editor_preference",
          content: expect.stringContaining("helix")
        })
      ])
    );
  });

  it("marks failed materialization attempts without losing durable enqueue truth", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await store.enqueueWrites([
      {
        writeId: "write_bad_001",
        sourceTurnId: "turn_bad",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_bad"],
        proposedMemoryType: "preference"
      }
    ]);

    const drain = await store.drainOutbox({ maxItems: 10 });
    const outbox = await store.listOutbox();
    const typedMemory = await store.listTypedMemory({
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });

    expect(drain).toMatchObject({
      processedCount: 0,
      failedCount: 1
    });
    expect(outbox).toEqual([
      expect.objectContaining({
        writeId: "write_bad_001",
        status: "failed",
        processedAt: null,
        attemptCount: 1,
        lastError: expect.stringContaining("materializable content")
      })
    ]);
    expect(typedMemory).toEqual([]);
  });
});
