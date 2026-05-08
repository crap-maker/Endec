import { describe, expect, it } from "vitest";
import { createSessionStore } from "./session-store.ts";

describe("openOrCreateSession", () => {
  it("returns an existing session id when one is provided", async () => {
    const store = createSessionStore({ filename: ":memory:" });
    await store.loadOrCreate({ sessionId: "session_001", workspaceId: "workspace_local", source: "cli" });

    const sessionId = await store.openOrCreateSession({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli"
    });

    expect(sessionId).toBe("session_001");
  });

  it("creates a new session id when the caller has no session id yet", async () => {
    const store = createSessionStore({ filename: ":memory:" });

    const sessionId = await store.openOrCreateSession({
      workspaceId: "workspace_local",
      source: "telegram"
    });

    expect(sessionId.startsWith("session_")).toBe(true);
  });
});
