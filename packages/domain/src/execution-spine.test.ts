import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ApprovalResolutionInputSchema,
  type ApprovalResolutionInput,
  ArtifactPreviewSchema,
  ArtifactReadQuerySchema,
  ArtifactReadResultSchema,
  ArtifactRefSchema,
  ProviderCompletionSchema,
  ProviderEventSchema,
  ProviderInvocationSchema,
  ContextAssemblyResultSchema,
  RuntimeEventSchema,
  RuntimeRequestSchema,
  RuntimeResultSchema,
  SessionBrowseResultSchema,
  SessionEventLookupQuerySchema,
  SessionEventLookupResultSchema,
  SessionEventSearchQuerySchema,
  SessionEventSearchResultSchema,
  SessionHistoryQuerySchema,
  SessionListQuerySchema
} from "./index.ts";

describe("execution spine contracts", () => {
  it("accepts frozen runtime, provider, artifact, and session query contracts", () => {
    const artifactRef = ArtifactRefSchema.parse({
      artifactId: "artifact_001",
      sessionId: "session_001",
      turnId: "turn_001",
      kind: "tool_result",
      storageKey: "artifacts/session_001/turn_001/output.txt",
      mimeType: "text/plain",
      byteLength: 2048,
      createdAt: new Date().toISOString()
    });

    const preview = ArtifactPreviewSchema.parse({
      artifactId: artifactRef.artifactId,
      ref: artifactRef,
      previewText: "first 200 bytes of spilled output",
      truncated: true,
      byteLength: artifactRef.byteLength,
      sourceRange: {
        offset: 0,
        length: 200
      }
    });

    const runtimeRequest = RuntimeRequestSchema.parse({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      resolvedMode: "act",
      correlation: {
        source: "cli",
        actorId: "actor_user"
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
          tokenCount: 12,
          sourceRefs: ["turn_001"]
        },
        {
          blockId: "ctx_memory",
          kind: "memory",
          title: "session working set",
          content: "Focus on the frozen execution seam.",
          tokenCount: 24,
          sourceRefs: ["working_set:session_001:3"]
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
      }
    });

    const runtimeEvent = RuntimeEventSchema.parse({
      eventId: "runtime_event_001",
      turnId: runtimeRequest.turnId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      kind: "tool_call",
      toolCall: {
        toolCallId: "tool_call_001",
        toolName: "read",
        arguments: { path: "README.md" }
      }
    });

    const runtimeResult = RuntimeResultSchema.parse({
      turnId: runtimeRequest.turnId,
      messages: [
        {
          role: "assistant",
          content: "I need to inspect README.md before continuing."
        }
      ],
      requestedToolCalls: [runtimeEvent.toolCall],
      loopCount: 1,
      toolCallCount: 1,
      usage: {
        inputTokens: 120,
        outputTokens: 32,
        totalTokens: 152,
        estimatedCost: 0.01
      },
      warnings: [
        {
          code: "tool_budget_near_limit",
          message: "Tool result budget is nearly exhausted."
        }
      ],
      stopReason: "tool_calls_pending",
      artifacts: [artifactRef]
    });

    const providerCompletion = ProviderCompletionSchema.parse({
      invocationId: "invoke_001",
      finishReason: "tool_calls",
      messages: runtimeResult.messages,
      toolCalls: runtimeResult.requestedToolCalls,
      usage: runtimeResult.usage,
      warnings: runtimeResult.warnings
    });

    const providerEvent = ProviderEventSchema.parse({
      invocationId: "invoke_001",
      sequence: 2,
      timestamp: new Date().toISOString(),
      kind: "completed",
      completion: providerCompletion
    });

    const contextAssembly = ContextAssemblyResultSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.context-assembly.v1",
      assemblyId: "assembly:turn_001",
      turnId: runtimeRequest.turnId,
      sessionId: runtimeRequest.sessionId,
      workspaceId: runtimeRequest.workspaceId,
      resolvedMode: runtimeRequest.resolvedMode,
      runtimeContextBlocks: runtimeRequest.contextBlocks,
      metadata: {
        assemblySource: "app-layer",
        memorySourceRefs: ["working_set:session_001:3"]
      },
      budgeting: {
        inputTokenBudget: runtimeRequest.limits.inputTokenBudget,
        outputTokenBudget: runtimeRequest.limits.outputTokenBudget,
        memoryInjectionBudget: runtimeRequest.limits.memoryInjectionBudget,
        toolResultInjectionBudget: runtimeRequest.limits.toolResultInjectionBudget
      },
      toolExposure: {
        exposureSource: "policy",
        exposedTools: runtimeRequest.toolSchemas,
        hiddenToolNames: []
      },
      promptContract: {
        version: "ws1",
        assemblyOrder: [
          "system_prompt",
          "mode_overlay",
          "tool_use_contract_overlay",
          "user_input"
        ],
        layers: [
          {
            layerId: "prompt:system",
            kind: "system_prompt",
            title: "system prompt",
            content: "You are Endec.",
            placement: "prepend",
            tokenCount: 4,
            optional: false,
            applied: true
          },
          {
            layerId: "prompt:mode",
            kind: "mode_overlay",
            title: "mode overlay",
            content: "Act mode may use exposed tools.",
            placement: "before_user_input",
            tokenCount: 7,
            optional: false,
            applied: true
          },
          {
            layerId: "prompt:tools",
            kind: "tool_use_contract_overlay",
            title: "tool contract",
            content: "Only use tools that appear in the tool schema list.",
            placement: "before_user_input",
            tokenCount: 12,
            optional: false,
            applied: true
          },
          {
            layerId: "prompt:user",
            kind: "user_input",
            title: "user input",
            content: runtimeRequest.userInput.text,
            placement: "append",
            tokenCount: 3,
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
            applied: false
          },
          blocked: {
            kind: "blocked",
            available: true,
            applied: false
          },
          continuation: {
            kind: "continuation",
            available: true,
            applied: false
          }
        }
      },
      runtimeRequest,
      budget: {
        inputTokenBudget: runtimeRequest.limits.inputTokenBudget,
        projectedInputTokens: 48,
        historyBudget: 3000,
        historyTokensUsed: 0,
        historyTruncated: false,
        memoryInjectionBudget: runtimeRequest.limits.memoryInjectionBudget,
        memoryTokensUsed: 24,
        memoryTruncated: false,
        toolResultInjectionBudget: runtimeRequest.limits.toolResultInjectionBudget,
        toolResultTokensUsed: 0
      },
      selection: {
        recentHistoryTurnIds: [],
        memorySourceRefs: ["working_set:session_001:3"],
        evidenceIds: [],
        projectionRefs: [],
        exposedToolNames: ["read"]
      },
      warnings: []
    });

    const providerInvocation = ProviderInvocationSchema.parse({
      invocationId: "invoke_001",
      turnId: contextAssembly.runtimeRequest.turnId,
      sessionId: contextAssembly.runtimeRequest.sessionId,
      workspaceId: contextAssembly.runtimeRequest.workspaceId,
      mode: contextAssembly.runtimeRequest.resolvedMode,
      model: contextAssembly.runtimeRequest.model,
      contextBlocks: contextAssembly.runtimeRequest.contextBlocks,
      tools: contextAssembly.runtimeRequest.toolSchemas,
      outputTokenBudget: contextAssembly.runtimeRequest.limits.outputTokenBudget
    });

    const readQuery = ArtifactReadQuerySchema.parse({
      artifactId: artifactRef.artifactId,
      offset: 0,
      limit: 256
    });

    const readResult = ArtifactReadResultSchema.parse({
      artifact: artifactRef,
      preview,
      content: "full spilled output",
      range: {
        offset: 0,
        limit: 256,
        returned: 19
      },
      eof: true
    });

    const listQuery = SessionListQuerySchema.parse({
      workspaceId: "workspace_local",
      limit: 10
    });

    const historyQuery = SessionHistoryQuerySchema.parse({
      sessionId: "session_001",
      limit: 20
    });

    const browseResult = SessionBrowseResultSchema.parse({
      items: [
        {
          sessionId: "session_001",
          turnId: "turn_001",
          eventId: "event_001",
          eventKind: "assistant_message",
          createdAt: new Date().toISOString(),
          summary: "Assistant requested a file read.",
          artifactRefs: [artifactRef],
          sourceRefs: ["working_set:session_001:3"]
        }
      ]
    });

    const searchQuery = SessionEventSearchQuerySchema.parse({
      workspaceId: "workspace_local",
      sessionId: "session_001",
      queryText: "file read",
      limit: 5
    });

    const searchResult = SessionEventSearchResultSchema.parse({
      hits: [
        {
          sessionId: "session_001",
          turnId: "turn_001",
          eventId: "event_001",
          eventKind: "assistant_message",
          createdAt: new Date().toISOString(),
          summary: "Assistant requested a file read.",
          snippet: "requested a file read",
          artifactRefs: [artifactRef],
          sourceRefs: ["working_set:session_001:3"]
        }
      ]
    });

    const lookupQuery = SessionEventLookupQuerySchema.parse({
      sessionId: "session_001",
      turnId: "turn_001",
      eventId: "event_001"
    });

    const lookupResult = SessionEventLookupResultSchema.parse({
      entry: browseResult.items[0]
    });

    expect(contextAssembly.promptContract.layers[0]?.kind).toBe("system_prompt");
    expect(contextAssembly.runtimeRequest.contextBlocks[0]?.kind).toBe("user_input");
    expect(runtimeResult.artifacts[0]?.artifactId).toBe(artifactRef.artifactId);
    expect(providerEvent.completion?.finishReason).toBe("tool_calls");
    expect(providerInvocation.tools).toHaveLength(1);
    expect(readQuery.limit).toBe(256);
    expect(readResult.preview?.truncated).toBe(true);
    expect(listQuery.limit).toBe(10);
    expect(historyQuery.limit).toBe(20);
    expect(searchQuery.queryText).toBe("file read");
    expect(searchResult.hits[0]?.snippet).toContain("file read");
    expect(lookupResult.entry?.eventId).toBe("event_001");
  });

  it("limits approval resolution scope contract to once|turn", () => {
    expectTypeOf<ApprovalResolutionInput["scope"]>().toEqualTypeOf<"once" | "turn" | undefined>();

    expect(ApprovalResolutionInputSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "approve",
      sessionId: "session_001",
      decisionId: "decision_001",
      scope: "once"
    }).scope).toBe("once");

    expect(ApprovalResolutionInputSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "deny",
      sessionId: "session_001",
      decisionId: "decision_001",
      scope: "turn"
    }).scope).toBe("turn");

    expect(() => ApprovalResolutionInputSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "approve",
      sessionId: "session_001",
      decisionId: "decision_001",
      scope: "session"
    })).toThrow();

    expect(() => ApprovalResolutionInputSchema.parse({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "approve",
      sessionId: "session_001",
      decisionId: "decision_001",
      scope: "workspace"
    })).toThrow();
  });
});
