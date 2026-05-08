import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

describe("retrieve", () => {
  it("returns a working-set summary inside a MemoryContextPack", async () => {
    const store = createMemoryStore({ filename: ":memory:" });
    await store.updateWorkingSet({
      sessionId: "session_001",
      summary: "remember this",
      highlights: ["a"],
      sourceRefs: ["turn_001"]
    });

    const pack = await store.retrieve({
      queryId: "query_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      purpose: "turn_context",
      memoryTypes: ["working_set"],
      maxItems: 5,
      maxInjectTokens: 256
    });

    expect(pack.workingSetSummary).toBe("remember this");
  });
});
