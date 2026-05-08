import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

describe("SessionWorkingSet", () => {
  it("increments the working-set version on update", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    const first = await store.updateWorkingSet({
      sessionId: "session_001",
      summary: "initial",
      highlights: ["a"],
      sourceRefs: ["turn_001"]
    });
    const second = await store.updateWorkingSet({
      sessionId: "session_001",
      summary: "updated",
      highlights: ["b"],
      sourceRefs: ["turn_002"]
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
  });
});
