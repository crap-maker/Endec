import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

describe("memory continuity surfaces", () => {
  it("renders legacy summary compatibility from structured working-set fields", async () => {
    const store = createMemoryStore({ filename: ":memory:" });
    await store.updateWorkingSet({
      sessionId: "session_001",
      summary: "legacy digest should not win once structure is present",
      highlights: ["legacy digest"],
      sourceRefs: ["turn_001", "checkpoint:turn_001"],
      objective: "Ship structured working-set continuity",
      recentProgress: [
        "Wrote the failing continuity tests",
        "Stored the latest task step"
      ],
      recentDecisions: ["Summary now renders from structured fields"],
      blockers: ["Waiting on operator approval"],
      openLoops: ["Run the full verification suite"],
      activeMemoryRefs: ["memory:turn_001:typed_memory:0"],
      activeTaskRefs: ["task_001", "checkpoint:task_001"],
      recentEventRefs: ["turn_001:user", "turn_001:message:0"]
    });

    const pack = await store.retrieve({
      queryId: "query_rendered_summary",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      purpose: "turn_context",
      memoryTypes: ["working_set"],
      maxItems: 5,
      maxInjectTokens: 256
    });

    expect(pack.workingSetSummary).toBe([
      "Objective: Ship structured working-set continuity",
      "",
      "Recent progress:",
      "- Wrote the failing continuity tests",
      "- Stored the latest task step",
      "",
      "Recent decisions:",
      "- Summary now renders from structured fields",
      "",
      "Blockers:",
      "- Waiting on operator approval",
      "",
      "Open loops:",
      "- Run the full verification suite"
    ].join("\n"));
    expect(pack.workingSetSummary).not.toContain("legacy digest should not win");
    expect(pack.continuity?.workingSet).toMatchObject({
      summary: pack.workingSetSummary,
      objective: "Ship structured working-set continuity",
      recentProgress: [
        "Wrote the failing continuity tests",
        "Stored the latest task step"
      ],
      recentDecisions: ["Summary now renders from structured fields"],
      blockers: ["Waiting on operator approval"],
      openLoops: ["Run the full verification suite"],
      activeMemoryRefs: ["memory:turn_001:typed_memory:0"],
      activeTaskRefs: ["task_001", "checkpoint:task_001"],
      recentEventRefs: ["turn_001:user", "turn_001:message:0"],
      sourceRefs: ["turn_001", "checkpoint:turn_001"]
    });
    expect(pack.contextBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "session working set",
          content: pack.workingSetSummary
        })
      ])
    );
  });

  it("keeps structured working-set continuity intact when projection-derived refs are retrieved durably", async () => {
    const store = createMemoryStore({
      filename: ":memory:",
      dailyMemoryProjectionDir: "/tmp/endec-projection-derived-refs-continuity"
    });
    await store.updateWorkingSet({
      sessionId: "session_001",
      summary: "legacy digest should stay out once structure is present",
      highlights: ["legacy digest"],
      sourceRefs: ["turn_001", "checkpoint:turn_001"],
      objective: "Ship hotspot-safe Lane 3 alignment",
      recentProgress: ["Preserved Lane 1 structured persistence"],
      recentDecisions: ["Projection refs stay locator-only"],
      blockers: ["Verify no truth-boundary regressions"],
      openLoops: ["Run memory package tests"],
      activeMemoryRefs: ["typed_memory:session_001:preference:shell"],
      activeTaskRefs: ["task_001"],
      recentEventRefs: ["turn_001"]
    });
    await store.enqueueWrites([
      {
        writeId: "write_pref_001",
        sourceTurnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_001"],
        proposedMemoryType: "preference",
        scope: "workspace",
        importance: 0.8,
        dedupeKey: "preference:shell",
        content: {
          summary: "Preferred shell is fish.",
          value: "fish"
        }
      }
    ]);
    await store.drainOutbox({ maxItems: 10 });

    const pack = await store.retrieve({
      queryId: "query_working_set_with_projection_refs",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      purpose: "turn_context",
      memoryTypes: ["working_set", "typed_memory", "evidence"],
      maxItems: 5,
      maxInjectTokens: 256
    });

    expect(pack.workingSetSummary).toBe([
      "Objective: Ship hotspot-safe Lane 3 alignment",
      "",
      "Recent progress:",
      "- Preserved Lane 1 structured persistence",
      "",
      "Recent decisions:",
      "- Projection refs stay locator-only",
      "",
      "Blockers:",
      "- Verify no truth-boundary regressions",
      "",
      "Open loops:",
      "- Run memory package tests"
    ].join("\n"));
    expect(pack.continuity?.workingSet).toMatchObject({
      objective: "Ship hotspot-safe Lane 3 alignment",
      recentProgress: ["Preserved Lane 1 structured persistence"],
      recentDecisions: ["Projection refs stay locator-only"],
      blockers: ["Verify no truth-boundary regressions"],
      openLoops: ["Run memory package tests"],
      activeMemoryRefs: ["typed_memory:session_001:preference:shell"],
      activeTaskRefs: ["task_001"],
      recentEventRefs: ["turn_001"],
      sourceRefs: ["turn_001", "checkpoint:turn_001"]
    });
    expect(pack.continuity?.projectionDerivedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: expect.stringMatching(/^projection:workspace_local:\d{4}-\d{2}-\d{2}$/),
          sourceRefs: ["typed_memory:session_001:preference:shell"],
          turnRefs: ["turn_001"]
        })
      ])
    );
    expect(pack.contextBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "session working set",
          content: pack.workingSetSummary
        })
      ])
    );
  });

  it("returns structured continuity surfaces and composable context blocks", async () => {
    const store = createMemoryStore({ filename: ":memory:" });
    await store.updateWorkingSet({
      sessionId: "session_001",
      summary: "keep the execution seam stable",
      highlights: ["execution seam"],
      sourceRefs: ["turn_001"]
    });

    const pack = await store.retrieve({
      query: {
        queryId: "query_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        purpose: "turn_context",
        memoryTypes: ["working_set", "recent_history", "active_task", "typed_memory", "evidence"],
        maxItems: 5,
        maxInjectTokens: 256,
        taskId: "task_001"
      },
      recentHistory: {
        summary: "user asked to continue the active task",
        refs: ["turn_001", "turn_002"],
        turnRefs: ["turn_001", "turn_002"]
      },
      requestedTask: {
        taskId: "task_001",
        title: "Ship WS4 front half",
        status: "active",
        checkpointRef: "checkpoint:task_001",
        currentStep: "wire retrieval policy",
        nextAction: "update working set",
        updatedAt: "2026-04-11T10:00:00.000Z"
      },
      activeTasks: [],
      typedMemory: [],
      evidence: [],
      projectionDerivedRefs: [
        {
          ref: "projection:workspace_local:2026-04-16#ws4",
          day: "2026-04-16",
          section: "ws4",
          summary: "daily projection mentions the frozen retrieval seam",
          sourceRefs: ["working_set:session_001:1", "evidence:turn_001"],
          turnRefs: ["turn_001", "turn_002"]
        }
      ]
    });

    expect(pack.continuity).toMatchObject({
      retrievalPolicy: {
        strategy: "active_task_preferred",
        activeTaskSelection: {
          mode: "request_task",
          taskId: "task_001"
        }
      },
      recentHistory: {
        summary: "user asked to continue the active task",
        refs: ["turn_001", "turn_002"]
      },
      workingSet: {
        summary: "keep the execution seam stable",
        objective: undefined,
        recentProgress: [],
        recentDecisions: [],
        blockers: [],
        openLoops: [],
        activeMemoryRefs: [],
        activeTaskRefs: [],
        recentEventRefs: [],
        sourceRefs: ["turn_001"]
      },
      activeTask: {
        taskId: "task_001",
        checkpointRef: "checkpoint:task_001",
        selectedBy: "request_task"
      },
      typedMemory: [],
      evidence: [],
      projectionDerivedRefs: [
        {
          ref: "projection:workspace_local:2026-04-16#ws4",
          day: "2026-04-16",
          section: "ws4",
          summary: "daily projection mentions the frozen retrieval seam",
          sourceRefs: ["working_set:session_001:1", "evidence:turn_001"],
          turnRefs: ["turn_001", "turn_002"]
        }
      ]
    });
    expect(pack.continuity?.evidence).toEqual([]);
    expect(pack.contextBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memory",
          title: "session working set"
        }),
        expect.objectContaining({
          kind: "history",
          title: "recent history"
        }),
        expect.objectContaining({
          kind: "task",
          title: "active task"
        })
      ])
    );
  });
});
