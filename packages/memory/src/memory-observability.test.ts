import type { ActiveTaskSnapshot, MemoryWriteRequest } from "@endec/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

const sessionId = "session_001";
const workspaceId = "workspace_local";

function createWrite(
  overrides: Omit<Partial<MemoryWriteRequest>, "scope" | "workspaceId"> & {
    writeId: string;
    sourceTurnId: string;
    writeKind: MemoryWriteRequest["writeKind"];
    scope?: string;
    workspaceId?: string;
    actorId?: string;
  }
): MemoryWriteRequest {
  return {
    writeId: overrides.writeId,
    sourceTurnId: overrides.sourceTurnId,
    sessionId: overrides.sessionId ?? sessionId,
    workspaceId: overrides.workspaceId ?? workspaceId,
    actorId: overrides.actorId,
    writeKind: overrides.writeKind,
    evidenceRefs: overrides.evidenceRefs ?? [overrides.sourceTurnId],
    taskId: overrides.taskId,
    scope: overrides.scope as MemoryWriteRequest["scope"],
    proposedMemoryType: overrides.proposedMemoryType,
    importance: overrides.importance,
    dedupeKey: overrides.dedupeKey,
    metadata: overrides.metadata,
    content: overrides.content ?? {
      summary: overrides.writeId,
      evidence: `${overrides.writeId} evidence`
    }
  };
}

function createRequestedTask(taskId: string): Omit<ActiveTaskSnapshot, "selectedBy"> {
  return {
    taskId,
    title: `Task ${taskId}`,
    status: "active",
    checkpointRef: `checkpoint:${taskId}`,
    currentStep: `continue ${taskId}`,
    nextAction: `advance ${taskId}`,
    updatedAt: "2026-04-17T09:00:00.000Z"
  };
}

async function materializeWrite(store: ReturnType<typeof createMemoryStore>, write: MemoryWriteRequest, at: string) {
  vi.setSystemTime(new Date(at));
  await store.enqueueWrites([write]);
  await store.drainOutbox({ maxItems: 1 });
}

describe("memory observability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports ordinary-route durable memory selection with scopes, buckets, ranks, and not-chosen candidates", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_workspace_fact",
      sourceTurnId: "turn_workspace_fact",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "fact",
      importance: 0.8,
      content: { summary: "Workspace fact: CI lives in .github/workflows/test.yml." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_preference",
      sourceTurnId: "turn_user_preference",
      writeKind: "typed_upsert",
      scope: "user",
      workspaceId: "workspace_other",
      actorId: "actor_cli",
      proposedMemoryType: "preference",
      importance: 0.7,
      content: { summary: "User preference: keep verification reports concise." }
    }), "2026-04-17T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_session_follow_up",
      sourceTurnId: "turn_session_follow_up",
      writeKind: "typed_upsert",
      taskId: "task_scope_freeze",
      proposedMemoryType: "follow_up",
      importance: 0.9,
      content: { summary: "Session note: land the scope freeze before cleanup." }
    }), "2026-04-17T09:02:00.000Z");

    const result = await store.retrieve({
      query: {
        queryId: "query_observability_ordinary",
        sessionId,
        workspaceId,
        actorId: "actor_cli",
        purpose: "turn_context",
        memoryTypes: ["typed_memory"],
        maxItems: 2,
        maxInjectTokens: 256,
        queryText: "Which rule should I follow in this workspace right now?"
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      },
      activeTasks: []
    });

    const observability = (result as { observability?: any }).observability;

    expect(observability.durableMemory).toMatchObject({
      route: "ordinary",
      preferredScopes: ["workspace", "user", "session"],
      preferredFamilies: ["fact", "preference", "procedural", "continuity"]
    });
    expect(observability.durableMemory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "workspace",
        memoryType: "fact",
        family: "fact",
        bucket: "fact",
        rank: 1,
        selectionStatus: "selected"
      }),
      expect.objectContaining({
        scope: "user",
        memoryType: "preference",
        family: "preference",
        bucket: "preference",
        rank: 2,
        selectionStatus: "selected"
      }),
      expect.objectContaining({
        scope: "session",
        memoryType: "follow_up",
        family: "continuity",
        bucket: "open_loop",
        selectionStatus: "not-chosen",
        reasons: ["ranked_below_limit"]
      })
    ]));
  });

  it("reports continuation-route durable memory selection and explains when actor scope drops user memory", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_task_continuity",
      sourceTurnId: "turn_task_continuity",
      writeKind: "typed_upsert",
      taskId: "task_lane2",
      proposedMemoryType: "task_continuity",
      importance: 0.9,
      content: { summary: "Task lane2 is mid-migration and needs the selector finished next." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_workspace_procedural",
      sourceTurnId: "turn_workspace_procedural",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "procedural",
      importance: 0.8,
      content: { summary: "Workspace rule: run memory package tests before app package tests." }
    }), "2026-04-17T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_preference",
      sourceTurnId: "turn_user_preference",
      writeKind: "typed_upsert",
      scope: "user",
      workspaceId: "workspace_other",
      actorId: "actor_cli",
      proposedMemoryType: "preference",
      importance: 0.95,
      content: { summary: "User preference: keep reports concise." }
    }), "2026-04-17T09:02:00.000Z");

    const result = await store.retrieve({
      query: {
        queryId: "query_observability_continuation",
        sessionId,
        workspaceId,
        actorId: "actor_other",
        purpose: "turn_context",
        memoryTypes: ["typed_memory"],
        maxItems: 2,
        maxInjectTokens: 256,
        queryText: "Continue the current task from the checkpoint.",
        taskId: "task_lane2",
        resumeFrom: "checkpoint:task_lane2"
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      },
      requestedTask: createRequestedTask("task_lane2"),
      activeTasks: []
    });

    const observability = (result as { observability?: any }).observability;

    expect(observability.durableMemory).toMatchObject({
      route: "continuation",
      preferredScopes: ["session", "workspace", "user"],
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "blocker", "open_loop", "decision"]
    });
    expect(observability.durableMemory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "session",
        memoryType: "task_continuity",
        family: "continuity",
        bucket: "task_continuity",
        rank: 1,
        selectionStatus: "selected",
        reasons: ["matched_selected_task"]
      }),
      expect.objectContaining({
        scope: "workspace",
        memoryType: "procedural",
        family: "procedural",
        bucket: "procedural",
        rank: 2,
        selectionStatus: "selected"
      }),
      expect.objectContaining({
        scope: "user",
        memoryType: "preference",
        family: "preference",
        bucket: "preference",
        selectionStatus: "scope-mismatch",
        reasons: ["actor_scope_mismatch"]
      })
    ]));
  });
});
