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

describe("session browse/read model", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("lists recent sessions and paginates session history from committed event truth", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_alpha",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "first",
      attachments: []
    });
    await store.loadOrCreate({
      turnId: "turn_002",
      sessionId: "session_beta",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_user",
      input: "second",
      attachments: []
    });

    await store.commitTurn({
      turnId: "turn_001",
      sessionId: "session_alpha",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "task",
      status: "completed",
      sessionStatus: "active",
      currentGoal: "Recover morning session",
      createdAt: "2026-04-09T10:00:00.000Z",
      events: [
        {
          eventId: "event_001",
          eventKind: "user_message",
          createdAt: "2026-04-09T10:00:00.000Z",
          summary: "User asked for recovery.",
          text: "recover the blocked turn from this morning"
        },
        {
          eventId: "event_002",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T10:00:05.000Z",
          summary: "Assistant located the blocked turn.",
          text: "I found the blocked turn turn_001 and checkpoint checkpoint:turn_001",
          sourceRefs: ["memory:write-001"]
        }
      ]
    });

    await store.commitTurn({
      turnId: "turn_002",
      sessionId: "session_beta",
      workspaceId: "workspace_local",
      source: "telegram",
      mode: "chat",
      status: "completed",
      sessionStatus: "waiting_input",
      currentGoal: "Review latest artifact",
      createdAt: "2026-04-09T11:00:00.000Z",
      events: [
        {
          eventId: "event_003",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T11:00:00.000Z",
          summary: "Assistant linked the generated artifact preview.",
          text: "Here is the generated artifact preview for the latest run.",
          artifactRefs: [
            {
              artifactId: "artifact_001",
              sessionId: "session_beta",
              turnId: "turn_002",
              kind: "tool_result",
              storageKey: "artifacts/session_beta/turn_002/output.txt",
              byteLength: 2048,
              createdAt: "2026-04-09T11:00:00.000Z"
            }
          ],
          sourceRefs: ["memory:write-002"]
        }
      ]
    });

    const sessions = await queries.listSessions({
      workspaceId: "workspace_local",
      limit: 1
    });

    expect(sessions.items).toHaveLength(1);
    expect(sessions.items[0]?.sessionId).toBe("session_beta");
    expect(sessions.items[0]?.source).toBe("telegram");
    expect(sessions.nextCursor).toBeTruthy();

    const nextPage = await queries.listSessions({
      workspaceId: "workspace_local",
      limit: 1,
      cursor: sessions.nextCursor
    });

    expect(nextPage.items.map((item) => item.sessionId)).toEqual(["session_alpha"]);

    const firstHistoryPage = await queries.browseSessionHistory({
      sessionId: "session_alpha",
      limit: 1
    });

    expect(firstHistoryPage.items).toHaveLength(1);
    expect(firstHistoryPage.items[0]?.eventId).toBe("event_002");
    expect(firstHistoryPage.items[0]?.sourceRefs).toEqual(["memory:write-001"]);
    expect(firstHistoryPage.nextCursor).toBeTruthy();

    const secondHistoryPage = await queries.browseSessionHistory({
      sessionId: "session_alpha",
      limit: 1,
      cursor: firstHistoryPage.nextCursor
    });

    expect(secondHistoryPage.items.map((item) => item.eventId)).toEqual(["event_001"]);

    const beforeTurn = await queries.browseSessionHistory({
      sessionId: "session_beta",
      beforeTurnId: "turn_002",
      limit: 5
    });

    expect(beforeTurn.items).toEqual([]);
  });

  it("supports recovery-oriented lookup by turn id or event id", async () => {
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
      input: "recover",
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
      createdAt: "2026-04-09T12:00:00.000Z",
      events: [
        {
          eventId: "event_001",
          eventKind: "user_message",
          createdAt: "2026-04-09T12:00:00.000Z",
          summary: "User asked to resume work.",
          text: "resume the blocked turn"
        },
        {
          eventId: "event_002",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T12:00:03.000Z",
          summary: "Assistant found the exact blocked turn.",
          text: "blocked turn turn_001 is ready to resume",
          sourceRefs: ["memory:resume-001"]
        }
      ]
    });

    const byTurn = await queries.lookupSessionEvent({
      sessionId: "session_001",
      turnId: "turn_001"
    });

    expect(byTurn.entry?.eventId).toBe("event_002");
    expect(byTurn.entry?.turnId).toBe("turn_001");

    const byEvent = await queries.lookupSessionEvent({
      sessionId: "session_001",
      eventId: "event_001"
    });

    expect(byEvent.entry?.summary).toBe("User asked to resume work.");
  });

  it("does not expose write-side session state getters on the query surface", () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const queries = createSessionQueryStore({ filename: db.filename });

    expect(queries).not.toHaveProperty("getSession");
  });

  it("rejects invalid list and history cursors instead of silently paging from the beginning", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const queries = createSessionQueryStore({ filename: db.filename });

    await expect(
      queries.listSessions({
        workspaceId: "workspace_local",
        limit: 1,
        cursor: "not-a-valid-cursor"
      })
    ).rejects.toThrow(/invalid .*cursor/i);

    await expect(
      queries.browseSessionHistory({
        sessionId: "session_001",
        limit: 1,
        cursor: "not-a-valid-cursor"
      })
    ).rejects.toThrow(/invalid .*cursor/i);
  });
});
