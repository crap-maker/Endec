import { describe, expect, it } from "vitest";
import {
  OperatorRecoverySnapshotSchema,
  RuntimeSelfAwarenessSurfaceSchema
} from "./index.ts";

describe("WS5 operator seam freeze", () => {
  it("constructs an operator-facing recovery snapshot contract", () => {
    const runtimeSelfAwareness = RuntimeSelfAwarenessSurfaceSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws5.runtime-self-awareness.v1",
      source: "telegram",
      channel: "telegram",
      mode: "act",
      exposedToolNames: ["read", "write", "bash"],
      replyPath: "blocked",
      constraints: [
        {
          code: "approval_required",
          summary: "Operator approval is required before write_file can continue.",
          blocking: true,
          metadata: {
            pendingApprovalRef: "decision_001"
          }
        }
      ]
    });

    const snapshot = OperatorRecoverySnapshotSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws5.operator-recovery-snapshot.v1",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      recoverable: true,
      hasPendingExecution: true,
      turnId: "turn_001",
      frameRef: "frame:turn_001",
      pendingExecutionId: "pending:turn_001",
      blockedBy: "permission",
      waitingReason: "permission",
      state: "awaiting_permission",
      allowedActions: ["approve", "deny", "resume", "cancel"],
      pendingApprovalRef: "decision_001",
      pendingDecision: {
        decisionId: "decision_001",
        behavior: "ask",
        scope: "once",
        reasonCode: "tool_requires_approval",
        reasonText: "write_file requires approval",
        issuedAt: new Date().toISOString(),
        requestedBy: "turn_001"
      },
      checkpointRef: "checkpoint:turn_001",
      contextSummary: {
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "telegram",
        mode: "act",
        currentGoal: "freeze operator recovery seam",
        activeTaskIds: ["task_001"],
        recentTurnRefs: ["turn_prev", "turn_001"]
      },
      runtimeSelfAwareness
    });

    expect(snapshot.allowedActions).toEqual(["approve", "deny", "resume", "cancel"]);
    expect(snapshot.pendingDecision?.decisionId).toBe("decision_001");
    expect(snapshot.runtimeSelfAwareness).toEqual(runtimeSelfAwareness);
  });

  it("constructs a runtime self-awareness surface contract", () => {
    const surface = RuntimeSelfAwarenessSurfaceSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws5.runtime-self-awareness.v1",
      source: "cli",
      channel: "cli",
      mode: "chat",
      exposedToolNames: ["read", "bash"],
      replyPath: "continuation",
      constraints: [
        {
          code: "readonly_workspace",
          summary: "The current turn is running in readonly mode.",
          blocking: false
        },
        {
          code: "tool_budget_remaining",
          summary: "Only 1 tool call remains in this continuation window.",
          blocking: false,
          metadata: {
            remaining: 1
          }
        }
      ]
    });

    expect(surface.exposedToolNames).toEqual(["read", "bash"]);
    expect(surface.replyPath).toBe("continuation");
    expect(surface.constraints).toHaveLength(2);
  });
});
