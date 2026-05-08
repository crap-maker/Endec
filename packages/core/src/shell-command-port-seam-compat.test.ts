import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ExecutionControlInput } from "@endec/domain";
import type { ResolveApprovalCommand, ShellCommandPort } from "./shell-command-port.ts";
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
    checkpointRef: `checkpoint:${status}`
  };
}

describe("shell command port seam compatibility", () => {
  it("keeps submitExecutionControl aligned with the execution-control contract", () => {
    expectTypeOf<Parameters<ShellCommandPort["submitExecutionControl"]>[0]>().toEqualTypeOf<ExecutionControlInput>();
    expectTypeOf<ResolveApprovalCommand["scope"]>().toEqualTypeOf<"once" | "turn" | undefined>();
  });

  it("rejects unsupported approval scopes before reaching legacy shell delegates", async () => {
    const resolveApproval = vi.fn(async () => createTurnResult("completed"));
    const shell = createShellCommandPort({
      executeTurn: vi.fn(async () => createTurnResult("completed")),
      resumeTurn: vi.fn(async () => createTurnResult("completed")),
      resolveApproval,
      cancelInflightTurn: vi.fn(async () => createTurnResult("interrupted"))
    });

    await expect(shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "approve",
      sessionId: "session_001",
      turnId: "turn_001",
      decisionId: "decision_001",
      scope: "session"
    } as unknown as Parameters<ShellCommandPort["submitExecutionControl"]>[0])).rejects.toThrow();

    await expect(shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "approve",
      sessionId: "session_001",
      turnId: "turn_001",
      decisionId: "decision_001",
      scope: "workspace"
    } as unknown as Parameters<ShellCommandPort["submitExecutionControl"]>[0])).rejects.toThrow();

    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("accepts submitExecutionControl and maps it to legacy shell commands", async () => {
    const submitExecutionControl = vi.fn(async (input: { action: string }) => createTurnResult(input.action === "cancel" ? "interrupted" : "completed"));

    const shell = createShellCommandPort({
      executeTurn: vi.fn(async () => createTurnResult("completed")),
      resumeTurn: vi.fn(async () => createTurnResult("completed")),
      resolveApproval: vi.fn(async () => createTurnResult("completed")),
      cancelInflightTurn: vi.fn(async () => createTurnResult("interrupted")),
      submitExecutionControl
    });

    await shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "resume",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      turnId: "turn_001",
      frameRef: "frame:turn_001",
      input: "resume"
    });
    await shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "approve",
      sessionId: "session_001",
      turnId: "turn_001",
      frameRef: "frame:turn_001",
      decisionId: "decision_001",
      scope: "once"
    });
    await shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "deny",
      sessionId: "session_001",
      turnId: "turn_001",
      frameRef: "frame:turn_001",
      decisionId: "decision_001",
      scope: "once"
    });
    await shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "cancel",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      turnId: "turn_001",
      frameRef: "frame:turn_001",
      reason: "operator_cancelled"
    });

    expect(submitExecutionControl).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: "resume", frameRef: "frame:turn_001" }));
    expect(submitExecutionControl).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: "approve", frameRef: "frame:turn_001" }));
    expect(submitExecutionControl).toHaveBeenNthCalledWith(3, expect.objectContaining({ action: "deny", frameRef: "frame:turn_001" }));
    expect(submitExecutionControl).toHaveBeenNthCalledWith(4, expect.objectContaining({ action: "cancel", frameRef: "frame:turn_001" }));
  });
});
