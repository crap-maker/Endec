import { describe, expect, it } from "vitest";
import { planOutboxConsumption } from "./outbox-consumer.ts";

describe("planOutboxConsumption", () => {
  it("maps candidate_extract writes to the front-half typed-memory/evidence contract", () => {
    const plan = planOutboxConsumption({
      writeId: "write_001",
      sourceTurnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      writeKind: "candidate_extract",
      evidenceRefs: ["turn_001"],
      payload: {
        writeId: "write_001",
        sourceTurnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "candidate_extract",
        evidenceRefs: ["turn_001"],
        taskId: "task_001"
      },
      createdAt: "2026-04-11T10:00:00.000Z",
      processedAt: null
    });

    expect(plan).toEqual({
      writeId: "write_001",
      contract: "candidate_extract_pending",
      target: "typed_memory_pipeline",
      typedMemory: {
        kind: "candidate_extract",
        status: "pending"
      },
      evidence: {
        refs: ["turn_001"]
      }
    });
  });

  it("maps typed_upsert writes to a stable typed-memory upsert contract", () => {
    const plan = planOutboxConsumption({
      writeId: "write_002",
      sourceTurnId: "turn_002",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      writeKind: "typed_upsert",
      evidenceRefs: ["turn_001", "turn_002"],
      payload: {
        writeId: "write_002",
        sourceTurnId: "turn_002",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_001", "turn_002"],
        proposedMemoryType: "task_continuity",
        content: {
          summary: "current task state"
        }
      },
      createdAt: "2026-04-11T10:05:00.000Z",
      processedAt: null
    });

    expect(plan).toEqual({
      writeId: "write_002",
      contract: "typed_upsert_ready",
      target: "typed_memory_store",
      typedMemory: {
        kind: "typed_upsert",
        status: "ready",
        memoryType: "task_continuity"
      },
      evidence: {
        refs: ["turn_001", "turn_002"]
      }
    });
  });
});
