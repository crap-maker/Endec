import { describe, expect, it } from "vitest";
import { createSessionStore } from "./session-store.ts";

describe("loadRecoveryContext", () => {
  it("returns inflight + session continuity refs for a blocked turn", async () => {
    const sessions = createSessionStore({ filename: ":memory:" });
    await sessions.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });
    await sessions.markInflight({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      pendingApprovalRef: "approval_001"
    });

    const recovery = await sessions.loadRecoveryContext("session_001");
    expect(recovery?.inflight.turnId).toBe("turn_001");
    expect(recovery?.inflight.waitingReason).toBe("permission");
    expect(recovery?.session.sessionId).toBe("session_001");
    expect(recovery?.session.workingSetRef).toBe("working_set:initial");
    expect(Array.isArray(recovery?.session.activeTaskIds)).toBe(true);
    expect(Array.isArray(recovery?.session.recentTurnRefs)).toBe(true);
    expect(recovery?.checkpointRef).toBe("checkpoint:turn_001");
  });
});
