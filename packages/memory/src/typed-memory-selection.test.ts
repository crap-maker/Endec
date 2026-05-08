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
    conversationBoundaryKey: overrides.conversationBoundaryKey,
    disclosureMode: overrides.disclosureMode,
    targetConversationKeys: overrides.targetConversationKeys,
    borrowedConversationKeys: overrides.borrowedConversationKeys,
    transientBorrowed: overrides.transientBorrowed,
    visibility: overrides.visibility,
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

async function retrieveTypedMemory(
  store: ReturnType<typeof createMemoryStore>,
  input?: {
    maxItems?: number;
    queryText?: string;
    taskId?: string;
    resumeFrom?: string;
    actorId?: string;
    workspaceId?: string;
    sessionId?: string;
    scopeFilter?: string;
    requestedTask?: Omit<ActiveTaskSnapshot, "selectedBy">;
    activeTasks?: Array<Omit<ActiveTaskSnapshot, "selectedBy">>;
  }
) {
  const result = await store.retrieve({
    query: {
      queryId: "query_001",
      sessionId: input?.sessionId ?? sessionId,
      workspaceId: input?.workspaceId ?? workspaceId,
      actorId: input?.actorId,
      purpose: "turn_context",
      memoryTypes: ["typed_memory"],
      maxItems: input?.maxItems ?? 3,
      maxInjectTokens: 256,
      queryText: input?.queryText,
      taskId: input?.taskId,
      resumeFrom: input?.resumeFrom,
      scopeFilter: input?.scopeFilter as MemoryWriteRequest["scope"]
    },
    recentHistory: {
      summary: "",
      refs: [],
      turnRefs: []
    },
    requestedTask: input?.requestedTask,
    activeTasks: input?.activeTasks ?? []
  });

  return result.continuity?.typedMemory ?? [];
}

describe("typed memory selection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefers fact/preference/procedural buckets on the ordinary route instead of filling with episodic noise", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_fact",
      sourceTurnId: "turn_fact",
      writeKind: "typed_upsert",
      proposedMemoryType: "fact",
      importance: 0.8,
      content: { summary: "Primary deploy target is canary-cluster-1." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_preference",
      sourceTurnId: "turn_preference",
      writeKind: "typed_upsert",
      proposedMemoryType: "preference",
      importance: 0.7,
      dedupeKey: "preference:editor",
      content: { summary: "Preferred editor is helix." }
    }), "2026-04-17T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_procedural",
      sourceTurnId: "turn_procedural",
      writeKind: "typed_upsert",
      proposedMemoryType: "procedural",
      importance: 0.75,
      content: { summary: "Always run pnpm build before pnpm --filter @endec/app test." }
    }), "2026-04-17T09:02:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_turn_summary_1",
      sourceTurnId: "turn_summary_1",
      writeKind: "candidate_extract",
      proposedMemoryType: "turn_summary",
      content: { summary: "We briefly mentioned coffee while waiting for tests." }
    }), "2026-04-17T10:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_turn_summary_2",
      sourceTurnId: "turn_summary_2",
      writeKind: "candidate_extract",
      proposedMemoryType: "turn_summary",
      content: { summary: "There was a short aside about window focus." }
    }), "2026-04-17T10:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_turn_summary_3",
      sourceTurnId: "turn_summary_3",
      writeKind: "candidate_extract",
      proposedMemoryType: "turn_summary",
      content: { summary: "A recent but disposable note about keyboard chatter." }
    }), "2026-04-17T10:02:00.000Z");

    const typedMemory = await retrieveTypedMemory(store, { maxItems: 3 });

    expect(typedMemory.map((item) => item.memoryType)).toEqual(["fact", "preference", "procedural"]);
  });

  it("keeps workspace durable memory ahead of user preference on ordinary routes even across bucket families", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_workspace_fact",
      sourceTurnId: "turn_workspace_fact",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "fact",
      importance: 0.65,
      content: { summary: "Workspace fact: CI lives in .github/workflows/test.yml." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_workspace_procedural",
      sourceTurnId: "turn_workspace_procedural",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "procedural",
      importance: 0.7,
      content: { summary: "Workspace procedure: run memory package tests before app package tests." }
    }), "2026-04-17T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_preference",
      sourceTurnId: "turn_user_preference",
      writeKind: "typed_upsert",
      scope: "user",
      actorId: "actor_cli",
      workspaceId: "workspace_other",
      proposedMemoryType: "preference",
      importance: 1,
      content: { summary: "User preference: keep verification reports ultra concise." }
    }), "2026-04-17T09:02:00.000Z");

    const typedMemory = await retrieveTypedMemory(store, {
      maxItems: 3,
      actorId: "actor_cli",
      queryText: "Which rule should I follow for this workspace right now?"
    });

    expect(typedMemory.map((item) => ({ scope: item.scope, memoryType: item.memoryType }))).toEqual([
      { scope: "workspace", memoryType: "fact" },
      { scope: "workspace", memoryType: "procedural" },
      { scope: "user", memoryType: "preference" }
    ]);
  });

  it("prefers continuity buckets on the continuation route", async () => {
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
      writeId: "write_blocker",
      sourceTurnId: "turn_blocker",
      writeKind: "typed_upsert",
      taskId: "task_lane2",
      proposedMemoryType: "blocker",
      importance: 0.8,
      content: { summary: "Blocked on proving scope gating before release." }
    }), "2026-04-17T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_follow_up",
      sourceTurnId: "turn_follow_up",
      writeKind: "typed_upsert",
      taskId: "task_lane2",
      proposedMemoryType: "follow_up",
      importance: 0.75,
      content: { summary: "Open loop: wire route bias through typed memory retrieval." }
    }), "2026-04-17T09:02:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_decision",
      sourceTurnId: "turn_decision",
      writeKind: "typed_upsert",
      taskId: "task_lane2",
      proposedMemoryType: "decision",
      importance: 0.7,
      content: { summary: "Recent decision: keep ranking in the memory layer." }
    }), "2026-04-17T09:03:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_preference",
      sourceTurnId: "turn_preference",
      writeKind: "typed_upsert",
      proposedMemoryType: "preference",
      content: { summary: "Preferred editor is helix." }
    }), "2026-04-17T10:00:00.000Z");

    const typedMemory = await retrieveTypedMemory(store, {
      maxItems: 4,
      resumeFrom: "checkpoint:lane2",
      requestedTask: createRequestedTask("task_lane2")
    });

    expect(typedMemory.map((item) => item.memoryType)).toEqual(["task_continuity", "blocker", "follow_up", "decision"]);
  });

  it("prefers active-task episodic and procedural memory for active_task_preferred routes", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_task_123_continuity",
      sourceTurnId: "turn_task_123_continuity",
      writeKind: "typed_upsert",
      taskId: "task_123",
      proposedMemoryType: "task_continuity",
      importance: 0.9,
      content: { summary: "task_123 continuity: keep the family selector change isolated." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_task_123_procedural",
      sourceTurnId: "turn_task_123_procedural",
      writeKind: "typed_upsert",
      taskId: "task_123",
      proposedMemoryType: "procedural",
      importance: 0.85,
      content: { summary: "task_123 procedure: run memory tests before app tests." }
    }), "2026-04-17T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_task_999_continuity",
      sourceTurnId: "turn_task_999_continuity",
      writeKind: "typed_upsert",
      taskId: "task_999",
      proposedMemoryType: "task_continuity",
      importance: 0.9,
      content: { summary: "task_999 continuity: unrelated but newer noise." }
    }), "2026-04-17T10:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_task_999_procedural",
      sourceTurnId: "turn_task_999_procedural",
      writeKind: "typed_upsert",
      taskId: "task_999",
      proposedMemoryType: "procedural",
      importance: 0.85,
      content: { summary: "task_999 procedure: unrelated but newer noise." }
    }), "2026-04-17T10:01:00.000Z");

    const typedMemory = await retrieveTypedMemory(store, {
      maxItems: 2,
      taskId: "task_123",
      requestedTask: createRequestedTask("task_123")
    });
    const summaries = typedMemory.map((item) => String((item.payload as { summary?: unknown } | undefined)?.summary ?? ""));

    expect(typedMemory.map((item) => item.memoryType)).toEqual(["task_continuity", "procedural"]);
    expect(summaries.join("\n")).toContain("task_123");
    expect(summaries.join("\n")).not.toContain("task_999");
  });

  it("keeps high-salience durable memory above recent unimportant noise", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_fact_durable",
      sourceTurnId: "turn_fact_durable",
      writeKind: "typed_upsert",
      proposedMemoryType: "fact",
      importance: 1,
      content: { summary: "The approval matrix for deploys lives in ops/runbooks/deploy.md." }
    }), "2026-04-17T08:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_recent_noise",
      sourceTurnId: "turn_recent_noise",
      writeKind: "candidate_extract",
      proposedMemoryType: "turn_summary",
      importance: 0,
      content: { summary: "We casually mentioned the approval matrix while discussing lunch." }
    }), "2026-04-17T10:00:00.000Z");

    const typedMemory = await retrieveTypedMemory(store, {
      maxItems: 1,
      queryText: "approval matrix"
    });

    expect(typedMemory[0]).toMatchObject({
      memoryType: "fact",
      payload: expect.objectContaining({
        summary: "The approval matrix for deploys lives in ops/runbooks/deploy.md."
      })
    });
  });

  it("applies scope as a hard gate so cross-scope typed memory is excluded", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_workspace_fact",
      sourceTurnId: "turn_workspace_fact",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "fact",
      importance: 0.6,
      content: { summary: "Workspace service port is 3000." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_fact",
      sourceTurnId: "turn_user_fact",
      writeKind: "typed_upsert",
      scope: "user",
      actorId: "actor_cli",
      proposedMemoryType: "fact",
      importance: 1,
      content: { summary: "User-wide service port preference is 3000 but belongs to another scope." }
    }), "2026-04-17T10:00:00.000Z");

    const typedMemory = await retrieveTypedMemory(store, {
      maxItems: 2,
      actorId: "actor_cli",
      queryText: "service port 3000",
      scopeFilter: "workspace"
    });

    expect(typedMemory).toHaveLength(1);
    expect(typedMemory[0]).toMatchObject({
      scope: "workspace",
      memoryType: "fact",
      payload: expect.objectContaining({
        summary: "Workspace service port is 3000."
      })
    });
  });

  it("keeps ordinary routes workspace-first while continuation and active-task routes stay session-first", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_session_procedural",
      sourceTurnId: "turn_session_procedural",
      writeKind: "typed_upsert",
      taskId: "task_scope_freeze",
      scope: "session",
      proposedMemoryType: "procedural",
      importance: 0.7,
      content: { summary: "Session rule: finish the failing scope tests before touching app assembly." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_workspace_procedural",
      sourceTurnId: "turn_workspace_procedural",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "procedural",
      importance: 0.7,
      content: { summary: "Workspace rule: run pnpm --filter @endec/memory test before app-layer verification." }
    }), "2026-04-17T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_procedural",
      sourceTurnId: "turn_user_procedural",
      writeKind: "typed_upsert",
      scope: "user",
      actorId: "actor_cli",
      workspaceId: "workspace_other",
      proposedMemoryType: "procedural",
      importance: 0.7,
      content: { summary: "User rule: prefer concise verification reports after tests pass." }
    }), "2026-04-17T09:02:00.000Z");

    const ordinary = await retrieveTypedMemory(store, {
      maxItems: 3,
      actorId: "actor_cli",
      queryText: "Which rule should I follow right now?"
    });
    const continuation = await retrieveTypedMemory(store, {
      maxItems: 3,
      actorId: "actor_cli",
      queryText: "Continue the current task from the checkpoint.",
      resumeFrom: "checkpoint:task_scope_freeze",
      taskId: "task_scope_freeze",
      requestedTask: createRequestedTask("task_scope_freeze")
    });
    const activeTaskPreferred = await retrieveTypedMemory(store, {
      maxItems: 3,
      actorId: "actor_cli",
      queryText: "Keep moving the current task forward.",
      taskId: "task_scope_freeze",
      requestedTask: createRequestedTask("task_scope_freeze")
    });

    expect(ordinary.map((item) => item.scope)).toEqual(["workspace", "user", "session"]);
    expect(continuation.map((item) => item.scope)).toEqual(["session", "workspace", "user"]);
    expect(activeTaskPreferred.map((item) => item.scope)).toEqual(["session", "workspace", "user"]);
  });

  it("retrieves user-scoped memory across workspaces without importing other-workspace conventions", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_other_workspace_workspace_pref",
      sourceTurnId: "turn_other_workspace_workspace_pref",
      writeKind: "typed_upsert",
      workspaceId: "workspace_other",
      scope: "workspace",
      proposedMemoryType: "preference",
      importance: 0.8,
      content: { summary: "Other workspace prefers deno formatting." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_editor_pref",
      sourceTurnId: "turn_user_editor_pref",
      writeKind: "typed_upsert",
      workspaceId: "workspace_other",
      scope: "user",
      actorId: "actor_cli",
      proposedMemoryType: "preference",
      importance: 0.9,
      content: { summary: "User prefers helix across projects." }
    }), "2026-04-17T09:01:00.000Z");

    const typedMemory = await retrieveTypedMemory(store, {
      maxItems: 2,
      actorId: "actor_cli",
      queryText: "What editor do I prefer?"
    });

    expect(typedMemory).toHaveLength(1);
    expect(typedMemory[0]).toMatchObject({
      scope: "user",
      memoryType: "preference",
      payload: expect.objectContaining({
        summary: "User prefers helix across projects."
      })
    });
  });

  it("keeps inferred session memory out of workspace durable retrieval", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_turn_summary",
      sourceTurnId: "turn_turn_summary",
      writeKind: "candidate_extract",
      proposedMemoryType: "turn_summary",
      content: { summary: "Temporary session note: we only paused to wait for CI." }
    }), "2026-04-17T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_workspace_fact",
      sourceTurnId: "turn_workspace_fact",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "fact",
      content: { summary: "Workspace fact: CI lives in .github/workflows/test.yml." }
    }), "2026-04-17T09:01:00.000Z");

    const workspaceOnly = await retrieveTypedMemory(store, {
      maxItems: 2,
      queryText: "Where does CI live?",
      scopeFilter: "workspace"
    });

    expect(workspaceOnly).toHaveLength(1);
    expect(workspaceOnly[0]).toMatchObject({
      scope: "workspace",
      payload: expect.objectContaining({
        summary: "Workspace fact: CI lives in .github/workflows/test.yml."
      })
    });
  });

  it("filters turn-context retrieval to the local conversation by default", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_owner_dm",
      sourceTurnId: "turn_owner_dm",
      sessionId: "session_owner_dm",
      writeKind: "typed_upsert",
      proposedMemoryType: "fact",
      visibility: "owner_private",
      conversationBoundaryKey: "private:42",
      content: { summary: "Owner DM note about release timing." }
    }), "2026-05-01T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_group_b",
      sourceTurnId: "turn_group_b",
      sessionId: "session_group_b",
      writeKind: "typed_upsert",
      proposedMemoryType: "fact",
      visibility: "conversation_local",
      conversationBoundaryKey: "supergroup:group_b",
      content: { summary: "group_b budget note" }
    }), "2026-05-01T09:01:00.000Z");

    const result = await store.retrieve({
      query: {
        queryId: "query_001",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        actorId: "actor_owner",
        purpose: "turn_context",
        memoryTypes: ["typed_memory"],
        maxItems: 10,
        maxInjectTokens: 1200,
        conversationBoundaryKey: "private:42",
        disclosureMode: "local_only"
      }
    });

    expect(result.continuity?.typedMemory.map((item) => String((item.payload as { summary?: unknown })?.summary ?? ""))).toEqual([
      "Owner DM note about release timing."
    ]);
    expect(result.continuity?.typedMemory.every((item) => item.sourceRefs.every((ref) => !ref.includes("group_b")))).toBe(true);
  });
});
