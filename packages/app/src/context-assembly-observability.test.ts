import { describe, expect, it, vi } from "vitest";
import type { RuntimeMemoryContext, TurnRequest } from "@endec/domain";
import { MEMORY_CONTEXT_TRUNCATED_CODE } from "@endec/domain";
import { createContextAssembler } from "./context-assembler.ts";
import { createAppToolPort } from "./tool-port.ts";

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli",
    actorId: "actor_cli",
    input: "Explain what you can do in this turn.",
    attachments: [],
    ...overrides
  };
}

function createMemoryContext(overrides: Partial<RuntimeMemoryContext> = {}): RuntimeMemoryContext {
  return {
    workingSetSummary: "Keep the current task continuity ahead of durable memory.",
    retrievedItems: [],
    injectionPlan: [],
    tokenEstimate: 24,
    sourceRefs: ["working_set:session_001:3"],
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

describe("context assembly observability", () => {
  it("records the configured current time context and excludes control-path/system churn from the anchor", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T13:14:00.000Z"));

    try {
      const assembler = createContextAssembler({
        historyStore: {
          async loadRecentHistory() {
            return [
              {
                eventId: "event_background_assistant",
                turnId: "run_bg_1234567890abcdef",
                eventKind: "assistant_message",
                summary: "background work finished",
                text: "background work finished",
                createdAt: "2026-04-29T13:13:00.000Z",
                sourceRefs: ["run_bg_1234567890abcdef"]
              },
              {
                eventId: "event_control_notice",
                turnId: "authority_notice_001",
                eventKind: "system",
                summary: "Trusted conversation granted for group:chat_100.",
                text: "Trusted conversation granted for group:chat_100.",
                createdAt: "2026-04-29T13:12:00.000Z",
                sourceRefs: ["group:chat_100"]
              },
              {
                eventId: "event_owner_reply",
                turnId: "turn_owner_init_preflight",
                eventKind: "assistant_message",
                summary: "Saved your timezone = Asia/Shanghai.",
                text: "Saved your timezone = Asia/Shanghai.",
                createdAt: "2026-04-29T12:56:00.000Z",
                sourceRefs: ["turn_owner_init_preflight", "msg_owner_init_preflight"]
              }
            ];
          }
        },
        memoryStore: {
          async retrieve() {
            return createMemoryContext({
              continuity: undefined,
              contextBlocks: []
            });
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
        ownerStateStore: {
          async inspectOwnerBinding() {
            return {
              resolvedOwnerPreferences: {
                timezone: "Asia/Shanghai",
                timezoneSource: "owner_preference"
              }
            };
          },
          resolveServerTimezone() {
            return "Asia/Shanghai";
          }
        },
        resolveToolExposure: async () => ({
          exposureSource: "policy",
          exposedTools: [],
          hiddenToolNames: []
        })
      });

      const result = await assembler.assemble({
        request: createTurnRequest({
          turnId: "turn_time_context_observability",
          source: "telegram",
          actorId: "actor_owner",
          taskId: undefined,
          resumeFrom: undefined,
          input: "hello again",
          conversationRef: {
            accountId: "acct_bot",
            conversationId: "dm:chat_42",
            peerId: "chat_42",
            peerKind: "dm"
          } as never
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

      expect(result.runtimeRequest.turnContext?.timeContext).toMatchObject({
        timezone: "Asia/Shanghai",
        timezoneSource: "owner_preference",
        previousInteractionAtUtc: "2026-04-29T12:56:00.000Z",
        elapsedSincePreviousInteractionMinutes: 18,
        gapKind: "same_day",
        summary: "Local time is Wed 2026-04-29 21:14 (Asia/Shanghai), evening. The last observed interaction was earlier today, 18 minutes ago."
      });
      const timeContextBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "current time context");
      expect(timeContextBlock).toMatchObject({
        title: "current time context",
        kind: "instruction"
      });
      expect(timeContextBlock?.content).toContain("timezone: Asia/Shanghai (owner_preference)");
      expect(timeContextBlock?.content).toContain("gap kind: same_day");
    } finally {
      vi.useRealTimers();
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it("reports authoritative truth observability and mixed-risk drift diagnostics from the current-turn packet", async () => {
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

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_truth_observability",
        requestedMode: "chat"
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

    const observability = (result as { observability?: any }).observability;

    expect(observability.authoritativeTruth.packet).toEqual(result.runtimeRequest.turnContext?.authoritativeTruth);
    expect(observability.authoritativeTruth.summary).toMatchObject({
      replyPath: "normal",
      guaranteedToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
      approvalRequiredCapabilities: ["remote_git_push", "pull_request_create"],
      notGuaranteedCapabilities: expect.arrayContaining(["deploy"])
    });
    expect(observability.authoritativeTruth.consistency).toMatchObject({
      exposedToolsMatchSelection: true,
      replyPathMatchesSelfAwareness: true,
      constraintCodesMatch: true
    });
    expect(observability.driftDiagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "mixed_risk_capability_authorization",
        evidence: expect.objectContaining({
          visibleToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
          approvalRequiredCapabilities: expect.arrayContaining(["remote_git_push"]),
          notGuaranteedCapabilities: expect.arrayContaining(["deploy"])
        })
      })
    ]));
  });

  it("reports continuity selection, durable memory drops, and truncation reasons under a tight budget", async () => {
    const hugeWorkingSetSummary = Array.from({ length: 80 }, () => "GENERIC DURABLE MEMORY SHOULD NOT DISPLACE CONTINUITY CORE").join(" ");
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return {
            ...createMemoryContext({
              workingSetSummary: hugeWorkingSetSummary,
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
                  summary: "carry forward: keep the current task boundary and continue from the last approved checkpoint",
                  refs: ["turn_prev"],
                  turnRefs: ["turn_prev"],
                  carryForwardKinds: ["assistant_message", "system" as never]
                } as never,
                workingSet: {
                  ref: "working_set:session_001:12",
                  version: 12,
                  summary: hugeWorkingSetSummary,
                  objective: "Ship continuity-first context assembly",
                  recentProgress: ["froze current-turn truth above memory recall"],
                  recentDecisions: ["continuity core beats generic durable memory"],
                  blockers: ["budget pressure must not drop active task continuity"],
                  openLoops: ["run targeted Slice 4 verification"],
                  activeMemoryRefs: ["typed_memory:session_001:decision:priority"],
                  activeTaskRefs: ["task_001", "checkpoint:task_001"],
                  recentEventRefs: ["turn_prev"],
                  sourceRefs: ["turn_prev", "checkpoint:task_001"]
                },
                activeTask: {
                  taskId: "task_001",
                  title: "Continuity-first assembly",
                  status: "blocked",
                  checkpointRef: "checkpoint:task_001",
                  currentStep: "preserve the active task minimum surface",
                  nextAction: "trim generic durable memory after continuity core",
                  blockingReason: "approval boundary still pending",
                  updatedAt: "2026-04-11T10:00:00.000Z",
                  selectedBy: "request_task"
                },
                typedMemory: [
                  {
                    kind: "typed_upsert",
                    status: "materialized",
                    scope: "session",
                    memoryType: "decision",
                    sourceRefs: ["typed_memory:session_001:decision:priority"],
                    payload: {
                      summary: "Generic durable memory can be ranked later.",
                      content: Array.from({ length: 40 }, () => "typed memory filler").join(" ")
                    }
                  }
                ],
                evidence: [
                  {
                    ref: "evidence:turn_prev",
                    topic: "continuity-budget",
                    content: Array.from({ length: 40 }, () => "evidence filler").join(" "),
                    sourceRefs: ["evidence:turn_prev"]
                  }
                ],
                projectionDerivedRefs: [
                  {
                    ref: "projection:workspace_local:2026-04-16#continuity",
                    day: "2026-04-16",
                    section: "continuity",
                    summary: "Projection locator for the continuity section.",
                    sourceRefs: ["working_set:session_001:12", "evidence:turn_prev"],
                    turnRefs: ["turn_prev"]
                  }
                ]
              }
            }),
            observability: {
              durableMemory: {
                route: "continuation",
                preferredScopes: ["session", "workspace", "user"],
                preferredFamilies: ["continuity", "procedural", "fact", "preference"],
                preferredBuckets: ["task_continuity", "blocker", "open_loop", "decision"],
                items: [
                  {
                    memoryId: "memory_decision_001",
                    scope: "session",
                    memoryType: "decision",
                    family: "continuity",
                    bucket: "decision",
                    route: "continuation",
                    rank: 1,
                    selectionStatus: "selected",
                    reasons: ["matched continuation bias"],
                    summary: "Generic durable memory can be ranked later."
                  }
                ]
              }
            }
          } as RuntimeMemoryContext & { observability: any };
        }
      },
      taskStore: {
        async loadById() {
          return {
            taskId: "task_001",
            workspaceId: "workspace_local",
            sessionId: "session_001",
            title: "Continuity-first assembly",
            description: "Preserve the continuity core under truncation",
            kind: "act" as const,
            status: "blocked" as const,
            lastTurnId: "turn_prev",
            checkpointRef: "checkpoint:task_001",
            currentStep: "preserve the active task minimum surface",
            nextAction: "trim generic durable memory after continuity core",
            createdAt: "2026-04-11T08:00:00.000Z",
            updatedAt: "2026-04-11T10:00:00.000Z",
            blockingReason: "approval boundary still pending"
          };
        },
        async loadLatestActiveBySession() {
          return undefined;
        },
        async listActiveBySession() {
          return [];
        }
      },
      resolveToolExposure: async () => ({
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_tight_budget_observability",
        taskId: "task_001",
        resumeFrom: "checkpoint:task_001",
        input: "Keep the task continuity stable even if the budget is small."
      }),
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
          memoryInjectionBudget: 120,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      }
    });

    const observability = (result as { observability?: any }).observability;

    expect(observability.continuity.blocks).toMatchObject({
      activeTask: expect.objectContaining({
        selectionStatus: "selected",
        injectionStatus: "full"
      }),
      workingSet: expect.objectContaining({
        selectionStatus: "selected",
        injectionStatus: "skeleton"
      }),
      recentHistory: expect.objectContaining({
        selectionStatus: "selected",
        injectionStatus: "partial",
        carryForwardKinds: ["assistant_message", "system"]
      })
    });
    expect(observability.durableMemory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memoryId: "memory_decision_001",
        scope: "session",
        family: "continuity",
        bucket: "decision",
        selectionStatus: "selected",
        injectionStatus: "budget-dropped"
      })
    ]));
    expect(observability.truncation).toMatchObject({
      memoryInjectionBudget: 120,
      memoryTokensUsed: result.budget.memoryTokensUsed,
      memoryTruncated: true
    });
    expect(observability.truncation.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        blockId: "memory:turn_tight_budget_observability:working_set",
        layer: "continuity_core",
        outcome: "skeleton",
        reason: "budget_preserve_continuity_core"
      }),
      expect.objectContaining({
        blockId: "memory:turn_tight_budget_observability:typed_memory:session:0",
        layer: "durable_memory",
        outcome: "dropped",
        reason: "budget_reserved_for_higher_priority_context"
      }),
      expect.objectContaining({
        blockId: "memory:turn_tight_budget_observability:evidence:0",
        layer: "evidence",
        outcome: "dropped",
        reason: "budget_reserved_for_higher_priority_context"
      }),
      expect.objectContaining({
        blockId: "memory:turn_tight_budget_observability:projection_ref:0",
        layer: "supplement",
        outcome: "dropped",
        reason: "budget_reserved_for_higher_priority_context"
      })
    ]));
    expect(observability.contextBudget).toBeUndefined();
    expect(observability.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: MEMORY_CONTEXT_TRUNCATED_CODE,
        category: "memory_budget",
        audience: "operator_debug",
        metadata: expect.objectContaining({
          selectedMemoryTokens: expect.any(Number),
          injectedMemoryTokens: expect.any(Number),
          droppedMemoryTokens: expect.any(Number),
          selectedCount: 6,
          injectedCount: 3,
          droppedCount: 3,
          memoryInjectionBudget: 120,
          selectedMemorySourceRefs: expect.arrayContaining([
            "task_001",
            "checkpoint:task_001",
            "turn_prev",
            "typed_memory:session_001:decision:priority",
            "evidence:turn_prev",
            "projection:workspace_local:2026-04-16#continuity",
            "working_set:session_001:12"
          ]),
          injectedMemorySourceRefs: expect.arrayContaining([
            "task_001",
            "checkpoint:task_001",
            "turn_prev"
          ]),
          droppedMemorySourceRefs: expect.arrayContaining([
            "typed_memory:session_001:decision:priority",
            "evidence:turn_prev",
            "projection:workspace_local:2026-04-16#continuity",
            "working_set:session_001:12",
            "turn_prev"
          ])
        })
      })
    ]));
    expect(observability.diagnostics[0]?.metadata).not.toHaveProperty("budgetProfile");
    expect(observability.diagnostics[0]?.metadata).not.toHaveProperty("effectiveMemoryInjectionBudget");
    expect(result.warnings).toContain(MEMORY_CONTEXT_TRUNCATED_CODE);
    expect(result.warnings).not.toContain("memory selection truncated to fit budget");
  });

  it("reports legacy context-block truncation through the shared budget observability contract", async () => {
    const longLegacyWorkingSet = Array.from({ length: 24 }, () => "legacy working set continuity").join(" ");
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: "Legacy compatibility working set summary.",
            continuity: undefined,
            contextBlocks: [
              {
                blockId: "legacy:working_set",
                kind: "memory",
                title: "session working set",
                content: longLegacyWorkingSet,
                tokenCount: 12,
                sourceRefs: ["working_set:session_001:legacy"]
              },
              {
                blockId: "legacy:active_task",
                kind: "task",
                title: "active task",
                content: "Legacy active task title\nLegacy next action",
                tokenCount: 6,
                sourceRefs: ["task_legacy", "checkpoint:task_legacy"]
              },
              {
                blockId: "legacy:evidence:0",
                kind: "resource",
                title: "evidence",
                content: "Legacy evidence should stay observable even when dropped.",
                tokenCount: 8,
                sourceRefs: ["evidence:legacy"]
              }
            ]
          });
        }
      },
      taskStore: {
        async loadById() {
          return {
            taskId: "task_legacy",
            workspaceId: "workspace_local",
            sessionId: "session_001",
            title: "Legacy compatibility task",
            description: "Preserve compatibility observability",
            kind: "act" as const,
            status: "active" as const,
            lastTurnId: "turn_prev",
            checkpointRef: "checkpoint:task_legacy",
            createdAt: "2026-04-11T08:00:00.000Z",
            updatedAt: "2026-04-11T10:00:00.000Z"
          };
        },
        async loadLatestActiveBySession() {
          return undefined;
        },
        async listActiveBySession() {
          return [];
        }
      },
      resolveToolExposure: async () => ({
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_legacy_context_budget_observability",
        taskId: "task_legacy",
        input: "Keep the legacy compatibility path observable under truncation."
      }),
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
          memoryInjectionBudget: 10,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        },
        budgetDebug: {
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
          toolSchemaTokenEstimate: 0,
          safetyReserveTokens: 4000,
          unestimatedComponents: [],
          effectiveInputTokenBudget: 1000,
          effectiveMemoryInjectionBudget: 10,
          maxMemoryShareOfInput: 0.4,
          capHits: [],
          capReasons: [],
          overridesApplied: []
        }
      }
    });

    const observability = (result as { observability?: any }).observability;

    expect(observability.contextBudget).toMatchObject({
      selectedMemoryCount: 3,
      injectedMemoryCount: 1,
      droppedMemoryCount: 2,
      selectedMemorySourceRefs: [
        "working_set:session_001:legacy",
        "task_legacy",
        "checkpoint:task_legacy",
        "evidence:legacy"
      ],
      injectedMemorySourceRefs: ["working_set:session_001:legacy"],
      droppedMemorySourceRefs: ["task_legacy", "checkpoint:task_legacy", "evidence:legacy"]
    });
    expect(observability.contextBudget?.projectedInputTokensAfterFitting).toBe(
      observability.contextBudget?.promptBlocks.reduce(
        (total: number, block: { status: string; estimatedTokens: number }) =>
          block.status === "dropped" ? total : total + block.estimatedTokens,
        0
      )
    );
    expect(observability.contextBudget?.remainingHeadroomEstimate).toBe(
      1000 - (observability.contextBudget?.projectedInputTokensAfterFitting ?? 0)
    );
    expect(observability.contextBudget?.promptBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        blockId: "legacy:working_set",
        layer: "continuity_core",
        status: "partial",
        reason: "budget_partial_truncate"
      }),
      expect.objectContaining({
        blockId: "legacy:active_task",
        layer: "continuity_core",
        status: "dropped",
        reason: "budget_reserved_for_higher_priority_context"
      }),
      expect.objectContaining({
        blockId: "legacy:evidence:0",
        layer: "evidence",
        status: "dropped",
        reason: "budget_reserved_for_higher_priority_context"
      }),
      expect.objectContaining({
        blockId: "tool_schema:all",
        layer: "tool_schema",
        status: "included"
      })
    ]));
    expect(observability.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: MEMORY_CONTEXT_TRUNCATED_CODE,
        metadata: expect.objectContaining({
          selectedCount: 3,
          injectedCount: 1,
          droppedCount: 2,
          selectedMemorySourceRefs: [
            "working_set:session_001:legacy",
            "task_legacy",
            "checkpoint:task_legacy",
            "evidence:legacy"
          ],
          injectedMemorySourceRefs: ["working_set:session_001:legacy"],
          droppedMemorySourceRefs: ["task_legacy", "checkpoint:task_legacy", "evidence:legacy"]
        })
      })
    ]));
  });

  it("reports the final legacy working-set fallback through the shared budget observability contract", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: "Legacy-only working set summary must stay observable even when the budget drops it.",
            sourceRefs: ["working_set:session_001:fallback"],
            continuity: undefined,
            contextBlocks: []
          });
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
      resolveToolExposure: async () => ({
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_legacy_working_set_fallback_budget_observability",
        input: "Keep the final legacy working-set fallback truthful under a zero memory budget."
      }),
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
          memoryInjectionBudget: 0,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        },
        budgetDebug: {
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
          toolSchemaTokenEstimate: 0,
          safetyReserveTokens: 4000,
          unestimatedComponents: [],
          effectiveInputTokenBudget: 1000,
          effectiveMemoryInjectionBudget: 0,
          maxMemoryShareOfInput: 0.4,
          capHits: [],
          capReasons: [],
          overridesApplied: []
        }
      }
    });

    const observability = (result as { observability?: any }).observability;

    expect(observability.contextBudget).toMatchObject({
      selectedMemoryCount: 1,
      injectedMemoryCount: 0,
      droppedMemoryCount: 1,
      selectedMemorySourceRefs: ["working_set:session_001:fallback"],
      injectedMemorySourceRefs: [],
      droppedMemorySourceRefs: ["working_set:session_001:fallback"]
    });
    expect(observability.contextBudget?.projectedInputTokensAfterFitting).toBe(
      observability.contextBudget?.promptBlocks.reduce(
        (total: number, block: { status: string; estimatedTokens: number }) =>
          block.status === "dropped" ? total : total + block.estimatedTokens,
        0
      )
    );
    expect(observability.contextBudget?.remainingHeadroomEstimate).toBe(
      1000 - (observability.contextBudget?.projectedInputTokensAfterFitting ?? 0)
    );
    expect(observability.continuity.blocks.workingSet).toMatchObject({
      blockId: "memory:turn_legacy_working_set_fallback_budget_observability:working_set",
      selectionStatus: "selected",
      injectionStatus: "dropped",
      reason: "budget_reserved_for_higher_priority_context",
      sourceRefs: ["working_set:session_001:fallback"]
    });
    expect(observability.contextBudget?.promptBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        blockId: "memory:turn_legacy_working_set_fallback_budget_observability:working_set",
        layer: "continuity_core",
        status: "dropped",
        reason: "budget_reserved_for_higher_priority_context"
      }),
      expect.objectContaining({
        blockId: "tool_schema:all",
        layer: "tool_schema",
        status: "included"
      })
    ]));
    expect(observability.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: MEMORY_CONTEXT_TRUNCATED_CODE,
        metadata: expect.objectContaining({
          selectedCount: 1,
          injectedCount: 0,
          droppedCount: 1,
          selectedMemorySourceRefs: ["working_set:session_001:fallback"],
          injectedMemorySourceRefs: [],
          droppedMemorySourceRefs: ["working_set:session_001:fallback"]
        })
      })
    ]));
    expect(result.warnings).toContain(MEMORY_CONTEXT_TRUNCATED_CODE);
  });

  it("surfaces drift diagnostics when actor/scope rules keep user memory out of the current turn", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return {
            ...createMemoryContext({
              continuity: {
                retrievalPolicy: {
                  strategy: "ordinary",
                  activeTaskSelection: { mode: "none" },
                  includeWorkingSet: true,
                  includeRecentHistory: true,
                  includeActiveTask: false,
                  includeTypedMemory: true,
                  includeEvidence: false
                },
                recentHistory: {
                  summary: "",
                  refs: [],
                  turnRefs: []
                },
                workingSet: {
                  summary: "Investigate why user memory did not inject.",
                  objective: "explain actor/scope misses",
                  recentProgress: [],
                  recentDecisions: [],
                  blockers: [],
                  openLoops: [],
                  activeMemoryRefs: [],
                  activeTaskRefs: [],
                  recentEventRefs: [],
                  sourceRefs: ["turn_prev"]
                },
                typedMemory: [],
                evidence: [],
                projectionDerivedRefs: []
              }
            }),
            observability: {
              durableMemory: {
                route: "ordinary",
                preferredScopes: ["workspace", "user", "session"],
                preferredFamilies: ["fact", "preference", "procedural", "continuity"],
                preferredBuckets: [],
                items: [
                  {
                    memoryId: "user_pref_001",
                    scope: "user",
                    memoryType: "preference",
                    family: "preference",
                    bucket: "preference",
                    route: "ordinary",
                    rank: 1,
                    selectionStatus: "scope-mismatch",
                    reasons: ["actor_scope_mismatch"],
                    summary: "User prefers concise completion reports."
                  }
                ]
              }
            }
          } as RuntimeMemoryContext & { observability: any };
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
      resolveToolExposure: async () => ({
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_user_memory_scope_miss",
        actorId: "actor_other",
        input: "Why didn't my cross-project preference show up here?"
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

    const observability = (result as { observability?: any }).observability;

    expect(observability.driftDiagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "user_memory_scope_miss",
        evidence: expect.objectContaining({
          route: "ordinary",
          reasons: ["actor_scope_mismatch"],
          missedScopes: ["user"]
        })
      })
    ]));
  });

  it("surfaces disclosure mode, borrowed sources, and persona scope in observability", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            continuity: undefined,
            contextBlocks: []
          });
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
      ownerStateStore: {
        async inspectOwnerBinding() {
          return {
            ownerBinding: {
              ownerBindingId: "owner_001",
              ownerGeneration: 1
            }
          } as never;
        },
        resolveServerTimezone() {
          return "UTC";
        }
      },
      resolvePersona: async () => ({
        scopeKind: "owner_direct",
        styleInstructions: "professional, concise",
        behaviorInstructions: "lead with the answer",
        sourceRefs: ["persona:owner_direct"]
      }),
      resolveToolExposure: async () => ({
        exposureSource: "policy",
        exposedTools: [],
        hiddenToolNames: []
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_im_observability",
        source: "telegram",
        actorId: "actor_owner",
        input: "summarize release-room",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "private:42",
          peerId: "42",
          peerKind: "dm"
        } as never,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "owner_targeted",
            targetConversationKeys: ["supergroup:-100123"],
            borrowedConversationKeys: ["supergroup:-100123"],
            transientBorrowed: true
          }
        }
      }),
      session: {
        sessionId: "session_owner_dm",
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

    const observability = (result as { observability?: any }).observability;
    expect(observability.imBoundary).toMatchObject({
      disclosureMode: "owner_targeted",
      borrowedConversationKeys: ["supergroup:-100123"],
      personaScopeKind: "owner_direct"
    });
  });
});
