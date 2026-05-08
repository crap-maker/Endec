import { describe, expect, it, vi } from "vitest";
import { PendingExecutionSchema, type ContextAssemblyResult } from "@endec/domain";
import { createAgentCore } from "./agent-core.ts";

function createBudgetResolution() {
  return {
    resolvedMode: "act" as const,
    model: {
      providerId: "local-default",
      modelId: "strong-default",
      modelTier: "strong" as const
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
  };
}

function createContextAssembly(overrides: Partial<ContextAssemblyResult["runtimeRequest"]> = {}): ContextAssemblyResult {
  const resolution = createBudgetResolution();
  const contextBlocks = overrides.contextBlocks ?? [
    {
      blockId: "prompt:system_prompt",
      kind: "system",
      title: "system prompt",
      content: "You are Endec.",
      tokenCount: 4,
      sourceRefs: []
    },
    {
      blockId: "user_input:turn_001",
      kind: "user_input",
      title: "user input",
      content: "hello",
      tokenCount: 2,
      sourceRefs: ["turn_001"]
    }
  ];
  const toolSchemas = overrides.toolSchemas ?? [];

  return {
    schemaVersion: 1,
    contractVersion: "ws0.context-assembly.v1",
    assemblyId: `assembly:${overrides.turnId ?? "turn_001"}`,
    turnId: overrides.turnId ?? "turn_001",
    sessionId: overrides.sessionId ?? "session_001",
    workspaceId: overrides.workspaceId ?? "workspace_local",
    resolvedMode: overrides.resolvedMode ?? resolution.resolvedMode,
    runtimeContextBlocks: contextBlocks,
    metadata: {
      assemblySource: "app-layer",
      memorySourceRefs: []
    },
    budgeting: {
      inputTokenBudget: resolution.limits.inputTokenBudget,
      outputTokenBudget: resolution.limits.outputTokenBudget,
      memoryInjectionBudget: resolution.limits.memoryInjectionBudget,
      toolResultInjectionBudget: resolution.limits.toolResultInjectionBudget
    },
    toolExposure: {
      exposureSource: "policy",
      exposedTools: toolSchemas,
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
          content: overrides.userInput?.text ?? "hello",
          placement: "append",
          tokenCount: 2,
          optional: false,
          applied: true
        }
      ],
      userInputPlacement: {
        kind: "dedicated_block",
        position: "last"
      },
      overlayHooks: {
        recovery: { kind: "recovery", available: true, applied: false },
        blocked: { kind: "blocked", available: true, applied: false },
        continuation: { kind: "continuation", available: true, applied: false }
      }
    },
    runtimeRequest: {
      turnId: overrides.turnId ?? "turn_001",
      sessionId: overrides.sessionId ?? "session_001",
      workspaceId: overrides.workspaceId ?? "workspace_local",
      resolvedMode: overrides.resolvedMode ?? resolution.resolvedMode,
      correlation: overrides.correlation ?? {
        source: "cli",
        actorId: "actor_user"
      },
      userInput: overrides.userInput ?? {
        text: "hello",
        attachments: []
      },
      model: overrides.model ?? resolution.model,
      toolSchemas,
      contextBlocks,
      limits: overrides.limits ?? resolution.limits,
      turnContext: {
        memory: {
          workingSetSummary: "keep continuity",
          retrievedItems: [],
          injectionPlan: [],
          tokenEstimate: 16,
          sourceRefs: ["working_set:session_001:1"],
          continuity: {
            retrievalPolicy: {
              strategy: "continuation",
              activeTaskSelection: {
                mode: "request_task",
                taskId: "task_001"
              },
              includeWorkingSet: true,
              includeRecentHistory: true,
              includeActiveTask: true,
              includeTypedMemory: true,
              includeEvidence: true
            },
            recentHistory: {
              summary: "last turn blocked",
              refs: ["turn_prev"],
              turnRefs: ["turn_prev"]
            },
            workingSet: {
              ref: "working_set:session_001:1",
              version: 1,
              summary: "keep continuity",
              objective: "preserve the frozen retrieval seam",
              recentProgress: [],
              recentDecisions: [],
              blockers: [],
              openLoops: [],
              activeMemoryRefs: [],
              activeTaskRefs: ["task_001"],
              recentEventRefs: ["turn_prev"],
              sourceRefs: ["turn_prev"]
            },
            activeTask: {
              taskId: "task_001",
              title: "Ship WS4",
              status: "blocked",
              checkpointRef: "checkpoint:task_001",
              updatedAt: "2026-04-11T10:00:00.000Z",
              selectedBy: "request_task"
            },
            typedMemory: [],
            evidence: [],
            projectionDerivedRefs: []
          },
          contextBlocks
        }
      }
    },
    budget: {
      inputTokenBudget: resolution.limits.inputTokenBudget,
      projectedInputTokens: 12,
      historyBudget: 3000,
      historyTokensUsed: 0,
      historyTruncated: false,
      memoryInjectionBudget: resolution.limits.memoryInjectionBudget,
      memoryTokensUsed: 16,
      memoryTruncated: false,
      toolResultInjectionBudget: resolution.limits.toolResultInjectionBudget,
      toolResultTokensUsed: 0
    },
    selection: {
      recentHistoryTurnIds: [],
      memorySourceRefs: ["working_set:session_001:1"],
      activeTaskId: "task_001",
      evidenceIds: [],
      projectionRefs: [],
      typedMemoryScopes: [],
      exposedToolNames: toolSchemas.map((tool) => tool.name)
    },
    warnings: []
  };
}

describe("AgentCore WS1 seam compatibility", () => {
  it("persists frameRef + pendingExecution when permission blocks execution", async () => {
    const markInflight = vi.fn(async () => undefined);

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        markInflight,
        async finalize() {
          return "session_state_ref:turn_blocked";
        }
      },
      contextAssembler: {
        async assemble() {
          return createContextAssembly();
        }
      },
      memoryPort: {
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return {
            schemaVersion: 1 as const,
            contractVersion: "ws0.tool-batch.v1" as const,
            batchId: input.batchId,
            turnId: input.turnId,
            requestedToolCalls: input.requestedToolCalls,
            permissionDecisions: [
              {
                decisionId: "decision_001",
                behavior: "ask" as const,
                scope: "once" as const,
                reasonCode: "tool_requires_approval",
                reasonText: "write requires approval",
                issuedAt: new Date().toISOString(),
                requestedBy: "turn_blocked"
              }
            ],
            executionResults: []
          };
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        async recordCost() {
          return "ledger_001";
        }
      },
      runtimePort: {
        async run() {
          return {
            turnId: "turn_blocked",
            stopReason: "tool_calls_pending",
            messages: [{ role: "assistant" as const, content: "Need approval first." }],
            requestedToolCalls: [
              {
                toolCallId: "tool_call_001",
                toolName: "write",
                arguments: { path: "notes.txt", content: "hello" }
              }
            ],
            loopCount: 1,
            toolCallCount: 1,
            toolResultTokensUsed: 0,
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              estimatedCost: 0.01
            },
            warnings: [],
            permissionDecisions: [],
            toolExecutionResults: [],
            artifacts: []
          };
        }
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "please write the file",
      attachments: []
    });

    expect(result.status).toBe("blocked");
    expect(result.frameRef).toBe("frame:turn_blocked");
    expect(result.continuation).toMatchObject({
      contractVersion: "ws0.execution-control.v1",
      frameRef: "frame:turn_blocked",
      allowedActions: ["approve", "deny", "cancel"]
    });
    expect(markInflight).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn_blocked",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        loopCount: 1,
        toolCallCount: 1,
        frameRef: "frame:turn_blocked",
        contractVersion: "ws0.pending-execution.v1",
        pendingExecution: expect.objectContaining({
          frameRef: "frame:turn_blocked",
          frame: expect.objectContaining({
            phase: "awaiting_permission",
            step: "tool_batch"
          })
        })
      })
    );

    const firstMarkInflightCall = (markInflight.mock.calls as Array<[unknown?]>)[0]?.[0] as { pendingExecution?: unknown } | undefined;
    const pendingExecution = PendingExecutionSchema.parse(firstMarkInflightCall?.pendingExecution);
    expect(pendingExecution.frame.pendingToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_001",
        toolName: "write"
      })
    ]);
  });
});
