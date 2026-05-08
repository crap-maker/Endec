import { describe, expect, it } from "vitest";
import {
  createCanonicalToolExposure,
  createStaticToolRegistry,
  evaluateToolCallPermission,
  reclassifyCapabilityTruth
} from "./index.ts";

function createNarrowedExposure(toolNames: string[]) {
  const registry = createStaticToolRegistry();
  const canonical = createCanonicalToolExposure({ registry, resolvedMode: "chat" });
  const visible = new Set(toolNames);

  return {
    exposureSource: canonical.exposureSource,
    exposedTools: canonical.exposedTools.filter((tool) => visible.has(tool.name)),
    hiddenToolNames: canonical.hiddenToolNames.concat(
      canonical.exposedTools
        .filter((tool) => !visible.has(tool.name))
        .map((tool) => tool.name)
    )
  };
}

describe("authoritative capability reclassification seam", () => {
  it("keeps the unified tool surface stable across modes and reclassifies risk independently from the mode name", () => {
    const registry = createStaticToolRegistry();
    const chatExposure = createCanonicalToolExposure({ registry, resolvedMode: "chat" });
    const actExposure = createCanonicalToolExposure({ registry, resolvedMode: "act" });

    expect(chatExposure.exposedTools.map((tool) => tool.name)).toEqual(["read", "glob", "grep", "write", "edit", "bash"]);
    expect(actExposure.exposedTools.map((tool) => tool.name)).toEqual(["read", "glob", "grep", "write", "edit", "bash"]);

    const chatTruth = reclassifyCapabilityTruth({ exposure: chatExposure });
    const actTruth = reclassifyCapabilityTruth({ exposure: actExposure });

    expect(chatTruth).toMatchObject({
      guaranteedToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
      guaranteedCapabilities: expect.arrayContaining([
        "workspace_read",
        "workspace_write",
        "workspace_local_routine_bash",
        "local_git_status",
        "local_git_commit"
      ]),
      approvalRequiredCapabilities: ["remote_git_push", "pull_request_create"],
      notGuaranteedCapabilities: expect.arrayContaining(["mainline_merge", "deploy", "production_side_effects"])
    });
    expect(actTruth).toEqual(chatTruth);
  });

  it("distinguishes local routine bash from push, PR, and higher-risk side effects", () => {
    const registry = createStaticToolRegistry();
    const exposure = createCanonicalToolExposure({ registry, resolvedMode: "chat" });

    expect(evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_bash_test",
      toolName: "bash",
      exposure,
      arguments: { command: "pnpm test" }
    })).toMatchObject({
      behavior: "allow",
      reasonCode: "bash_action_auto_allowed"
    });

    expect(evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_git_status",
      toolName: "bash",
      exposure,
      arguments: { command: "git status --short" }
    })).toMatchObject({
      behavior: "allow",
      reasonCode: "bash_action_auto_allowed"
    });

    expect(evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_git_commit",
      toolName: "bash",
      exposure,
      arguments: { command: "git commit -m 'slice1'" }
    })).toMatchObject({
      behavior: "allow",
      reasonCode: "bash_action_auto_allowed"
    });

    expect(evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_git_push",
      toolName: "bash",
      exposure,
      arguments: { command: "git push origin HEAD" }
    })).toMatchObject({
      behavior: "ask",
      reasonCode: "bash_action_requires_approval"
    });

    expect(evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_pr_create",
      toolName: "bash",
      exposure,
      arguments: { command: "gh pr create --fill" }
    })).toMatchObject({
      behavior: "ask",
      reasonCode: "bash_action_requires_approval"
    });

    expect(evaluateToolCallPermission({
      turnId: "turn_001",
      toolCallId: "tool_call_deploy",
      toolName: "bash",
      exposure,
      arguments: { command: "vercel deploy" }
    })).toMatchObject({
      behavior: "deny",
      reasonCode: "bash_action_not_guaranteed"
    });
  });

  it("shrinks authoritative truth to the current narrowed exposure instead of overpromising hidden capabilities", () => {
    const exposure = createNarrowedExposure(["read", "glob"]);

    const truth = reclassifyCapabilityTruth({ exposure });

    expect(truth).toMatchObject({
      visibleToolNames: ["read", "glob"],
      guaranteedToolNames: ["read", "glob"],
      guaranteedCapabilities: ["workspace_read"],
      approvalRequiredCapabilities: [],
      notGuaranteedCapabilities: expect.arrayContaining([
        "workspace_write",
        "workspace_local_routine_bash",
        "local_git_status",
        "local_git_commit",
        "remote_git_push",
        "pull_request_create",
        "mainline_merge",
        "deploy",
        "production_side_effects"
      ])
    });
    expect(truth.actionAuthorizations).toEqual([
      expect.objectContaining({
        actionClass: "workspace_read",
        authorizationLevel: "guaranteed"
      })
    ]);
  });

  it("stays consistent with the permission evaluator when bash is hidden in the current turn", () => {
    const exposure = createNarrowedExposure(["read", "glob"]);
    const truth = reclassifyCapabilityTruth({ exposure });
    const bashDecision = evaluateToolCallPermission({
      turnId: "turn_hidden_bash",
      toolCallId: "tool_call_hidden_bash",
      toolName: "bash",
      exposure,
      arguments: { command: "pnpm test" }
    });

    expect(bashDecision).toMatchObject({
      behavior: "deny",
      reasonCode: "tool_hidden"
    });
    expect(truth.guaranteedCapabilities).not.toContain("workspace_local_routine_bash");
    expect(truth.guaranteedCapabilities).not.toContain("local_git_status");
    expect(truth.guaranteedCapabilities).not.toContain("local_git_commit");
    expect(truth.approvalRequiredCapabilities).not.toContain("remote_git_push");
    expect(truth.approvalRequiredCapabilities).not.toContain("pull_request_create");
    expect(truth.notGuaranteedCapabilities).toEqual(
      expect.arrayContaining(["workspace_local_routine_bash", "remote_git_push", "pull_request_create"])
    );
    expect(truth.actionAuthorizations.some((entry) => entry.toolName === "bash")).toBe(false);
  });
});
