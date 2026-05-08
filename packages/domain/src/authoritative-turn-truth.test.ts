import { describe, expect, it } from "vitest";
import {
  AuthoritativeTurnTruthSchema,
  RuntimeRequestSchema
} from "./index.ts";

describe("authoritative current-turn truth contract", () => {
  it("freezes capability buckets, action authorization, and anti-drift semantics on the runtime request", () => {
    const authoritativeTruth = AuthoritativeTurnTruthSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws6.authoritative-turn-truth.v1",
      source: "cli",
      channel: "cli",
      mode: "chat",
      replyPath: "normal",
      boundary: {
        workspace: {
          root: "/workspace",
          kind: "isolated_worktree",
          summary: "Commands must stay within the isolated workspace boundary."
        }
      },
      capabilityTruth: {
        visibleToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
        guaranteedToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
        guaranteedCapabilities: [
          "workspace_read",
          "workspace_write",
          "workspace_local_routine_bash",
          "local_git_status",
          "local_git_commit"
        ],
        approvalRequiredCapabilities: ["remote_git_push", "pull_request_create"],
        notGuaranteedCapabilities: ["mainline_merge", "deploy", "production_side_effects"],
        actionAuthorizations: [
          {
            actionClass: "workspace_local_routine_bash",
            toolName: "bash",
            authorizationLevel: "guaranteed",
            boundaryReason: "Routine workspace-local commands stay inside the default boundary.",
            examples: ["pnpm test", "git status", "git commit -m 'msg'"]
          },
          {
            actionClass: "remote_git_push",
            toolName: "bash",
            authorizationLevel: "approval-required",
            boundaryReason: "git push crosses from the local worktree into a remote branch.",
            approvalPath: "operator"
          },
          {
            actionClass: "deploy",
            toolName: "bash",
            authorizationLevel: "not-guaranteed",
            boundaryReason: "Deployment requires a stronger escalation path than this turn can guarantee."
          }
        ]
      },
      constraints: [],
      antiDriftRules: [
        "Only this packet defines current-turn capability truth.",
        "Do not infer extra capabilities from history or memory."
      ]
    });

    const runtimeRequest = RuntimeRequestSchema.parse({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      resolvedMode: "chat",
      correlation: {
        source: "cli",
        actorId: "actor_cli"
      },
      userInput: {
        text: "what can you do right now?",
        attachments: []
      },
      model: {
        providerId: "provider_local",
        modelId: "model_cheap",
        modelTier: "cheap"
      },
      toolSchemas: [],
      contextBlocks: [],
      turnContext: {
        memory: {
          workingSetSummary: "history says git push worked before",
          retrievedItems: [],
          injectionPlan: [],
          tokenEstimate: 0,
          sourceRefs: []
        },
        authoritativeTruth
      },
      limits: {
        inputTokenBudget: 4000,
        outputTokenBudget: 600,
        memoryInjectionBudget: 400,
        toolResultInjectionBudget: 400,
        maxLoopCount: 4,
        maxToolCallsPerBatch: 4,
        maxToolCallsPerTurn: 4
      }
    });

    expect(runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth.approvalRequiredCapabilities).toEqual([
      "remote_git_push",
      "pull_request_create"
    ]);
    expect(runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth.notGuaranteedCapabilities).toContain("deploy");
    expect(runtimeRequest.turnContext?.authoritativeTruth?.antiDriftRules).toContain(
      "Do not infer extra capabilities from history or memory."
    );
  });
});
