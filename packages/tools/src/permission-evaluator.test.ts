import { describe, expect, it } from "vitest";
import { createActToolExposure, createReadonlyToolExposure } from "./presets.ts";
import { evaluateToolCallPermission } from "./permission-evaluator.ts";
import { createStaticToolRegistry } from "./registry.ts";

describe("tool permission policy", () => {
  it("auto-allows readonly tools and denies hidden tools in chat exposure", () => {
    const registry = createStaticToolRegistry();
    const exposure = createReadonlyToolExposure(registry);

    const allowDecision = evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_read_001",
      toolName: "read",
      exposure
    });
    const denyDecision = evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_bash_001",
      toolName: "bash",
      exposure
    });

    expect(allowDecision).toMatchObject({
      behavior: "allow",
      scope: "once",
      reasonCode: "tool_auto_allowed",
      reasonText: "read is auto-allowed by the current tool exposure policy",
      requestedBy: "turn_001"
    });
    expect(denyDecision).toMatchObject({
      behavior: "deny",
      scope: "once",
      reasonCode: "tool_hidden",
      reasonText: "bash is not exposed by the current tool exposure policy",
      requestedBy: "turn_001"
    });
  });

  it("auto-allows write and edit in act exposure while routing remote bash actions through approval", () => {
    const registry = createStaticToolRegistry();
    const exposure = createActToolExposure(registry);

    expect(evaluateToolCallPermission({
      turnId: "turn_002",
      toolCallId: "tool_call_write_001",
      toolName: "write",
      exposure
    })).toMatchObject({
      behavior: "allow",
      reasonCode: "tool_auto_allowed",
      reasonText: "write is auto-allowed by the current tool exposure policy"
    });

    expect(evaluateToolCallPermission({
      turnId: "turn_002",
      toolCallId: "tool_call_edit_001",
      toolName: "edit",
      exposure
    })).toMatchObject({
      behavior: "allow",
      reasonCode: "tool_auto_allowed",
      reasonText: "edit is auto-allowed by the current tool exposure policy"
    });

    expect(evaluateToolCallPermission({
      turnId: "turn_002",
      toolCallId: "tool_call_bash_002",
      toolName: "bash",
      exposure,
      arguments: {
        command: "git push origin HEAD"
      }
    })).toMatchObject({
      behavior: "ask",
      reasonCode: "bash_action_requires_approval",
      reasonText: "git push crosses from the local workspace into remote branch state."
    });
  });

  it("allows a previously requested bash call exactly once after approval", () => {
    const registry = createStaticToolRegistry();
    const exposure = createActToolExposure(registry);

    expect(evaluateToolCallPermission({
      turnId: "turn_003",
      toolCallId: "tool_call_bash_003",
      toolName: "bash",
      exposure,
      permissionContext: {
        approvedDecisionIds: ["tool_call_bash_003"],
        approverId: "operator_001"
      }
    })).toMatchObject({
      decisionId: "tool_call_bash_003",
      behavior: "allow",
      reasonCode: "tool_approved_once",
      approverId: "operator_001",
      reasonText: "bash was approved for this pending execution"
    });
  });

  it("auto-allows bash for the rest of the current turn when turn trust is active", () => {
    const registry = createStaticToolRegistry();
    const exposure = createActToolExposure(registry);

    expect(evaluateToolCallPermission({
      turnId: "turn_004",
      toolCallId: "tool_call_bash_004",
      toolName: "bash",
      exposure,
      permissionContext: {
        approvedDecisionIds: [],
        approverId: "operator_001",
        bashTrust: {
          toolName: "bash",
          scope: "turn",
          decisionId: "tool_call_bash_003",
          approverId: "operator_001"
        }
      }
    })).toMatchObject({
      decisionId: "tool_call_bash_004",
      behavior: "allow",
      scope: "turn",
      reasonCode: "tool_trusted_for_turn",
      approverId: "operator_001",
      reasonText: "bash is approved for the rest of this turn"
    });
  });
});
