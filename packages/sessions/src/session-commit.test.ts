import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionQueryStore } from "./query-store.ts";
import { createSessionStore } from "./session-store.ts";

function createDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "endec-sessions-"));
  return {
    filename: join(dir, `${randomUUID()}.sqlite`),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

describe("commitTurn", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("persists committed turn truth and updates session continuity refs", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "Recover the blocked turn",
      attachments: []
    });

    await store.commitTurn({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "task",
      status: "completed",
      sessionStatus: "active",
      currentGoal: "Recover blocked session state",
      createdAt: "2026-04-09T10:00:00.000Z",
      events: [
        {
          eventId: "event_001",
          eventKind: "user_message",
          createdAt: "2026-04-09T10:00:00.000Z",
          summary: "User asked to recover a blocked turn.",
          text: "recover the blocked turn from this morning"
        },
        {
          eventId: "event_002",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T10:00:01.000Z",
          summary: "Assistant found the blocked turn and checkpoint.",
          text: "I found blocked turn turn_001 with checkpoint checkpoint:turn_001",
          sourceRefs: ["memory:work-item-1"]
        }
      ]
    });

    const session = await store.loadById("session_001");
    expect(session?.mode).toBe("task");
    expect(session?.status).toBe("active");
    expect(session?.currentGoal).toBe("Recover blocked session state");
    expect(session?.recentTurnRefs).toEqual(["turn_001"]);
    expect(session?.lastEventSeq).toBe(2);
    expect(session?.lastTurnAt).toBe("2026-04-09T10:00:00.000Z");
  });

  it("appends continuation truth when the same blocked turn later completes", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "Recover the blocked turn",
      attachments: []
    });

    await store.commitTurn({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "task",
      status: "blocked",
      sessionStatus: "waiting_input",
      currentGoal: "Recover blocked session state",
      createdAt: "2026-04-09T10:00:00.000Z",
      events: [
        {
          eventId: "turn_001:user",
          eventKind: "user_message",
          createdAt: "2026-04-09T10:00:00.000Z",
          summary: "User asked to resume work.",
          text: "resume the blocked turn"
        },
        {
          eventId: "turn_001:warning:0",
          eventKind: "warning",
          createdAt: "2026-04-09T10:00:01.000Z",
          summary: "soft_limit",
          text: "soft_limit"
        }
      ]
    });

    await store.commitTurn({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "task",
      status: "completed",
      sessionStatus: "active",
      currentGoal: "Recover blocked session state",
      createdAt: "2026-04-09T10:05:00.000Z",
      events: [
        {
          eventId: "turn_001:user",
          eventKind: "user_message",
          createdAt: "2026-04-09T10:05:00.000Z",
          summary: "Operator resumed the blocked turn.",
          text: "continue after the budget stop"
        },
        {
          eventId: "turn_001:message:0",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T10:05:01.000Z",
          summary: "Assistant resumed work.",
          text: "resume completed successfully"
        }
      ]
    });

    const session = await store.loadById("session_001");
    const history = await queries.browseSessionHistory({
      sessionId: "session_001",
      limit: 10
    });
    const latest = await queries.lookupSessionEvent({
      sessionId: "session_001",
      turnId: "turn_001"
    });

    expect(session).toMatchObject({
      status: "active",
      recentTurnRefs: ["turn_001"],
      lastEventSeq: 4,
      lastTurnAt: "2026-04-09T10:05:00.000Z"
    });
    expect(history.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: "turn_001",
          eventKind: "assistant_message",
          summary: "Assistant resumed work."
        }),
        expect.objectContaining({
          turnId: "turn_001",
          eventKind: "warning",
          summary: "soft_limit"
        })
      ])
    );
    expect(latest.entry).toMatchObject({
      turnId: "turn_001",
      eventKind: "assistant_message",
      summary: "Assistant resumed work."
    });
  });

  it("is idempotent for a committed turn id", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "Recover the blocked turn",
      attachments: []
    });

    const input = {
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli" as const,
      mode: "task" as const,
      status: "completed" as const,
      sessionStatus: "active" as const,
      currentGoal: "Recover blocked session state",
      createdAt: "2026-04-09T10:00:00.000Z",
      events: [
        {
          eventId: "event_001",
          eventKind: "assistant_message" as const,
          createdAt: "2026-04-09T10:00:01.000Z",
          summary: "Assistant found the blocked turn and checkpoint.",
          text: "I found blocked turn turn_001 with checkpoint checkpoint:turn_001"
        }
      ]
    };

    await store.commitTurn(input);
    await store.commitTurn(input);

    const session = await store.loadById("session_001");
    expect(session?.recentTurnRefs).toEqual(["turn_001"]);
    expect(session?.lastEventSeq).toBe(1);
  });
});
