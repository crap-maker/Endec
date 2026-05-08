import { describe, expect, it } from "vitest";
import { createSessionStore } from "./session-store.ts";

describe("SessionStore", () => {
  it("creates and reloads a session row", async () => {
    const store = createSessionStore({ filename: ":memory:" });

    const created = await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    const loaded = await store.loadById("session_001");
    expect(created.sessionId).toBe("session_001");
    expect(loaded?.workspaceId).toBe("workspace_local");
  });

  it("rewires the working set pointer without disturbing session continuity fields", async () => {
    const store = createSessionStore({ filename: ":memory:" });
    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    await store.updateWorkingSetPointer({
      sessionId: "session_001",
      workingSetRef: "working_set:session_001:2",
      workingSetVersion: 2
    });

    await expect(store.loadById("session_001")).resolves.toMatchObject({
      sessionId: "session_001",
      workingSetRef: "working_set:session_001:2",
      workingSetVersion: 2,
      recentTurnRefs: [],
      activeTaskIds: []
    });
  });

  it("persists frameRef and pendingExecution on inflight recovery rows", async () => {
    const store = createSessionStore({ filename: ":memory:" });
    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    await store.markInflight({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 1,
      pendingApprovalRef: "decision_001",
      checkpointRef: "checkpoint:turn_001",
      frameRef: "frame:turn_001",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:turn_001",
        frameRef: "frame:turn_001",
        checkpointRef: "checkpoint:turn_001",
        status: "blocked",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:turn_001",
          checkpointRef: "checkpoint:turn_001",
          turnId: "turn_001",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          phase: "awaiting_permission",
          step: "tool_batch",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 1,
          toolCallCount: 1,
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "awaiting_operator",
            allowedActions: ["approve", "deny", "cancel"],
            metadata: {}
          }
        }
      }
    });

    await expect(store.loadRecoveryContext("session_001")).resolves.toMatchObject({
      inflight: {
        frameRef: "frame:turn_001",
        contractVersion: "ws0.pending-execution.v1",
        pendingExecution: expect.objectContaining({
          frameRef: "frame:turn_001"
        })
      }
    });
  });

  it("preserves inflight recovery rows on interrupted finalize only when explicitly requested", async () => {
    const store = createSessionStore({ filename: ":memory:" });
    await store.loadOrCreate({
      turnId: "turn_resume_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    await store.markInflight({
      turnId: "turn_resume_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      checkpointRef: "checkpoint:turn_resume_001",
      frameRef: "frame:turn_resume_001",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:turn_resume_001",
        frameRef: "frame:turn_resume_001",
        checkpointRef: "checkpoint:turn_resume_001",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:turn_resume_001",
          checkpointRef: "checkpoint:turn_resume_001",
          turnId: "turn_resume_001",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "tool_turn_limit",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 1,
          toolCallCount: 2,
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {}
          }
        }
      }
    });

    await store.finalize({
      turnId: "turn_resume_001",
      sessionId: "session_001",
      status: "interrupted",
      preserveInflight: true
    });

    await expect(store.loadRecoveryContext("session_001")).resolves.toMatchObject({
      inflight: {
        turnId: "turn_resume_001",
        pendingExecution: expect.objectContaining({
          pendingExecutionId: "pending:turn_resume_001",
          status: "ready"
        })
      }
    });
  });
});
