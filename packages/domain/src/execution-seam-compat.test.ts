import { describe, expect, it } from "vitest";
import {
  ContextAssemblyResultSchema,
  ExecutionControlInputSchema,
  ExecutionFrameSchema,
  PendingExecutionSchema
} from "./index.ts";

describe("WS4 execution seam compatibility", () => {
  it("preserves WS0 execution-control, pending-execution, frameRef, and WS1 assembly surfaces", () => {
    const frame = ExecutionFrameSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.execution-frame.v1",
      frameRef: "frame:turn_001",
      checkpointRef: "checkpoint:turn_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      phase: "awaiting_permission",
      step: "tool_batch",
      pendingToolCalls: [
        {
          toolCallId: "tool_call_001",
          toolName: "write",
          arguments: { path: "notes.txt", content: "hello" }
        }
      ],
      pendingPermissionDecisions: [
        {
          decisionId: "decision_ask_001",
          behavior: "ask",
          scope: "once",
          reasonCode: "tool_requires_approval",
          reasonText: "write requires approval",
          issuedAt: new Date().toISOString(),
          requestedBy: "turn_001"
        }
      ],
      loopCount: 1,
      toolCallCount: 1,
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
        estimatedCost: 0.01
      },
      continuation: {
        continuationKind: "awaiting_operator",
        allowedActions: ["approve", "deny", "cancel"],
        metadata: {
          stopReason: "permission_required"
        }
      }
    });

    const pendingExecution = PendingExecutionSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.pending-execution.v1",
      pendingExecutionId: "pending:turn_001",
      frameRef: frame.frameRef,
      checkpointRef: frame.checkpointRef,
      status: "blocked",
      frame,
      sessionStateRef: "session_state_ref:turn_001"
    });

    const contextAssembly = ContextAssemblyResultSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.context-assembly.v1",
      assemblyId: "assembly:turn_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      resolvedMode: "act",
      runtimeContextBlocks: [
        {
          blockId: "prompt:system_prompt",
          kind: "system",
          title: "system prompt",
          content: "You are Endec.",
          tokenCount: 4,
          sourceRefs: []
        },
        {
          blockId: "continuation:pending:turn_001",
          kind: "instruction",
          title: "pending execution continuation",
          content: "Continue the existing turn from the pending frame.",
          tokenCount: 12,
          sourceRefs: ["turn_001", "frame:turn_001", "checkpoint:turn_001"]
        },
        {
          blockId: "user_input:turn_001",
          kind: "user_input",
          title: "user input",
          content: "continue from the pending frame",
          tokenCount: 7,
          sourceRefs: ["turn_001"]
        }
      ],
      metadata: {
        assemblySource: "app-layer",
        memorySourceRefs: ["working_set:session_001:4"]
      },
      budgeting: {
        inputTokenBudget: 10000,
        outputTokenBudget: 1800,
        memoryInjectionBudget: 1000,
        toolResultInjectionBudget: 1400
      },
      toolExposure: {
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      },
      promptContract: {
        version: "ws1",
        assemblyOrder: [
          "system_prompt",
          "mode_overlay",
          "tool_use_contract_overlay",
          "recovery_overlay",
          "blocked_overlay",
          "continuation_overlay",
          "user_input"
        ],
        layers: [
          {
            layerId: "prompt:system_prompt",
            kind: "system_prompt",
            title: "system prompt",
            content: "You are Endec.",
            placement: "prepend",
            tokenCount: 4,
            optional: false,
            applied: true
          },
          {
            layerId: "prompt:user_input",
            kind: "user_input",
            title: "user input",
            content: "continue from the pending frame",
            placement: "append",
            tokenCount: 7,
            optional: false,
            applied: true
          }
        ],
        userInputPlacement: {
          kind: "dedicated_block",
          position: "last"
        },
        overlayHooks: {
          recovery: {
            kind: "recovery",
            available: true,
            applied: true,
            layerId: "prompt:recovery_overlay",
            reason: "resume checkpoint present"
          },
          blocked: {
            kind: "blocked",
            available: true,
            applied: false
          },
          continuation: {
            kind: "continuation",
            available: true,
            applied: true,
            layerId: "prompt:continuation_overlay",
            reason: "resume flow requested"
          }
        }
      },
      runtimeRequest: {
        turnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        resolvedMode: "act",
        correlation: {
          source: "cli",
          actorId: "actor_user"
        },
        userInput: {
          text: "continue from the pending frame",
          attachments: []
        },
        model: {
          providerId: "provider_local",
          modelId: "model_strong",
          modelTier: "strong"
        },
        toolSchemas: [],
        contextBlocks: [
          {
            blockId: "prompt:system_prompt",
            kind: "system",
            title: "system prompt",
            content: "You are Endec.",
            tokenCount: 4,
            sourceRefs: []
          },
          {
            blockId: "continuation:pending:turn_001",
            kind: "instruction",
            title: "pending execution continuation",
            content: "Continue the existing turn from the pending frame.",
            tokenCount: 12,
            sourceRefs: ["turn_001", "frame:turn_001", "checkpoint:turn_001"]
          },
          {
            blockId: "user_input:turn_001",
            kind: "user_input",
            title: "user input",
            content: "continue from the pending frame",
            tokenCount: 7,
            sourceRefs: ["turn_001"]
          }
        ],
        turnContext: {
          memory: {
            workingSetSummary: "keep continuity",
            retrievedItems: [],
            injectionPlan: [],
            tokenEstimate: 20,
            sourceRefs: ["working_set:session_001:4"],
            continuity: {
              retrievalPolicy: {
                strategy: "continuation",
                activeTaskSelection: {
                  mode: "none"
                },
                includeWorkingSet: true,
                includeRecentHistory: true,
                includeActiveTask: false,
                includeTypedMemory: true,
                includeEvidence: true
              },
              recentHistory: {
                summary: "last turn blocked",
                refs: ["turn_prev"],
                turnRefs: ["turn_prev"]
              },
              workingSet: {
                ref: "working_set:session_001:4",
                version: 4,
                summary: "keep continuity",
                objective: "preserve retrieval seam compatibility",
                recentProgress: ["captured continuity surface"],
                recentDecisions: ["keep markdown as locator only"],
                blockers: [],
                openLoops: ["wire projection refs through continuity"],
                activeMemoryRefs: ["memory:turn_prev:typed_memory:0"],
                activeTaskRefs: ["task_001"],
                recentEventRefs: ["turn_prev"],
                sourceRefs: ["turn_prev"]
              },
              typedMemory: [
                {
                  kind: "candidate_extract",
                  status: "pending",
                  sourceRefs: ["turn_prev"],
                  payload: {
                    contract: "candidate_extract_pending"
                  }
                }
              ],
              evidence: [
                {
                  ref: "evidence:turn_prev",
                  topic: "continuity",
                  content: "Prior turn evidence",
                  sourceRefs: ["turn_prev"]
                }
              ],
              projectionDerivedRefs: [
                {
                  ref: "projection:workspace_local:2026-04-16#continuity",
                  day: "2026-04-16",
                  section: "continuity",
                  summary: "Daily projection points back to the canonical continuity turn.",
                  sourceRefs: ["working_set:session_001:4", "evidence:turn_prev"],
                  turnRefs: ["turn_prev"]
                }
              ]
            }
          }
        },
        limits: {
          inputTokenBudget: 10000,
          outputTokenBudget: 1800,
          memoryInjectionBudget: 1000,
          toolResultInjectionBudget: 1400,
          maxLoopCount: 6,
          maxToolCallsPerBatch: 8,

          maxToolCallsPerTurn: 8
        }
      },
      budget: {
        inputTokenBudget: 10000,
        projectedInputTokens: 23,
        historyBudget: 3000,
        historyTokensUsed: 0,
        historyTruncated: false,
        memoryInjectionBudget: 1000,
        memoryTokensUsed: 20,
        memoryTruncated: false,
        toolResultInjectionBudget: 1400,
        toolResultTokensUsed: 0
      },
      selection: {
        recentHistoryTurnIds: ["turn_prev"],
        memorySourceRefs: ["working_set:session_001:4"],
        evidenceIds: ["evidence:turn_prev"],
        projectionRefs: ["projection:workspace_local:2026-04-16#continuity"],
        exposedToolNames: []
      },
      warnings: []
    });

    const control = ExecutionControlInputSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "resume",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      turnId: "turn_001",
      frameRef: pendingExecution.frameRef,
      input: "continue from the pending frame"
    });

    expect(pendingExecution.frameRef).toBe("frame:turn_001");
    expect(contextAssembly.runtimeRequest.turnContext?.memory.continuity?.workingSet).toMatchObject({
      objective: "preserve retrieval seam compatibility",
      recentProgress: ["captured continuity surface"],
      recentDecisions: ["keep markdown as locator only"],
      openLoops: ["wire projection refs through continuity"],
      activeMemoryRefs: ["memory:turn_prev:typed_memory:0"],
      activeTaskRefs: ["task_001"],
      recentEventRefs: ["turn_prev"]
    });
    expect(contextAssembly.runtimeRequest.turnContext?.memory.continuity?.typedMemory).toHaveLength(1);
    expect(contextAssembly.runtimeRequest.turnContext?.memory.continuity?.evidence).toHaveLength(1);
    expect(contextAssembly.runtimeRequest.turnContext?.memory.continuity?.projectionDerivedRefs).toEqual([
      expect.objectContaining({
        ref: "projection:workspace_local:2026-04-16#continuity",
        sourceRefs: ["working_set:session_001:4", "evidence:turn_prev"],
        turnRefs: ["turn_prev"]
      })
    ]);
    expect(control.frameRef).toBe("frame:turn_001");
  });
});
