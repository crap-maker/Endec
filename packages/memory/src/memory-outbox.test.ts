import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

describe("memory_outbox", () => {
  it("durably enqueues a candidate_extract write", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await store.enqueueWrites([
      {
        writeId: "write_001",
        sourceTurnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "candidate_extract",
        evidenceRefs: ["turn_001"]
      }
    ]);

    const rows = await store.listOutbox();

    expect(rows).toHaveLength(1);
    expect(rows[0].writeId).toBe("write_001");
  });
});
