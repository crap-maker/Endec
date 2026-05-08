import { describe, expect, it, vi } from "vitest";
import type { RuntimeMemoryContext, TurnRequest } from "@endec/domain";
import { createContextAssembler } from "./context-assembler.ts";
import { createAppToolPort } from "./tool-port.ts";

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli",
    actorId: "actor_cli",
    input: "Continue the blocked task using memory continuity.",
    attachments: [],
    taskId: "task_001",
    resumeFrom: "checkpoint:turn_prev",
    ...overrides
  };
}

function createMemoryContext(overrides: Partial<RuntimeMemoryContext> = {}): RuntimeMemoryContext {
  return {
    workingSetSummary: "Focus on WS4 seam compatibility.",
    retrievedItems: [],
    injectionPlan: [],
    tokenEstimate: 24,
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
        summary: "prior turn blocked on permission",
        refs: ["turn_prev"],
        turnRefs: ["turn_prev"]
      },
      workingSet: {
        ref: "working_set:session_001:3",
        version: 3,
        summary: "Focus on WS4 seam compatibility.",
        objective: "stabilize the retrieval seam",
        recentProgress: ["preserved typed memory + evidence continuity"],
        recentDecisions: ["treat markdown as locator only"],
        blockers: ["awaiting approval"],
        openLoops: ["codify projection-derived refs contract"],
        activeMemoryRefs: ["memory:turn_001:typed_memory:0"],
        activeTaskRefs: ["task_001"],
        recentEventRefs: ["turn_prev"],
        sourceRefs: ["turn_prev"]
      },
      activeTask: {
        taskId: "task_001",
        title: "Repair WS4",
        status: "blocked",
        checkpointRef: "checkpoint:task_001",
        updatedAt: "2026-04-11T10:00:00.000Z",
        selectedBy: "request_task"
      },
      typedMemory: [
        {
          kind: "candidate_extract",
          status: "pending",
          scope: "session",
          sourceRefs: ["turn_prev"],
          payload: {
            contract: "candidate_extract_pending",
            target: "typed_memory_pipeline"
          }
        }
      ],
      evidence: [
        {
          ref: "evidence:turn_prev",
          topic: "ws4",
          content: "WS4 must keep WS0 execution control compatible.",
          sourceRefs: ["turn_prev"]
        }
      ],
      projectionDerivedRefs: [
        {
          ref: "projection:workspace_local:2026-04-16#ws4",
          day: "2026-04-16",
          section: "ws4",
          summary: "Daily projection points back to the frozen WS4 seam.",
          sourceRefs: ["working_set:session_001:3", "evidence:turn_prev"],
          turnRefs: ["turn_prev"]
        }
      ]
    },
    contextBlocks: [
      {
        blockId: "memory:turn_001:recent_history",
        kind: "history",
        title: "recent history",
        content: "prior turn blocked on permission",
        tokenCount: 6,
        sourceRefs: ["turn_prev"]
      },
      {
        blockId: "memory:turn_001:working_set",
        kind: "memory",
        title: "session working set",
        content: "Focus on WS4 seam compatibility.",
        tokenCount: 8,
        sourceRefs: ["working_set:session_001:3"]
      },
      {
        blockId: "memory:turn_001:active_task",
        kind: "task",
        title: "active task",
        content: "Repair WS4",
        tokenCount: 4,
        sourceRefs: ["task_001", "checkpoint:task_001"]
      },
      {
        blockId: "memory:turn_001:typed_memory:session:0",
        kind: "memory",
        title: "session durable memory",
        content: "scope: session\ncandidate_extract",
        tokenCount: 4,
        sourceRefs: ["turn_prev"]
      },
      {
        blockId: "memory:turn_001:evidence:0",
        kind: "resource",
        title: "evidence",
        content: "WS4 must keep WS0 execution control compatible.",
        tokenCount: 8,
        sourceRefs: ["evidence:turn_prev"]
      }
    ],
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

describe("createContextAssembler", () => {
  it("uses the app-configured server timezone for current time context assembly instead of process env", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T13:14:00.000Z"));

    try {
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
            return undefined;
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
          turnId: "turn_time_context_configured_timezone",
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
        timezoneSource: "server_default",
        localDate: "2026-04-29",
        localTime: "21:14",
        dayPart: "evening"
      });
      const timeContextBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "current time context");
      expect(timeContextBlock?.content).toContain("timezone: Asia/Shanghai (server_default)");
      expect(timeContextBlock?.content).toContain("local now: Wed 2026-04-29 21:14");
    } finally {
      vi.useRealTimers();
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it("uses resolved owner preferences ahead of the configured server timezone during context assembly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T13:14:00.000Z"));

    try {
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
              resolvedOwnerPreferences: {
                timezone: "Asia/Shanghai",
                timezoneSource: "owner_preference"
              }
            };
          },
          resolveServerTimezone() {
            return "America/Los_Angeles";
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
          turnId: "turn_time_context_owner_preference",
          source: "telegram",
          actorId: "actor_owner",
          taskId: undefined,
          resumeFrom: undefined,
          input: "hello with owner timezone",
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
        timezoneSource: "owner_preference"
      });
      const timeContextBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "current time context");
      expect(timeContextBlock?.content).toContain("timezone: Asia/Shanghai (owner_preference)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses owner-preference runtime truth only when the resolved timezone source is owner_preference", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T13:14:00.000Z"));

    try {
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
              resolvedOwnerPreferences: {
                timezone: "UTC",
                timezoneSource: "server_default"
              }
            };
          },
          resolveServerTimezone() {
            return "UTC";
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
          turnId: "turn_time_context_server_default_only",
          source: "telegram",
          actorId: "actor_owner",
          taskId: undefined,
          resumeFrom: undefined,
          input: "hello after skipped init",
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
        timezone: "UTC",
        timezoneSource: "server_default"
      });
      const timeContextBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "current time context");
      expect(timeContextBlock?.content).toContain("timezone: UTC (server_default)");
      expect(timeContextBlock?.content).not.toContain("owner_preference");
    } finally {
      vi.useRealTimers();
      process.env.TZ = originalTz;
    }
  });

  it("keeps canonical exposure stable across modes while reclassifying authorization in authoritative truth", async () => {
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
      resolveToolExposure: async ({ request, session, budget }) =>
        toolPort.describeExposure({
          turnId: request.turnId,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          resolvedMode: budget.resolvedMode
        })
    });

    const chat = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_chat_tools",
        taskId: undefined,
        resumeFrom: undefined,
        input: "chat mode should stay readonly"
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

    const act = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_act_tools",
        taskId: undefined,
        resumeFrom: undefined,
        input: "act mode should expose writable tools"
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
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,

          maxToolCallsPerTurn: 4
        }
      }
    });

    expect(chat.toolExposure.hiddenToolNames).toEqual([]);
    expect(chat.selection.exposedToolNames).toEqual(["read", "glob", "grep", "write", "edit", "bash"]);
    expect(chat.runtimeRequest.turnContext?.selfAwareness).toMatchObject({
      mode: "chat",
      exposedToolNames: ["read", "glob", "grep", "write", "edit", "bash"]
    });
    expect(chat.runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth).toMatchObject({
      guaranteedToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
      approvalRequiredCapabilities: ["remote_git_push", "pull_request_create"]
    });
    const chatBlock = chat.runtimeRequest.contextBlocks.find((block) => block.title === "authoritative current-turn truth");
    expect(chatBlock?.content).toContain("approval-required capabilities: remote_git_push, pull_request_create");

    expect(act.toolExposure.hiddenToolNames).toEqual([]);
    expect(act.selection.exposedToolNames).toEqual(["read", "glob", "grep", "write", "edit", "bash"]);
    expect(act.runtimeRequest.turnContext?.selfAwareness).toMatchObject({
      mode: "act",
      exposedToolNames: ["read", "glob", "grep", "write", "edit", "bash"]
    });
    expect(act.runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth).toEqual(
      chat.runtimeRequest.turnContext?.authoritativeTruth?.capabilityTruth
    );
    const actBlock = act.runtimeRequest.contextBlocks.find((block) => block.title === "runtime self-awareness");
    expect(actBlock?.content).toContain("mode: act");
    expect(actBlock?.content).toContain("exposed tools: read, glob, grep, write, edit, bash");
  });
  it("injects runtime self-awareness for source, exposed tools, and normal-path turns", async () => {
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
      resolveToolExposure: async () => ({
        exposureSource: "lazy",
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
          },
          {
            name: "glob",
            description: "Find files",
            inputSchema: {
              type: "object",
              properties: {
                pattern: { type: "string" }
              },
              required: ["pattern"]
            }
          }
        ],
        hiddenToolNames: ["bash"]
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        source: "telegram",
        actorId: "actor_tg",
        input: "你现在通过什么入口工作？",
        taskId: undefined,
        resumeFrom: undefined
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
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,

          maxToolCallsPerTurn: 4
        }
      }
    });

    expect(result.runtimeRequest.turnContext?.selfAwareness).toMatchObject({
      source: "telegram",
      channel: "telegram",
      mode: "act",
      exposedToolNames: ["read", "glob"],
      replyPath: "normal",
      constraints: []
    });
    expect(result.runtimeRequest.contextBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "runtime self-awareness",
          kind: "instruction",
          content: expect.stringContaining("source/channel: telegram")
        })
      ])
    );
    const runtimeSelfAwarenessBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "runtime self-awareness");
    expect(runtimeSelfAwarenessBlock?.content).toContain("mode: act");
    expect(runtimeSelfAwarenessBlock?.content).toContain("reply path: normal");
    expect(runtimeSelfAwarenessBlock?.content).toContain("exposed tools: read, glob");
  });

  it("synthesizes structured continuity for legacy memory contexts while preserving compatibility fields", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: "Legacy summary stays for compatibility.",
            retrievedItems: [],
            injectionPlan: [],
            tokenEstimate: 0,
            sourceRefs: ["working_set:session_001:9"],
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
        taskId: undefined,
        resumeFrom: undefined,
        input: "reuse the legacy continuity payload"
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

    expect(result.runtimeRequest.turnContext?.memory).toMatchObject({
      workingSetSummary: "Legacy summary stays for compatibility.",
      retrievedItems: [],
      injectionPlan: [],
      continuity: {
        workingSet: {
          summary: "Legacy summary stays for compatibility.",
          objective: undefined,
          recentProgress: [],
          recentDecisions: [],
          blockers: [],
          openLoops: [],
          activeMemoryRefs: [],
          activeTaskRefs: [],
          recentEventRefs: [],
          sourceRefs: ["working_set:session_001:9"]
        },
        projectionDerivedRefs: []
      }
    });
    expect(result.selection.projectionRefs).toEqual([]);
  });

  it("does not re-inject legacy markdown context blocks when continuity is present but yields no structured blocks", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: "LEGACY SUMMARY SHOULD STAY OUT OF MODEL INJECTION",
            continuity: {
              retrievalPolicy: {
                strategy: "continuation",
                activeTaskSelection: {
                  mode: "request_task",
                  taskId: "task_001"
                },
                includeWorkingSet: false,
                includeRecentHistory: false,
                includeActiveTask: false,
                includeTypedMemory: false,
                includeEvidence: false
              },
              recentHistory: {
                summary: "",
                refs: [],
                turnRefs: []
              },
              workingSet: {
                ref: "working_set:session_001:11",
                version: 11,
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
              activeTask: undefined,
              typedMemory: [],
              evidence: [],
              projectionDerivedRefs: []
            },
            contextBlocks: [
              {
                blockId: "legacy:projection_markdown",
                kind: "resource",
                title: "projection-derived ref",
                content: "# Daily Memory Projection\nMANUAL MARKDOWN TRUTH",
                tokenCount: 12,
                sourceRefs: ["projection:workspace_local:2026-04-16#followups"]
              }
            ]
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
      }
    });

    expect(result.runtimeRequest.turnContext?.memory.contextBlocks).toEqual([]);
    expect(result.runtimeRequest.contextBlocks.some((block) => block.content.includes("MANUAL MARKDOWN TRUTH"))).toBe(false);
    expect(result.runtimeRequest.contextBlocks.some((block) => block.blockId === "legacy:projection_markdown")).toBe(false);
  });

  it("preserves legacy context blocks when continuity is missing and compatibility continuity is synthesized", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: "Synthesized working set should not replace legacy injection blocks.",
            continuity: undefined,
            contextBlocks: [
              {
                blockId: "legacy:working_set",
                kind: "memory",
                title: "session working set",
                content: "Legacy working set survives compatibility fallback.",
                tokenCount: 8,
                sourceRefs: ["working_set:session_001:legacy"]
              },
              {
                blockId: "legacy:active_task",
                kind: "task",
                title: "active task",
                content: "Legacy task title\nLegacy next action",
                tokenCount: 6,
                sourceRefs: ["task_001", "checkpoint:task_001"]
              },
              {
                blockId: "legacy:evidence:0",
                kind: "resource",
                title: "evidence",
                content: "Legacy evidence should still be injected.",
                tokenCount: 7,
                sourceRefs: ["evidence:legacy"]
              }
            ]
          });
        }
      },
      taskStore: {
        async loadById() {
          return {
            taskId: "task_001",
            workspaceId: "workspace_local",
            sessionId: "session_001",
            title: "Legacy task metadata",
            description: "Restore compatibility",
            kind: "act" as const,
            status: "active" as const,
            lastTurnId: "turn_prev",
            checkpointRef: "checkpoint:task_001",
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
        resumeFrom: undefined
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
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,

          maxToolCallsPerTurn: 4
        }
      }
    });

    expect(result.runtimeRequest.turnContext?.memory.continuity).toMatchObject({
      retrievalPolicy: {
        strategy: "active_task_preferred"
      },
      workingSet: {
        summary: "Synthesized working set should not replace legacy injection blocks."
      }
    });
    expect(result.runtimeRequest.turnContext?.memory.contextBlocks?.map((block) => block.blockId)).toEqual([
      "legacy:working_set",
      "legacy:active_task",
      "legacy:evidence:0"
    ]);
    expect(result.runtimeRequest.contextBlocks.some((block) => block.blockId === "memory:turn_001:working_set")).toBe(false);
    expect(result.runtimeRequest.contextBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ blockId: "legacy:active_task", content: "Legacy task title\nLegacy next action" }),
        expect.objectContaining({ blockId: "legacy:evidence:0", content: "Legacy evidence should still be injected." })
      ])
    );
  });

  it("prefers continuity truth for runtime injection order and keeps projection refs separate from evidence", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [
            {
              eventId: "event_history",
              turnId: "turn_history",
              eventKind: "assistant_message",
              summary: "legacy recent history should not win",
              text: "legacy recent history should not win",
              createdAt: "2026-04-11T08:00:00.000Z",
              sourceRefs: ["turn_history"]
            }
          ];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: "LEGACY SUMMARY SHOULD NOT WIN",
            retrievedItems: [{ kind: "working_set", summary: "LEGACY SUMMARY SHOULD NOT WIN" }],
            injectionPlan: [{ kind: "resource", blockId: "legacy_projection", tokenBudget: 64 }],
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
                summary: "continuity recent history wins",
                refs: ["turn_b", "turn_a"],
                turnRefs: ["turn_b", "turn_a"]
              },
              workingSet: {
                ref: "working_set:session_001:7",
                version: 7,
                summary: "CONTINUITY working set wins",
                objective: "inject continuity in fixed order",
                recentProgress: ["preserve memory-layer ordering"],
                recentDecisions: ["projection refs stay locator-only"],
                blockers: ["budget may trim low-priority refs"],
                openLoops: ["run package verification"],
                activeMemoryRefs: ["typed_memory:session_001:blocker:approval"],
                activeTaskRefs: ["task_001", "checkpoint:task_001"],
                recentEventRefs: ["turn_b", "turn_a"],
                sourceRefs: ["turn_b", "checkpoint:turn_b"]
              },
              activeTask: {
                taskId: "task_001",
                title: "Continuity task",
                status: "blocked",
                checkpointRef: "checkpoint:task_001",
                currentStep: "step from continuity",
                nextAction: "next from continuity",
                blockingReason: "blocked in continuity",
                updatedAt: "2026-04-11T10:00:00.000Z",
                selectedBy: "request_task"
              },
              typedMemory: [
                {
                  kind: "typed_upsert",
                  status: "materialized",
                  scope: "session",
                  memoryType: "blocker",
                  sourceRefs: ["typed_memory:session_001:blocker:approval", "turn_b"],
                  payload: {
                    summary: "Need approval",
                    content: "Approval blocks the shell-facing step."
                  }
                },
                {
                  kind: "candidate_extract",
                  status: "pending",
                  scope: "session",
                  sourceRefs: ["turn_a"],
                  payload: {
                    contract: "candidate_extract_pending",
                    target: "typed_memory_pipeline"
                  }
                }
              ],
              evidence: [
                {
                  ref: "evidence:turn_b",
                  topic: "topic-b",
                  content: "Evidence B should stay first.",
                  sourceRefs: ["evidence:turn_b", "session_001"]
                },
                {
                  ref: "evidence:turn_a",
                  topic: "topic-a",
                  content: "Evidence A should stay second.",
                  sourceRefs: ["evidence:turn_a", "session_001"]
                }
              ],
              projectionDerivedRefs: [
                {
                  ref: "projection:workspace_local:2026-04-16#followups",
                  day: "2026-04-16",
                  section: "followups",
                  summary: "Projection locator for the follow-up section.",
                  sourceRefs: ["working_set:session_001:7", "evidence:turn_b"],
                  turnRefs: ["turn_b"]
                },
                {
                  ref: "projection:workspace_local:2026-04-16#ws4",
                  day: "2026-04-16",
                  section: "ws4",
                  summary: "Projection locator for the ws4 section.",
                  sourceRefs: ["working_set:session_001:7", "evidence:turn_a"],
                  turnRefs: ["turn_a"]
                }
              ]
            },
            contextBlocks: [
              {
                blockId: "legacy:working_set",
                kind: "memory",
                title: "session working set",
                content: "LEGACY BLOCK SHOULD NOT WIN",
                tokenCount: 6,
                sourceRefs: ["legacy"]
              },
              {
                blockId: "legacy:projection_markdown",
                kind: "resource",
                title: "projection-derived ref",
                content: "# Daily Memory Projection\nMANUAL MARKDOWN TRUTH",
                tokenCount: 12,
                sourceRefs: ["projection:workspace_local:2026-04-16#followups"]
              }
            ]
          });
        }
      },
      taskStore: {
        async loadById() {
          return {
            taskId: "task_001",
            workspaceId: "workspace_local",
            sessionId: "session_001",
            title: "Legacy task should not drive memory injection",
            description: "Restore compatibility",
            kind: "act" as const,
            status: "blocked" as const,
            lastTurnId: "turn_prev",
            checkpointRef: "checkpoint:task_001",
            currentStep: "legacy step",
            nextAction: "legacy action",
            createdAt: "2026-04-11T08:00:00.000Z",
            updatedAt: "2026-04-11T10:00:00.000Z",
            blockingReason: "awaiting approval"
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
      }
    });

    const injectedMemoryBlocks = result.runtimeRequest.contextBlocks.filter((block) =>
      block.blockId.startsWith("memory:turn_001:")
    );

    expect(injectedMemoryBlocks.map((block) => block.blockId)).toEqual([
      "memory:turn_001:active_task",
      "memory:turn_001:working_set",
      "memory:turn_001:recent_history",
      "memory:turn_001:typed_memory:session:0",
      "memory:turn_001:typed_memory:session:1",
      "memory:turn_001:evidence:0",
      "memory:turn_001:evidence:1",
      "memory:turn_001:projection_ref:0",
      "memory:turn_001:projection_ref:1"
    ]);
    expect(result.runtimeRequest.turnContext?.memory.contextBlocks).toEqual(injectedMemoryBlocks);
    expect(injectedMemoryBlocks[0]?.content).toBe([
      "Continuity task",
      "step from continuity",
      "next from continuity",
      "blocked in continuity"
    ].join("\n"));
    expect(injectedMemoryBlocks[1]?.content).toContain("CONTINUITY working set wins");
    expect(injectedMemoryBlocks[1]?.content).not.toContain("LEGACY");
    expect(injectedMemoryBlocks[2]?.content).toBe("continuity recent history wins");
    expect(injectedMemoryBlocks[3]?.title).toBe("session durable memory");
    expect(injectedMemoryBlocks[3]?.content).toContain("scope: session");
    expect(injectedMemoryBlocks[3]?.content).toContain("type: blocker");
    expect(injectedMemoryBlocks[3]?.content).toContain("summary: Need approval");
    expect(injectedMemoryBlocks[4]?.content).toContain("kind: candidate_extract");
    expect(injectedMemoryBlocks[5]?.content).toContain("topic-b");
    expect(injectedMemoryBlocks[5]?.content).toContain("Evidence B should stay first.");
    expect(injectedMemoryBlocks[6]?.content).toContain("topic-a");
    expect(injectedMemoryBlocks[6]?.content).toContain("Evidence A should stay second.");
    expect(injectedMemoryBlocks[7]?.content).toContain("ref: projection:workspace_local:2026-04-16#followups");
    expect(injectedMemoryBlocks[7]?.content).toContain("canonical refs: working_set:session_001:7, evidence:turn_b");
    expect(injectedMemoryBlocks[7]?.content).toContain("turn refs: turn_b");
    expect(injectedMemoryBlocks[7]?.content).not.toContain("# Daily Memory Projection");
    expect(injectedMemoryBlocks[7]?.content).not.toContain("MANUAL MARKDOWN TRUTH");
    const authoritativeTruthIndex = result.runtimeRequest.contextBlocks.findIndex((block) => block.title === "authoritative current-turn truth");
    const activeTaskIndex = result.runtimeRequest.contextBlocks.findIndex((block) => block.blockId === "memory:turn_001:active_task");
    const typedMemoryIndex = result.runtimeRequest.contextBlocks.findIndex((block) => block.blockId === "memory:turn_001:typed_memory:session:0");
    expect(authoritativeTruthIndex).toBeGreaterThanOrEqual(0);
    expect(activeTaskIndex).toBeGreaterThan(authoritativeTruthIndex);
    expect(typedMemoryIndex).toBeGreaterThan(activeTaskIndex);
    expect(result.runtimeRequest.turnContext?.memory.workingSetSummary).toBe("LEGACY SUMMARY SHOULD NOT WIN");
    expect(result.runtimeRequest.turnContext?.memory.retrievedItems).toEqual([
      { kind: "working_set", summary: "LEGACY SUMMARY SHOULD NOT WIN" }
    ]);
    expect(result.runtimeRequest.turnContext?.memory.injectionPlan).toEqual([
      { kind: "resource", blockId: "legacy_projection", tokenBudget: 64 }
    ]);
    expect(result.selection).toMatchObject({
      recentHistoryTurnIds: ["turn_b", "turn_a"],
      activeTaskId: "task_001",
      evidenceIds: ["evidence:turn_b", "evidence:turn_a"],
      projectionRefs: [
        "projection:workspace_local:2026-04-16#followups",
        "projection:workspace_local:2026-04-16#ws4"
      ]
    });
    expect(result.selection.evidenceIds.some((ref) => ref.startsWith("projection:"))).toBe(false);
  });

  it("keeps continuity core ahead of durable memory when the memory budget is tight", async () => {
    const hugeLegacyLikeSummary = Array.from({ length: 80 }, () => "GENERIC DURABLE MEMORY SHOULD NOT DISPLACE CONTINUITY CORE").join(" ");
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            workingSetSummary: hugeLegacyLikeSummary,
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
                turnRefs: ["turn_prev"]
              },
              workingSet: {
                ref: "working_set:session_001:12",
                version: 12,
                summary: hugeLegacyLikeSummary,
                objective: "Ship continuity-first context assembly",
                recentProgress: ["froze current-turn truth above memory recall"],
                recentDecisions: ["continuity core beats generic durable memory"],
                blockers: ["budget pressure must not drop active task continuity"],
                openLoops: ["run targeted Slice 2 verification"],
                activeMemoryRefs: ["typed_memory:session_001:blocker:approval"],
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
            },
            contextBlocks: []
          });
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
        turnId: "turn_priority_budget",
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

    const injectedMemoryBlocks = result.runtimeRequest.contextBlocks.filter((block) =>
      block.blockId.startsWith("memory:turn_priority_budget:")
    );

    expect(injectedMemoryBlocks.map((block) => block.blockId)).toEqual([
      "memory:turn_priority_budget:active_task",
      "memory:turn_priority_budget:working_set",
      "memory:turn_priority_budget:recent_history"
    ]);
    expect(injectedMemoryBlocks[0]?.content).toContain("Continuity-first assembly");
    expect(injectedMemoryBlocks[0]?.content).toContain("preserve the active task minimum surface");
    expect(injectedMemoryBlocks[0]?.content).toContain("trim generic durable memory after continuity core");
    expect(injectedMemoryBlocks[0]?.content).toContain("approval boundary still pending");
    expect(injectedMemoryBlocks[1]?.content).toContain("Objective: Ship continuity-first context assembly");
    expect(injectedMemoryBlocks[1]?.content).toContain("Blockers:");
    expect(injectedMemoryBlocks[1]?.content).toContain("Open loops:");
    expect(injectedMemoryBlocks[1]?.content).not.toContain("GENERIC DURABLE MEMORY SHOULD NOT DISPLACE CONTINUITY CORE");
    expect(injectedMemoryBlocks[2]?.content).toContain("carry forward: keep the current task boundary");
    expect(result.runtimeRequest.contextBlocks.some((block) => block.blockId.includes(":typed_memory:"))).toBe(false);
    expect(result.runtimeRequest.contextBlocks.some((block) => block.blockId.includes(":evidence:"))).toBe(false);
    expect(result.runtimeRequest.contextBlocks.some((block) => block.blockId.includes(":projection_ref:"))).toBe(false);
    expect(result.budget.memoryTruncated).toBe(true);
  });

  it("routes memory continuity through the WS1 app-layer assembly and preserves typedMemory/evidence input", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [
            {
              eventId: "event_001",
              turnId: "turn_prev",
              eventKind: "assistant_message",
              summary: "prior turn blocked on permission",
              text: "prior turn blocked on permission",
              createdAt: "2026-04-11T08:00:00.000Z",
              sourceRefs: ["turn_prev"]
            }
          ];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext();
        },
        async searchEvidence() {
          return {
            items: [
              {
                evidenceId: "evidence:turn_prev",
                sessionId: "session_001",
                topic: "ws4",
                content: "WS4 must keep WS0 execution control compatible.",
                createdAt: "2026-04-11T08:00:00.000Z"
              }
            ]
          };
        },
        async listOutbox() {
          return [
            {
              writeId: "write:turn_prev",
              sourceTurnId: "turn_prev",
              sessionId: "session_001",
              workspaceId: "workspace_local",
              writeKind: "candidate_extract" as const,
              evidenceRefs: ["turn_prev"],
              payload: {
                writeId: "write:turn_prev",
                sourceTurnId: "turn_prev",
                sessionId: "session_001",
                workspaceId: "workspace_local",
                writeKind: "candidate_extract" as const,
                evidenceRefs: ["turn_prev"]
              },
              createdAt: "2026-04-11T08:00:00.000Z",
              processedAt: null
            }
          ];
        }
      },
      taskStore: {
        async loadById() {
          return {
            taskId: "task_001",
            workspaceId: "workspace_local",
            sessionId: "session_001",
            title: "Repair WS4",
            description: "Restore compatibility",
            kind: "act" as const,
            status: "blocked" as const,
            lastTurnId: "turn_prev",
            checkpointRef: "checkpoint:task_001",
            createdAt: "2026-04-11T08:00:00.000Z",
            updatedAt: "2026-04-11T10:00:00.000Z",
            blockingReason: "awaiting approval"
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
        toolSchemas: [
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
      }
    });

    expect(result.contractVersion).toBe("ws0.context-assembly.v1");
    expect(result.metadata).toMatchObject({
      assemblySource: "app-layer"
    });
    expect(result.toolExposure).toMatchObject({
      exposureSource: "policy",
      exposedTools: [expect.objectContaining({ name: "read" })],
      hiddenToolNames: ["bash"]
    });
    expect(result.runtimeRequest.toolSchemas).toEqual([
      expect.objectContaining({ name: "read" })
    ]);
    expect(result.selection.exposedToolNames).toEqual(["read"]);
    expect(result.runtimeRequest.turnContext?.memory.continuity).toMatchObject({
      retrievalPolicy: {
        strategy: "continuation"
      },
      activeTask: {
        taskId: "task_001"
      }
    });
    expect(result.runtimeRequest.turnContext?.memory.continuity?.typedMemory).toEqual([
      expect.objectContaining({
        kind: "candidate_extract",
        status: "pending"
      })
    ]);
    expect(result.runtimeRequest.turnContext?.memory.continuity?.evidence).toEqual([
      expect.objectContaining({
        ref: "evidence:turn_prev",
        topic: "ws4"
      })
    ]);
    expect(result.runtimeRequest.turnContext?.memory.continuity?.projectionDerivedRefs).toEqual([
      expect.objectContaining({
        ref: "projection:workspace_local:2026-04-16#ws4",
        day: "2026-04-16",
        section: "ws4",
        sourceRefs: ["working_set:session_001:3", "evidence:turn_prev"],
        turnRefs: ["turn_prev"]
      })
    ]);
    expect(result.selection).toMatchObject({
      activeTaskId: "task_001",
      evidenceIds: ["evidence:turn_prev"]
    });
    expect(result.runtimeRequest.turnContext?.selfAwareness).toMatchObject({
      source: "cli",
      channel: "cli",
      mode: "act",
      exposedToolNames: ["read"],
      replyPath: "continuation"
    });
    const runtimeSelfAwarenessBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "runtime self-awareness");
    expect(runtimeSelfAwarenessBlock?.content).toContain("reply path: continuation");
    expect(runtimeSelfAwarenessBlock?.content).toContain("exposed tools: read");
  });

  it("keeps blocked-path runtime self-awareness explicit instead of falling back to normal", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            continuity: undefined
          });
        }
      },
      taskStore: {
        async loadById() {
          return {
            taskId: "task_001",
            workspaceId: "workspace_local",
            sessionId: "session_001",
            title: "Repair WS4",
            description: "Restore compatibility",
            kind: "act" as const,
            status: "blocked" as const,
            lastTurnId: "turn_prev",
            checkpointRef: "checkpoint:task_001",
            createdAt: "2026-04-11T08:00:00.000Z",
            updatedAt: "2026-04-11T10:00:00.000Z",
            blockingReason: "awaiting approval"
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
      request: createTurnRequest({
        input: "为什么还不能继续？",
        resumeFrom: undefined
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
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,

          maxToolCallsPerTurn: 4
        }
      }
    });

    expect(result.runtimeRequest.turnContext?.selfAwareness).toMatchObject({
      source: "cli",
      channel: "cli",
      mode: "act",
      exposedToolNames: ["read"],
      replyPath: "blocked",
      constraints: [
        expect.objectContaining({
          code: "task_blocked",
          summary: "awaiting approval",
          blocking: true
        })
      ]
    });
    const runtimeSelfAwarenessBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "runtime self-awareness");
    expect(runtimeSelfAwarenessBlock?.content).toContain("reply path: blocked");
    expect(runtimeSelfAwarenessBlock?.content).toContain("constraints: task_blocked=awaiting approval");
  });

  it("surfaces turn-scoped bash trust through continuation policy and runtime self-awareness", async () => {
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
      resolveToolExposure: async () => ({
        exposureSource: "policy",
        exposedTools: [
          {
            name: "bash",
            description: "Execute a shell command",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string" }
              },
              required: ["command"]
            }
          }
        ],
        hiddenToolNames: []
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_continue_bash_trust",
        taskId: undefined,
        resumeFrom: "checkpoint:turn_blocked",
        input: "continue after approving bash for the rest of this turn"
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
          pendingExecutionId: "pending:turn_blocked",
          frameRef: "frame:turn_blocked",
          checkpointRef: "checkpoint:turn_blocked",
          status: "blocked",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:turn_blocked",
            checkpointRef: "checkpoint:turn_blocked",
            turnId: "turn_blocked",
            sessionId: "session_001",
            workspaceId: "workspace_local",
            phase: "awaiting_permission",
            step: "tool_batch",
            pendingToolCalls: [
              {
                toolCallId: "tool_call_bash_001",
                toolName: "bash",
                arguments: { command: "printf trusted" }
              }
            ],
            pendingPermissionDecisions: [
              {
                decisionId: "tool_call_bash_001",
                behavior: "ask",
                scope: "once",
                reasonCode: "tool_requires_approval",
                reasonText: "bash requires operator approval before it can run",
                issuedAt: "2026-04-14T00:00:00.000Z",
                requestedBy: "turn_blocked"
              }
            ],
            loopCount: 1,
            toolCallCount: 1,
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "awaiting_operator",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {}
            }
          }
        },
        control: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-control.v1",
          action: "approve",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          turnId: "turn_blocked",
          frameRef: "frame:turn_blocked",
          decisionId: "tool_call_bash_001",
          scope: "turn",
          approverId: "operator_001"
        }
      }
    });

    expect(result.runtimeRequest.continuation?.approvedToolBatch).toMatchObject({
      approvedDecisionIds: ["tool_call_bash_001"],
      approverId: "operator_001",
      bashTrust: {
        toolName: "bash",
        scope: "turn",
        decisionId: "tool_call_bash_001",
        approverId: "operator_001"
      }
    });
    expect(result.runtimeRequest.turnContext?.selfAwareness).toMatchObject({
      replyPath: "continuation",
      constraints: [
        expect.objectContaining({
          code: "bash_trust_active",
          summary: "bash is approved for the rest of this turn",
          blocking: false,
          metadata: expect.objectContaining({
            decisionId: "tool_call_bash_001",
            scope: "turn"
          })
        })
      ]
    });
    const runtimeSelfAwarenessBlock = result.runtimeRequest.contextBlocks.find((block) => block.title === "runtime self-awareness");
    expect(runtimeSelfAwarenessBlock?.content).toContain("reply path: continuation");
    expect(runtimeSelfAwarenessBlock?.content).toContain("bash_trust_active=bash is approved for the rest of this turn");
  });

  it("replays runtime-generated resumable pending tool batches before asking the provider for a new plan", async () => {
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
      resolveToolExposure: async () => ({
        exposureSource: "policy",
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
        hiddenToolNames: []
      })
    });

    const result = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_resume_runtime_pause",
        taskId: undefined,
        resumeFrom: "checkpoint:turn_runtime_pause",
        input: "resume the paused runtime batch"
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
          pendingExecutionId: "pending:turn_runtime_pause",
          frameRef: "frame:turn_runtime_pause",
          checkpointRef: "checkpoint:turn_runtime_pause",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:turn_runtime_pause",
            checkpointRef: "checkpoint:turn_runtime_pause",
            turnId: "turn_runtime_pause",
            sessionId: "session_001",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "tool_turn_limit",
            pendingToolCalls: [
              {
                toolCallId: "tool_call_resume_001",
                toolName: "read",
                arguments: { path: "README.md" }
              }
            ],
            pendingPermissionDecisions: [],
            loopCount: 1,
            toolCallCount: 2,
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                stopReason: "tool_turn_limit",
                requestedToolCallsInBatch: 1,
                toolCallCountBeforePausedBatch: 2,
                executedToolCalls: 0
              }
            }
          }
        },
        control: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-control.v1",
          action: "resume",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          turnId: "turn_runtime_pause",
          frameRef: "frame:turn_runtime_pause"
        }
      }
    });

    expect(result.runtimeRequest.continuation?.approvedToolBatch).toMatchObject({
      approvedDecisionIds: [],
      priorLoopCount: 1,
      priorToolCallCount: 2,
      requestedToolCalls: [
        {
          toolCallId: "tool_call_resume_001",
          toolName: "read",
          arguments: { path: "README.md" }
        }
      ]
    });
    expect(result.runtimeRequest.turnContext?.selfAwareness).toMatchObject({
      replyPath: "continuation"
    });
  });

  it("surfaces session/workspace/user durable memory as separate scope-aware injections", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            continuity: {
              retrievalPolicy: {
                strategy: "active_task_preferred",
                activeTaskSelection: {
                  mode: "request_task",
                  taskId: "task_001"
                },
                includeWorkingSet: true,
                includeRecentHistory: true,
                includeActiveTask: true,
                includeTypedMemory: true,
                includeEvidence: false,
                preferredScopes: ["session", "workspace", "user"] as never
              } as never,
              recentHistory: {
                summary: "recent history survives ahead of durable memory",
                refs: ["turn_prev"],
                turnRefs: ["turn_prev"]
              },
              workingSet: {
                ref: "working_set:session_001:9",
                version: 9,
                summary: "Keep the current task continuity ahead of durable memory.",
                objective: "Freeze scope boundaries for durable memory.",
                recentProgress: ["Slice 2 already promoted the continuity core."],
                recentDecisions: ["Slice 3 must separate session/workspace/user retrieval."],
                blockers: [],
                openLoops: ["wire scope-aware injection titles"],
                activeMemoryRefs: [],
                activeTaskRefs: ["task_001"],
                recentEventRefs: ["turn_prev"],
                sourceRefs: ["turn_prev"]
              },
              activeTask: {
                taskId: "task_001",
                title: "Freeze durable memory scopes",
                status: "active",
                checkpointRef: "checkpoint:task_001",
                currentStep: "thread scope through retrieval and injection",
                nextAction: "render scope-aware durable memory blocks",
                updatedAt: "2026-04-20T01:00:00.000Z",
                selectedBy: "request_task"
              },
              typedMemory: [
                {
                  kind: "typed_upsert",
                  status: "materialized",
                  scope: "session",
                  memoryType: "task_continuity",
                  sourceRefs: ["typed_memory:session:lane3"],
                  payload: {
                    summary: "Current task note: finish the scope freeze tests first."
                  }
                } as never,
                {
                  kind: "typed_upsert",
                  status: "materialized",
                  scope: "workspace",
                  memoryType: "procedural",
                  sourceRefs: ["typed_memory:workspace:convention"],
                  payload: {
                    summary: "Workspace rule: run memory package tests before app package tests."
                  }
                } as never,
                {
                  kind: "typed_upsert",
                  status: "materialized",
                  scope: "user",
                  memoryType: "preference",
                  sourceRefs: ["typed_memory:user:style"],
                  payload: {
                    summary: "User preference: keep implementation reports concise."
                  }
                } as never
              ],
              evidence: [],
              projectionDerivedRefs: []
            }
          });
        }
      },
      taskStore: {
        async loadById() {
          return {
            taskId: "task_001",
            workspaceId: "workspace_local",
            sessionId: "session_001",
            title: "Freeze durable memory scopes",
            description: "Separate session/workspace/user memory selection and injection.",
            kind: "act" as const,
            status: "active" as const,
            lastTurnId: "turn_prev",
            checkpointRef: "checkpoint:task_001",
            currentStep: "thread scope through retrieval and injection",
            nextAction: "render scope-aware durable memory blocks",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T01:00:00.000Z"
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
        turnId: "turn_scope_injection",
        resumeFrom: undefined,
        input: "Keep the scope boundaries frozen while continuing the task."
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
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      }
    });

    const injectedMemoryBlocks = result.runtimeRequest.contextBlocks.filter((block) =>
      block.blockId.startsWith("memory:turn_scope_injection:")
    );

    expect(injectedMemoryBlocks.map((block) => block.title)).toEqual([
      "active task",
      "session working set",
      "recent history",
      "session durable memory",
      "workspace durable memory",
      "user durable memory"
    ]);
    expect(injectedMemoryBlocks[3]?.content).toContain("Current task note: finish the scope freeze tests first.");
    expect(injectedMemoryBlocks[4]?.content).toContain("Workspace rule: run memory package tests before app package tests.");
    expect(injectedMemoryBlocks[5]?.content).toContain("User preference: keep implementation reports concise.");
    expect(result.runtimeRequest.turnContext?.memory.continuity?.typedMemory.map((item) => (item as { scope?: string }).scope)).toEqual([
      "session",
      "workspace",
      "user"
    ]);
    expect(result.selection).toMatchObject({
      typedMemoryScopes: ["session", "workspace", "user"]
    });

    const authoritativeTruthIndex = result.runtimeRequest.contextBlocks.findIndex((block) => block.title === "authoritative current-turn truth");
    const sessionDurableMemoryIndex = result.runtimeRequest.contextBlocks.findIndex((block) => block.title === "session durable memory");
    expect(authoritativeTruthIndex).toBeGreaterThanOrEqual(0);
    expect(sessionDurableMemoryIndex).toBeGreaterThan(authoritativeTruthIndex);
  });

  it("treats high-memory as a larger ceiling without force-filling low-salience memory", async () => {
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        async retrieve() {
          return createMemoryContext({
            continuity: {
              retrievalPolicy: {
                strategy: "ordinary",
                activeTaskSelection: { mode: "none" },
                includeWorkingSet: true,
                includeRecentHistory: false,
                includeActiveTask: false,
                includeTypedMemory: true,
                includeEvidence: false
              },
              recentHistory: { summary: "", refs: [], turnRefs: [] },
              workingSet: {
                summary: "Only the compact working set is relevant.",
                recentProgress: [],
                recentDecisions: [],
                blockers: [],
                openLoops: [],
                activeMemoryRefs: [],
                activeTaskRefs: [],
                recentEventRefs: [],
                sourceRefs: ["working_set:low_salience"]
              },
              typedMemory: [],
              evidence: [],
              projectionDerivedRefs: []
            },
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
      request: createTurnRequest({ turnId: "turn_high_memory_ceiling_only", taskId: undefined, resumeFrom: undefined }),
      session: { sessionId: "session_001", workspaceId: "workspace_local" },
      budget: {
        resolvedMode: "chat",
        model: { providerId: "test", modelId: "large", modelTier: "strong" },
        limits: {
          inputTokenBudget: 128000,
          outputTokenBudget: 64000,
          memoryInjectionBudget: 32000,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        },
        budgetDebug: {
          mode: "chat",
          budgetProfile: "high-memory",
          budgetProfileSource: "profile_default",
          inputBudgetSource: "profile_default",
          memoryBudgetSource: "profile_default",
          maxContextTokensSource: "provider_capability",
          effectiveInputTokenBudget: 128000,
          effectiveMemoryInjectionBudget: 32000,
          maxMemoryShareOfInput: 0.4,
          capHits: [],
          capReasons: [],
          unestimatedComponents: [],
          overridesApplied: []
        }
      }
    });

    expect(result.budget.memoryTokensUsed).toBeLessThan(32000);
    expect(result.runtimeRequest.contextBlocks.filter((block) => block.blockId.includes(":typed_memory:"))).toEqual([]);
    expect(result.observability?.contextBudget?.budgetResolution.budgetProfile).toBe("high-memory");
  });

  it("passes the effective memory budget through maxInjectTokens", async () => {
    const memoryStore = {
      retrieve: vi.fn(async () => createMemoryContext({ continuity: undefined, contextBlocks: [] }))
    };
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore,
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

    await assembler.assemble({
      request: createTurnRequest({ turnId: "turn_effective_memory_budget", taskId: undefined, resumeFrom: undefined }),
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local"
      },
      budget: {
        resolvedMode: "chat",
        model: {
          providerId: "provider_local",
          modelId: "model_strong",
          modelTier: "strong"
        },
        limits: {
          inputTokenBudget: 27_000,
          outputTokenBudget: 900,
          memoryInjectionBudget: 5_000,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        },
        budgetDebug: {
          mode: "chat",
          budgetProfile: "balanced",
          budgetProfileSource: "profile_default",
          inputBudgetSource: "profile_default",
          memoryBudgetSource: "profile_default",
          providerId: "provider_local",
          modelId: "model_strong",
          protocolFamily: "chat_completions",
          maxContextTokens: 200000,
          maxContextTokensSource: "provider_capability",
          usableContext: 20400,
          outputReserveTokens: 900,
          toolSchemaTokenEstimate: 0,
          safetyReserveTokens: 0,
          unestimatedComponents: [],
          effectiveInputTokenBudget: 27000,
          effectiveMemoryInjectionBudget: 5000,
          maxMemoryShareOfInput: 0.4,
          capHits: [],
          capReasons: [],
          overridesApplied: []
        }
      }
    });

    expect(memoryStore.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ maxInjectTokens: 5000 })
    }));
  });

  it("injects disclosure and persona overlays ahead of mode/tool overlays", async () => {
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
        turnId: "turn_telegram_overlay_order",
        taskId: undefined,
        resumeFrom: undefined,
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
      session: { sessionId: "session_owner_dm", workspaceId: "workspace_local" },
      budget: {
        resolvedMode: "chat",
        model: { providerId: "openai", modelId: "gpt5.4", modelTier: "cheap" },
        limits: {
          inputTokenBudget: 4000,
          outputTokenBudget: 800,
          memoryInjectionBudget: 1200,
          toolResultInjectionBudget: 600,
          maxLoopCount: 8,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 12
        }
      }
    });

    const layerKinds = result.promptContract.layers.map((layer) => layer.kind);
    expect(layerKinds).toEqual([
      "system_prompt",
      "disclosure_overlay",
      "persona_overlay",
      "mode_overlay",
      "tool_use_contract_overlay",
      "user_input"
    ]);
    expect(result.promptContract.layers[1]?.content).toContain("owner_targeted");
    expect(result.promptContract.layers[1]?.content).toContain("supergroup:-100123");
    expect(result.promptContract.layers[2]?.content).toContain("professional, concise");
    expect(result.promptContract.layers[2]?.content).toContain("cannot override privacy or tool rules");
  });
});
