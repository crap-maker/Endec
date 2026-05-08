import { describe, expect, it } from "vitest";
import { createSessionStore } from "./session-store.ts";

describe("session focus-run persistence", () => {
  it("stores and clears focus run truth without disturbing continuity fields", async () => {
    const store = createSessionStore({ filename: ":memory:" });
    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    await expect(store.setFocusRun({
      sessionId: "session_001",
      taskId: "task_001",
      runId: "run_001",
      now: "2026-04-30T00:00:01.000Z"
    })).resolves.toMatchObject({
      taskId: "task_001",
      runId: "run_001",
      updatedAt: "2026-04-30T00:00:01.000Z"
    });

    await expect(store.loadFocusRun("session_001")).resolves.toMatchObject({
      taskId: "task_001",
      runId: "run_001"
    });
    await expect(store.loadById("session_001")).resolves.toMatchObject({
      recentTurnRefs: [],
      activeTaskIds: [],
      focusTaskId: "task_001",
      focusRunId: "run_001"
    });

    await expect(store.clearFocusRun({
      sessionId: "session_001",
      now: "2026-04-30T00:00:02.000Z"
    })).resolves.toBeUndefined();
    await expect(store.loadById("session_001")).resolves.toMatchObject({
      recentTurnRefs: [],
      activeTaskIds: [],
      focusTaskId: undefined,
      focusRunId: undefined
    });
  });

  it("setFocusRun returns undefined when the session row does not exist", async () => {
    const store = createSessionStore({ filename: ":memory:" });

    await expect(store.setFocusRun({
      sessionId: "session_missing",
      taskId: "task_001",
      runId: "run_001",
      now: "2026-04-30T00:00:01.000Z"
    })).resolves.toBeUndefined();
    await expect(store.loadFocusRun("session_missing")).resolves.toBeUndefined();
  });

  it("clearFocusRun returns undefined when the session row does not exist", async () => {
    const store = createSessionStore({ filename: ":memory:" });

    await expect(store.clearFocusRun({
      sessionId: "session_missing",
      now: "2026-04-30T00:00:02.000Z"
    })).resolves.toBeUndefined();
  });
});
