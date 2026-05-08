import { describe, expect, it } from "vitest";
import type { RuntimeMemoryContext, TurnRequest } from "@endec/domain";
import { createContextAssembler } from "./context-assembler.ts";

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli",
    actorId: "actor_cli",
    input: "Continue the blocked turn.",
    attachments: [],
    resumeFrom: "checkpoint:turn_001",
    channelContext: {
      executionControl: {
        action: "resume"
      }
    },
    ...overrides
  };
}

function createMemoryContext(overrides: Partial<RuntimeMemoryContext> = {}): RuntimeMemoryContext {
  return {
    workingSetSummary: "Focus on the frozen execution seam.",
    retrievedItems: [],
    injectionPlan: [],
    tokenEstimate: 24,
    sourceRefs: ["working_set:session_001:1"],
    ...overrides
  };
}

describe("createContextAssembler seam compatibility", () => {
  it("restores structured toolExposure alongside runtimeRequest.toolSchemas", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext();
        },
        async searchEvidence() {
          return { items: [] };
        },
        async listOutbox() {
          return [];
        }
      },
      taskStore: {
        async loadById() {
          return undefined;
        },
        async listActiveBySession() {
          return [];
        }
      },
      resolveToolExposure: async () => ({
        exposureSource: "policy" as const,
        exposedTools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"]
            }
          }
        ],
        hiddenToolNames: ["bash"]
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest(),
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
      },
      continuation: {
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
            phase: "awaiting_operator",
            step: "budget_check",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "awaiting_operator",
              allowedActions: ["resume", "cancel"],
              metadata: {}
            }
          }
        },
        control: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-control.v1",
          action: "resume",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          turnId: "turn_001",
          frameRef: "frame:turn_001",
          input: "Continue the blocked turn."
        }
      }
    });

    expect(result.contractVersion).toBe("ws0.context-assembly.v1");
    expect(result.runtimeContextBlocks).toEqual(result.runtimeRequest.contextBlocks);
    expect(result.toolExposure).toMatchObject({
      exposureSource: "policy",
      hiddenToolNames: ["bash"],
      exposedTools: [expect.objectContaining({ name: "read" })]
    });
    expect(result.runtimeRequest.toolSchemas).toEqual(result.toolExposure.exposedTools);
    expect(result.selection.exposedToolNames).toEqual(["read"]);
    expect(result.promptContract.overlayHooks.continuation.applied).toBe(true);
    expect(result.runtimeRequest.contextBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blockId: "continuation:pending:turn_001", kind: "instruction" }),
        expect.objectContaining({ blockId: "user_input:turn_001", kind: "user_input" })
      ])
    );
  });
});
