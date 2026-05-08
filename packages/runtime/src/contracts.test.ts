import { describe, expect, it } from "vitest";
import { RuntimeRequestSchema, RuntimeResultSchema } from "./index.ts";
import type { ArtifactPolicyPort } from "./artifact-policy.ts";
import type { ProviderPort } from "./provider-port.ts";

describe("runtime contract surface", () => {
  it("re-exports frozen runtime schemas and provider/artifact ports", async () => {
    const provider: ProviderPort = {
      invoke() {
        return (async function* () {
          yield {
            invocationId: "invoke_001",
            sequence: 1,
            timestamp: new Date().toISOString(),
            kind: "completed",
            completion: {
              invocationId: "invoke_001",
              finishReason: "stop",
              messages: [{ role: "assistant", content: "done" }],
              toolCalls: [],
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                estimatedCost: 0.001
              },
              warnings: []
            }
          };
        })();
      }
    };

    const artifacts: ArtifactPolicyPort = {
      async spillIfNeeded() {
        return {
          kind: "inline",
          content: "small result"
        };
      }
    };

    const stream = provider.invoke({
      invocationId: "invoke_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      mode: "chat",
      model: {
        providerId: "provider_local",
        modelId: "model_cheap"
      },
      contextBlocks: [
        {
          blockId: "ctx_001",
          kind: "user_input",
          content: "hello",
          sourceRefs: ["turn_001"]
        }
      ],
      tools: []
    });
    const first = await stream[Symbol.asyncIterator]().next();

    const runtimeRequest = RuntimeRequestSchema.parse({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      resolvedMode: "chat",
      correlation: {
        source: "cli",
        actorId: "actor_user"
      },
      userInput: {
        text: "hello",
        attachments: []
      },
      model: {
        providerId: "provider_local",
        modelId: "model_cheap"
      },
      toolSchemas: [],
      contextBlocks: [
        {
          blockId: "ctx_001",
          kind: "user_input",
          content: "hello",
          sourceRefs: ["turn_001"]
        }
      ],
      turnContext: {
        memory: {
          workingSetSummary: "history mentioned git push last turn",
          retrievedItems: [],
          injectionPlan: [],
          tokenEstimate: 0,
          sourceRefs: []
        },
        authoritativeTruth: {
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
            guaranteedCapabilities: ["workspace_read", "workspace_write", "workspace_local_routine_bash"],
            approvalRequiredCapabilities: ["remote_git_push", "pull_request_create"],
            notGuaranteedCapabilities: ["deploy"],
            actionAuthorizations: [
              {
                actionClass: "workspace_local_routine_bash",
                toolName: "bash",
                authorizationLevel: "guaranteed",
                boundaryReason: "Routine workspace-local commands stay inside the default boundary.",
                examples: ["pnpm test"]
              }
            ]
          },
          constraints: [],
          antiDriftRules: ["Do not infer extra capabilities from history or memory."]
        }
      },
      limits: {
        inputTokenBudget: 6000,
        outputTokenBudget: 900,
        memoryInjectionBudget: 600,
        toolResultInjectionBudget: 800,
        maxLoopCount: 2,
        maxToolCallsPerBatch: 2,

        maxToolCallsPerTurn: 2
      }
    });

    const runtimeResult = RuntimeResultSchema.parse({
      turnId: runtimeRequest.turnId,
      messages: [{ role: "assistant", content: "done" }],
      requestedToolCalls: [],
      loopCount: 1,
      toolCallCount: 0,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedCost: 0.001
      },
      warnings: [],
      stopReason: "completed"
    });

    expect(first.value.kind).toBe("completed");
    expect(await artifacts.spillIfNeeded({
      turnId: runtimeRequest.turnId,
      sessionId: runtimeRequest.sessionId,
      kind: "runtime_output",
      mimeType: "text/plain",
      content: "small result"
    })).toEqual({
      kind: "inline",
      content: "small result"
    });
    expect(runtimeResult.stopReason).toBe("completed");
  });
});
