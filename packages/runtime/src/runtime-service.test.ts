import { describe, expect, it, vi } from "vitest";
import type { ArtifactPreview, ArtifactRef, ProviderEvent, ProviderInvocation, RuntimeRequest, RuntimeToolCall, ToolBatchResult } from "@endec/domain";
import type { ArtifactPolicyPort } from "./artifact-policy";
import type { ProviderPort } from "./provider-port";
import type { RuntimeToolExecutionPort } from "./tool-execution-port";
import { createRuntimeService, resolveRuntimeToolLoopLimits } from "./runtime-service";

function createRuntimeRequest(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    resolvedMode: "act",
    correlation: {
      source: "cli",
      actorId: "actor_user",
      traceId: "trace_001"
    },
    userInput: {
      text: "inspect the repository",
      attachments: []
    },
    model: {
      providerId: "provider_local",
      modelId: "model_strong",
      modelTier: "strong"
    },
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
    contextBlocks: [
      {
        blockId: "ctx_user",
        kind: "user_input",
        content: "inspect the repository",
        sourceRefs: ["turn_001"]
      }
    ],
    limits: {
      inputTokenBudget: 10000,
      outputTokenBudget: 1800,
      memoryInjectionBudget: 1000,
      toolResultInjectionBudget: 1400,
      maxLoopCount: 6,
      maxToolCallsPerBatch: 8,

      maxToolCallsPerTurn: 8
    },
    ...overrides
  };
}

function createRuntimeRequestWithToolLoop(overrides: Partial<RuntimeRequest> = {}, toolLoopOverrides: Partial<RuntimeRequest["limits"]["toolLoop"]> = {}): RuntimeRequest {
  const base = createRuntimeRequest(overrides);
  return {
    ...base,
    limits: {
      ...base.limits,
      toolLoop: {
        configuredMaxToolCallsPerBatch: toolLoopOverrides.configuredMaxToolCallsPerBatch ?? base.limits.maxToolCallsPerBatch,
        effectiveMaxToolCallsPerBatch: toolLoopOverrides.effectiveMaxToolCallsPerBatch ?? base.limits.maxToolCallsPerBatch,
        maxToolCallsPerBatchLimitSources: toolLoopOverrides.maxToolCallsPerBatchLimitSources ?? ["mode_default"],
        globalMaxToolCallsPerBatchHardCap: toolLoopOverrides.globalMaxToolCallsPerBatchHardCap ?? 8,
        maxToolBatchRepairAttempts: toolLoopOverrides.maxToolBatchRepairAttempts ?? 2,
        maxToolBatchRepairAttemptsHardCap: toolLoopOverrides.maxToolBatchRepairAttemptsHardCap ?? 3,
        toolSafetyClassification: "unavailable",
        toolSafetyCapApplied: false,
        ...toolLoopOverrides
      }
    }
  };
}

function createArtifactRef(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    artifactId: "artifact_001",
    sessionId: "session_001",
    turnId: "turn_001",
    kind: "runtime_output",
    storageKey: "artifacts/session_001/turn_001/output.txt",
    mimeType: "text/plain",
    byteLength: 4096,
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides
  };
}

function createArtifactPreview(ref: ArtifactRef, overrides: Partial<ArtifactPreview> = {}): ArtifactPreview {
  return {
    artifactId: ref.artifactId,
    ref,
    previewText: "preview of spilled output",
    truncated: true,
    byteLength: ref.byteLength,
    sourceRange: {
      offset: 0,
      length: 120
    },
    ...overrides
  };
}

function createCompletedEvent(overrides: Partial<NonNullable<ProviderEvent["completion"]>> = {}): ProviderEvent {
  return {
    invocationId: "invoke_001",
    sequence: 2,
    timestamp: "2026-04-09T00:00:00.000Z",
    kind: "completed",
    completion: {
      invocationId: "invoke_001",
      finishReason: "stop",
      messages: [{ role: "assistant", content: "done" }],
      toolCalls: [],
      usage: {
        inputTokens: 120,
        outputTokens: 32,
        totalTokens: 152,
        estimatedCost: 0.01
      },
      warnings: [],
      ...overrides
    }
  };
}

function createProvider(events: ProviderEvent[], capture?: (input: ProviderInvocation) => void): ProviderPort {
  return {
    invoke(input: ProviderInvocation) {
      capture?.(input);

      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    }
  };
}

function createArtifacts(port?: Partial<ArtifactPolicyPort>): ArtifactPolicyPort {
  return {
    async spillIfNeeded() {
      return {
        kind: "inline",
        content: "inline result"
      };
    },
    ...port
  };
}

function createToolBatch(overrides: Partial<ToolBatchResult> = {}): ToolBatchResult {
  return {
    schemaVersion: 1,
    contractVersion: "ws0.tool-batch.v1",
    batchId: "batch:turn_001:1",
    turnId: "turn_001",
    requestedToolCalls: [],
    permissionDecisions: [],
    executionResults: [],
    ...overrides
  };
}

function createTools(port?: Partial<RuntimeToolExecutionPort>): RuntimeToolExecutionPort {
  return {
    async handleBatch() {
      return createToolBatch();
    },
    ...port
  };
}

describe("createRuntimeService", () => {
  it("maps a provider completion into a runtime result and provider invocation", async () => {
    const request = createRuntimeRequest();
    const capturedInvocations: ProviderInvocation[] = [];
    const provider = createProvider(
      [
        {
          invocationId: "invoke_001",
          sequence: 1,
          timestamp: "2026-04-09T00:00:00.000Z",
          kind: "status",
          statusText: "streaming"
        },
        createCompletedEvent()
      ],
      (input) => capturedInvocations.push(input)
    );

    const service = createRuntimeService({
      provider,
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(request);

    expect(capturedInvocations).toEqual([
      {
        invocationId: "invoke_001",
        turnId: request.turnId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        mode: request.resolvedMode,
        model: request.model,
        contextBlocks: request.contextBlocks,
        tools: request.toolSchemas,
        outputTokenBudget: request.limits.outputTokenBudget,
        metadata: {
          source: "cli",
          actorId: "actor_user",
          traceId: "trace_001"
        }
      }
    ]);
    expect(result).toEqual({
      turnId: request.turnId,
      messages: [{ role: "assistant", content: "done" }],
      requestedToolCalls: [],
      loopCount: 1,
      toolCallCount: 0,
      toolResultTokensUsed: 0,
      usage: {
        inputTokens: 120,
        outputTokens: 32,
        totalTokens: 152,
        estimatedCost: 0.01
      },
      warnings: [],
      stopReason: "completed",
      permissionDecisions: [],
      toolExecutionResults: [],
      artifacts: []
    });
  });

  it("passes tool calls through to requestedToolCalls and counts them", async () => {
    const provider = createProvider([
      createCompletedEvent({
        toolCalls: [
          {
            toolCallId: "tool_call_001",
            toolName: "read",
            arguments: { path: "README.md" }
          },
          {
            toolCallId: "tool_call_002",
            toolName: "bash",
            arguments: { command: "pwd" }
          }
        ]
      })
    ]);

    const service = createRuntimeService({
      provider,
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(createRuntimeRequest());

    expect(result.requestedToolCalls).toEqual([
      {
        toolCallId: "tool_call_001",
        toolName: "read",
        arguments: { path: "README.md" }
      },
      {
        toolCallId: "tool_call_002",
        toolName: "bash",
        arguments: { command: "pwd" }
      }
    ]);
    expect(result.toolCallCount).toBe(2);
  });

  it("hard-stops before execution when one provider response exceeds maxToolCallsPerBatch", async () => {
    const baseRequest = createRuntimeRequest();
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider = createProvider([
      createCompletedEvent({
        finishReason: "tool_calls",
        messages: [{ role: "assistant", content: "Need a wide fan-out." }],
        toolCalls: [
          {
            toolCallId: "tool_call_001",
            toolName: "glob",
            arguments: { pattern: "package.json" }
          },
          {
            toolCallId: "tool_call_002",
            toolName: "glob",
            arguments: { pattern: "src/**/*.ts" }
          },
          {
            toolCallId: "tool_call_003",
            toolName: "read",
            arguments: { path: "README.md" }
          }
        ]
      })
    ]);

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        ...baseRequest.limits,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 20
      }
    }));

    // With default repair attempts = 2, runtime invokes provider 3 times.
    // Rejected oversized batches execute zero tools and do not consume the executed turn budget.
    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    expect(result.toolCallCount).toBe(0);
    expect(result.requestedToolCalls).toHaveLength(3);
    expect(result.toolExecutionResults).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "tool_batch_limit_repair",
        metadata: expect.objectContaining({ repairAttempt: 1, repairAttemptsUsed: 1 })
      }),
      expect.objectContaining({
        code: "tool_batch_limit_repair",
        metadata: expect.objectContaining({ repairAttempt: 2, repairAttemptsUsed: 2 })
      }),
      expect.objectContaining({
        code: "tool_batch_limit_retry_exhausted",
        metadata: expect.objectContaining({
          reason: "retry_oversized",
          executedToolCalls: 0,
          repairAttemptsUsed: 2,
          toolCallCount: 0
        })
      })
    ]);
  });

  it("hard-stops before executing the next batch when cumulative tool calls exceed maxToolCallsPerTurn", async () => {
    const baseRequest = createRuntimeRequest();
    let invocationCount = 0;
    const provider: ProviderPort = {
      invoke() {
        invocationCount += 1;

        return (async function* () {
          if (invocationCount === 1) {
            yield createCompletedEvent({
              finishReason: "tool_calls",
              messages: [{ role: "assistant", content: "First discovery pass." }],
              toolCalls: [
                {
                  toolCallId: "tool_call_001",
                  toolName: "glob",
                  arguments: { pattern: "package.json" }
                },
                {
                  toolCallId: "tool_call_002",
                  toolName: "glob",
                  arguments: { pattern: "src/**/*.ts" }
                }
              ]
            });
            return;
          }

          yield createCompletedEvent({
            finishReason: "tool_calls",
            messages: [{ role: "assistant", content: "Need one more read before answering." }],
            toolCalls: [
              {
                toolCallId: "tool_call_003",
                toolName: "read",
                arguments: { path: "README.md" }
              }
            ]
          });
        })();
      }
    };
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        permissionDecisions: [],
        executionResults: input.requestedToolCalls.map((toolCall) => ({
          resultId: `${input.batchId}:executed:${toolCall.toolCallId}`,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          state: "executed" as const,
          normalizedPayload: {
            contentType: "text" as const,
            value: `${toolCall.toolName} ok`
          }
        }))
      })
    );

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        ...baseRequest.limits,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 2
      }
    }));

    expect(invocationCount).toBe(2);
    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("tool_turn_limit");
    expect(result.toolCallCount).toBe(3);
    expect(result.requestedToolCalls).toEqual([
      {
        toolCallId: "tool_call_003",
        toolName: "read",
        arguments: { path: "README.md" }
      }
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "tool_turn_limit",
        message: expect.stringContaining("maxToolCallsPerTurn (2)"),
        metadata: expect.objectContaining({
          requestedToolCallsInBatch: 1,
          maxToolCallsPerTurn: 2,
          toolCallCountBeforePausedBatch: 2,
          executedToolCalls: 0,
          recoverable: true,
          summary: "Paused safely before executing the next tool batch.",
          pausedToolCalls: [
            {
              toolCallId: "tool_call_003",
              toolName: "read",
              arguments: { path: "README.md" }
            }
          ]
        })
      })
    ]);
  });

  it("passes usage and warnings through from the provider completion", async () => {
    const provider = createProvider([
      createCompletedEvent({
        usage: {
          inputTokens: 200,
          outputTokens: 55,
          totalTokens: 255,
          estimatedCost: 0.042
        },
        warnings: [
          {
            code: "context_compacted",
            message: "context compacted to fit token budget"
          }
        ]
      })
    ]);

    const service = createRuntimeService({
      provider,
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(createRuntimeRequest());

    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 55,
      totalTokens: 255,
      estimatedCost: 0.042
    });
    expect(result.warnings).toEqual([
      {
        code: "context_compacted",
        message: "context compacted to fit token budget"
      }
    ]);
  });

  it("keeps the final assistant message inline when the artifact policy returns inline", async () => {
    const spillIfNeeded = vi.fn(async () => ({
      kind: "inline" as const,
      content: "rewritten inline result should be ignored"
    }));
    const provider = createProvider([
      createCompletedEvent({
        messages: [{ role: "assistant", content: "short final answer" }]
      })
    ]);

    const service = createRuntimeService({
      provider,
      artifacts: createArtifacts({ spillIfNeeded }),
      createInvocationId: () => "invoke_001"
    });

    const request = createRuntimeRequest();
    const result = await service.run(request);

    expect(spillIfNeeded).toHaveBeenCalledWith({
      turnId: request.turnId,
      sessionId: request.sessionId,
      kind: "runtime_output",
      mimeType: "text/plain",
      content: "short final answer"
    });
    expect(result.messages).toEqual([{ role: "assistant", content: "short final answer" }]);
    expect(result.artifacts).toEqual([]);
  });

  it("spills the final assistant message into an artifact preview when required", async () => {
    const ref = createArtifactRef();
    const preview = createArtifactPreview(ref, {
      previewText: "artifact preview",
      truncated: true
    });
    const provider = createProvider([
      createCompletedEvent({
        messages: [
          { role: "assistant", content: "first answer" },
          { role: "assistant", content: "very large final answer" }
        ]
      })
    ]);

    const service = createRuntimeService({
      provider,
      artifacts: createArtifacts({
        async spillIfNeeded() {
          return {
            kind: "artifact",
            ref,
            preview
          };
        }
      }),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(createRuntimeRequest());

    expect(result.messages).toEqual([
      { role: "assistant", content: "first answer" },
      { role: "assistant", content: "artifact preview", artifactRefs: [ref] }
    ]);
    expect(result.artifacts).toEqual([ref]);
  });

  it("feeds readonly tool results back into the next provider step and accumulates loop metrics", async () => {
    const request = createRuntimeRequest();
    const capturedInvocations: ProviderInvocation[] = [];
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) => {
      expect(input.requestedToolCalls).toEqual([
        {
          toolCallId: "tool_call_read_001",
          toolName: "read",
          arguments: { path: "/tmp/runtime-loop.txt" }
        }
      ]);

      return createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        permissionDecisions: [
          {
            decisionId: "tool_call_read_001",
            behavior: "allow",
            scope: "once",
            reasonCode: "tool_auto_allowed",
            reasonText: "read is auto-allowed by the current tool exposure policy",
            issuedAt: "2026-04-09T00:00:01.000Z",
            requestedBy: input.turnId
          }
        ],
        executionResults: [
          {
            resultId: `${input.batchId}:executed:tool_call_read_001`,
            toolCallId: "tool_call_read_001",
            toolName: "read",
            state: "executed",
            permissionDecision: {
              decisionId: "tool_call_read_001",
              behavior: "allow",
              scope: "once",
              reasonCode: "tool_auto_allowed",
              reasonText: "read is auto-allowed by the current tool exposure policy",
              issuedAt: "2026-04-09T00:00:01.000Z",
              requestedBy: input.turnId
            },
            normalizedPayload: {
              contentType: "text",
              value: "runtime loop file contents"
            },
            metadata: {
              workspaceId: input.workspaceId
            }
          }
        ]
      });
    });
    const provider: ProviderPort = {
      invoke(input) {
        capturedInvocations.push(input);

        return (async function* () {
          if (capturedInvocations.length === 1) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              messages: [{ role: "assistant", content: "Inspecting the file now." }],
              toolCalls: [
                {
                  toolCallId: "tool_call_read_001",
                  toolName: "read",
                  arguments: { path: "/tmp/runtime-loop.txt" }
                }
              ],
              usage: {
                inputTokens: 80,
                outputTokens: 12,
                totalTokens: 92,
                estimatedCost: 0.01
              },
              warnings: [
                {
                  code: "context_compacted",
                  message: "context compacted"
                }
              ]
            });
            return;
          }

          const toolResultBlock = input.contextBlocks.find((block) => block.kind === "tool_result");
          expect(toolResultBlock).toMatchObject({
            kind: "tool_result",
            metadata: expect.objectContaining({
              toolCallId: "tool_call_read_001",
              toolName: "read",
              status: "success"
            })
          });
          expect(toolResultBlock?.content).toContain("runtime loop file contents");

          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "stop",
            messages: [{ role: "assistant", content: "The file says runtime loop file contents." }],
            toolCalls: [],
            usage: {
              inputTokens: 40,
              outputTokens: 18,
              totalTokens: 58,
              estimatedCost: 0.005
            },
            warnings: [
              {
                code: "second_pass",
                message: "continued after tool result"
              }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(request);
    const reinjectedToolResultBlocks = capturedInvocations[1]?.contextBlocks.filter((block) => block.kind === "tool_result") ?? [];
    const reinjectedToolResultTokens = reinjectedToolResultBlocks.reduce((total, block) => total + (block.tokenCount ?? 0), 0);

    expect(capturedInvocations).toHaveLength(2);
    expect(reinjectedToolResultBlocks).toHaveLength(1);
    expect(reinjectedToolResultTokens).toBeGreaterThan(0);
    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      turnId: request.turnId,
      messages: [{ role: "assistant", content: "The file says runtime loop file contents." }],
      requestedToolCalls: [],
      loopCount: 2,
      toolCallCount: 1,
      toolResultTokensUsed: reinjectedToolResultTokens,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        estimatedCost: 0.015
      },
      warnings: [
        {
          code: "context_compacted",
          message: "context compacted"
        },
        {
          code: "second_pass",
          message: "continued after tool result"
        }
      ],
      stopReason: "completed",
      permissionDecisions: [
        expect.objectContaining({
          decisionId: "tool_call_read_001",
          behavior: "allow"
        })
      ],
      toolExecutionResults: [
        expect.objectContaining({
          toolCallId: "tool_call_read_001",
          toolName: "read",
          state: "executed"
        })
      ],
      artifacts: []
    });
  });

  it("does not count tool_result tokens when maxLoopCount stops before reinjection", async () => {
    const request = createRuntimeRequest({
      limits: {
        inputTokenBudget: 10000,
        outputTokenBudget: 1800,
        memoryInjectionBudget: 1000,
        toolResultInjectionBudget: 1400,
        maxLoopCount: 1,
        maxToolCallsPerBatch: 8,

        maxToolCallsPerTurn: 8
      }
    });
    const capturedInvocations: ProviderInvocation[] = [];
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        permissionDecisions: [],
        executionResults: [
          {
            resultId: `${input.batchId}:executed:tool_call_read_001`,
            toolCallId: "tool_call_read_001",
            toolName: "read",
            state: "executed",
            normalizedPayload: {
              contentType: "text",
              value: "runtime loop file contents"
            }
          }
        ]
      })
    );
    const provider = createProvider([
      createCompletedEvent({
        finishReason: "tool_calls",
        messages: [{ role: "assistant", content: "Need one tool first." }],
        toolCalls: [
          {
            toolCallId: "tool_call_read_001",
            toolName: "read",
            arguments: { path: "/tmp/runtime-loop.txt" }
          }
        ]
      })
    ], (input) => capturedInvocations.push(input));

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(request);

    expect(capturedInvocations).toHaveLength(1);
    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("loop_limit");
    expect(result.loopCount).toBe(1);
    expect(result.toolCallCount).toBe(1);
    expect(result.toolResultTokensUsed).toBe(0);
    expect(result.requestedToolCalls).toEqual([]);
    expect(result.toolExecutionResults).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_read_001",
        state: "executed"
      })
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "loop_limit",
        message: expect.stringContaining("maxLoopCount")
      })
    ]);
  });

  it("does not count denied tool_result tokens when execution stops before reinjection", async () => {
    const request = createRuntimeRequest();
    const capturedInvocations: ProviderInvocation[] = [];
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        permissionDecisions: [
          {
            decisionId: "decision_hidden_tool_001",
            behavior: "deny",
            scope: "once",
            reasonCode: "hidden_tool_denied",
            reasonText: "hidden tool call is not recoverable",
            issuedAt: "2026-04-09T00:00:01.000Z",
            requestedBy: input.turnId
          }
        ],
        executionResults: [
          {
            resultId: `${input.batchId}:deny:tool_call_hidden_001`,
            toolCallId: "tool_call_hidden_001",
            toolName: "write",
            state: "deny",
            permissionDecision: {
              decisionId: "decision_hidden_tool_001",
              behavior: "deny",
              scope: "once",
              reasonCode: "hidden_tool_denied",
              reasonText: "hidden tool call is not recoverable",
              issuedAt: "2026-04-09T00:00:01.000Z",
              requestedBy: input.turnId
            }
          }
        ]
      })
    );
    const provider = createProvider([
      createCompletedEvent({
        finishReason: "tool_calls",
        messages: [{ role: "assistant", content: "Trying a hidden tool." }],
        toolCalls: [
          {
            toolCallId: "tool_call_hidden_001",
            toolName: "write",
            arguments: { path: "/tmp/runtime-loop.txt", content: "secret" }
          }
        ]
      })
    ], (input) => capturedInvocations.push(input));

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(request);

    expect(capturedInvocations).toHaveLength(1);
    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("completed");
    expect(result.requestedToolCalls).toEqual([]);
    expect(result.toolResultTokensUsed).toBe(0);
    expect(result.permissionDecisions).toEqual([
      expect.objectContaining({
        decisionId: "decision_hidden_tool_001",
        behavior: "deny"
      })
    ]);
    expect(result.toolExecutionResults).toEqual([
      expect.objectContaining({
        toolCallId: "tool_call_hidden_001",
        toolName: "write",
        state: "deny"
      })
    ]);
  });

  it("releases an approved pending bash batch before the next provider invocation", async () => {
    const request = createRuntimeRequest({
      toolSchemas: [
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
      continuation: {
        approvedToolBatch: {
          requestedToolCalls: [
            {
              toolCallId: "tool_call_bash_001",
              toolName: "bash",
              arguments: { command: "printf runtime-approved" }
            }
          ],
          approvedDecisionIds: ["tool_call_bash_001"],
          approverId: "operator_001",
          priorLoopCount: 0,
          priorToolCallCount: 0
        }
      }
    });
    const capturedInvocations: ProviderInvocation[] = [];
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        permissionDecisions: [
          {
            decisionId: "tool_call_bash_001",
            behavior: "allow",
            scope: "once",
            reasonCode: "tool_approved_once",
            reasonText: "bash was approved for this pending execution",
            issuedAt: "2026-04-13T00:00:00.000Z",
            requestedBy: input.turnId,
            approverId: "operator_001"
          }
        ],
        executionResults: [
          {
            resultId: `${input.batchId}:executed:tool_call_bash_001`,
            toolCallId: "tool_call_bash_001",
            toolName: "bash",
            state: "executed",
            normalizedPayload: {
              contentType: "json",
              value: {
                command: "printf runtime-approved",
                exitCode: 0,
                stdout: "runtime-approved",
                stderr: ""
              }
            }
          }
        ]
      })
    );
    const provider = createProvider([
      createCompletedEvent({
        messages: [{ role: "assistant", content: "approved bash completed" }],
        usage: {
          inputTokens: 64,
          outputTokens: 12,
          totalTokens: 76,
          estimatedCost: 0.006
        }
      })
    ], (input) => capturedInvocations.push(input));

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(request);
    const toolResultBlocks = capturedInvocations[0]?.contextBlocks.filter((block) => block.kind === "tool_result") ?? [];

    expect(handleBatch).toHaveBeenCalledWith(expect.objectContaining({
      requestedToolCalls: [expect.objectContaining({ toolCallId: "tool_call_bash_001", toolName: "bash" })],
      permissionContext: {
        approvedDecisionIds: ["tool_call_bash_001"],
        approverId: "operator_001"
      }
    }));
    expect(toolResultBlocks).toHaveLength(1);
    expect(toolResultBlocks[0]?.content).toContain("runtime-approved");
    expect(result).toMatchObject({
      messages: [{ role: "assistant", content: "approved bash completed" }],
      requestedToolCalls: [],
      permissionDecisions: [expect.objectContaining({ behavior: "allow", reasonCode: "tool_approved_once" })],
      toolExecutionResults: [expect.objectContaining({ toolName: "bash", state: "executed" })]
    });
  });

  it("keeps turn-scoped bash trust active across later provider tool batches in the same turn", async () => {
    const request = createRuntimeRequest({
      toolSchemas: [
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
      continuation: {
        approvedToolBatch: {
          requestedToolCalls: [
            {
              toolCallId: "tool_call_bash_001",
              toolName: "bash",
              arguments: { command: "printf first" }
            }
          ],
          approvedDecisionIds: ["tool_call_bash_001"],
          approverId: "operator_001",
          priorLoopCount: 0,
          priorToolCallCount: 0,
          bashTrust: {
            toolName: "bash",
            scope: "turn",
            decisionId: "tool_call_bash_001",
            approverId: "operator_001"
          }
        }
      }
    });
    const capturedInvocations: ProviderInvocation[] = [];
    const invocations = [
      [
        createCompletedEvent({
          invocationId: "invoke_001",
          messages: [{ role: "assistant", content: "running another bash command" }],
          toolCalls: [
            {
              toolCallId: "tool_call_bash_002",
              toolName: "bash",
              arguments: { command: "printf second" }
            }
          ],
          usage: {
            inputTokens: 40,
            outputTokens: 10,
            totalTokens: 50,
            estimatedCost: 0.004
          }
        })
      ],
      [
        createCompletedEvent({
          invocationId: "invoke_002",
          messages: [{ role: "assistant", content: "both bash commands completed" }],
          toolCalls: [],
          usage: {
            inputTokens: 44,
            outputTokens: 12,
            totalTokens: 56,
            estimatedCost: 0.005
          }
        })
      ]
    ];
    let providerInvocationIndex = 0;
    const provider: ProviderPort = {
      invoke(input) {
        capturedInvocations.push(input);
        const events = invocations[providerInvocationIndex] ?? [];
        providerInvocationIndex += 1;

        return (async function* () {
          for (const event of events) {
            yield event;
          }
        })();
      }
    };
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) => {
      const toolCall = input.requestedToolCalls[0];
      const command = (toolCall?.arguments as { command?: string } | undefined)?.command ?? "";
      const stdout = command === "printf first" ? "first" : "second";
      const scope = toolCall?.toolCallId === "tool_call_bash_001" ? "turn" : "turn";

      return createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        permissionDecisions: [
          {
            decisionId: toolCall?.toolCallId ?? "missing",
            behavior: "allow",
            scope,
            reasonCode: "tool_trusted_for_turn",
            reasonText: "bash is approved for the rest of this turn",
            issuedAt: "2026-04-13T00:00:00.000Z",
            requestedBy: input.turnId,
            approverId: input.permissionContext?.approverId
          }
        ],
        executionResults: [
          {
            resultId: `${input.batchId}:executed:${toolCall?.toolCallId ?? "missing"}`,
            toolCallId: toolCall?.toolCallId ?? "missing",
            toolName: toolCall?.toolName ?? "bash",
            state: "executed",
            normalizedPayload: {
              contentType: "json",
              value: {
                command,
                exitCode: 0,
                stdout,
                stderr: ""
              }
            }
          }
        ]
      });
    });

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(request);

    expect(handleBatch).toHaveBeenCalledTimes(2);
    expect(handleBatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestedToolCalls: [expect.objectContaining({ toolCallId: "tool_call_bash_001" })],
      permissionContext: {
        approvedDecisionIds: ["tool_call_bash_001"],
        approverId: "operator_001",
        bashTrust: {
          toolName: "bash",
          scope: "turn",
          decisionId: "tool_call_bash_001",
          approverId: "operator_001"
        }
      }
    }));
    expect(handleBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestedToolCalls: [expect.objectContaining({ toolCallId: "tool_call_bash_002" })],
      permissionContext: {
        approvedDecisionIds: ["tool_call_bash_001"],
        approverId: "operator_001",
        bashTrust: {
          toolName: "bash",
          scope: "turn",
          decisionId: "tool_call_bash_001",
          approverId: "operator_001"
        }
      }
    }));
    expect(capturedInvocations).toHaveLength(2);
    expect(result).toMatchObject({
      messages: [{ role: "assistant", content: "both bash commands completed" }],
      requestedToolCalls: [],
      permissionDecisions: [
        expect.objectContaining({ decisionId: "tool_call_bash_001", reasonCode: "tool_trusted_for_turn" }),
        expect.objectContaining({ decisionId: "tool_call_bash_002", reasonCode: "tool_trusted_for_turn" })
      ],
      toolExecutionResults: [
        expect.objectContaining({ toolCallId: "tool_call_bash_001", state: "executed" }),
        expect.objectContaining({ toolCallId: "tool_call_bash_002", state: "executed" })
      ]
    });
  });

  it("returns a structured failed runtime result when the provider stream never yields a completed event", async () => {
    const handleBatch = vi.fn(async () => {
      throw new Error("tools must not execute for an incomplete provider stream");
    });
    const provider = createProvider([
      {
        invocationId: "invoke_001",
        sequence: 1,
        timestamp: "2026-04-09T00:00:00.000Z",
        kind: "status",
        statusText: "streaming"
      },
      {
        invocationId: "invoke_001",
        sequence: 2,
        timestamp: "2026-04-09T00:00:00.000Z",
        kind: "message",
        message: {
          role: "assistant",
          content: "partial text that must not be final"
        }
      },
      {
        invocationId: "invoke_001",
        sequence: 3,
        timestamp: "2026-04-09T00:00:00.000Z",
        kind: "tool_call",
        toolCall: {
          toolCallId: "tool_call_partial_001",
          toolName: "read",
          arguments: { path: "README.md" }
        }
      }
    ]);

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(createRuntimeRequest());

    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("provider_stream_incomplete");
    expect(result.messages).toEqual([]);
    expect(result.requestedToolCalls).toEqual([]);
    expect(result.toolExecutionResults).toEqual([]);
    expect(result.loopCount).toBe(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "provider_stream_incomplete",
        message: expect.stringContaining("completed event"),
        metadata: expect.objectContaining({
          invocationId: "invoke_001",
          observedEventCount: 3
        })
      })
    ]);
  });

  it("repairs one oversized tool batch by injecting a constraint and executing only the compliant retry", async () => {
    const baseRequest = createRuntimeRequest();
    const capturedInvocations: ProviderInvocation[] = [];
    let invocationCount = 0;
    const provider: ProviderPort = {
      invoke(input) {
        capturedInvocations.push(input);
        invocationCount += 1;

        return (async function* () {
          if (invocationCount === 1) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              messages: [{ role: "assistant", content: "Need too many tools." }],
              toolCalls: [
                { toolCallId: "tool_call_001", toolName: "glob", arguments: { pattern: "package.json" } },
                { toolCallId: "tool_call_002", toolName: "glob", arguments: { pattern: "src/**/*.ts" } },
                { toolCallId: "tool_call_003", toolName: "read", arguments: { path: "README.md" } }
              ]
            });
            return;
          }

          if (invocationCount === 2) {
            expect(input.contextBlocks).toEqual(expect.arrayContaining([
              expect.objectContaining({
                kind: "runtime_repair",
                content: expect.stringContaining("it requested 3 tool calls"),
                metadata: expect.objectContaining({
                  code: "tool_batch_limit_repair",
                  requestedToolCallsInBatch: 3,
                  maxToolCallsPerBatch: 2,
                  repairAttempt: 1,
                  executedToolCalls: 0
                })
              })
            ]));
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              messages: [{ role: "assistant", content: "Retrying with a smaller batch." }],
              toolCalls: [
                { toolCallId: "tool_call_retry_001", toolName: "read", arguments: { path: "README.md" } }
              ]
            });
            return;
          }

          yield createCompletedEvent({
            invocationId: input.invocationId,
            messages: [{ role: "assistant", content: "done after compliant retry" }],
            toolCalls: []
          });
        })();
      }
    };
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        executionResults: input.requestedToolCalls.map((toolCall) => ({
          resultId: `${input.batchId}:executed:${toolCall.toolCallId}`,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          state: "executed" as const,
          normalizedPayload: { contentType: "text" as const, value: "ok" }
        }))
      })
    );

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        ...baseRequest.limits,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 8,
        maxLoopCount: 4
      }
    }));

    expect(capturedInvocations).toHaveLength(3);
    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(handleBatch).toHaveBeenCalledWith(expect.objectContaining({
      requestedToolCalls: [expect.objectContaining({ toolCallId: "tool_call_retry_001" })]
    }));
    expect(result.stopReason).toBe("completed");
    expect(result.messages).toEqual([{ role: "assistant", content: "done after compliant retry" }]);
    expect(result.toolCallCount).toBe(1);
    expect(result.toolExecutionResults).toEqual([
      expect.objectContaining({ toolCallId: "tool_call_retry_001", state: "executed" })
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "tool_batch_limit_repair" })
    ]);
  });

  it("stops with retry exhausted when the repaired provider response is still oversized and executes zero tools", async () => {
    const baseRequest = createRuntimeRequest();
    let invocationCount = 0;
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            messages: [{ role: "assistant", content: `oversized attempt ${invocationCount}` }],
            toolCalls: [
              { toolCallId: `tool_call_${invocationCount}_001`, toolName: "glob", arguments: { pattern: "a" } },
              { toolCallId: `tool_call_${invocationCount}_002`, toolName: "glob", arguments: { pattern: "b" } },
              { toolCallId: `tool_call_${invocationCount}_003`, toolName: "read", arguments: { path: "README.md" } }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        ...baseRequest.limits,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 20,
        maxLoopCount: 4
      }
    }));
    expect(invocationCount).toBe(3);
    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    expect(result.messages.map((message) => message.content).join("\n")).not.toContain("oversized attempt 3");
    expect(result.toolExecutionResults).toEqual([]);
    expect(result.requestedToolCalls).toHaveLength(3);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "tool_batch_limit_repair" }),
      expect.objectContaining({ code: "tool_batch_limit_repair" }),
      expect.objectContaining({
        code: "tool_batch_limit_retry_exhausted",
        metadata: expect.objectContaining({
          requestedToolCallsInBatch: 3,
          repairAttemptsUsed: 2,
          executedToolCalls: 0,
          reason: "retry_oversized"
        })
      })
    ]);
  });

  it("does not start a tool-batch repair retry when accepted executions leave no safe repair capacity", async () => {
    const baseRequest = createRuntimeRequest();
    let invocationCount = 0;
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        executionResults: input.requestedToolCalls.map((toolCall) => ({
          resultId: `${input.batchId}:executed:${toolCall.toolCallId}`,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          state: "executed" as const,
          normalizedPayload: { contentType: "text" as const, value: "ok" }
        }))
      })
    );
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          if (invocationCount === 1) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              messages: [{ role: "assistant", content: "use the whole turn budget" }],
              toolCalls: [
                { toolCallId: "tool_call_accepted_001", toolName: "glob", arguments: { pattern: "a" } },
                { toolCallId: "tool_call_accepted_002", toolName: "glob", arguments: { pattern: "b" } }
              ]
            });
            return;
          }

          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            messages: [{ role: "assistant", content: "oversized after turn budget is spent" }],
            toolCalls: [
              { toolCallId: "tool_call_001", toolName: "glob", arguments: { pattern: "a" } },
              { toolCallId: "tool_call_002", toolName: "glob", arguments: { pattern: "b" } },
              { toolCallId: "tool_call_003", toolName: "read", arguments: { path: "README.md" } }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        ...baseRequest.limits,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 2,
        maxLoopCount: 4
      }
    }));

    expect(invocationCount).toBe(2);
    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    expect(result.toolCallCount).toBe(2);
    expect(result.toolExecutionResults).toEqual([
      expect.objectContaining({ toolCallId: "tool_call_accepted_001", state: "executed" }),
      expect.objectContaining({ toolCallId: "tool_call_accepted_002", state: "executed" })
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "tool_batch_limit_retry_exhausted",
        metadata: expect.objectContaining({
          reason: "turn_tool_budget_exhausted",
          requestedToolCallsInBatch: 3,
          repairAttemptsUsed: 0,
          executedToolCalls: 0,
          toolCallCount: 2
        })
      })
    ]);
  });

  it("stops immediately when resumed continuation would exceed same-turn tool budget", async () => {
    const baseRequest = createRuntimeRequest();
    const handleBatch = vi.fn(async () => createToolBatch());
    const service = createRuntimeService({
      provider: createProvider([createCompletedEvent({ messages: [{ role: "assistant", content: "must not be invoked" }] })]),
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        ...baseRequest.limits,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 2
      },
      continuation: {
        approvedToolBatch: {
          approvedDecisionIds: [],
          priorLoopCount: 1,
          priorToolCallCount: 2,
          requestedToolCalls: [
            { toolCallId: "tool_call_resume_001", toolName: "read", arguments: { path: "README.md" } }
          ]
        }
      }
    }));

    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_turn_limit");
    expect(result.loopCount).toBe(1);
    expect(result.toolCallCount).toBe(3);
    expect(result.requestedToolCalls).toEqual([
      { toolCallId: "tool_call_resume_001", toolName: "read", arguments: { path: "README.md" } }
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "tool_turn_limit",
        metadata: expect.objectContaining({
          maxToolCallsPerTurn: 2,
          toolCallCount: 3,
          toolCallCountBeforePausedBatch: 2,
          requestedToolCallsInBatch: 1,
          executedToolCalls: 0,
          recoverable: true,
          pausedToolCalls: [
            { toolCallId: "tool_call_resume_001", toolName: "read", arguments: { path: "README.md" } }
          ]
        })
      })
    ]);
  });

  it("stops approved continuation oversized batch with retry exhausted and zero execution", async () => {
    const baseRequest = createRuntimeRequest();
    const handleBatch = vi.fn(async () => createToolBatch());
    const service = createRuntimeService({
      provider: createProvider([createCompletedEvent({ messages: [{ role: "assistant", content: "must not be invoked" }] })]),
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_001"
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        ...baseRequest.limits,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 8
      },
      continuation: {
        approvedToolBatch: {
          approvedDecisionIds: ["decision_001"],
          approverId: "operator_001",
          priorLoopCount: 0,
          priorToolCallCount: 0,
          requestedToolCalls: [
            { toolCallId: "tool_call_cont_001", toolName: "read", arguments: { path: "a" } },
            { toolCallId: "tool_call_cont_002", toolName: "read", arguments: { path: "b" } },
            { toolCallId: "tool_call_cont_003", toolName: "read", arguments: { path: "c" } }
          ]
        }
      }
    }));

    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    expect(result.requestedToolCalls).toHaveLength(3);
    expect(result.toolExecutionResults).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "tool_batch_limit_retry_exhausted",
        metadata: expect.objectContaining({
          reason: "continuation_batch_oversized",
          executedToolCalls: 0,
          toolCallCount: 0
        })
      })
    ]);
  });

  it("stops immediately when provider emits partial events then a failed incomplete completion", async () => {
    const handleBatch = vi.fn(async () => {
      throw new Error("tools must not execute for a synthetic failed provider completion");
    });
    const provider = createProvider([
      {
        invocationId: "invoke_synthetic_failed",
        sequence: 1,
        timestamp: "2026-04-09T00:00:00.000Z",
        kind: "message",
        message: { role: "assistant", content: "partial output is not final" }
      },
      {
        invocationId: "invoke_synthetic_failed",
        sequence: 2,
        timestamp: "2026-04-09T00:00:00.000Z",
        kind: "tool_call",
        toolCall: {
          toolCallId: "tool_call_partial_synthetic",
          toolName: "read",
          arguments: { path: "README.md" }
        }
      },
      createCompletedEvent({
        invocationId: "invoke_synthetic_failed",
        finishReason: "failed",
        messages: [],
        toolCalls: [],
        warnings: [{
          code: "provider_stream_incomplete",
          message: "Provider stream ended before emitting its required terminal completion event.",
          metadata: { invocationId: "invoke_synthetic_failed", observedEventCount: 2 }
        }]
      })
    ]);

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: () => "invoke_synthetic_failed"
    });

    const result = await service.run(createRuntimeRequest());

    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("provider_stream_incomplete");
    expect(result.messages).toEqual([]);
    expect(result.requestedToolCalls).toEqual([]);
    expect(result.toolExecutionResults).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("partial output is not final");
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "provider_stream_incomplete" })
    ]);
  });
});

describe("configurable repair attempts", () => {
  it("approved chat defaults allow two repairs before terminal oversized retry exhaustion", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            toolCalls: Array.from({ length: 5 }, (_, index) => ({
              toolCallId: `tc_${invocationCount}_${index}`,
              toolName: "read",
              arguments: { path: `file_${index}` }
            }))
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      {
        limits: {
          ...createRuntimeRequest().limits,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 8,
          maxLoopCount: 4
        }
      },
      {
        configuredMaxToolCallsPerBatch: 4,
        effectiveMaxToolCallsPerBatch: 4,
        maxToolBatchRepairAttempts: 2,
        maxToolBatchRepairAttemptsHardCap: 3
      }
    ));

    expect(invocationCount).toBe(3);
    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    expect(result.toolCallCount).toBe(0);
    expect(result.toolExecutionResults).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "tool_batch_limit_repair",
        metadata: expect.objectContaining({
          requestedToolCallsInBatch: 5,
          repairAttempt: 1,
          repairAttemptsUsed: 1,
          executedToolCalls: 0,
          toolCallCount: 0
        })
      }),
      expect.objectContaining({
        code: "tool_batch_limit_repair",
        metadata: expect.objectContaining({
          requestedToolCallsInBatch: 5,
          repairAttempt: 2,
          repairAttemptsUsed: 2,
          executedToolCalls: 0,
          toolCallCount: 0
        })
      }),
      expect.objectContaining({
        code: "tool_batch_limit_retry_exhausted",
        metadata: expect.objectContaining({
          requestedToolCallsInBatch: 5,
          repairAttemptsUsed: 2,
          reason: "retry_oversized",
          executedToolCalls: 0,
          toolCallCount: 0
        })
      })
    ]);
  });

  it("default repair attempts = 2 allows initial + 2 repairs = 3 provider invocations", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            toolCalls: [
              { toolCallId: `tc_${invocationCount}_1`, toolName: "glob", arguments: { pattern: "a" } },
              { toolCallId: `tc_${invocationCount}_2`, toolName: "glob", arguments: { pattern: "b" } },
              { toolCallId: `tc_${invocationCount}_3`, toolName: "read", arguments: { path: "README.md" } }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      { limits: { ...createRuntimeRequest().limits, maxToolCallsPerBatch: 2, maxToolCallsPerTurn: 20, maxLoopCount: 6 } },
      { maxToolBatchRepairAttempts: 2, effectiveMaxToolCallsPerBatch: 2, configuredMaxToolCallsPerBatch: 2 }
    ));

    expect(invocationCount).toBe(3);
    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    expect(result.warnings).toHaveLength(3); // 2 repairs + 1 exhausted
    const exhausted = result.warnings.find((w) => w.code === "tool_batch_limit_retry_exhausted");
    expect(exhausted?.metadata).toMatchObject({ repairAttemptsUsed: 2, reason: "retry_oversized" });
  });

  it("repair succeeds on second repair attempt", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        executionResults: input.requestedToolCalls.map((tc) => ({
          resultId: `${input.batchId}:executed:${tc.toolCallId}`,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          state: "executed" as const,
          normalizedPayload: { contentType: "text" as const, value: "ok" }
        }))
      })
    );
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          if (invocationCount <= 2) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              toolCalls: [
                { toolCallId: `tc_${invocationCount}_1`, toolName: "glob", arguments: { pattern: "a" } },
                { toolCallId: `tc_${invocationCount}_2`, toolName: "glob", arguments: { pattern: "b" } },
                { toolCallId: `tc_${invocationCount}_3`, toolName: "read", arguments: { path: "README.md" } }
              ]
            });
          } else if (invocationCount === 3) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              messages: [{ role: "assistant", content: "repaired" }],
              toolCalls: [
                { toolCallId: "tc_compliant_1", toolName: "read", arguments: { path: "ok" } }
              ]
            });
          } else {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              messages: [{ role: "assistant", content: "done after repair" }],
              toolCalls: []
            });
          }
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      { limits: { ...createRuntimeRequest().limits, maxToolCallsPerBatch: 2, maxToolCallsPerTurn: 20, maxLoopCount: 6 } },
      { maxToolBatchRepairAttempts: 2, effectiveMaxToolCallsPerBatch: 2, configuredMaxToolCallsPerBatch: 2 }
    ));

    expect(invocationCount).toBe(4);
    expect(result.stopReason).toBe("completed");
    expect(handleBatch).toHaveBeenCalledTimes(1);
  });

  it("zero configured repair attempts: first oversized immediately terminal exhausted", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            toolCalls: [
              { toolCallId: "tc_1", toolName: "glob", arguments: { pattern: "a" } },
              { toolCallId: "tc_2", toolName: "glob", arguments: { pattern: "b" } },
              { toolCallId: "tc_3", toolName: "read", arguments: { path: "README.md" } }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      {},
      { maxToolBatchRepairAttempts: 0, effectiveMaxToolCallsPerBatch: 2, configuredMaxToolCallsPerBatch: 2 }
    ));

    expect(invocationCount).toBe(1);
    expect(handleBatch).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    expect(result.toolExecutionResults).toEqual([]);
    const exhausted = result.warnings.find((w) => w.code === "tool_batch_limit_retry_exhausted");
    expect(exhausted?.metadata).toMatchObject({ repairAttemptsUsed: 0, executedToolCalls: 0 });
  });

  it("loop budget constrains repair attempts", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            toolCalls: [
              { toolCallId: `tc_${invocationCount}_1`, toolName: "glob", arguments: { pattern: "a" } },
              { toolCallId: `tc_${invocationCount}_2`, toolName: "glob", arguments: { pattern: "b" } },
              { toolCallId: `tc_${invocationCount}_3`, toolName: "read", arguments: { path: "README.md" } }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      { limits: { ...createRuntimeRequest().limits, maxToolCallsPerBatch: 2, maxToolCallsPerTurn: 8, maxLoopCount: 2 } },
      { maxToolBatchRepairAttempts: 2, effectiveMaxToolCallsPerBatch: 2, configuredMaxToolCallsPerBatch: 2 }
    ));

    expect(invocationCount).toBe(2);
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
  });

  it("global hard cap clamps attempted batch override above 8", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            toolCalls: Array.from({ length: 9 }, (_, i) => ({
              toolCallId: `tc_${invocationCount}_${i}`,
              toolName: "read",
              arguments: { path: `file_${i}` }
            }))
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      { limits: { ...createRuntimeRequest().limits, maxToolCallsPerTurn: 20, maxLoopCount: 6 } },
      {
        configuredMaxToolCallsPerBatch: 99,
        effectiveMaxToolCallsPerBatch: 8,
        globalMaxToolCallsPerBatchHardCap: 8,
        maxToolCallsPerBatchLimitSources: ["config_override", "global_hard_cap"]
      }
    ));

    expect(invocationCount).toBe(3);
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
    const repairWarning = result.warnings.find((w) => w.code === "tool_batch_limit_repair");
    expect(repairWarning?.metadata).toMatchObject({
      effectiveMaxToolCallsPerBatch: 8,
      globalMaxToolCallsPerBatchHardCap: 8,
      requestedToolCallsInBatch: 9,
      maxToolCallsPerBatchLimitSources: expect.arrayContaining(["global_hard_cap"])
    });
  });

  it("configured global batch hard cap lowered to 2 treats 3 calls as oversized", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async () => createToolBatch());
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            toolCalls: [
              { toolCallId: `tc_${invocationCount}_1`, toolName: "glob", arguments: { pattern: "a" } },
              { toolCallId: `tc_${invocationCount}_2`, toolName: "glob", arguments: { pattern: "b" } },
              { toolCallId: `tc_${invocationCount}_3`, toolName: "read", arguments: { path: "README.md" } }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      {},
      {
        configuredMaxToolCallsPerBatch: 3,
        effectiveMaxToolCallsPerBatch: 2,
        globalMaxToolCallsPerBatchHardCap: 2,
        maxToolCallsPerBatchLimitSources: ["config_override", "global_hard_cap"]
      }
    ));

    expect(invocationCount).toBe(3);
    expect(result.stopReason).toBe("tool_batch_limit_retry_exhausted");
  });
});

describe("resolveRuntimeToolLoopLimits", () => {
  it("uses legacy_flat_limit for direct runtime requests without toolLoop", () => {
    const limits = createRuntimeRequest().limits;
    const resolved = resolveRuntimeToolLoopLimits(limits);
    expect(resolved.maxToolCallsPerBatchLimitSources).toEqual(["legacy_flat_limit"]);
  });

  it("preserves mode_default when provided by budget resolution", () => {
    const resolved = resolveRuntimeToolLoopLimits({
      ...createRuntimeRequest().limits,
      maxToolCallsPerBatch: 4,
      toolLoop: {
        configuredMaxToolCallsPerBatch: 4,
        effectiveMaxToolCallsPerBatch: 4,
        maxToolCallsPerBatchLimitSources: ["mode_default"],
        globalMaxToolCallsPerBatchHardCap: 8,
        maxToolBatchRepairAttempts: 2,
        maxToolBatchRepairAttemptsHardCap: 3,
        toolSafetyClassification: "unavailable",
        toolSafetyCapApplied: false
      }
    });
    expect(resolved.maxToolCallsPerBatchLimitSources).toEqual(["mode_default"]);
    expect(resolved.effectiveMaxToolCallsPerBatch).toBe(4);
  });

  it("clamps repair attempts above approved hard cap", () => {
    const resolved = resolveRuntimeToolLoopLimits({
      ...createRuntimeRequest().limits,
      toolLoop: {
        configuredMaxToolCallsPerBatch: 4,
        effectiveMaxToolCallsPerBatch: 4,
        maxToolCallsPerBatchLimitSources: ["mode_default"],
        globalMaxToolCallsPerBatchHardCap: 8,
        maxToolBatchRepairAttempts: 99,
        maxToolBatchRepairAttemptsHardCap: 3,
        toolSafetyClassification: "unavailable",
        toolSafetyCapApplied: false
      }
    });
    expect(resolved.maxToolBatchRepairAttempts).toBe(3);
  });

  it("clamps configured hard cap above approved to approved value", () => {
    const resolved = resolveRuntimeToolLoopLimits({
      ...createRuntimeRequest().limits,
      toolLoop: {
        configuredMaxToolCallsPerBatch: 4,
        effectiveMaxToolCallsPerBatch: 4,
        maxToolCallsPerBatchLimitSources: ["mode_default"],
        globalMaxToolCallsPerBatchHardCap: 99,
        maxToolBatchRepairAttempts: 2,
        maxToolBatchRepairAttemptsHardCap: 99,
        toolSafetyClassification: "unavailable",
        toolSafetyCapApplied: false
      }
    });
    expect(resolved.globalMaxToolCallsPerBatchHardCap).toBe(8);
    expect(resolved.maxToolBatchRepairAttemptsHardCap).toBe(3);
  });

  it("adds global_hard_cap source when nested runtime limits are defensively clamped", () => {
    const resolved = resolveRuntimeToolLoopLimits({
      ...createRuntimeRequest().limits,
      maxToolCallsPerBatch: 4,
      toolLoop: {
        configuredMaxToolCallsPerBatch: 99,
        effectiveMaxToolCallsPerBatch: 99,
        maxToolCallsPerBatchLimitSources: ["runtime_request"],
        globalMaxToolCallsPerBatchHardCap: 99,
        maxToolBatchRepairAttempts: 2,
        maxToolBatchRepairAttemptsHardCap: 3,
        toolSafetyClassification: "unavailable",
        toolSafetyCapApplied: false
      }
    });

    expect(resolved.effectiveMaxToolCallsPerBatch).toBe(8);
    expect(resolved.globalMaxToolCallsPerBatchHardCap).toBe(8);
    expect(resolved.maxToolCallsPerBatchLimitSources).toEqual(["runtime_request", "global_hard_cap"]);
  });

  it("normalizes invalid nested runtime limits to valid effective limits", () => {
    const resolved = resolveRuntimeToolLoopLimits({
      ...createRuntimeRequest().limits,
      toolLoop: {
        configuredMaxToolCallsPerBatch: 0,
        effectiveMaxToolCallsPerBatch: -1,
        maxToolCallsPerBatchLimitSources: ["runtime_request"],
        globalMaxToolCallsPerBatchHardCap: 0,
        maxToolBatchRepairAttempts: 2.9,
        maxToolBatchRepairAttemptsHardCap: -1,
        toolSafetyClassification: "unavailable",
        toolSafetyCapApplied: false
      }
    });

    expect(resolved.configuredMaxToolCallsPerBatch).toBe(1);
    expect(resolved.effectiveMaxToolCallsPerBatch).toBe(1);
    expect(resolved.globalMaxToolCallsPerBatchHardCap).toBe(1);
    expect(resolved.maxToolBatchRepairAttemptsHardCap).toBe(0);
    expect(resolved.maxToolBatchRepairAttempts).toBe(0);
  });

  it("defaults to 2 repair attempts when no toolLoop present", () => {
    const resolved = resolveRuntimeToolLoopLimits(createRuntimeRequest().limits);
    expect(resolved.maxToolBatchRepairAttempts).toBe(2);
  });
});

describe("observability metadata", () => {
  it("repair warning includes full diagnostic metadata", async () => {
    let invocationCount = 0;
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          if (invocationCount === 1) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              toolCalls: [
                { toolCallId: "tc_1", toolName: "glob", arguments: { pattern: "a" } },
                { toolCallId: "tc_2", toolName: "glob", arguments: { pattern: "b" } },
                { toolCallId: "tc_3", toolName: "read", arguments: { path: "README.md" } }
              ]
            });
          } else {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              messages: [{ role: "assistant", content: "ok" }],
              toolCalls: [{ toolCallId: "tc_ok", toolName: "read", arguments: { path: "ok" } }]
            });
          }
        })();
      }
    };
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        executionResults: input.requestedToolCalls.map((tc) => ({
          resultId: `${input.batchId}:executed:${tc.toolCallId}`,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          state: "executed" as const,
          normalizedPayload: { contentType: "text" as const, value: "ok" }
        }))
      })
    );

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      { limits: { ...createRuntimeRequest().limits, maxToolCallsPerBatch: 2, maxToolCallsPerTurn: 8, maxLoopCount: 6 } },
      {
        configuredMaxToolCallsPerBatch: 4,
        effectiveMaxToolCallsPerBatch: 2,
        globalMaxToolCallsPerBatchHardCap: 2,
        maxToolCallsPerBatchLimitSources: ["config_override", "global_hard_cap"],
        maxToolBatchRepairAttempts: 2,
        maxToolBatchRepairAttemptsHardCap: 3
      }
    ));

    const repairWarning = result.warnings.find((w) => w.code === "tool_batch_limit_repair");
    expect(repairWarning?.metadata).toMatchObject({
      configuredMaxToolCallsPerBatch: 4,
      effectiveMaxToolCallsPerBatch: 2,
      globalMaxToolCallsPerBatchHardCap: 2,
      requestedToolCallsInBatch: 3,
      maxToolCallsPerTurn: 8,
      maxToolBatchRepairAttempts: 2,
      maxToolBatchRepairAttemptsHardCap: 3,
      repairAttempt: 1,
      repairAttemptsUsed: 1,
      executedToolCalls: 0,
      maxToolCallsPerBatchLimitSources: ["config_override", "global_hard_cap"],
      toolSafetyClassification: "unavailable",
      toolSafetyCapApplied: false
    });
  });

  it("exhausted warning includes repairAttemptsUsed and reason", async () => {
    let invocationCount = 0;
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          yield createCompletedEvent({
            invocationId: input.invocationId,
            finishReason: "tool_calls",
            toolCalls: [
              { toolCallId: "tc_1", toolName: "glob", arguments: { pattern: "a" } },
              { toolCallId: "tc_2", toolName: "glob", arguments: { pattern: "b" } },
              { toolCallId: "tc_3", toolName: "read", arguments: { path: "README.md" } }
            ]
          });
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools(),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequestWithToolLoop(
      {},
      { maxToolBatchRepairAttempts: 1, effectiveMaxToolCallsPerBatch: 2, configuredMaxToolCallsPerBatch: 2 }
    ));

    const exhausted = result.warnings.find((w) => w.code === "tool_batch_limit_retry_exhausted");
    expect(exhausted?.metadata).toMatchObject({
      repairAttemptsUsed: 1,
      reason: "retry_oversized",
      executedToolCalls: 0,
      toolSafetyClassification: "unavailable",
      toolSafetyCapApplied: false
    });
  });
});

describe("turn limit compatibility", () => {
  it("plan default 3-tool batch does not fail due to turn limit", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        executionResults: input.requestedToolCalls.map((tc) => ({
          resultId: `${input.batchId}:executed:${tc.toolCallId}`,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          state: "executed" as const,
          normalizedPayload: { contentType: "text" as const, value: "ok" }
        }))
      })
    );

    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          if (invocationCount === 1) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              toolCalls: [
                { toolCallId: "tc_1", toolName: "read", arguments: { path: "a" } },
                { toolCallId: "tc_2", toolName: "read", arguments: { path: "b" } },
                { toolCallId: "tc_3", toolName: "read", arguments: { path: "c" } }
              ]
            });
          } else {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              messages: [{ role: "assistant", content: "done" }]
            });
          }
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        inputTokenBudget: 10000,
        outputTokenBudget: 1800,
        memoryInjectionBudget: 1000,
        toolResultInjectionBudget: 1400,
        maxLoopCount: 4,
        maxToolCallsPerBatch: 4,
        maxToolCallsPerTurn: 8
      }
    }));

    expect(result.stopReason).toBe("completed");
    expect(handleBatch).toHaveBeenCalledTimes(1);
  });

  it("review default 2-tool batch does not fail due to turn limit", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        executionResults: input.requestedToolCalls.map((tc) => ({
          resultId: `${input.batchId}:executed:${tc.toolCallId}`,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          state: "executed" as const,
          normalizedPayload: { contentType: "text" as const, value: "ok" }
        }))
      })
    );

    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          if (invocationCount === 1) {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              finishReason: "tool_calls",
              toolCalls: [
                { toolCallId: "tc_1", toolName: "read", arguments: { path: "a" } },
                { toolCallId: "tc_2", toolName: "read", arguments: { path: "b" } }
              ]
            });
          } else {
            yield createCompletedEvent({
              invocationId: input.invocationId,
              messages: [{ role: "assistant", content: "done" }]
            });
          }
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        inputTokenBudget: 10000,
        outputTokenBudget: 1800,
        memoryInjectionBudget: 1000,
        toolResultInjectionBudget: 1400,
        maxLoopCount: 2,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 2
      }
    }));

    expect(result.stopReason).toBe("completed");
    expect(handleBatch).toHaveBeenCalledTimes(1);
  });

  it("cumulative non-repair overuse still triggers tool_turn_limit", async () => {
    let invocationCount = 0;
    const handleBatch = vi.fn(async (input: Parameters<RuntimeToolExecutionPort["handleBatch"]>[0]) =>
      createToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        requestedToolCalls: input.requestedToolCalls,
        executionResults: input.requestedToolCalls.map((tc) => ({
          resultId: `${input.batchId}:executed:${tc.toolCallId}`,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          state: "executed" as const,
          normalizedPayload: { contentType: "text" as const, value: "ok" }
        }))
      })
    );
    const provider: ProviderPort = {
      invoke(input) {
        invocationCount += 1;
        return (async function* () {
          if (invocationCount === 1) {
            yield createCompletedEvent({
              finishReason: "tool_calls",
              toolCalls: [
                { toolCallId: "tc_1", toolName: "read", arguments: { path: "a" } },
                { toolCallId: "tc_2", toolName: "read", arguments: { path: "b" } }
              ]
            });
          } else {
            yield createCompletedEvent({
              finishReason: "tool_calls",
              toolCalls: [
                { toolCallId: "tc_3", toolName: "read", arguments: { path: "c" } }
              ]
            });
          }
        })();
      }
    };

    const service = createRuntimeService({
      provider,
      tools: createTools({ handleBatch }),
      artifacts: createArtifacts(),
      createInvocationId: (_input, loopIndex) => `invoke_00${loopIndex}`
    });

    const result = await service.run(createRuntimeRequest({
      limits: {
        inputTokenBudget: 10000,
        outputTokenBudget: 1800,
        memoryInjectionBudget: 1000,
        toolResultInjectionBudget: 1400,
        maxLoopCount: 4,
        maxToolCallsPerBatch: 2,
        maxToolCallsPerTurn: 2
      }
    }));

    expect(result.stopReason).toBe("tool_turn_limit");
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "tool_turn_limit",
        metadata: expect.objectContaining({
          requestedToolCallsInBatch: 1,
          maxToolCallsPerTurn: 2,
          toolCallCountBeforePausedBatch: 2,
          executedToolCalls: 0
        })
      })
    ]);
  });
});
