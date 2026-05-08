import { describe, expect, it } from "vitest";
import { createSessionStore } from "./session-store.ts";

describe("inflight guard", () => {
  it("rejects a second recoverable inflight turn for the same session", async () => {
    const store = createSessionStore({ filename: ":memory:" });
    await store.loadOrCreate({ sessionId: "session_001", workspaceId: "workspace_local", source: "cli" });
    await store.markInflight({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      pendingApprovalRef: "approval_001"
    });

    await expect(() =>
      store.markInflight({
        turnId: "turn_002",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        state: "awaiting_permission",
        waitingReason: "permission",
        resumePolicy: "resume",
        pendingApprovalRef: "approval_002"
      })
    ).rejects.toThrow(/open recoverable inflight/i);
  });
});
