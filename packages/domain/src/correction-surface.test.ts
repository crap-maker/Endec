import { describe, expect, it } from "vitest";
import {
  CorrectionInspectionSchema,
  CorrectionRequestSchema
} from "./index.ts";

describe("WS6 correction surface contract", () => {
  it("freezes working-set rewrite, refresh, and typed-memory correction contracts", () => {
    const rewrite = CorrectionRequestSchema.parse({
      correctionId: "corr_working_set_rewrite_001",
      actorId: "operator:cli",
      reason: "working set drifted away from the current task",
      target: {
        kind: "working_set",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        workingSetRef: "working_set:session_001:4"
      },
      operation: {
        kind: "rewrite_working_set",
        replace: true,
        workingSet: {
          objective: "Correction-owned continuity objective",
          recentProgress: ["rewrote the continuity skeleton from inspection"],
          blockers: ["awaiting a fresh operator confirmation"],
          openLoops: ["resume after the corrected working set is acknowledged"],
          sourceRefs: ["turn_observability_001"]
        }
      }
    });

    const refresh = CorrectionRequestSchema.parse({
      correctionId: "corr_working_set_refresh_001",
      actorId: "system:continuity-refresh",
      reason: "existing working set is stale and should be rebuilt",
      target: {
        kind: "working_set",
        sessionId: "session_001",
        workspaceId: "workspace_local"
      },
      operation: {
        kind: "refresh_working_set"
      }
    });

    const supersede = CorrectionRequestSchema.parse({
      correctionId: "corr_memory_supersede_001",
      actorId: "operator:cli",
      reason: "the old user preference was replaced by a newer one",
      target: {
        kind: "typed_memory",
        memoryId: "typed_memory:turn_old_preference",
        scope: "user",
        workspaceId: "workspace_local",
        actorId: "actor_cli"
      },
      operation: {
        kind: "mark_memory_superseded",
        supersededByMemoryId: "typed_memory:turn_new_preference"
      }
    });

    expect(rewrite.operation.kind).toBe("rewrite_working_set");
    expect(refresh.operation.kind).toBe("refresh_working_set");
    expect(supersede.operation.kind).toBe("mark_memory_superseded");
  });

  it("freezes operator-facing correction inspection targets", () => {
    const inspection = CorrectionInspectionSchema.parse({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      workingSet: {
        target: {
          kind: "working_set",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          workingSetRef: "working_set:session_001:4"
        },
        workingSet: {
          ref: "working_set:session_001:4",
          version: 4,
          summary: "Objective: keep continuity authoritative",
          objective: "keep continuity authoritative",
          recentProgress: ["observability exposed stale continuity"],
          recentDecisions: [],
          blockers: ["old blockers are no longer relevant"],
          openLoops: ["rewrite the working set"],
          activeMemoryRefs: ["typed_memory:turn_old_preference"],
          activeTaskRefs: ["task_001"],
          recentEventRefs: ["event_001"],
          sourceRefs: ["turn_observability_001"]
        }
      },
      typedMemory: [
        {
          target: {
            kind: "typed_memory",
            memoryId: "typed_memory:turn_old_preference",
            scope: "user",
            workspaceId: "workspace_local",
            actorId: "actor_cli"
          },
          record: {
            memoryId: "typed_memory:turn_old_preference",
            writeId: "write_old_preference",
            sourceTurnId: "turn_old_preference",
            sessionId: "session_001",
            workspaceId: "workspace_local",
            actorId: "actor_cli",
            scope: "user",
            importance: 0.9,
            kind: "typed_upsert",
            status: "materialized",
            selectionState: "superseded",
            memoryType: "preference",
            summary: "Old preference: ultra terse summaries.",
            content: "Old preference: ultra terse summaries.",
            payload: {
              summary: "Old preference: ultra terse summaries."
            },
            evidenceRefs: ["turn_old_preference"],
            createdAt: "2026-04-21T00:00:00.000Z",
            updatedAt: "2026-04-21T00:00:00.000Z",
            correctedAt: "2026-04-21T00:05:00.000Z",
            supersededByMemoryId: "typed_memory:turn_new_preference"
          }
        }
      ]
    });

    expect(inspection.workingSet?.target.kind).toBe("working_set");
    expect(inspection.typedMemory[0]?.record.selectionState).toBe("superseded");
    expect(inspection.typedMemory[0]?.record.supersededByMemoryId).toBe("typed_memory:turn_new_preference");
  });
});
