import { describe, expect, it, vi } from "vitest";
import { createShellCommandPort } from "./shell-command-port.ts";

function createTurnResult(status: "completed" | "blocked" | "interrupted" | "failed") {
  return {
    turnId: `turn_${status}`,
    sessionId: "session_001",
    resolvedMode: "chat" as const,
    status,
    messages: [],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    },
    warnings: [],
    checkpointRef: `checkpoint_${status}`
  };
}

describe("shell command port", () => {
  it("wraps only command-facing delegates for CLI-safe access", async () => {
    const executeTurn = vi.fn(async () => createTurnResult("completed"));
    const resumeTurn = vi.fn(async () => createTurnResult("completed"));
    const resolveApproval = vi.fn(async () => createTurnResult("blocked"));
    const cancelInflightTurn = vi.fn(async () => createTurnResult("interrupted"));

    const shell = createShellCommandPort({
      executeTurn,
      resumeTurn,
      resolveApproval,
      cancelInflightTurn
    });

    await shell.executeTurn({
      turnId: "turn_execute",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });
    await shell.resumeTurn({
      turnId: "turn_resume",
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });
    await shell.resolveApproval({
      turnId: "turn_approval",
      sessionId: "session_001",
      decisionId: "decision_001",
      approved: true,
      scope: "once"
    });
    await shell.cancelInflightTurn({
      turnId: "turn_cancel",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      reason: "user_cancelled"
    });

    expect(executeTurn).toHaveBeenCalledTimes(1);
    expect(resumeTurn).toHaveBeenCalledWith({
      turnId: "turn_resume",
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });
    expect(resolveApproval).toHaveBeenCalledWith({
      turnId: "turn_approval",
      sessionId: "session_001",
      decisionId: "decision_001",
      approved: true,
      scope: "once"
    });
    expect(cancelInflightTurn).toHaveBeenCalledWith({
      turnId: "turn_cancel",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      reason: "user_cancelled"
    });
  });

  it("preserves omitted recoverable turn ids for session-scoped recovery commands", async () => {
    const resumeTurn = vi.fn(async () => createTurnResult("completed"));
    const resolveApproval = vi.fn(async () => createTurnResult("completed"));
    const cancelInflightTurn = vi.fn(async () => createTurnResult("interrupted"));

    const shell = createShellCommandPort({
      executeTurn: vi.fn(async () => createTurnResult("completed")),
      resumeTurn,
      resolveApproval,
      cancelInflightTurn
    });

    await shell.resumeTurn({
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });
    await shell.resolveApproval({
      sessionId: "session_001",
      decisionId: "decision_001",
      approved: true
    });
    await shell.cancelInflightTurn({
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });

    expect(resumeTurn).toHaveBeenCalledWith({
      turnId: undefined,
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });
    expect(resolveApproval).toHaveBeenCalledWith({
      turnId: undefined,
      sessionId: "session_001",
      decisionId: "decision_001",
      approved: true
    });
    expect(cancelInflightTurn).toHaveBeenCalledWith({
      turnId: undefined,
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });
  });
});
