import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

describe("searchEvidence", () => {
  it("returns matching evidence rows from Endec's own store", async () => {
    const store = createMemoryStore({ filename: ":memory:" });
    await store.appendEvidence({
      evidenceId: "evidence_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      content: "auth migration decision",
      topic: "auth"
    });

    const result = await store.searchEvidence({
      workspaceId: "workspace_local",
      queryText: "auth migration",
      maxItems: 5
    });

    expect(result[0].evidenceId).toBe("evidence_001");
    expect(result[0].sessionId).toBe("session_001");
  });

  it("matches evidence when query terms are present across topic and content", async () => {
    const store = createMemoryStore({ filename: ":memory:" });
    await store.appendEvidence({
      evidenceId: "evidence_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      content: "decision finalized for migration rollout",
      topic: "auth"
    });

    const result = await store.searchEvidence({
      workspaceId: "workspace_local",
      queryText: "auth migration",
      maxItems: 5
    });

    expect(result.map((row) => row.evidenceId)).toContain("evidence_001");
  });

  it("matches topic metadata even when content does not contain the query text", async () => {
    const store = createMemoryStore({ filename: ":memory:" });
    await store.appendEvidence({
      evidenceId: "evidence_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      content: "decision finalized and documented",
      topic: "auth"
    });

    const result = await store.searchEvidence({
      workspaceId: "workspace_local",
      queryText: "auth",
      maxItems: 5
    });

    expect(result.map((row) => row.evidenceId)).toContain("evidence_001");
  });
});
