import { describe, expect, it, vi } from "vitest";
import type { CostLedger, RuntimeMemoryContext, RuntimeMessage, RuntimeRequest, RuntimeResult, RuntimeToolCall, RuntimeWarning } from "@endec/domain";
import { createAgentCore } from "./agent-core.ts";

function createBudgetResolution(mode: "chat" | "act" = "act") {
  if (mode === "chat") {
    return {
      resolvedMode: "chat" as const,
      model: {
        providerId: "local-default",
        modelId: "cheap-default",
        modelTier: "cheap" as const
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
    };
  }

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

function createMemoryContext(overrides?: Partial<RuntimeMemoryContext>): RuntimeMemoryContext {
  const base: RuntimeMemoryContext = {
    workingSetSummary: "",
    retrievedItems: [],
    injectionPlan: [],
    tokenEstimate: 0,
    sourceRefs: [],
    continuity: {
      retrievalPolicy: {
        strategy: "ordinary",
        activeTaskSelection: { mode: "none" },
        includeWorkingSet: true,
        includeRecentHistory: true,
        includeActiveTask: false,
        includeTypedMemory: true,
        includeEvidence: true
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      },
      workingSet: {
        summary: "",
        objective: undefined,
        recentProgress: [],
        recentDecisions: [],
        blockers: [],
        openLoops: [],
        activeMemoryRefs: [],
        activeTaskRefs: [],
        recentEventRefs: [],
        sourceRefs: []
      },
      typedMemory: [],
      evidence: [],
      projectionDerivedRefs: []
    }
  };

  return {
    ...base,
    ...overrides,
    continuity: overrides?.continuity
      ? {
          ...base.continuity!,
          ...overrides.continuity,
          retrievalPolicy: overrides.continuity.retrievalPolicy
            ? {
                ...base.continuity!.retrievalPolicy,
                ...overrides.continuity.retrievalPolicy,
                activeTaskSelection: overrides.continuity.retrievalPolicy.activeTaskSelection
                  ? {
                      ...base.continuity!.retrievalPolicy.activeTaskSelection,
                      ...overrides.continuity.retrievalPolicy.activeTaskSelection
                    }
                  : base.continuity!.retrievalPolicy.activeTaskSelection
              }
            : base.continuity!.retrievalPolicy,
          recentHistory: overrides.continuity.recentHistory
            ? {
                ...base.continuity!.recentHistory,
                ...overrides.continuity.recentHistory
              }
            : base.continuity!.recentHistory,
          workingSet: overrides.continuity.workingSet
            ? {
                ...base.continuity!.workingSet,
                ...overrides.continuity.workingSet
              }
            : base.continuity!.workingSet
        }
      : base.continuity!
  };
}

function createRuntimeResult(
  overrides?: Partial<Omit<RuntimeResult, "messages" | "requestedToolCalls" | "warnings" | "permissionDecisions" | "toolExecutionResults">> & {
    messages?: RuntimeMessage[];
    requestedToolCalls?: RuntimeToolCall[];
    warnings?: RuntimeWarning[];
    permissionDecisions?: RuntimeResult["permissionDecisions"];
    toolExecutionResults?: RuntimeResult["toolExecutionResults"];
  }
): RuntimeResult {
  return {
    turnId: "turn_runtime",
    stopReason: "completed",
    messages: [],
    requestedToolCalls: [],
    loopCount: 1,
    toolCallCount: 0,
    toolResultTokensUsed: 0,
    usage: {
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      estimatedCost: 0.002
    },
    warnings: [],
    permissionDecisions: [],
    toolExecutionResults: [],
    artifacts: [],
    ...overrides
  };
}

function createEmptyToolBatch(input: {
  batchId: string;
  turnId: string;
  requestedToolCalls: RuntimeToolCall[];
}) {
  return {
    schemaVersion: 1 as const,
    contractVersion: "ws0.tool-batch.v1" as const,
    batchId: input.batchId,
    turnId: input.turnId,
    requestedToolCalls: input.requestedToolCalls,
    permissionDecisions: [],
    executionResults: []
  };
}

describe("AgentCore", () => {
  it("records ledger cost when the tool pipeline blocks on permission", async () => {
    const markInflight = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => "session_state_ref_blocked");
    const recordCost = vi.fn(async (_input: CostLedger) => "ledger_permission_blocked");

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        markInflight,
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return {
            ...createEmptyToolBatch(input),
            permissionDecisions: [
              {
                decisionId: "decision_001",
                behavior: "ask",
                scope: "once",
                reasonCode: "needs_approval",
                reasonText: "bash write requires approval",
                issuedAt: new Date().toISOString()
              }
            ]
          };
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        recordCost
      },
      runtimePort: {
        async run() {
          return createRuntimeResult({
            stopReason: "tool_calls_pending",
            requestedToolCalls: [
              {
                toolCallId: "tool_call_001",
                toolName: "bash",
                arguments: { command: "pwd" }
              }
            ],
            toolCallCount: 1
          });
        }
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "run the command",
      attachments: []
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedBy).toBe("permission");
    expect(result.costRecord).toBe("ledger_permission_blocked");
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      mode: "act",
      modelId: "strong-default",
      providerId: "local-default",
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      estimatedCost: 0.002,
      memoryInjectedTokens: 0,
      toolResultInjectedTokens: 0,
      loopCount: 1,
      toolCallCount: 1,
      stopReason: "permission_required",
      startedAt: expect.any(String),
      endedAt: expect.any(String)
    }));
    const blockedLedgerInput = recordCost.mock.calls[0]?.[0];
    expect(blockedLedgerInput?.cacheReadTokens).toBeUndefined();
    expect(blockedLedgerInput?.cacheWriteTokens).toBeUndefined();
    expect(markInflight).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      pendingApprovalRef: "decision_001",
      frameRef: "frame:turn_blocked",
      contractVersion: "ws0.pending-execution.v1"
    }));
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_blocked",
      sessionId: "session_001",
      status: "blocked"
    });
  });

  it("returns blocked from integrated runtime permission decisions without replaying the legacy tool batch", async () => {
    const markInflight = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => "session_state_ref_runtime_blocked");
    const handleBatch = vi.fn(async (input: { batchId: string; turnId: string; requestedToolCalls: RuntimeToolCall[] }) => createEmptyToolBatch(input));

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        markInflight,
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        handleBatch
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        async recordCost() {
          return "ledger_unused";
        }
      },
      runtimePort: {
        async run() {
          return {
            ...createRuntimeResult({
              stopReason: "permission_required",
              requestedToolCalls: [
                {
                  toolCallId: "tool_call_read_001",
                  toolName: "read",
                  arguments: { path: "README.md" }
                }
              ],
              toolCallCount: 1
            }),
            permissionDecisions: [
              {
                decisionId: "decision_runtime_001",
                behavior: "ask",
                scope: "once",
                reasonCode: "permission_required",
                reasonText: "operator approval required",
                issuedAt: new Date().toISOString(),
                requestedBy: "turn_runtime_blocked"
              }
            ],
            toolExecutionResults: [
              {
                resultId: "batch:turn_runtime_blocked:deny:tool_call_hidden_001",
                toolCallId: "tool_call_hidden_001",
                toolName: "write",
                state: "deny",
                permissionDecision: {
                  decisionId: "tool_call_hidden_001",
                  behavior: "deny",
                  scope: "once",
                  reasonCode: "tool_hidden",
                  reasonText: "write is not exposed by the current tool exposure policy",
                  issuedAt: new Date().toISOString(),
                  requestedBy: "turn_runtime_blocked"
                }
              }
            ]
          } as RuntimeResult;
        }
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_runtime_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "continue the existing loop",
      attachments: []
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedBy).toBe("permission");
    expect(result.toolEvents).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_hidden_001",
        state: "deny"
      })
    ]);
    expect(handleBatch).not.toHaveBeenCalled();
    expect(markInflight).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_runtime_blocked",
      pendingApprovalRef: "decision_runtime_001",
      loopCount: 1,
      toolCallCount: 1,
      pendingExecution: expect.objectContaining({
        frame: expect.objectContaining({
          pendingToolCalls: [expect.objectContaining({ toolCallId: "tool_call_read_001" })],
          pendingPermissionDecisions: [expect.objectContaining({ decisionId: "decision_runtime_001" })]
        })
      })
    }));
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_runtime_blocked",
      sessionId: "session_001",
      status: "blocked"
    });
  });

  it("stores only the unexecuted suffix from the first ask boundary when a mixed tool batch blocks", async () => {
    const markInflight = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => "session_state_ref_runtime_blocked_mixed");

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        markInflight,
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        async recordCost() {
          return "ledger_unused";
        }
      },
      runtimePort: {
        async run() {
          return {
            ...createRuntimeResult({
              stopReason: "permission_required",
              requestedToolCalls: [
                {
                  toolCallId: "tool_call_edit_001",
                  toolName: "edit",
                  arguments: {
                    path: "notes.txt",
                    edits: [
                      {
                        oldText: "seed",
                        newText: "seed +edit"
                      }
                    ]
                  }
                },
                {
                  toolCallId: "tool_call_bash_001",
                  toolName: "bash",
                  arguments: { command: "cat notes.txt" }
                },
                {
                  toolCallId: "tool_call_edit_after_001",
                  toolName: "edit",
                  arguments: {
                    path: "notes.txt",
                    edits: [
                      {
                        oldText: "\n",
                        newText: " +after\n"
                      }
                    ]
                  }
                }
              ],
              toolCallCount: 3
            }),
            permissionDecisions: [
              {
                decisionId: "tool_call_edit_001",
                behavior: "allow",
                scope: "once",
                reasonCode: "tool_auto_allowed",
                reasonText: "edit is auto-allowed by the current tool exposure policy",
                issuedAt: new Date().toISOString(),
                requestedBy: "turn_runtime_mixed_blocked"
              },
              {
                decisionId: "tool_call_bash_001",
                behavior: "ask",
                scope: "once",
                reasonCode: "tool_requires_approval",
                reasonText: "bash requires operator approval before it can run",
                issuedAt: new Date().toISOString(),
                requestedBy: "turn_runtime_mixed_blocked"
              }
            ],
            toolExecutionResults: [
              {
                resultId: "batch:turn_runtime_mixed_blocked:executed:tool_call_edit_001",
                toolCallId: "tool_call_edit_001",
                toolName: "edit",
                state: "executed",
                permissionDecision: {
                  decisionId: "tool_call_edit_001",
                  behavior: "allow",
                  scope: "once",
                  reasonCode: "tool_auto_allowed",
                  reasonText: "edit is auto-allowed by the current tool exposure policy",
                  issuedAt: new Date().toISOString(),
                  requestedBy: "turn_runtime_mixed_blocked"
                },
                normalizedPayload: {
                  contentType: "json",
                  value: {
                    path: "notes.txt"
                  }
                }
              },
              {
                resultId: "batch:turn_runtime_mixed_blocked:ask:tool_call_bash_001",
                toolCallId: "tool_call_bash_001",
                toolName: "bash",
                state: "ask",
                permissionDecision: {
                  decisionId: "tool_call_bash_001",
                  behavior: "ask",
                  scope: "once",
                  reasonCode: "tool_requires_approval",
                  reasonText: "bash requires operator approval before it can run",
                  issuedAt: new Date().toISOString(),
                  requestedBy: "turn_runtime_mixed_blocked"
                }
              }
            ]
          } as RuntimeResult;
        }
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_runtime_mixed_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "run edit and then bash",
      attachments: []
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedBy).toBe("permission");
    expect(result.toolEvents).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_edit_001",
        toolName: "edit",
        state: "executed"
      }),
      expect.objectContaining({
        toolCallId: "tool_call_bash_001",
        toolName: "bash",
        state: "ask"
      })
    ]);

    const inflight = (markInflight.mock.calls as unknown as Array<[{
      pendingApprovalRef: string;
      pendingExecution: {
        frame: {
          pendingToolCalls: RuntimeToolCall[];
          pendingPermissionDecisions: RuntimeResult["permissionDecisions"];
        };
        runtimeSelfAwareness?: {
          constraints: Array<{ metadata?: Record<string, unknown> }>;
        };
      };
    }]>)[0]?.[0];

    expect(inflight?.pendingApprovalRef).toBe("tool_call_bash_001");
    expect(inflight?.pendingExecution.frame.pendingToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_bash_001",
        toolName: "bash"
      }),
      expect.objectContaining({
        toolCallId: "tool_call_edit_after_001",
        toolName: "edit"
      })
    ]);
    expect(inflight?.pendingExecution.frame.pendingPermissionDecisions).toEqual([
      expect.objectContaining({
        decisionId: "tool_call_bash_001",
        behavior: "ask",
        reasonCode: "tool_requires_approval"
      })
    ]);
  });

  it("returns interrupted when loop guard hard-stops after runtime output", async () => {
    const finalize = vi.fn(async () => "session_state_ref_interrupted");
    const handleBatch = vi.fn(async (input: { batchId: string; turnId: string; requestedToolCalls: RuntimeToolCall[] }) => createEmptyToolBatch(input));
    const recordCost = vi.fn(async () => "ledger_loop_limit");

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        handleBatch
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        recordCost
      },
      runtimePort: {
        async run() {
          return {
            ...createRuntimeResult({
              messages: [{ role: "assistant", content: "need to stop" }],
              requestedToolCalls: [
                {
                  toolCallId: "tool_call_001",
                  toolName: "bash",
                  arguments: { command: "pwd" }
                }
              ],
              loopCount: 7,
              toolCallCount: 1,
              stopReason: "loop_limit",
              warnings: [
                {
                  code: "loop_limit",
                  message: "Reached maxLoopCount (6) before continuing the runtime loop."
                }
              ]
            }),
            toolResultTokensUsed: 16
          } as RuntimeResult;
        }
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_loop_limit",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "keep going",
      attachments: []
    });

    expect(result.status).toBe("interrupted");
    expect(result.warnings).toEqual(["Reached maxLoopCount (6) before continuing the runtime loop."]);
    expect(result.toolEvents).toEqual([]);
    expect(handleBatch).not.toHaveBeenCalled();
    expect(recordCost).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn_loop_limit",
        stopReason: "loop_limit",
        loopCount: 7,
        toolCallCount: 1,
        toolResultInjectedTokens: 16
      })
    );
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_loop_limit",
      sessionId: "session_001",
      status: "interrupted"
    });
  });

  it("records ledger cost when budget blocks on user decision before runtime", async () => {
    const markInflight = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => "session_state_ref_budget_blocked");
    const run = vi.fn(async () => {
      throw new Error("runtime should not run");
    });
    const recordCost = vi.fn(async () => "ledger_user_decision_blocked");

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        markInflight,
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        async evaluateBudget() {
          return {
            kind: "ask_continue" as const,
            status: "blocked" as const,
            stopReason: "soft_limit"
          };
        },
        recordCost
      },
      runtimePort: {
        run
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_budget_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "expensive request",
      attachments: []
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedBy).toBe("user_decision");
    expect(result.costRecord).toBe("ledger_user_decision_blocked");
    expect(result.warnings).toEqual(["soft_limit"]);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    });
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_budget_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      mode: "act",
      modelId: "strong-default",
      providerId: "local-default",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      memoryInjectedTokens: 0,
      toolResultInjectedTokens: 0,
      loopCount: 0,
      toolCallCount: 0,
      stopReason: "soft_limit",
      startedAt: expect.any(String),
      endedAt: expect.any(String)
    }));
    expect(markInflight).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_budget_blocked",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      pendingApprovalRef: "budget:turn_budget_blocked",
      frameRef: "frame:turn_budget_blocked",
      contractVersion: "ws0.pending-execution.v1"
    }));
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_budget_blocked",
      sessionId: "session_001",
      status: "blocked"
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns interrupted when budget hard-stops before runtime", async () => {
    const markInflight = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => "session_state_ref_budget_interrupted");
    const run = vi.fn(async () => {
      throw new Error("runtime should not run");
    });

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        markInflight,
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        async evaluateBudget() {
          return {
            kind: "hard_stop" as const,
            status: "interrupted" as const,
            stopReason: "hard_limit"
          };
        },
        async recordCost() {
          return "ledger_unused";
        }
      },
      runtimePort: {
        run
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_budget_interrupted",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "too expensive request",
      attachments: []
    });

    expect(result.status).toBe("interrupted");
    expect(result.warnings).toEqual(["hard_limit"]);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    });
    expect(markInflight).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_budget_interrupted",
      sessionId: "session_001",
      status: "interrupted"
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("passes retrieval hints into memory and exposes structured continuity on the runtime request", async () => {
    const retrieve = vi.fn(async () =>
      createMemoryContext({
        workingSetSummary: "keep task continuity",
        retrievedItems: [{ kind: "working_set", summary: "keep task continuity" }],
        injectionPlan: [{ kind: "working_set", tokenBudget: 96 }],
        tokenEstimate: 96,
        sourceRefs: ["working_set:session_001:3"],
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
            summary: "last turn blocked on permission",
            refs: ["turn_prev", "checkpoint:turn_prev"],
            turnRefs: ["turn_prev"]
          },
          workingSet: {
            ref: "working_set:session_001:3",
            version: 3,
            summary: "keep task continuity",
            objective: "preserve blocked-task continuity",
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
            title: "Ship memory integration",
            status: "blocked",
            checkpointRef: "checkpoint:task_001",
            updatedAt: "2026-04-11T10:00:00.000Z",
            selectedBy: "request_task"
          },
          typedMemory: [],
          evidence: [],
          projectionDerivedRefs: []
        }
      })
    );
    const run = vi.fn(async () =>
      createRuntimeResult({
        turnId: "turn_002",
        messages: [{ role: "assistant", content: "resumed" }]
      })
    );

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        async finalize() {
          return "session_state_ref_002";
        }
      },
      memoryPort: {
        retrieve,
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        async recordCost() {
          return "ledger_002";
        }
      },
      runtimePort: {
        run
      }
    });

    await core.executeTurn({
      turnId: "turn_002",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "resume the blocked task",
      attachments: [],
      taskId: "task_001",
      resumeFrom: "checkpoint:turn_prev"
    });

    expect(retrieve).toHaveBeenCalledWith({
      queryId: "query:turn_002",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      purpose: "turn_context",
      memoryTypes: ["working_set", "recent_history", "active_task", "typed_memory", "evidence"],
      maxItems: 8,
      maxInjectTokens: 1000,
      queryText: "resume the blocked task",
      topicHints: ["resume", "blocked", "task"],
      taskId: "task_001",
      resumeFrom: "checkpoint:turn_prev"
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        turnContext: {
          memory: expect.objectContaining({
            continuity: expect.objectContaining({
              retrievalPolicy: expect.objectContaining({
                strategy: "continuation"
              }),
              activeTask: expect.objectContaining({
                taskId: "task_001"
              })
            })
          })
        }
      })
    );
  });

  it("reuses the real actor for continuation requests while keeping execution-control semantics distinct", async () => {
    const assemble = vi.fn(async ({ request }) => ({
      budget: {
        inputTokenBudget: 10000,
        projectedInputTokens: 64,
        historyBudget: 0,
        historyTokensUsed: 0,
        historyTruncated: false,
        memoryInjectionBudget: 1000,
        memoryTokensUsed: 0,
        memoryTruncated: false,
        toolResultInjectionBudget: 1400,
        toolResultTokensUsed: 0
      },
      warnings: [],
      toolExposure: {
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      },
      runtimeRequest: {
        turnId: request.turnId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        resolvedMode: "act",
        correlation: {
          source: request.source,
          actorId: request.actorId
        },
        userInput: {
          text: request.input,
          attachments: request.attachments
        },
        model: createBudgetResolution().model,
        toolSchemas: [],
        contextBlocks: [],
        limits: createBudgetResolution().limits
      }
    } as never));
    const run = vi.fn(async (_input: RuntimeRequest) =>
      createRuntimeResult({
        turnId: "turn_001",
        messages: [{ role: "assistant", content: "continuation resumed" }]
      })
    );

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        async finalize() {
          return "session_state_ref_001";
        }
      },
      contextAssembler: {
        assemble
      },
      memoryPort: {
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
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
        run
      }
    });

    await core.continueExecution({
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act"
      },
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
            metadata: {
              actorId: "actor_user"
            }
          }
        }
      } as never,
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "resume",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        turnId: "turn_001",
        frameRef: "frame:turn_001",
        input: "continue from the pending checkpoint"
      }
    });

    expect(assemble).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actorId: "actor_user",
        channelContext: expect.objectContaining({
          executionControl: expect.objectContaining({
            action: "resume"
          }),
          executionControlActorId: "system:execution-control:resume"
        })
      })
    }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      correlation: expect.objectContaining({
        actorId: "actor_user"
      })
    }));
  });

  it("builds the runtime request from the WS2 tool-port contract and preserves runtime warnings on completion", async () => {
    const recordCost = vi.fn(async () => "ledger_001");
    const finalize = vi.fn(async () => "session_state_ref_001");
    const run = vi.fn(async (runtimeRequest: {
      model: {
        providerId: string;
        modelId: string;
        modelTier?: string;
      };
    }) => {
      void runtimeRequest;
      return createRuntimeResult({
        turnId: "turn_001",
        messages: [{ role: "assistant", content: "hi" }],
        requestedToolCalls: [
          {
            toolCallId: "tool_call_read_001",
            toolName: "read",
            arguments: { path: "notes.txt" }
          }
        ],
        toolCallCount: 1,
        warnings: [
          {
            code: "context_compacted",
            message: "context compacted"
          }
        ]
      });
    });
    const describeExposure = vi.fn(async () => ({
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
    }));
    const handleBatch = vi.fn(async (input: {
      batchId: string;
      turnId: string;
      sessionId: string;
      workspaceId: string;
      requestedToolCalls: Array<{ toolCallId: string; toolName: string; arguments?: unknown; rationale?: string }>;
      contextAssembly: {
        toolExposure: {
          exposedTools: Array<{ name: string }>;
        };
        runtimeRequest?: {
          toolSchemas: Array<{ name: string }>;
        };
      };
    }) => ({
      schemaVersion: 1 as const,
      contractVersion: "ws0.tool-batch.v1" as const,
      batchId: input.batchId,
      turnId: input.turnId,
      requestedToolCalls: input.requestedToolCalls,
      permissionDecisions: [],
      executionResults: []
    }));

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: "freeze runtime seam",
            retrievedItems: [{ kind: "working_set", summary: "freeze runtime seam" }],
            injectionPlan: [{ kind: "working_set", tokenBudget: 64 }],
            tokenEstimate: 64,
            sourceRefs: ["working_set:session_001:1"]
          });
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        describeExposure,
        handleBatch
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution("chat");
        },
        recordCost
      },
      runtimePort: {
        run
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    expect(result.status).toBe("completed");
    expect(result.resolvedMode).toBe("chat");
    expect(result.messages).toHaveLength(1);
    expect(result.toolEvents).toEqual([]);
    expect(result.warnings).toEqual(["context compacted"]);
    expect(describeExposure).toHaveBeenCalledWith({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      resolvedMode: "chat"
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
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
          providerId: "local-default",
          modelId: "cheap-default"
        },
        toolSchemas: [
          expect.objectContaining({
            name: "read"
          })
        ],
        limits: {
          inputTokenBudget: 6000,
          outputTokenBudget: 900,
          memoryInjectionBudget: 600,
          toolResultInjectionBudget: 800,
          maxLoopCount: 2,
          maxToolCallsPerBatch: 2,

          maxToolCallsPerTurn: 2
        },
        contextBlocks: expect.arrayContaining([
          expect.objectContaining({
            kind: "user_input",
            content: "hello",
            sourceRefs: ["turn_001"]
          }),
          expect.objectContaining({
            kind: "memory",
            content: "freeze runtime seam",
            sourceRefs: ["working_set:session_001:1"]
          })
        ])
      })
    );
    const runtimeRequest = run.mock.calls[0]?.[0];
    expect(runtimeRequest?.model).not.toHaveProperty("modelTier");
    expect(handleBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: "batch:turn_001",
        turnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        requestedToolCalls: [
          expect.objectContaining({
            toolCallId: "tool_call_read_001",
            toolName: "read"
          })
        ],
        contextAssembly: expect.objectContaining({
          toolExposure: expect.objectContaining({
            exposedTools: [expect.objectContaining({ name: "read" })]
          }),
          runtimeRequest: expect.objectContaining({
            toolSchemas: [expect.objectContaining({ name: "read" })]
          })
        })
      })
    );
    expect(recordCost).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "cheap-default",
        providerId: "local-default",
        loopCount: 1,
        toolCallCount: 1
      })
    );
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_001",
      sessionId: "session_001",
      status: "completed"
    });
  });

  it("defaults provider_stream_incomplete runtime output to passthrough warnings", async () => {
    const finalize = vi.fn(async () => "session_state_ref_failed");
    const recordCost = vi.fn(async () => "ledger_provider_incomplete");
    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        recordCost
      },
      runtimePort: {
        async run() {
          return createRuntimeResult({
            stopReason: "provider_stream_incomplete",
            messages: [],
            warnings: [{
              code: "provider_stream_incomplete",
              message: "Provider stream ended without a completed event for invocation invoke_001.",
              metadata: { invocationId: "invoke_001" }
            }]
          });
        }
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_provider_incomplete",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    expect(result.status).toBe("failed");
    expect(result.messages).toEqual([]);
    expect(result.warnings).toEqual(["Provider stream ended without a completed event for invocation invoke_001."]);
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      stopReason: "provider_stream_incomplete"
    }));
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_provider_incomplete",
      sessionId: "session_001",
      status: "failed"
    });
  });

  it("keeps provider_stream_incomplete runtime output friendly in sanitized mode", async () => {
    const finalize = vi.fn(async () => "session_state_ref_failed_sanitized");
    const recordCost = vi.fn(async () => "ledger_provider_incomplete_sanitized");
    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution();
        },
        recordCost
      },
      runtimePort: {
        async run() {
          return createRuntimeResult({
            stopReason: "provider_stream_incomplete",
            messages: [],
            warnings: [{
              code: "provider_stream_incomplete",
              message: "Provider stream ended without a completed event for invocation invoke_001.",
              metadata: { invocationId: "invoke_001" }
            }]
          });
        }
      },
      errorExposureMode: "sanitized"
    });

    const result = await core.executeTurn({
      turnId: "turn_provider_incomplete_sanitized",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    expect(result.status).toBe("failed");
    expect(result.messages).toEqual([]);
    expect(result.warnings).toEqual(["模型响应流提前结束，本轮已安全停止，请重试。"]);
    expect(result.warnings.join("\n")).not.toContain("Provider stream ended without a completed event");
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      stopReason: "provider_stream_incomplete"
    }));
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_provider_incomplete_sanitized",
      sessionId: "session_001",
      status: "failed"
    });
  });

  it("persists a ready recoverable pending execution for tool_turn_limit instead of only returning interrupted", async () => {
    const markInflight = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => "session_state_ref_tool_turn_limit");
    const recordCost = vi.fn(async () => "ledger_tool_turn_limit");

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        markInflight,
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution("chat");
        },
        recordCost
      },
      runtimePort: {
        async run() {
          return createRuntimeResult({
            stopReason: "tool_turn_limit",
            requestedToolCalls: [
              {
                toolCallId: "tool_call_003",
                toolName: "read",
                arguments: { path: "README.md" }
              }
            ],
            loopCount: 2,
            toolCallCount: 3,
            toolExecutionResults: [
              {
                resultId: "batch:turn_tool_turn_limit_resume:executed:tool_call_001",
                toolCallId: "tool_call_001",
                toolName: "glob",
                state: "executed",
                normalizedPayload: {
                  contentType: "text",
                  value: "glob ok"
                }
              }
            ],
            warnings: [{
              code: "tool_turn_limit",
              message: "Reached maxToolCallsPerTurn (2) before executing the next tool batch.",
              metadata: {
                requestedToolCallsInBatch: 1,
                maxToolCallsPerTurn: 2,
                toolCallCountBeforePausedBatch: 2,
                executedToolCalls: 0,
                recoverable: true,
                pausedToolCalls: [
                  {
                    toolCallId: "tool_call_003",
                    toolName: "read",
                    arguments: { path: "README.md" }
                  }
                ]
              }
            }]
          });
        }
      }
    });

    const result = await core.executeTurn({
      turnId: "turn_tool_turn_limit_resume",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "inspect the repo",
      attachments: []
    });

    expect(result).toMatchObject({
      status: "interrupted",
      continuation: {
        continuationKind: "resume",
        allowedActions: ["resume", "cancel"]
      },
      warnings: [
        "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume."
      ]
    });
    expect(markInflight).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_tool_turn_limit_resume",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 2,
      toolCallCount: 3,
      frameRef: "frame:turn_tool_turn_limit_resume",
      pendingExecution: expect.objectContaining({
        status: "ready",
        frame: expect.objectContaining({
          phase: "awaiting_operator",
          step: "tool_turn_limit",
          pendingToolCalls: [
            {
              toolCallId: "tool_call_003",
              toolName: "read",
              arguments: { path: "README.md" }
            }
          ],
          continuation: expect.objectContaining({
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: expect.objectContaining({
              stopReason: "tool_turn_limit",
              toolCallCountBeforePausedBatch: 2,
              requestedToolCallsInBatch: 1,
              executedToolCalls: 0
            })
          })
        })
      })
    }));
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_tool_turn_limit_resume",
      sessionId: "session_001",
      status: "interrupted",
      preserveInflight: true
    });
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      stopReason: "tool_turn_limit"
    }));
  });

  it("maps tool_batch_limit_retry_exhausted runtime output to interrupted with friendly warning and no legacy execution", async () => {
    const finalize = vi.fn(async () => "session_state_ref_interrupted");
    const handleBatch = vi.fn(async (input: { batchId: string; turnId: string; requestedToolCalls: RuntimeToolCall[] }) => createEmptyToolBatch(input));
    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        finalize
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: { handleBatch },
      budgetPort: {
        async resolve() {
          return createBudgetResolution("chat");
        },
        async recordCost() {
          return "ledger_tool_batch_retry_exhausted";
        }
      },
      runtimePort: {
        async run() {
          return createRuntimeResult({
            stopReason: "tool_batch_limit_retry_exhausted",
            requestedToolCalls: [
              { toolCallId: "tool_call_001", toolName: "read", arguments: { path: "a" } },
              { toolCallId: "tool_call_002", toolName: "read", arguments: { path: "b" } },
              { toolCallId: "tool_call_003", toolName: "read", arguments: { path: "c" } }
            ],
            toolCallCount: 6,
            warnings: [{
              code: "tool_batch_limit_retry_exhausted",
              message: "Provider requested too many tool calls after one repair retry.",
              metadata: { requestedToolCallsInBatch: 3, maxToolCallsPerBatch: 2, executedToolCalls: 0 }
            }]
          });
        }
      },
      errorExposureMode: "sanitized"
    });

    const result = await core.executeTurn({
      turnId: "turn_batch_retry_exhausted",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "inspect several files",
      attachments: []
    });

    expect(result.status).toBe("interrupted");
    expect(result.warnings).toEqual(["模型一次请求了过多工具，本轮已安全停止，请重试或拆分任务。"]);
    expect(result.toolEvents).toEqual([]);
    expect(handleBatch).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith({
      turnId: "turn_batch_retry_exhausted",
      sessionId: "session_001",
      status: "interrupted"
    });
  });

  it("uses friendly retry-exhausted warning before invalid assistant text candidate", async () => {
    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        async finalize() {
          return "session_state_ref_interrupted";
        }
      },
      memoryPort: {
        async retrieve() {
          return createMemoryContext();
        },
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return createEmptyToolBatch(input);
        }
      },
      budgetPort: {
        async resolve() {
          return createBudgetResolution("chat");
        },
        async recordCost() {
          return "ledger_retry_exhausted_warning_priority";
        }
      },
      runtimePort: {
        async run() {
          return createRuntimeResult({
            stopReason: "tool_batch_limit_retry_exhausted",
            messages: [{ role: "assistant", content: "oversized attempt 2" }],
            warnings: [{
              code: "tool_batch_limit_retry_exhausted",
              message: "Provider requested too many tool calls after one repair retry.",
              metadata: { requestedToolCallsInBatch: 3, maxToolCallsPerBatch: 2, repairAttemptsUsed: 1, executedToolCalls: 0 }
            }]
          });
        }
      },
      errorExposureMode: "sanitized"
    });

    const result = await core.executeTurn({
      turnId: "turn_retry_exhausted_warning_priority",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "inspect several files",
      attachments: []
    });

    expect(result.status).toBe("interrupted");
    expect(result.warnings).toEqual(["模型一次请求了过多工具，本轮已安全停止，请重试或拆分任务。"]);
    expect(JSON.stringify(result)).not.toContain("oversized attempt 2");
  });

});
