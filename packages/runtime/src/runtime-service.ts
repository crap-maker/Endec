import type {
  ArtifactRef,
  ContextToolExposure,
  PermissionDecision,
  ProviderCompletion,
  ProviderInvocation,
  RuntimeContextBlock,
  RuntimeLimits,
  RuntimeMessage,
  RuntimeRequest,
  RuntimeResult,
  RuntimeToolLoopLimits,
  RuntimeToolResult,
  RuntimeWarning,
  ToolBatchPermissionContext,
  ToolExecutionResult,
  Usage
} from "@endec/domain";
import type { ArtifactPolicyPort } from "./artifact-policy";
import type { ProviderPort } from "./provider-port";
import type { RuntimeToolExecutionPort } from "./tool-execution-port";

const APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP = 3;
const APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP = 8;

export interface RuntimeService {
  run(input: RuntimeRequest): Promise<RuntimeResult>;
}

export interface RuntimeServiceDependencies {
  provider: ProviderPort;
  tools?: RuntimeToolExecutionPort;
  artifacts: ArtifactPolicyPort;
  createInvocationId?: (input: RuntimeRequest, loopIndex: number) => string;
}

function normalizeInteger(input: number | undefined, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) ? Math.floor(input) : fallback;
}

function normalizePositiveInteger(input: number | undefined, fallback: number): number {
  return Math.max(1, normalizeInteger(input, fallback));
}

function normalizeNonNegativeInteger(input: number | undefined, fallback: number): number {
  return Math.max(0, normalizeInteger(input, fallback));
}

export function resolveRuntimeToolLoopLimits(limits: RuntimeLimits): RuntimeToolLoopLimits {
  const configured = normalizePositiveInteger(
    limits.toolLoop?.configuredMaxToolCallsPerBatch ?? limits.maxToolCallsPerBatch,
    limits.maxToolCallsPerBatch
  );
  const configuredRepairAttempts = normalizeNonNegativeInteger(limits.toolLoop?.maxToolBatchRepairAttempts, 2);

  const configuredRepairHardCap = normalizeNonNegativeInteger(
    limits.toolLoop?.maxToolBatchRepairAttemptsHardCap,
    APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP
  );
  const effectiveRepairHardCap = Math.min(
    configuredRepairHardCap,
    APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP
  );

  const configuredGlobalBatchHardCap = normalizePositiveInteger(
    limits.toolLoop?.globalMaxToolCallsPerBatchHardCap,
    APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP
  );
  const effectiveGlobalBatchHardCap = Math.min(
    configuredGlobalBatchHardCap,
    APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP
  );

  const requestedEffective = normalizePositiveInteger(
    limits.toolLoop?.effectiveMaxToolCallsPerBatch,
    configured
  );
  const effective = Math.min(
    requestedEffective,
    effectiveGlobalBatchHardCap
  );

  const sources = [...(limits.toolLoop?.maxToolCallsPerBatchLimitSources
    ?? ["legacy_flat_limit"])] as RuntimeToolLoopLimits["maxToolCallsPerBatchLimitSources"];

  if (effective < requestedEffective && !sources.includes("global_hard_cap")) {
    sources.push("global_hard_cap");
  }

  return {
    configuredMaxToolCallsPerBatch: configured,
    effectiveMaxToolCallsPerBatch: effective,
    maxToolCallsPerBatchLimitSources: sources,
    globalMaxToolCallsPerBatchHardCap: effectiveGlobalBatchHardCap,
    maxToolBatchRepairAttempts: Math.min(configuredRepairAttempts, effectiveRepairHardCap),
    maxToolBatchRepairAttemptsHardCap: effectiveRepairHardCap,
    toolSafetyClassification: "unavailable",
    toolSafetyCapApplied: false
  };
}

export function createRuntimeService(deps: RuntimeServiceDependencies): RuntimeService {
  const createInvocationId = deps.createInvocationId ?? defaultCreateInvocationId;

  return {
    async run(input: RuntimeRequest): Promise<RuntimeResult> {
      const injectedContextBlocks: RuntimeContextBlock[] = [];
      const aggregatedWarnings: RuntimeWarning[] = [];
      const aggregatedPermissionDecisions: PermissionDecision[] = [];
      const aggregatedToolExecutionResults: ToolExecutionResult[] = [];
      const aggregatedArtifacts: ArtifactRef[] = [];
      let aggregatedUsage = createZeroUsage();
      let latestMessages: RuntimeMessage[] = [];
      let requestedToolCalls: RuntimeResult["requestedToolCalls"] = [];
      let loopCount = 0;
      let toolCallCount = 0;
      let toolResultTokensUsed = 0;
      let pendingToolResultTokensUsed = 0;
      let stopReason: RuntimeResult["stopReason"] = "completed";
      let toolBatchRepairAttempts = 0;
      let shouldContinueProviderLoop = true;

      const toolLoop = resolveRuntimeToolLoopLimits(input.limits);
      const effectiveMaxToolCallsPerBatch = toolLoop.effectiveMaxToolCallsPerBatch;
      const effectiveMaxRepairAttempts = toolLoop.maxToolBatchRepairAttempts;

      const approvedToolBatch = input.continuation?.approvedToolBatch;
      if (approvedToolBatch) {
        loopCount = normalizeNonNegativeInteger(approvedToolBatch.priorLoopCount, 0);
        toolCallCount = normalizeNonNegativeInteger(approvedToolBatch.priorToolCallCount, 0);
      }
      const activePermissionContext = approvedToolBatch
        ? createActivePermissionContext(approvedToolBatch)
        : undefined;
      if (approvedToolBatch && approvedToolBatch.requestedToolCalls.length > 0) {
        requestedToolCalls = approvedToolBatch.requestedToolCalls;

        if (approvedToolBatch.requestedToolCalls.length > effectiveMaxToolCallsPerBatch) {
          stopReason = "tool_batch_limit_retry_exhausted";
          aggregatedWarnings.push(createToolBatchRetryExhaustedWarning({
            requestedToolCallsInBatch: approvedToolBatch.requestedToolCalls.length,
            maxToolCallsPerBatch: effectiveMaxToolCallsPerBatch,
            toolCallCount,
            repairAttemptsUsed: 0,
            reason: "continuation_batch_oversized",
            toolLoop,
            limits: input.limits
          }));
          shouldContinueProviderLoop = false;
        } else {
          toolCallCount += approvedToolBatch.requestedToolCalls.length;
          const toolBudgetLimit = evaluateToolBudgetLimit({
            batchToolCallCount: approvedToolBatch.requestedToolCalls.length,
            toolCallCount,
            limits: input.limits,
            effectiveMaxToolCallsPerBatch,
            pausedToolCalls: approvedToolBatch.requestedToolCalls
          });

          if (toolBudgetLimit) {
            stopReason = toolBudgetLimit.stopReason;
            aggregatedWarnings.push(toolBudgetLimit.warning);
            shouldContinueProviderLoop = false;
          } else if (!deps.tools) {
            stopReason = "tool_calls_pending";
            shouldContinueProviderLoop = false;
          } else {
            const toolBatch = await deps.tools.handleBatch({
              batchId: `batch:${input.turnId}:continuation`,
              turnId: input.turnId,
              sessionId: input.sessionId,
              workspaceId: input.workspaceId,
              requestedToolCalls: approvedToolBatch.requestedToolCalls,
              contextAssembly: {
                toolExposure: createToolExposure(input.toolSchemas)
              },
              permissionContext: activePermissionContext
            });

            aggregatedPermissionDecisions.push(...toolBatch.permissionDecisions);
            aggregatedToolExecutionResults.push(...toolBatch.executionResults);
            aggregatedArtifacts.push(...toolBatch.executionResults.flatMap(toExecutionArtifactRefs));

            const toolResultBlocks = toolBatch.executionResults.map((result, index) =>
              toToolResultBlock(input.turnId, 0, index, result)
            );

            injectedContextBlocks.push(...toolResultBlocks);
            pendingToolResultTokensUsed = toolResultBlocks.reduce((total, block) => total + (block.tokenCount ?? 0), 0);

            if (toolBatch.permissionDecisions.some((decision) => decision.behavior === "ask")) {
              requestedToolCalls = approvedToolBatch.requestedToolCalls;
              stopReason = "permission_required";
              shouldContinueProviderLoop = false;
            } else {
              const allResultsDenied = toolBatch.executionResults.length > 0
                && toolBatch.executionResults.every((result) => result.state === "deny");
              if (allResultsDenied) {
                requestedToolCalls = [];
                stopReason = "completed";
                shouldContinueProviderLoop = false;
              }
            }
          }
        }
      }

      while (shouldContinueProviderLoop) {
        loopCount += 1;
        toolResultTokensUsed += pendingToolResultTokensUsed;
        pendingToolResultTokensUsed = 0;
        const invocation = buildProviderInvocation(
          {
            ...input,
            contextBlocks: [...input.contextBlocks, ...injectedContextBlocks]
          },
          createInvocationId(input, loopCount)
        );
        const completion = await consumeProviderCompletion(deps.provider, invocation);

        latestMessages = completion.messages;
        requestedToolCalls = completion.toolCalls;
        aggregatedUsage = addUsage(aggregatedUsage, completion.usage);
        aggregatedWarnings.push(...completion.warnings);

        if (
          completion.finishReason === "failed"
          && completion.warnings.some((warning) => warning.code === "provider_stream_incomplete")
        ) {
          latestMessages = [];
          requestedToolCalls = [];
          stopReason = "provider_stream_incomplete";
          break;
        }

        if (completion.toolCalls.length === 0) {
          stopReason = "completed";
          break;
        }

        const batchIsOversized = completion.toolCalls.length > effectiveMaxToolCallsPerBatch;
        const remainingTurnToolCapacity = input.limits.maxToolCallsPerTurn - toolCallCount;

        if (batchIsOversized) {
          const requestedToolCallsInBatch = completion.toolCalls.length;
          const canRepair = toolBatchRepairAttempts < effectiveMaxRepairAttempts
            && loopCount < input.limits.maxLoopCount
            && remainingTurnToolCapacity > 0;

          if (canRepair) {
            toolBatchRepairAttempts += 1;
            aggregatedWarnings.push(createToolBatchRepairWarning({
              requestedToolCallsInBatch,
              maxToolCallsPerBatch: effectiveMaxToolCallsPerBatch,
              toolCallCount,
              repairAttempt: toolBatchRepairAttempts,
              toolLoop,
              limits: input.limits
            }));
            injectedContextBlocks.push(createToolBatchRepairBlock({
              turnId: input.turnId,
              loopCount,
              requestedToolCalls: completion.toolCalls,
              maxToolCallsPerBatch: effectiveMaxToolCallsPerBatch,
              repairAttempt: toolBatchRepairAttempts
            }));
            requestedToolCalls = completion.toolCalls;
            continue;
          }

          latestMessages = [];
          requestedToolCalls = completion.toolCalls;
          stopReason = "tool_batch_limit_retry_exhausted";
          aggregatedWarnings.push(createToolBatchRetryExhaustedWarning({
            requestedToolCallsInBatch,
            maxToolCallsPerBatch: effectiveMaxToolCallsPerBatch,
            toolCallCount,
            repairAttemptsUsed: toolBatchRepairAttempts,
            reason: remainingTurnToolCapacity <= 0
              ? "turn_tool_budget_exhausted"
              : toolBatchRepairAttempts >= effectiveMaxRepairAttempts ? "retry_oversized" : "loop_budget_exhausted",
            toolLoop,
            limits: input.limits
          }));
          break;
        }

        toolCallCount += completion.toolCalls.length;
        const turnToolBudgetExceeded = toolCallCount > input.limits.maxToolCallsPerTurn;

        if (turnToolBudgetExceeded) {
          stopReason = "tool_turn_limit";
          aggregatedWarnings.push(createToolTurnLimitWarning({
            batchToolCallCount: completion.toolCalls.length,
            toolCallCount,
            limits: input.limits,
            pausedToolCalls: completion.toolCalls
          }));
          break;
        }

        if (!deps.tools) {
          stopReason = "tool_calls_pending";
          break;
        }

        const toolBatch = await deps.tools.handleBatch({
          batchId: `batch:${input.turnId}:${loopCount}`,
          turnId: input.turnId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          requestedToolCalls: completion.toolCalls,
          contextAssembly: {
            toolExposure: createToolExposure(input.toolSchemas)
          },
          permissionContext: activePermissionContext
        });

        aggregatedPermissionDecisions.push(...toolBatch.permissionDecisions);
        aggregatedToolExecutionResults.push(...toolBatch.executionResults);
        aggregatedArtifacts.push(...toolBatch.executionResults.flatMap(toExecutionArtifactRefs));

        const toolResultBlocks = toolBatch.executionResults.map((result, index) =>
          toToolResultBlock(input.turnId, loopCount, index, result)
        );

        injectedContextBlocks.push(...completion.messages.map((message, index) => toHistoryBlock(message, loopCount, index)));
        injectedContextBlocks.push(...toolResultBlocks);
        pendingToolResultTokensUsed = toolResultBlocks.reduce((total, block) => total + (block.tokenCount ?? 0), 0);

        if (toolBatch.permissionDecisions.some((decision) => decision.behavior === "ask")) {
          stopReason = "permission_required";
          break;
        }

        const allResultsDenied = toolBatch.executionResults.length > 0
          && toolBatch.executionResults.every((result) => result.state === "deny");
        if (allResultsDenied) {
          requestedToolCalls = [];
          stopReason = "completed";
          break;
        }

        requestedToolCalls = [];

        if (loopCount >= input.limits.maxLoopCount) {
          stopReason = "loop_limit";
          aggregatedWarnings.push({
            code: "loop_limit",
            message: `Reached maxLoopCount (${input.limits.maxLoopCount}) before continuing the runtime loop.`
          });
          break;
        }
      }

      const materializedOutput = await materializeFinalAssistantMessage(input, latestMessages, deps.artifacts);

      return {
        turnId: input.turnId,
        messages: materializedOutput.messages,
        requestedToolCalls,
        loopCount,
        toolCallCount,
        toolResultTokensUsed,
        usage: aggregatedUsage,
        warnings: aggregatedWarnings,
        stopReason,
        permissionDecisions: aggregatedPermissionDecisions,
        toolExecutionResults: aggregatedToolExecutionResults,
        artifacts: dedupeArtifacts([...aggregatedArtifacts, ...materializedOutput.artifacts])
      };
    }
  };
}

function createActivePermissionContext(
  input: NonNullable<NonNullable<RuntimeRequest["continuation"]>["approvedToolBatch"]>
): ToolBatchPermissionContext {
  return {
    approvedDecisionIds: input.approvedDecisionIds,
    approverId: input.approverId,
    bashTrust: input.bashTrust
  };
}

function createZeroUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedCost: left.estimatedCost + right.estimatedCost
  };
}

function defaultCreateInvocationId(input: RuntimeRequest, loopIndex: number) {
  return `invoke_${input.turnId}_${loopIndex}`;
}

function createToolTurnLimitWarning(input: {
  batchToolCallCount: number;
  toolCallCount: number;
  limits: RuntimeRequest["limits"];
  pausedToolCalls?: RuntimeResult["requestedToolCalls"];
}): RuntimeWarning {
  const toolCallCountBeforePausedBatch = Math.max(0, input.toolCallCount - input.batchToolCallCount);

  return {
    code: "tool_turn_limit",
    message: `Reached maxToolCallsPerTurn (${input.limits.maxToolCallsPerTurn}) before executing the next tool batch.`,
    metadata: {
      maxToolCallsPerTurn: input.limits.maxToolCallsPerTurn,
      toolCallCount: input.toolCallCount,
      toolCallCountBeforePausedBatch,
      requestedToolCallsInBatch: input.batchToolCallCount,
      executedToolCalls: 0,
      recoverable: true,
      summary: "Paused safely before executing the next tool batch.",
      pausedToolCalls: input.pausedToolCalls ?? []
    }
  };
}

function createToolBatchRepairWarning(input: {
  requestedToolCallsInBatch: number;
  maxToolCallsPerBatch: number;
  toolCallCount: number;
  repairAttempt: number;
  toolLoop: RuntimeToolLoopLimits;
  limits: RuntimeLimits;
}): RuntimeWarning {
  return {
    code: "tool_batch_limit_repair",
    message: `Provider requested ${input.requestedToolCallsInBatch} tool calls in one batch; asking model to retry with at most ${input.maxToolCallsPerBatch}.`,
    metadata: {
      requestedToolCallsInBatch: input.requestedToolCallsInBatch,
      maxToolCallsPerBatch: input.maxToolCallsPerBatch,
      toolCallCount: input.toolCallCount,
      repairAttempt: input.repairAttempt,
      repairAttemptsUsed: input.repairAttempt,
      executedToolCalls: 0,
      configuredMaxToolCallsPerBatch: input.toolLoop.configuredMaxToolCallsPerBatch,
      effectiveMaxToolCallsPerBatch: input.toolLoop.effectiveMaxToolCallsPerBatch,
      globalMaxToolCallsPerBatchHardCap: input.toolLoop.globalMaxToolCallsPerBatchHardCap,
      maxToolCallsPerBatchLimitSources: input.toolLoop.maxToolCallsPerBatchLimitSources,
      maxToolBatchRepairAttempts: input.toolLoop.maxToolBatchRepairAttempts,
      maxToolBatchRepairAttemptsHardCap: input.toolLoop.maxToolBatchRepairAttemptsHardCap,
      maxToolCallsPerTurn: input.limits.maxToolCallsPerTurn,
      toolSafetyClassification: input.toolLoop.toolSafetyClassification,
      toolSafetyCapApplied: input.toolLoop.toolSafetyCapApplied
    }
  };
}

function createToolBatchRetryExhaustedWarning(input: {
  requestedToolCallsInBatch: number;
  maxToolCallsPerBatch: number;
  toolCallCount: number;
  repairAttemptsUsed: number;
  reason: "retry_oversized" | "loop_budget_exhausted" | "turn_tool_budget_exhausted" | "continuation_batch_oversized";
  toolLoop: RuntimeToolLoopLimits;
  limits: RuntimeLimits;
}): RuntimeWarning {
  return {
    code: "tool_batch_limit_retry_exhausted",
    message: `Provider requested too many tool calls; exhausted bounded repair for maxToolCallsPerBatch (${input.maxToolCallsPerBatch}).`,
    metadata: {
      requestedToolCallsInBatch: input.requestedToolCallsInBatch,
      maxToolCallsPerBatch: input.maxToolCallsPerBatch,
      toolCallCount: input.toolCallCount,
      repairAttemptsUsed: input.repairAttemptsUsed,
      executedToolCalls: 0,
      reason: input.reason,
      configuredMaxToolCallsPerBatch: input.toolLoop.configuredMaxToolCallsPerBatch,
      effectiveMaxToolCallsPerBatch: input.toolLoop.effectiveMaxToolCallsPerBatch,
      globalMaxToolCallsPerBatchHardCap: input.toolLoop.globalMaxToolCallsPerBatchHardCap,
      maxToolCallsPerBatchLimitSources: input.toolLoop.maxToolCallsPerBatchLimitSources,
      maxToolBatchRepairAttempts: input.toolLoop.maxToolBatchRepairAttempts,
      maxToolBatchRepairAttemptsHardCap: input.toolLoop.maxToolBatchRepairAttemptsHardCap,
      maxToolCallsPerTurn: input.limits.maxToolCallsPerTurn,
      toolSafetyClassification: input.toolLoop.toolSafetyClassification,
      toolSafetyCapApplied: input.toolLoop.toolSafetyCapApplied
    }
  };
}

function createToolBatchRepairBlock(input: {
  turnId: string;
  loopCount: number;
  requestedToolCalls: RuntimeResult["requestedToolCalls"];
  maxToolCallsPerBatch: number;
  repairAttempt: number;
}): RuntimeContextBlock {
  const requestedCount = input.requestedToolCalls.length;
  const content = [
    `The previous assistant response requested too many tool calls: it requested ${requestedCount} tool calls in one batch.`,
    `This runtime allows at most ${input.maxToolCallsPerBatch} tool calls per provider response.`,
    "No tools from that oversized batch were executed.",
    `Retry with at most ${input.maxToolCallsPerBatch} tool calls in this response.`
  ].join("\n");

  return {
    blockId: `runtime_repair:${input.loopCount}:tool_batch_limit`,
    kind: "runtime_repair",
    title: "Tool-call batch limit repair",
    content,
    tokenCount: estimateTextTokens(content),
    sourceRefs: [input.turnId, ...input.requestedToolCalls.map((toolCall) => toolCall.toolCallId)],
    metadata: {
      code: "tool_batch_limit_repair",
      requestedToolCallsInBatch: requestedCount,
      maxToolCallsPerBatch: input.maxToolCallsPerBatch,
      repairAttempt: input.repairAttempt,
      executedToolCalls: 0
    }
  };
}

function evaluateToolBudgetLimit(input: {
  batchToolCallCount: number;
  toolCallCount: number;
  limits: RuntimeRequest["limits"];
  effectiveMaxToolCallsPerBatch: number;
  pausedToolCalls?: RuntimeResult["requestedToolCalls"];
}): { stopReason: RuntimeResult["stopReason"]; warning: RuntimeWarning } | undefined {
  if (input.batchToolCallCount > input.effectiveMaxToolCallsPerBatch) {
    return {
      stopReason: "tool_batch_limit",
      warning: {
        code: "tool_batch_limit",
        message: `Provider requested ${input.batchToolCallCount} tool calls in one batch, exceeding maxToolCallsPerBatch (${input.effectiveMaxToolCallsPerBatch}).`,
        metadata: {
          requestedToolCallsInBatch: input.batchToolCallCount,
          maxToolCallsPerBatch: input.effectiveMaxToolCallsPerBatch,
          toolCallCount: input.toolCallCount
        }
      }
    };
  }

  if (input.toolCallCount > input.limits.maxToolCallsPerTurn) {
    return {
      stopReason: "tool_turn_limit",
      warning: createToolTurnLimitWarning({
        ...input,
        pausedToolCalls: input.pausedToolCalls ?? []
      })
    };
  }

  return undefined;
}

function createToolExposure(toolSchemas: RuntimeRequest["toolSchemas"]): ContextToolExposure {
  return {
    exposureSource: "policy",
    exposedTools: toolSchemas,
    hiddenToolNames: []
  };
}

function buildProviderInvocation(input: RuntimeRequest, invocationId: string): ProviderInvocation {
  return {
    invocationId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    mode: input.resolvedMode,
    model: input.model,
    contextBlocks: input.contextBlocks,
    tools: input.toolSchemas,
    outputTokenBudget: input.limits.outputTokenBudget,
    metadata: {
      source: input.correlation.source,
      actorId: input.correlation.actorId,
      ...(input.correlation.traceId ? { traceId: input.correlation.traceId } : {})
    }
  };
}

async function consumeProviderCompletion(provider: ProviderPort, invocation: ProviderInvocation): Promise<ProviderCompletion> {
  let completion: ProviderCompletion | undefined;
  let observedEventCount = 0;

  for await (const event of provider.invoke(invocation)) {
    observedEventCount += 1;

    if (event.kind !== "completed") {
      continue;
    }

    if (!event.completion) {
      throw new Error(`Provider completed event missing completion payload for invocation ${invocation.invocationId}`);
    }

    completion = event.completion;
  }

  if (!completion) {
    return {
      invocationId: invocation.invocationId,
      finishReason: "failed",
      messages: [],
      toolCalls: [],
      usage: createZeroUsage(),
      warnings: [
        {
          code: "provider_stream_incomplete",
          message: `Provider stream ended without a completed event for invocation ${invocation.invocationId}.`,
          metadata: {
            invocationId: invocation.invocationId,
            observedEventCount,
            finishReason: "failed",
            stopReason: "provider_stream_incomplete"
          }
        }
      ]
    };
  }

  return completion;
}

function toHistoryBlock(message: RuntimeMessage, loopIndex: number, messageIndex: number): RuntimeContextBlock {
  return {
    blockId: `history:${loopIndex}:${messageIndex}`,
    kind: "history",
    title: `${message.role} message`,
    content: message.content,
    tokenCount: estimateTextTokens(message.content),
    sourceRefs: [],
    metadata: {
      role: message.role,
      ...(message.artifactRefs?.length ? { artifactRefs: message.artifactRefs } : {})
    }
  };
}

function toToolResultBlock(
  turnId: string,
  loopIndex: number,
  resultIndex: number,
  executionResult: ToolExecutionResult
): RuntimeContextBlock {
  const toolResult = toRuntimeToolResult(executionResult);
  const content = renderToolResultContent(toolResult);

  return {
    blockId: `tool_result:${loopIndex}:${resultIndex}:${executionResult.toolCallId}`,
    kind: "tool_result",
    title: executionResult.toolName,
    content,
    tokenCount: estimateTextTokens(content),
    sourceRefs: [
      turnId,
      executionResult.toolCallId,
      ...(executionResult.artifactRef ? [executionResult.artifactRef.artifactId] : [])
    ],
    metadata: {
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      status: toolResult.status,
      ...(toolResult.preview ? { preview: toolResult.preview } : {}),
      ...(toolResult.artifact ? { artifact: toolResult.artifact } : {}),
      ...(toolResult.output !== undefined ? { output: toolResult.output } : {}),
      ...(toolResult.metadata ? { toolResult: toolResult.metadata } : {})
    }
  };
}

function toRuntimeToolResult(executionResult: ToolExecutionResult): RuntimeToolResult {
  if (executionResult.state === "deny") {
    return {
      toolCallId: executionResult.toolCallId,
      toolName: executionResult.toolName,
      status: "denied",
      output: executionResult.permissionDecision?.reasonText,
      metadata: {
        state: executionResult.state,
        resultId: executionResult.resultId,
        ...executionResult.metadata,
        ...(executionResult.permissionDecision ? { permissionDecision: executionResult.permissionDecision } : {})
      }
    };
  }

  if (executionResult.state === "error") {
    return {
      toolCallId: executionResult.toolCallId,
      toolName: executionResult.toolName,
      status: "error",
      output: executionResult.error?.message,
      metadata: {
        state: executionResult.state,
        resultId: executionResult.resultId,
        ...executionResult.metadata,
        ...(executionResult.error ? { error: executionResult.error } : {})
      }
    };
  }

  return {
    toolCallId: executionResult.toolCallId,
    toolName: executionResult.toolName,
    status: "success",
    output: executionResult.normalizedPayload?.value,
    artifact: executionResult.artifactRef,
    preview: executionResult.preview,
    metadata: {
      state: executionResult.state,
      resultId: executionResult.resultId,
      ...executionResult.metadata,
      ...(executionResult.normalizedPayload?.metadata ? { payloadMetadata: executionResult.normalizedPayload.metadata } : {}),
      ...(executionResult.permissionDecision ? { permissionDecision: executionResult.permissionDecision } : {})
    }
  };
}

function renderToolResultContent(result: RuntimeToolResult) {
  const lines = [`Tool: ${result.toolName}`, `Status: ${result.status}`];

  if (result.preview?.previewText) {
    lines.push(`Preview:\n${result.preview.previewText}`);
  } else if (result.output !== undefined) {
    lines.push(`Output:\n${serializeUnknown(result.output)}`);
  } else {
    lines.push("Output:\n(empty)");
  }

  if (result.artifact) {
    lines.push(`Artifact: ${result.artifact.artifactId}`);
  }

  return lines.join("\n");
}

function serializeUnknown(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function estimateTextTokens(text: string) {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

function toExecutionArtifactRefs(result: ToolExecutionResult): ArtifactRef[] {
  return result.artifactRef ? [result.artifactRef] : [];
}

function dedupeArtifacts(artifacts: ArtifactRef[]) {
  const deduped = new Map<string, ArtifactRef>();

  for (const artifact of artifacts) {
    deduped.set(artifact.artifactId, artifact);
  }

  return [...deduped.values()];
}

async function materializeFinalAssistantMessage(
  input: RuntimeRequest,
  messages: RuntimeMessage[],
  artifacts: ArtifactPolicyPort
): Promise<Pick<RuntimeResult, "messages" | "artifacts">> {
  const finalAssistantIndex = findFinalAssistantMessageIndex(messages);

  if (finalAssistantIndex === -1) {
    return {
      messages,
      artifacts: []
    };
  }

  const finalAssistantMessage = messages[finalAssistantIndex];
  if (!finalAssistantMessage) {
    return {
      messages,
      artifacts: []
    };
  }

  const materialization = await artifacts.spillIfNeeded({
    turnId: input.turnId,
    sessionId: input.sessionId,
    kind: "runtime_output",
    mimeType: "text/plain",
    content: finalAssistantMessage.content
  });

  if (materialization.kind === "inline") {
    return {
      messages,
      artifacts: []
    };
  }

  const updatedMessages = messages.map((message, index) => {
    if (index !== finalAssistantIndex) {
      return message;
    }

    return {
      ...message,
      content: materialization.preview.previewText,
      artifactRefs: [...(message.artifactRefs ?? []), materialization.ref]
    };
  });

  return {
    messages: updatedMessages,
    artifacts: [materialization.ref]
  };
}

function findFinalAssistantMessageIndex(messages: RuntimeMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return index;
    }
  }

  return -1;
}
