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
    updatedAt: "2026-04-21T09:00:00.000Z"
  };
}

async function materializeWrite(store: ReturnType<typeof createMemoryStore>, write: MemoryWriteRequest, at: string) {
  vi.setSystemTime(new Date(at));
  await store.enqueueWrites([write]);
  await store.drainOutbox({ maxItems: 1 });
}

describe("correction surface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rewrites and refreshes the working set through a formal correction seam and changes retrieved continuity", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    const initial = await store.updateWorkingSet({
      sessionId,
      summary: "Objective: stale continuity summary",
      highlights: ["stale continuity summary"],
      sourceRefs: ["turn_initial"],
      objective: "stale continuity summary",
      recentProgress: ["kept the wrong working set alive"],
      blockers: ["old blocker that should disappear"],
      openLoops: ["obsolete open loop"]
    });

    await store.applyCorrection({
      correctionId: "corr_working_set_rewrite_001",
      actorId: "operator:cli",
      reason: "rewrite the continuity skeleton from inspection",
      target: {
        kind: "working_set",
        sessionId,
        workspaceId,
        workingSetRef: initial.workingSetRef
      },
      operation: {
        kind: "rewrite_working_set",
        replace: true,
        workingSet: {
          objective: "corrected continuity objective",
          recentProgress: ["rebuilt the working set from authoritative inspection"],
          blockers: ["waiting for a narrow operator confirmation"],
          openLoops: ["resume after applying the corrected continuity"],
          sourceRefs: ["turn_observability_001"]
        }
      }
    });

    const rewritten = await store.retrieve({
      query: {
        queryId: "query_rewritten_working_set",
        sessionId,
        workspaceId,
        purpose: "turn_context",
        memoryTypes: ["working_set"],
        maxItems: 4,
        maxInjectTokens: 256
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      },
      activeTasks: []
    });

    expect(rewritten.continuity?.workingSet).toMatchObject({
      objective: "corrected continuity objective",
      recentProgress: ["rebuilt the working set from authoritative inspection"],
      blockers: ["waiting for a narrow operator confirmation"],
      openLoops: ["resume after applying the corrected continuity"]
    });
    expect(rewritten.continuity?.workingSet.summary).toContain("corrected continuity objective");
    expect(rewritten.continuity?.workingSet.summary).not.toContain("stale continuity summary");

    await store.applyCorrection({
      correctionId: "corr_working_set_refresh_001",
      actorId: "system:continuity-refresh",
      reason: "clear the stale working set so it can be regenerated",
      target: {
        kind: "working_set",
        sessionId,
        workspaceId,
        workingSetRef: rewritten.continuity?.workingSet.ref
      },
      operation: {
        kind: "refresh_working_set"
      }
    });

    const refreshed = await store.retrieve({
      query: {
        queryId: "query_refreshed_working_set",
        sessionId,
        workspaceId,
        purpose: "turn_context",
        memoryTypes: ["working_set"],
        maxItems: 4,
        maxInjectTokens: 256
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      },
      activeTasks: []
    });

    expect(refreshed.continuity?.workingSet).toMatchObject({
      summary: "",
      objective: undefined,
      recentProgress: [],
      blockers: [],
      openLoops: []
    });
  });

  it("excludes stale and superseded durable memory from ordinary selection while letting the replacement win", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_workspace_old",
      sourceTurnId: "turn_workspace_old",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "procedural",
      importance: 0.85,
      content: { summary: "Old workspace rule: run the legacy smoke suite first." }
    }), "2026-04-21T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_workspace_new",
      sourceTurnId: "turn_workspace_new",
      writeKind: "typed_upsert",
      scope: "workspace",
      proposedMemoryType: "procedural",
      importance: 0.8,
      content: { summary: "New workspace rule: run pnpm --filter @endec/memory test first." }
    }), "2026-04-21T09:01:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_old",
      sourceTurnId: "turn_user_old",
      writeKind: "typed_upsert",
      scope: "user",
      actorId: "actor_cli",
      workspaceId: "workspace_other",
      proposedMemoryType: "preference",
      importance: 1,
      content: { summary: "Old user preference: keep replies ultra terse." }
    }), "2026-04-21T09:02:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_user_new",
      sourceTurnId: "turn_user_new",
      writeKind: "typed_upsert",
      scope: "user",
      actorId: "actor_cli",
      workspaceId: "workspace_other",
      proposedMemoryType: "preference",
      importance: 0.95,
      content: { summary: "New user preference: keep replies concise but explicit." }
    }), "2026-04-21T09:03:00.000Z");

    const inspection = await store.inspectCorrections({
      sessionId,
      workspaceId,
      actorId: "actor_cli"
    });
    const workspaceOld = inspection.typedMemory.find((item) => item.record.writeId === "write_workspace_old");
    const userOld = inspection.typedMemory.find((item) => item.record.writeId === "write_user_old");
    const userNew = inspection.typedMemory.find((item) => item.record.writeId === "write_user_new");

    await store.applyCorrection({
      correctionId: "corr_workspace_stale_001",
      actorId: "operator:cli",
      reason: "legacy workspace procedure is stale",
      target: workspaceOld!.target,
      operation: {
        kind: "mark_memory_stale"
      }
    });
    await store.applyCorrection({
      correctionId: "corr_user_superseded_001",
      actorId: "operator:cli",
      reason: "the old user preference was superseded",
      target: userOld!.target,
      operation: {
        kind: "mark_memory_superseded",
        supersededByMemoryId: userNew!.record.memoryId
      }
    });

    const result = await store.retrieve({
      query: {
        queryId: "query_corrected_ordinary",
        sessionId,
        workspaceId,
        actorId: "actor_cli",
        purpose: "turn_context",
        memoryTypes: ["typed_memory"],
        maxItems: 4,
        maxInjectTokens: 256,
        queryText: "Which workspace rule and user preference should I follow now?"
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      },
      activeTasks: []
    });

    const typedMemory = result.continuity?.typedMemory ?? [];
    const summaries = typedMemory.map((item) => String((item.payload as { summary?: unknown } | undefined)?.summary ?? ""));

    expect(summaries.join("\n")).toContain("New workspace rule");
    expect(summaries.join("\n")).toContain("New user preference");
    expect(summaries.join("\n")).not.toContain("Old workspace rule");
    expect(summaries.join("\n")).not.toContain("Old user preference");
  });

  it("keeps disabled session continuity memory out of continuation selection and exposes correction targets in observability", async () => {
    const store = createMemoryStore({ filename: ":memory:" });

    await materializeWrite(store, createWrite({
      writeId: "write_task_disabled",
      sourceTurnId: "turn_task_disabled",
      writeKind: "typed_upsert",
      scope: "session",
      taskId: "task_lane2",
      proposedMemoryType: "task_continuity",
      importance: 0.95,
      content: { summary: "Old continuation note: keep the obsolete recovery branch alive." }
    }), "2026-04-21T09:00:00.000Z");
    await materializeWrite(store, createWrite({
      writeId: "write_task_replacement",
      sourceTurnId: "turn_task_replacement",
      writeKind: "typed_upsert",
      scope: "session",
      taskId: "task_lane2",
      proposedMemoryType: "task_continuity",
      importance: 0.9,
      content: { summary: "Current continuation note: resume from the scope-aware checkpoint." }
    }), "2026-04-21T09:01:00.000Z");

    const inspection = await store.inspectCorrections({
      sessionId,
      workspaceId,
      actorId: "actor_cli"
    });
    const disabledTarget = inspection.typedMemory.find((item) => item.record.writeId === "write_task_disabled")?.target;

    await store.applyCorrection({
      correctionId: "corr_session_disable_001",
      actorId: "operator:cli",
      reason: "this session-derived durable memory should stop polluting continuation selection",
      target: disabledTarget!,
      operation: {
        kind: "disable_memory"
      }
    });

    const result = await store.retrieve({
      query: {
        queryId: "query_corrected_continuation",
        sessionId,
        workspaceId,
        actorId: "actor_cli",
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

    const typedMemory = result.continuity?.typedMemory ?? [];
    const summaries = typedMemory.map((item) => String((item.payload as { summary?: unknown } | undefined)?.summary ?? ""));
    const observabilityItems = result.observability?.durableMemory?.items ?? [];

    expect(summaries).toEqual(["Current continuation note: resume from the scope-aware checkpoint."]);
    expect(observabilityItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        selectionStatus: "corrected-out",
        reasons: ["disabled"],
        correctionTarget: expect.objectContaining({
          kind: "typed_memory"
        })
      }),
      expect.objectContaining({
        selectionStatus: "selected",
        correctionTarget: expect.objectContaining({
          kind: "typed_memory"
        })
      })
    ]));
  });
});
