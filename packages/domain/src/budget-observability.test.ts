import { describe, expect, it } from "vitest";
import {
  ContextAssemblyObservabilitySchema,
  ContextAssemblyResultSchema,
  MEMORY_CONTEXT_TRUNCATED_CODE
} from "./index.ts";

describe("budget observability domain contract", () => {
  it("accepts prompt/context budget observability and structured diagnostics", () => {
    const observability = ContextAssemblyObservabilitySchema.parse({
      authoritativeTruth: {
        packet: {
          schemaVersion: 1,
          contractVersion: "ws6.authoritative-turn-truth.v1",
          source: "cli",
          channel: "cli",
          mode: "act",
          replyPath: "normal",
          boundary: {
            workspace: {
              root: "/workspace",
              kind: "isolated_worktree",
              summary: "isolated workspace"
            }
          },
          capabilityTruth: {
            visibleToolNames: ["read"],
            guaranteedToolNames: ["read"],
            guaranteedCapabilities: ["workspace_read"],
            approvalRequiredCapabilities: [],
            notGuaranteedCapabilities: [],
            actionAuthorizations: []
          },
          constraints: [],
          antiDriftRules: []
        },
        summary: {
          replyPath: "normal",
          guaranteedToolNames: ["read"],
          approvalRequiredCapabilities: [],
          notGuaranteedCapabilities: [],
          actionAuthorizations: [],
          antiDriftRules: []
        },
        consistency: {
          exposedToolsMatchSelection: true,
          replyPathMatchesSelfAwareness: true,
          constraintCodesMatch: true
        }
      },
      continuity: {
        route: "ordinary",
        blocks: {
          activeTask: {
            selectionStatus: "not-selected",
            injectionStatus: "not-requested",
            sourceRefs: [],
            carryForwardKinds: []
          },
          workingSet: {
            selectionStatus: "selected",
            injectionStatus: "partial",
            sourceRefs: ["working_set:1"],
            carryForwardKinds: []
          },
          recentHistory: {
            selectionStatus: "selected",
            injectionStatus: "full",
            sourceRefs: ["turn:prev"],
            carryForwardKinds: ["decision"]
          }
        }
      },
      durableMemory: {
        route: "ordinary",
        preferredScopes: ["workspace"],
        preferredFamilies: ["fact"],
        preferredBuckets: ["project"],
        items: [],
        summary: "durable memory summary"
      },
      truncation: {
        memoryInjectionBudget: 5000,
        memoryTokensUsed: 3200,
        memoryTruncated: true,
        items: [
          {
            blockId: "memory:working_set",
            layer: "continuity_core",
            outcome: "partial",
            reason: "budget_preserve_continuity_core"
          }
        ]
      },
      driftDiagnostics: {
        issues: []
      },
      diagnostics: [
        {
          code: MEMORY_CONTEXT_TRUNCATED_CODE,
          message: "Memory selection was truncated to fit the memory injection budget.",
          category: "memory_budget",
          audience: "operator_debug",
          severity: "info",
          metadata: {
            selectedMemoryTokens: 4100,
            injectedMemoryTokens: 3200,
            droppedMemoryTokens: 900,
            selectedCount: 3,
            injectedCount: 2,
            droppedCount: 1,
            memoryInjectionBudget: 5000,
            budgetProfile: "balanced",
            effectiveMemoryInjectionBudget: 5000
          }
        }
      ],
      contextBudget: {
        budgetResolution: {
          mode: "act",
          budgetProfile: "balanced",
          budgetProfileSource: "profile_default",
          inputBudgetSource: "profile_default",
          memoryBudgetSource: "profile_default",
          providerId: "provider_local",
          modelId: "model_strong",
          protocolFamily: "chat_completions",
          maxContextTokens: 200000,
          maxContextTokensSource: "provider_capability",
          usableContext: 188000,
          outputReserveTokens: 8000,
          toolSchemaTokenEstimate: 1200,
          safetyReserveTokens: 2800,
          unestimatedComponents: [],
          effectiveInputTokenBudget: 50000,
          effectiveMemoryInjectionBudget: 5000,
          maxMemoryShareOfInput: 0.4,
          capHits: ["memory_share_of_input"],
          capReasons: ["memory_share_of_input"],
          fallbackReason: "model_context_unknown",
          overridesApplied: [
            {
              source: "deployment_override",
              field: "memoryInjectionBudget",
              value: 5000
            }
          ]
        },
        selectedMemoryCount: 3,
        injectedMemoryCount: 2,
        droppedMemoryCount: 1,
        selectedMemorySourceRefs: ["working_set:1", "turn:prev", "memory:typed_memory:0"],
        injectedMemorySourceRefs: ["working_set:1", "turn:prev"],
        droppedMemorySourceRefs: ["memory:typed_memory:0"],
        promptBlocks: [
          {
            blockId: "authoritative_turn_truth:turn_001",
            kind: "instruction",
            layer: "authoritative_truth",
            title: "authoritative current-turn truth",
            estimatedTokens: 120,
            status: "included"
          },
          {
            blockId: "memory:recent_history",
            kind: "history",
            layer: "continuity_core",
            title: "recent history",
            estimatedTokens: 1800,
            status: "partial",
            reason: "budget_preserve_continuity_core"
          },
          {
            blockId: "memory:active_task",
            kind: "task",
            layer: "continuity_core",
            title: "active task",
            estimatedTokens: 400,
            status: "included"
          },
          {
            blockId: "tool_schema:all",
            kind: "tool_schema",
            layer: "tool_schema",
            title: "tool schemas",
            estimatedTokens: 1200,
            status: "included"
          },
          {
            blockId: "memory:typed_memory:0",
            kind: "memory",
            layer: "durable_memory",
            title: "workspace durable memory",
            estimatedTokens: 900,
            status: "dropped",
            reason: "budget_reserved_for_higher_priority_context"
          }
        ],
        projectedInputTokensBeforeFitting: 6120,
        projectedInputTokensAfterFitting: 4920,
        projectedMemoryTokensBeforeFitting: 4100,
        projectedMemoryTokensAfterFitting: 3200,
        remainingHeadroomEstimate: 45080,
        toolSchemaAccounting: {
          status: "estimated",
          totalTokens: 1200,
          perTool: [
            {
              toolName: "read",
              estimatedTokens: 300
            }
          ]
        }
      }
    });

    expect(observability.contextBudget?.budgetResolution.budgetProfile).toBe("balanced");
    expect(observability.contextBudget?.budgetResolution.capReasons).toEqual(["memory_share_of_input"]);
    expect(observability.contextBudget?.budgetResolution.fallbackReason).toBe("model_context_unknown");
    expect(observability.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: MEMORY_CONTEXT_TRUNCATED_CODE,
          metadata: expect.objectContaining({
            selectedMemoryTokens: 4100,
            injectedMemoryTokens: 3200,
            droppedMemoryTokens: 900,
            selectedCount: 3,
            injectedCount: 2,
            droppedCount: 1,
            memoryInjectionBudget: 5000,
            budgetProfile: "balanced",
            effectiveMemoryInjectionBudget: 5000
          })
        })
      ])
    );
    expect(observability.contextBudget?.selectedMemorySourceRefs).toEqual([
      "working_set:1",
      "turn:prev",
      "memory:typed_memory:0"
    ]);
    expect(observability.contextBudget?.injectedMemorySourceRefs).toEqual(["working_set:1", "turn:prev"]);
    expect(observability.contextBudget?.droppedMemorySourceRefs).toEqual(["memory:typed_memory:0"]);
    expect(observability.contextBudget?.promptBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "tool_schema", status: "included" }),
        expect.objectContaining({ blockId: "memory:recent_history", kind: "history", status: "partial" }),
        expect.objectContaining({ blockId: "memory:active_task", kind: "task", status: "included" }),
        expect.objectContaining({ layer: "durable_memory", status: "dropped" })
      ])
    );
    expect(observability.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: MEMORY_CONTEXT_TRUNCATED_CODE })
      ])
    );

    const result = ContextAssemblyResultSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.context-assembly.v1",
      assemblyId: "assembly:turn_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_001",
      resolvedMode: "act",
      runtimeContextBlocks: [
        {
          blockId: "user_input:turn_001",
          kind: "user_input",
          content: "inspect the repository",
          tokenCount: 12,
          sourceRefs: ["turn_001"]
        }
      ],
      metadata: {},
      budgeting: {
        inputTokenBudget: 50000,
        outputTokenBudget: 4000,
        memoryInjectionBudget: 5000,
        toolResultInjectionBudget: 1500
      },
      toolExposure: {
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      },
      promptContract: {
        version: "ws1",
        assemblyOrder: ["system_prompt", "user_input"],
        layers: [
          {
            layerId: "prompt:user",
            kind: "user_input",
            title: "user input",
            content: "inspect the repository",
            placement: "append",
            tokenCount: 12,
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
        turnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_001",
        resolvedMode: "act",
        correlation: {
          source: "cli",
          actorId: "actor_001"
        },
        userInput: {
          text: "inspect the repository",
          attachments: []
        },
        model: {
          providerId: "provider_local",
          modelId: "model_strong"
        },
        toolSchemas: [],
        contextBlocks: [
          {
            blockId: "user_input:turn_001",
            kind: "user_input",
            content: "inspect the repository",
            tokenCount: 12,
            sourceRefs: ["turn_001"]
          }
        ],
        turnContext: {
          memory: {
            workingSetSummary: "working set",
            retrievedItems: [],
            injectionPlan: [],
            tokenEstimate: 0,
            sourceRefs: []
          },
          observability
        },
        limits: {
          inputTokenBudget: 50000,
          outputTokenBudget: 4000,
          memoryInjectionBudget: 5000,
          toolResultInjectionBudget: 1500,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      },
      budget: {
        inputTokenBudget: 50000,
        projectedInputTokens: 4920,
        historyBudget: 0,
        historyTokensUsed: 0,
        historyTruncated: false,
        memoryInjectionBudget: 5000,
        memoryTokensUsed: 3200,
        memoryTruncated: true,
        toolResultInjectionBudget: 1500,
        toolResultTokensUsed: 0
      },
      selection: {
        recentHistoryTurnIds: [],
        memorySourceRefs: [],
        evidenceIds: [],
        projectionRefs: [],
        typedMemoryScopes: [],
        exposedToolNames: []
      },
      observability,
      warnings: [MEMORY_CONTEXT_TRUNCATED_CODE]
    });

    expect(result.runtimeRequest.turnContext?.observability?.contextBudget?.selectedMemoryCount).toBe(3);
    expect(result.observability?.diagnostics[0]?.code).toBe(MEMORY_CONTEXT_TRUNCATED_CODE);
  });
});
