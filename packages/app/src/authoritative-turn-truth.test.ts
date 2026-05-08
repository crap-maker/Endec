import { describe, expect, it } from "vitest";
import type { ContextToolExposure, RuntimeMemoryContext, TurnRequest } from "@endec/domain";
import { createContextAssembler } from "./context-assembler.ts";
import { createAppToolPort } from "./tool-port.ts";

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli",
    actorId: "actor_cli",
    input: "What can you do in this turn?",
    attachments: [],
    ...overrides
  };
}

function createMemoryContext(overrides: Partial<RuntimeMemoryContext> = {}): RuntimeMemoryContext {
  return {
    workingSetSummary: "History mentions that git push and deploy happened in older turns.",
    retrievedItems: [],
    injectionPlan: [],
    tokenEstimate: 18,
    sourceRefs: ["working_set:session_001:7"],
    continuity: undefined,
    contextBlocks: [],
    ...overrides
  };
}

function createInlineArtifactPolicy() {
  return {
    async spillIfNeeded(input: {
      turnId: string;
      sessionId: string;
      kind: "runtime_output" | "tool_result";
      mimeType?: string;
      content: string;
    }) {
      return {
        kind: "inline" as const,
        content: input.content
      };
    }
  };
}

function narrowExposure(exposure: ContextToolExposure, toolNames: string[]): ContextToolExposure {
  const visible = new Set(toolNames);

  return {
    exposureSource: exposure.exposureSource,
    exposedTools: exposure.exposedTools.filter((tool) => visible.has(tool.name)),
    hiddenToolNames: exposure.hiddenToolNames.concat(
      exposure.exposedTools
        .filter((tool) => !visible.has(tool.name))
        .map((tool) => tool.name)
    )
  };
}

describe("context assembler authoritative truth packet", () => {
  it("injects canonical current-turn truth with anti-drift rules instead of mode-derived exposure aliases", async () => {
    const toolPort = createAppToolPort({
      cwd: "/workspace",
      artifacts: createInlineArtifactPolicy()
    });
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext();
        }
      },
      taskStore: {
        async loadById() {
          return undefined;
        },
        async loadLatestActiveBySession() {
          return undefined;
        },
        async listActiveBySession() {
          return [];
        }
      },
      resolveToolExposure: async ({ request, session, budget }) =>
        toolPort.describeExposure({
          turnId: request.turnId,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          resolvedMode: budget.resolvedMode
        })
    });

    const chat = await assembler.assemble({
      request: createTurnRequest({ turnId: "turn_chat_truth", requestedMode: "chat" }),
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local"
      },
      budget: {
        resolvedMode: "chat",
        model: {
          providerId: "provider_local",
          modelId: "model_cheap",
          modelTier: "cheap"
        },
        limits: {
          inputTokenBudget: 1000,
          outputTokenBudget: 400,
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      }
    });

    const act = await assembler.assemble({
      request: createTurnRequest({ turnId: "turn_act_truth", requestedMode: "act" }),
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local"
      },
      budget: {
        resolvedMode: "act",
        model: {
          providerId: "provider_local",
          modelId: "model_strong",
          modelTier: "strong"
        },
        limits: {
          inputTokenBudget: 1000,
          outputTokenBudget: 400,
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      }
    });

    expect(chat.selection.exposedToolNames).toEqual(["read", "glob", "grep", "write", "edit", "bash"]);
    expect(chat.runtimeRequest.turnContext?.selfAwareness?.exposedToolNames).toEqual([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "bash"
    ]);
    expect(chat.runtimeRequest.turnContext?.authoritativeTruth).toMatchObject({
      mode: "chat",
      replyPath: "normal",
      capabilityTruth: {
        guaranteedToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
        approvalRequiredCapabilities: ["remote_git_push", "pull_request_create"],
        notGuaranteedCapabilities: expect.arrayContaining(["mainline_merge", "deploy", "production_side_effects"]),
        actionAuthorizations: expect.arrayContaining([
          expect.objectContaining({
            actionClass: "workspace_local_routine_bash",
            authorizationLevel: "guaranteed"
          }),
          expect.objectContaining({
            actionClass: "remote_git_push",
            authorizationLevel: "approval-required"
          }),
          expect.objectContaining({
            actionClass: "deploy",
            authorizationLevel: "not-guaranteed"
          })
        ])
      },
      antiDriftRules: expect.arrayContaining([
        "Do not infer extra current-turn capabilities from history or memory."
      ])
    });
    expect(act.runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth).toEqual(
      chat.runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth
    );

    const truthBlock = chat.runtimeRequest.contextBlocks.find((block) => block.title === "authoritative current-turn truth");
    expect(truthBlock?.content).toContain("guaranteed tools: read, glob, grep, write, edit, bash");
    expect(truthBlock?.content).toContain("approval-required capabilities: remote_git_push, pull_request_create");
    expect(truthBlock?.content).toContain("not-guaranteed capabilities: mainline_merge, deploy, production_side_effects");
    expect(truthBlock?.content).toContain("anti-drift: do not infer extra current-turn capabilities from history or memory");
  });

  it("keeps authoritative truth narrowed when selection exposure is narrowed to read and glob", async () => {
    const toolPort = createAppToolPort({
      cwd: "/workspace",
      artifacts: createInlineArtifactPolicy()
    });
    const canonicalExposure = await toolPort.describeExposure({
      turnId: "turn_narrowed_truth",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      resolvedMode: "chat"
    });
    const narrowedExposure = narrowExposure(canonicalExposure, ["read", "glob"]);
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext();
        }
      },
      taskStore: {
        async loadById() {
          return undefined;
        },
        async loadLatestActiveBySession() {
          return undefined;
        },
        async listActiveBySession() {
          return [];
        }
      },
      resolveToolExposure: async () => narrowedExposure
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_narrowed_truth",
        requestedMode: "chat",
        input: "What can you do right now?"
      }),
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local"
      },
      budget: {
        resolvedMode: "chat",
        model: {
          providerId: "provider_local",
          modelId: "model_cheap",
          modelTier: "cheap"
        },
        limits: {
          inputTokenBudget: 1000,
          outputTokenBudget: 400,
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      }
    });

    expect(result.selection.exposedToolNames).toEqual(["read", "glob"]);
    expect(result.runtimeRequest.turnContext?.selfAwareness?.exposedToolNames).toEqual(["read", "glob"]);
    expect(result.runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth).toMatchObject({
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
        "pull_request_create"
      ])
    });
    expect(
      result.runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth.actionAuthorizations.some((entry) => entry.toolName === "bash")
    ).toBe(false);

    const truthBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "authoritative current-turn truth");
    expect(truthBlock?.content).toContain("guaranteed tools: read, glob");
    expect(truthBlock?.content).toContain("guaranteed capabilities: workspace_read");
    expect(truthBlock?.content).toContain(
      "not-guaranteed capabilities: workspace_write, workspace_local_routine_bash, local_git_status, local_git_commit, remote_git_push, pull_request_create"
    );
    expect(truthBlock?.content).not.toContain("workspace_local_routine_bash=guaranteed");
    expect(truthBlock?.content).not.toContain("remote_git_push=approval-required");
  });
});
