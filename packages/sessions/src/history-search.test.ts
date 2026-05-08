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

describe("searchSessionEvents", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("searches committed session events without becoming memory search", async () => {
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
      input: "find the blocked approval turn",
      attachments: []
    });
    await store.loadOrCreate({
      turnId: "turn_002",
      sessionId: "session_002",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_user",
      input: "another session",
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
      currentGoal: "Recover blocked approval turn",
      createdAt: "2026-04-09T13:00:00.000Z",
      events: [
        {
          eventId: "event_001",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T13:00:00.000Z",
          summary: "Assistant found the blocked approval turn.",
          text: "I found the blocked approval turn and its recovery checkpoint.",
          sourceRefs: ["memory:resume-001"]
        },
        {
          eventId: "event_002",
          eventKind: "tool_result",
          createdAt: "2026-04-09T13:00:05.000Z",
          summary: "Tool returned the diff artifact link.",
          text: "Diff artifact stored for recovery review.",
          artifactRefs: [
            {
              artifactId: "artifact_001",
              sessionId: "session_001",
              turnId: "turn_001",
              kind: "tool_result",
              storageKey: "artifacts/session_001/turn_001/diff.txt",
              byteLength: 5120,
              createdAt: "2026-04-09T13:00:05.000Z"
            }
          ]
        }
      ]
    });

    await store.commitTurn({
      turnId: "turn_002",
      sessionId: "session_002",
      workspaceId: "workspace_local",
      source: "telegram",
      mode: "chat",
      status: "completed",
      sessionStatus: "waiting_input",
      currentGoal: "Small talk",
      createdAt: "2026-04-09T13:30:00.000Z",
      events: [
        {
          eventId: "event_003",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T13:30:00.000Z",
          summary: "Assistant chatted casually.",
          text: "Just a casual conversation."
        }
      ]
    });

    const results = await queries.searchSessionEvents({
      workspaceId: "workspace_local",
      queryText: "blocked approval turn",
      eventKinds: ["assistant_message"],
      limit: 10
    });

    expect(results.hits).toHaveLength(1);
    expect(results.hits[0]?.sessionId).toBe("session_001");
    expect(results.hits[0]?.snippet.toLowerCase()).toContain("blocked approval turn");
    expect(results.hits[0]?.sourceRefs).toEqual(["memory:resume-001"]);
    expect(results.hits[0]?.artifactRefs).toBeUndefined();
  });

  it("paginates search results in reverse chronological order", async () => {
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
      currentGoal: "Recover blocked turns",
      createdAt: "2026-04-09T14:00:00.000Z",
      events: [
        {
          eventId: "event_001",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T14:00:00.000Z",
          summary: "Assistant recovered the first blocked turn.",
          text: "Recovered blocked turn turn_001."
        },
        {
          eventId: "event_002",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T14:10:00.000Z",
          summary: "Assistant recovered the second blocked turn.",
          text: "Recovered blocked turn turn_002."
        }
      ]
    });

    const firstPage = await queries.searchSessionEvents({
      workspaceId: "workspace_local",
      sessionId: "session_001",
      queryText: "recovered blocked turn",
      limit: 1
    });

    expect(firstPage.hits.map((hit) => hit.eventId)).toEqual(["event_002"]);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await queries.searchSessionEvents({
      workspaceId: "workspace_local",
      sessionId: "session_001",
      queryText: "recovered blocked turn",
      limit: 1,
      cursor: firstPage.nextCursor
    });

    expect(secondPage.hits.map((hit) => hit.eventId)).toEqual(["event_001"]);
  });

  it("rejects invalid search cursors instead of silently returning the first page", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const queries = createSessionQueryStore({ filename: db.filename });

    await expect(
      queries.searchSessionEvents({
        workspaceId: "workspace_local",
        queryText: "blocked turn",
        limit: 1,
        cursor: "not-a-valid-cursor"
      })
    ).rejects.toThrow(/invalid .*cursor/i);
  });
});
