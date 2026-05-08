import {
  DEFAULT_ERROR_EXPOSURE_MODE,
  RuntimeHardeningWarningCodes,
  renderRuntimeWarningText,
  ExecutionFrameSchema,
  PendingExecutionSchema,
  ToolBatchResultSchema,
  TurnResultSchema,
  projectPendingToolBatch,
  resolvePendingPermissionDecision,
  type AuthoritativeTurnTruth,
  type ContextAssemblyObservability,
  type ContextAssemblyResult,
  type ContextToolExposure,
  type CostLedger,
  type ErrorExposureMode,
  type ExecutionAction,
  type ExecutionControlInput,
  type MemoryWriteRequest,
  type PendingExecution,
  type RuntimeMemoryContext,
  type RuntimeSelfAwarenessSurface,
  type RuntimeWarning,
  type TurnRequest,
  type TurnResult,
  type Usage
} from "@endec/domain";
import type { BudgetPort, ContextAssemblyPort, ExecutionSessionContext, MemoryPort, RuntimePort, SessionStorePort, ToolPort } from "./ports.ts";

const EXECUTION_FRAME_CONTRACT_VERSION = "ws0.execution-frame.v1";
const PENDING_EXECUTION_CONTRACT_VERSION = "ws0.pending-execution.v1";
const EXECUTION_CONTROL_CONTRACT_VERSION = "ws0.execution-control.v1";
const FRIENDLY_TOOL_TURN_LIMIT_WARNING = "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume.";

export function createAgentCore(deps: {
  sessionStore: SessionStorePort;
  contextAssembler?: ContextAssemblyPort;
  memoryPort: MemoryPort;
  toolPort: ToolPort;
  budgetPort: BudgetPort;
  runtimePort: RuntimePort;
  errorExposureMode?: ErrorExposureMode;
}) {
  const errorExposureMode = deps.errorExposureMode ?? DEFAULT_ERROR_EXPOSURE_MODE;
  function createZeroUsage(): Usage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    };
  }

  function createCheckpointRef(turnId: string) {
    return `checkpoint:${turnId}`;
  }

  function createFrameRef(turnId: string) {
    return `frame:${turnId}`;
  }

  function createExecutionControlActorId(action: ExecutionControlInput["action"]) {
    return `system:execution-control:${action}`;
  }

  function resolveContinuationActorId(pendingExecution: PendingExecution) {
    const actorId = pendingExecution.frame.continuation.metadata?.actorId;
    return typeof actorId === "string" && actorId.length > 0
      ? actorId
      : undefined;
  }

  function sanitizeOrdinaryWarningText(text: string) {
    const trimmed = text.trim();

    if (/tool_turn_limit|Reached maxToolCallsPerTurn/i.test(trimmed)) {
      return FRIENDLY_TOOL_TURN_LIMIT_WARNING;
    }

    return trimmed;
  }

  function renderWarnings(warnings: RuntimeWarning[] | undefined, extra: string[] = []) {
    const runtimeWarnings = (warnings ?? []).flatMap((warning) => {
      if (warning.code === RuntimeHardeningWarningCodes.toolBatchLimitRepair) {
        return [];
      }

      return [renderRuntimeWarningText(warning, errorExposureMode)];
    });

    return [...runtimeWarnings, ...extra]
      .map(sanitizeOrdinaryWarningText)
      .filter(Boolean)
      .filter((warning, index, all) => all.indexOf(warning) === index);
  }

  function compactText(value: string, maxLength = 160) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) {
      return "";
    }

    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
  }

  function deriveTopicHints(text: string) {
    const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const topicHints = [...new Set(terms.filter((term) => term.length >= 4))].slice(0, 6);
    return topicHints.length > 0 ? topicHints : undefined;
  }

  function normalizeRuntimeModel(model: Awaited<ReturnType<BudgetPort["resolve"]>>["model"]) {
    return {
      providerId: model.providerId,
      modelId: model.modelId
    };
  }

  function firstAssistantMessageText(messages: unknown[]) {
    for (const message of messages) {
      if (!message || typeof message !== "object") {
        continue;
      }

      const record = message as { role?: unknown; content?: unknown };
      if (record.role === "assistant" && typeof record.content === "string") {
        return record.content;
      }
    }

    return "";
  }

  function buildTurnMemoryWriteContent(input: {
    request: TurnRequest;
    resolvedMode: ContextAssemblyResult["resolvedMode"];
    messages: unknown[];
  }) {
    const assistantResponse = firstAssistantMessageText(input.messages);
    const summary = [
      compactText(input.request.input, 120) ? `user: ${compactText(input.request.input, 120)}` : "",
      assistantResponse ? `assistant: ${compactText(assistantResponse, 120)}` : "",
      input.request.taskId ? `task: ${input.request.taskId}` : "",
      input.request.resumeFrom ? `resume_from: ${input.request.resumeFrom}` : ""
    ].filter((value) => value.length > 0).join("\n");

    return {
      summary,
      userInput: input.request.input,
      assistantResponse,
      requestedMode: input.resolvedMode,
      taskId: input.request.taskId,
      resumeFrom: input.request.resumeFrom
    };
  }

  function shouldInterruptFromRuntime(stopReason: string) {
    return stopReason === "loop_limit"
      || stopReason === "tool_batch_limit"
      || stopReason === "tool_batch_limit_retry_exhausted"
      || stopReason === "tool_turn_limit";
  }

  function shouldFailFromRuntime(stopReason: string) {
    return stopReason === RuntimeHardeningWarningCodes.providerStreamIncomplete;
  }

  function shouldUseLegacyToolBatch(runtimeOutput: Awaited<ReturnType<RuntimePort["run"]>>) {
    return runtimeOutput.stopReason === "tool_calls_pending"
      || (
        runtimeOutput.requestedToolCalls.length > 0
        && runtimeOutput.permissionDecisions.length === 0
        && runtimeOutput.toolExecutionResults.length === 0
      );
  }

  function mergeRuntimeConstraints(
    baseConstraints: RuntimeSelfAwarenessSurface["constraints"],
    pendingConstraint: RuntimeSelfAwarenessSurface["constraints"][number] | undefined
  ) {
    if (!pendingConstraint) {
      return baseConstraints;
    }

    const pendingSignature = JSON.stringify([pendingConstraint.code, pendingConstraint.summary, pendingConstraint.metadata ?? null]);
    const hasPendingConstraint = baseConstraints.some((constraint) =>
      JSON.stringify([constraint.code, constraint.summary, constraint.metadata ?? null]) === pendingSignature
    );

    return hasPendingConstraint ? baseConstraints : [...baseConstraints, pendingConstraint];
  }

  function createBlockedRuntimeSelfAwareness(input: {
    base?: RuntimeSelfAwarenessSurface;
    pendingPermissionDecisions: Awaited<ReturnType<ToolPort["handleBatch"]>>["permissionDecisions"];
    pendingApprovalRef?: string;
  }) {
    if (!input.base) {
      return undefined;
    }

    const pendingDecision = resolvePendingPermissionDecision({
      permissionDecisions: input.pendingPermissionDecisions,
      pendingApprovalRef: input.pendingApprovalRef
    });
    const pendingConstraint = pendingDecision
      ? {
          code: pendingDecision.reasonCode,
          summary: pendingDecision.reasonText,
          blocking: true,
          metadata: {
            decisionId: pendingDecision.decisionId,
            scope: pendingDecision.scope,
            requestedBy: pendingDecision.requestedBy
          }
        }
      : undefined;

    return {
      ...input.base,
      replyPath: "blocked" as const,
      constraints: mergeRuntimeConstraints(input.base.constraints, pendingConstraint)
    };
  }

  function createResumableRuntimeSelfAwareness(input: {
    base?: RuntimeSelfAwarenessSurface;
  }) {
    if (!input.base) {
      return undefined;
    }

    return {
      ...input.base,
      replyPath: "continuation" as const
    };
  }

  function createPendingExecution(input: {
    request: TurnRequest;
    session: { sessionId: string; workspaceId: string };
    phase: "awaiting_permission" | "awaiting_operator";
    step: string;
    loopCount: number;
    toolCallCount: number;
    usage: Usage;
    pendingToolCalls: Parameters<ToolPort["handleBatch"]>[0]["requestedToolCalls"];
    pendingPermissionDecisions: Awaited<ReturnType<ToolPort["handleBatch"]>>["permissionDecisions"];
    allowedActions: ExecutionAction[];
    continuationKind?: "awaiting_operator" | "resume";
    status?: "blocked" | "ready";
    metadata?: Record<string, unknown>;
    sessionStateRef?: string;
    runtimeSelfAwareness?: RuntimeSelfAwarenessSurface;
    authoritativeTruth?: AuthoritativeTurnTruth;
    observability?: ContextAssemblyObservability;
  }): PendingExecution {
    const frameRef = createFrameRef(input.request.turnId);
    const checkpointRef = createCheckpointRef(input.request.turnId);

    const frame = ExecutionFrameSchema.parse({
      schemaVersion: 1,
      contractVersion: EXECUTION_FRAME_CONTRACT_VERSION,
      frameRef,
      checkpointRef,
      turnId: input.request.turnId,
      sessionId: input.session.sessionId,
      workspaceId: input.session.workspaceId,
      phase: input.phase,
      step: input.step,
      pendingToolCalls: input.pendingToolCalls,
      pendingPermissionDecisions: input.pendingPermissionDecisions,
      loopCount: input.loopCount,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
      continuation: {
        continuationKind: input.continuationKind ?? "awaiting_operator",
        allowedActions: input.allowedActions,
        metadata: {
          ...(input.metadata ?? {}),
          actorId: input.request.actorId
        }
      }
    });

    return PendingExecutionSchema.parse({
      schemaVersion: 1,
      contractVersion: PENDING_EXECUTION_CONTRACT_VERSION,
      pendingExecutionId: `pending:${input.request.turnId}`,
      frameRef,
      checkpointRef,
      status: input.status ?? "blocked",
      frame,
      runtimeSelfAwareness: input.runtimeSelfAwareness,
      authoritativeTruth: input.authoritativeTruth,
      observability: input.observability,
      sessionStateRef: input.sessionStateRef
    });
  }

  function createContinuationRequest(input: {
    session: ExecutionSessionContext;
    pendingExecution: PendingExecution;
    control: ExecutionControlInput;
  }): TurnRequest {
    return {
      turnId: input.pendingExecution.frame.turnId,
      sessionId: input.pendingExecution.frame.sessionId,
      workspaceId: input.pendingExecution.frame.workspaceId,
      source: input.session.source,
      actorId: resolveContinuationActorId(input.pendingExecution) ?? createExecutionControlActorId(input.control.action),
      input: input.control.action === "resume" ? (input.control.input ?? "") : "",
      attachments: [],
      requestedMode: input.session.mode,
      resumeFrom: input.pendingExecution.checkpointRef ?? input.pendingExecution.frame.checkpointRef,
      channelContext: {
        executionControl: input.control,
        executionControlActorId: createExecutionControlActorId(input.control.action),
        continuationFrameRef: input.pendingExecution.frameRef,
        pendingExecutionId: input.pendingExecution.pendingExecutionId
      }
    };
  }

  function createBlockedTurnResult(input: {
    request: TurnRequest;
    sessionId: string;
    resolvedMode: ContextAssemblyResult["resolvedMode"];
    messages: unknown[];
    toolEvents: unknown[];
    usage: Usage;
    warnings: string[];
    artifacts?: unknown[];
    approvals?: unknown[];
    blockedBy: string;
    pendingExecution: ReturnType<typeof createPendingExecution>;
    costRecord?: string;
    nextSessionStateRef: string;
  }): TurnResult {
    const { pendingExecution } = input;
    const continuationKind = pendingExecution.frame.continuation.continuationKind === "resume"
      ? "resume"
      : "awaiting_operator";

    return TurnResultSchema.parse({
      turnId: input.request.turnId,
      sessionId: input.sessionId,
      resolvedMode: input.resolvedMode,
      status: "blocked",
      messages: input.messages,
      toolEvents: input.toolEvents,
      taskUpdates: [],
      usage: input.usage,
      warnings: input.warnings,
      checkpointRef: createCheckpointRef(input.request.turnId),
      frameRef: pendingExecution.frameRef,
      continuation: {
        schemaVersion: 1,
        contractVersion: EXECUTION_CONTROL_CONTRACT_VERSION,
        frameRef: pendingExecution.frameRef,
        checkpointRef: pendingExecution.checkpointRef,
        continuationKind,
        allowedActions: pendingExecution.frame.continuation.allowedActions,
        metadata: {
          pendingExecutionId: pendingExecution.pendingExecutionId,
          ...pendingExecution.frame.continuation.metadata
        }
      },
      artifacts: input.artifacts,
      approvals: input.approvals,
      costRecord: input.costRecord,
      blockedBy: input.blockedBy,
      nextSessionStateRef: input.nextSessionStateRef
    });
  }

  async function recordTurnCost(input: {
    request: TurnRequest;
    session: { sessionId: string; workspaceId: string };
    budget: Awaited<ReturnType<BudgetPort["resolve"]>>;
    assembly: ContextAssemblyResult;
    usage: Usage;
    toolResultTokensUsed?: number;
    toolCallCount: number;
    loopCount: number;
    stopReason: string;
    startedAt: string;
  }) {
    return deps.budgetPort.recordCost({
      ledgerId: `ledger:${input.request.turnId}`,
      turnId: input.request.turnId,
      sessionId: input.session.sessionId,
      workspaceId: input.session.workspaceId,
      mode: input.budget.resolvedMode,
      modelId: input.budget.model.modelId,
      providerId: input.budget.model.providerId,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
      totalTokens: input.usage.totalTokens,
      estimatedCost: input.usage.estimatedCost,
      memoryInjectedTokens: input.assembly.budget.memoryTokensUsed,
      toolResultInjectedTokens: input.assembly.budget.toolResultTokensUsed + (input.toolResultTokensUsed ?? 0),
      toolCallCount: input.toolCallCount,
      loopCount: input.loopCount,
      stopReason: input.stopReason,
      startedAt: input.startedAt,
      endedAt: new Date().toISOString()
    } satisfies CostLedger);
  }

  function createLegacyAssembly(input: {
    request: TurnRequest;
    session: { sessionId: string; workspaceId: string };
    budget: Awaited<ReturnType<BudgetPort["resolve"]>>;
    memory: RuntimeMemoryContext;
    toolExposure: ContextToolExposure;
  }): ContextAssemblyResult {
    const contextBlocks = input.memory.contextBlocks?.length
      ? input.memory.contextBlocks
      : input.memory.workingSetSummary
        ? [{
            blockId: `memory:${input.request.turnId}`,
            kind: "memory" as const,
            title: "session working set",
            content: input.memory.workingSetSummary,
            tokenCount: input.memory.tokenEstimate,
            sourceRefs: input.memory.sourceRefs
          }]
        : [];

    const runtimeRequest = {
      turnId: input.request.turnId,
      sessionId: input.session.sessionId,
      workspaceId: input.session.workspaceId,
      resolvedMode: input.budget.resolvedMode,
      correlation: {
        source: input.request.source,
        actorId: input.request.actorId
      },
      userInput: {
        text: input.request.input,
        attachments: input.request.attachments
      },
      model: normalizeRuntimeModel(input.budget.model),
      toolSchemas: input.toolExposure.exposedTools,
      contextBlocks: [
        ...contextBlocks,
        {
          blockId: `user_input:${input.request.turnId}`,
          kind: "user_input" as const,
          title: "user input",
          content: input.request.input,
          sourceRefs: [input.request.turnId]
        }
      ],
      turnContext: {
        memory: input.memory
      },
      limits: input.budget.limits
    };

    return {
      schemaVersion: 1,
      contractVersion: "ws0.context-assembly.v1",
      assemblyId: `assembly:${input.request.turnId}`,
      turnId: input.request.turnId,
      sessionId: input.session.sessionId,
      workspaceId: input.session.workspaceId,
      resolvedMode: input.budget.resolvedMode,
      runtimeContextBlocks: runtimeRequest.contextBlocks,
      metadata: {
        assemblySource: "core-legacy",
        memorySourceRefs: input.memory.sourceRefs
      },
      budgeting: {
        inputTokenBudget: input.budget.limits.inputTokenBudget,
        outputTokenBudget: input.budget.limits.outputTokenBudget,
        memoryInjectionBudget: input.budget.limits.memoryInjectionBudget,
        toolResultInjectionBudget: input.budget.limits.toolResultInjectionBudget
      },
      toolExposure: input.toolExposure,
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
            layerId: "prompt:user_input",
            kind: "user_input",
            title: "user input",
            content: input.request.input,
            placement: "append",
            tokenCount: Math.max(1, Math.ceil(input.request.input.length / 4)),
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
      runtimeRequest,
      budget: {
        inputTokenBudget: input.budget.limits.inputTokenBudget,
        projectedInputTokens: runtimeRequest.contextBlocks.reduce((total, block) => total + (block.tokenCount ?? 0), 0),
        historyBudget: 0,
        historyTokensUsed: 0,
        historyTruncated: false,
        memoryInjectionBudget: input.budget.limits.memoryInjectionBudget,
        memoryTokensUsed: input.memory.tokenEstimate,
        memoryTruncated: false,
        toolResultInjectionBudget: input.budget.limits.toolResultInjectionBudget,
        toolResultTokensUsed: 0
      },
      selection: {
        recentHistoryTurnIds: input.memory.continuity?.recentHistory.turnRefs ?? [],
        memorySourceRefs: input.memory.sourceRefs,
        activeTaskId: input.memory.continuity?.activeTask?.taskId,
        evidenceIds: input.memory.continuity?.evidence.map((item) => item.ref).filter((value): value is string => typeof value === "string") ?? [],
        projectionRefs: input.memory.continuity?.projectionDerivedRefs.map((item) => item.ref) ?? [],
        typedMemoryScopes: [
          ...new Set(
            input.memory.continuity?.typedMemory
              .map((item) => item.scope)
              .filter((value): value is "session" | "workspace" | "user" => typeof value === "string") ?? []
          )
        ],
        exposedToolNames: input.toolExposure.exposedTools.map((tool) => tool.name)
      },
      warnings: []
    };
  }

  async function executeTurnInternal(input: {
    request: TurnRequest;
    session?: { sessionId: string; workspaceId: string };
    continuation?: {
      pendingExecution: PendingExecution;
      control: ExecutionControlInput;
    };
  }): Promise<TurnResult> {
    const { request } = input;
    const startedAt = new Date().toISOString();
    const session = input.session ?? await deps.sessionStore.loadOrCreate(request);
    const budget = await deps.budgetPort.resolve(request);
    const assembly = deps.contextAssembler
      ? await deps.contextAssembler.assemble({
          request,
          session,
          budget,
          continuation: input.continuation
        })
      : deps.memoryPort.retrieve
        ? createLegacyAssembly({
            request,
            session,
            budget,
            memory: await deps.memoryPort.retrieve({
              queryId: `query:${request.turnId}`,
              sessionId: session.sessionId,
              workspaceId: session.workspaceId,
              purpose: "turn_context",
              memoryTypes: ["working_set", "recent_history", "active_task", "typed_memory", "evidence"],
              maxItems: 8,
              maxInjectTokens: budget.limits.memoryInjectionBudget,
              queryText: request.input,
              topicHints: deriveTopicHints(request.input),
              taskId: request.taskId,
              resumeFrom: request.resumeFrom
            }),
            toolExposure: await deps.toolPort.describeExposure?.({
              turnId: request.turnId,
              sessionId: session.sessionId,
              workspaceId: session.workspaceId,
              resolvedMode: budget.resolvedMode
            }) ?? {
              exposureSource: "policy",
              exposedTools: [],
              hiddenToolNames: []
            }
          })
        : (() => {
            throw new Error("AgentCore requires either contextAssembler or memoryPort.retrieve");
          })();

    const budgetDecision = await deps.budgetPort.evaluateBudget?.({
      resolvedMode: budget.resolvedMode,
      projectedTotalTokens: assembly.budget.projectedInputTokens,
      hardLimitTokens: budget.limits.inputTokenBudget * 2
    });

    if (budgetDecision?.kind === "ask_continue") {
      const pendingExecution = createPendingExecution({
        request,
        session,
        phase: "awaiting_operator",
        step: "budget_check",
        loopCount: 0,
        toolCallCount: 0,
        usage: createZeroUsage(),
        pendingToolCalls: [],
        pendingPermissionDecisions: [
          {
            decisionId: `budget:${request.turnId}`,
            behavior: "ask",
            scope: "once",
            reasonCode: "budget_requires_confirmation",
            reasonText: budgetDecision.stopReason,
            issuedAt: startedAt,
            requestedBy: request.turnId
          }
        ],
        allowedActions: ["resume", "cancel"],
        metadata: {
          stopReason: budgetDecision.stopReason
        },
        runtimeSelfAwareness: createBlockedRuntimeSelfAwareness({
          base: assembly.runtimeRequest.turnContext?.selfAwareness,
          pendingPermissionDecisions: [
            {
              decisionId: `budget:${request.turnId}`,
              behavior: "ask",
              scope: "once",
              reasonCode: "budget_requires_confirmation",
              reasonText: budgetDecision.stopReason,
              issuedAt: startedAt,
              requestedBy: request.turnId
            }
          ]
        }),
        authoritativeTruth: assembly.runtimeRequest.turnContext?.authoritativeTruth,
        observability: assembly.runtimeRequest.turnContext?.observability
      });

      await deps.sessionStore.markInflight?.({
        turnId: request.turnId,
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        state: "awaiting_user_decision",
        waitingReason: "user_decision",
        resumePolicy: "resume",
        loopCount: 0,
        toolCallCount: 0,
        pendingApprovalRef: `budget:${request.turnId}`,
        checkpointRef: pendingExecution.checkpointRef ?? createCheckpointRef(request.turnId),
        frameRef: pendingExecution.frameRef,
        contractVersion: pendingExecution.contractVersion,
        pendingExecution
      });

      const costRecord = await recordTurnCost({
        request,
        session,
        budget,
        assembly,
        usage: createZeroUsage(),
        toolCallCount: 0,
        loopCount: 0,
        stopReason: budgetDecision.stopReason,
        startedAt
      });

      const nextSessionStateRef = await deps.sessionStore.finalize({
        turnId: request.turnId,
        sessionId: session.sessionId,
        status: "blocked"
      });

      return createBlockedTurnResult({
        request,
        sessionId: session.sessionId,
        resolvedMode: budget.resolvedMode,
        messages: [],
        toolEvents: [],
        usage: createZeroUsage(),
        warnings: [...assembly.warnings, budgetDecision.stopReason],
        approvals: pendingExecution.frame.pendingPermissionDecisions,
        blockedBy: "user_decision",
        pendingExecution,
        costRecord,
        nextSessionStateRef
      });
    }

    if (budgetDecision?.kind === "hard_stop") {
      const nextSessionStateRef = await deps.sessionStore.finalize({
        turnId: request.turnId,
        sessionId: session.sessionId,
        status: "interrupted"
      });

      return TurnResultSchema.parse({
        turnId: request.turnId,
        sessionId: session.sessionId,
        resolvedMode: budget.resolvedMode,
        status: "interrupted",
        messages: [],
        toolEvents: [],
        taskUpdates: [],
        usage: createZeroUsage(),
        warnings: [...assembly.warnings, budgetDecision.stopReason],
        checkpointRef: createCheckpointRef(request.turnId),
        nextSessionStateRef
      });
    }

    const runtimeOutput = await deps.runtimePort.run(assembly.runtimeRequest);
    const runtimeFailed = shouldFailFromRuntime(runtimeOutput.stopReason);
    const runtimeInterrupted = shouldInterruptFromRuntime(runtimeOutput.stopReason);

    if (runtimeFailed) {
      const costRecord = await recordTurnCost({
        request,
        session,
        budget,
        assembly,
        usage: runtimeOutput.usage,
        toolResultTokensUsed: runtimeOutput.toolResultTokensUsed,
        toolCallCount: runtimeOutput.toolCallCount,
        loopCount: runtimeOutput.loopCount,
        stopReason: runtimeOutput.stopReason,
        startedAt
      });

      const nextSessionStateRef = await deps.sessionStore.finalize({
        turnId: request.turnId,
        sessionId: session.sessionId,
        status: "failed"
      });

      return TurnResultSchema.parse({
        turnId: request.turnId,
        sessionId: session.sessionId,
        resolvedMode: budget.resolvedMode,
        status: "failed",
        messages: [],
        toolEvents: runtimeOutput.toolExecutionResults,
        taskUpdates: [],
        usage: runtimeOutput.usage,
        warnings: [...assembly.warnings, ...renderWarnings(runtimeOutput.warnings)],
        checkpointRef: createCheckpointRef(request.turnId),
        artifacts: runtimeOutput.artifacts,
        costRecord,
        nextSessionStateRef
      });
    }

    if (runtimeInterrupted) {
      const resumableToolTurnLimit = runtimeOutput.stopReason === "tool_turn_limit"
        && runtimeOutput.requestedToolCalls.length > 0
        && runtimeOutput.permissionDecisions.length === 0;

      if (resumableToolTurnLimit) {
        const pendingExecution = createPendingExecution({
          request,
          session,
          phase: "awaiting_operator",
          step: "tool_turn_limit",
          loopCount: runtimeOutput.loopCount,
          toolCallCount: runtimeOutput.toolCallCount,
          usage: runtimeOutput.usage,
          pendingToolCalls: runtimeOutput.requestedToolCalls,
          pendingPermissionDecisions: [],
          allowedActions: ["resume", "cancel"],
          continuationKind: "resume",
          status: "ready",
          metadata: {
            stopReason: "tool_turn_limit",
            ...(runtimeOutput.warnings.find((warning) => warning.code === "tool_turn_limit")?.metadata ?? {})
          },
          runtimeSelfAwareness: createResumableRuntimeSelfAwareness({
            base: assembly.runtimeRequest.turnContext?.selfAwareness
          }),
          authoritativeTruth: assembly.runtimeRequest.turnContext?.authoritativeTruth,
          observability: assembly.runtimeRequest.turnContext?.observability
        });

        await deps.sessionStore.markInflight?.({
          turnId: request.turnId,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          state: "awaiting_user_decision",
          waitingReason: "user_decision",
          resumePolicy: "resume",
          loopCount: runtimeOutput.loopCount,
          toolCallCount: runtimeOutput.toolCallCount,
          checkpointRef: pendingExecution.checkpointRef ?? createCheckpointRef(request.turnId),
          frameRef: pendingExecution.frameRef,
          contractVersion: pendingExecution.contractVersion,
          pendingExecution
        });

        const costRecord = await recordTurnCost({
          request,
          session,
          budget,
          assembly,
          usage: runtimeOutput.usage,
          toolResultTokensUsed: runtimeOutput.toolResultTokensUsed,
          toolCallCount: runtimeOutput.toolCallCount,
          loopCount: runtimeOutput.loopCount,
          stopReason: runtimeOutput.stopReason,
          startedAt
        });

        const nextSessionStateRef = await deps.sessionStore.finalize({
          turnId: request.turnId,
          sessionId: session.sessionId,
          status: "interrupted",
          preserveInflight: true
        });

        return TurnResultSchema.parse({
          turnId: request.turnId,
          sessionId: session.sessionId,
          resolvedMode: budget.resolvedMode,
          status: "interrupted",
          messages: [],
          toolEvents: runtimeOutput.toolExecutionResults,
          taskUpdates: [],
          usage: runtimeOutput.usage,
          warnings: [...assembly.warnings, ...renderWarnings(runtimeOutput.warnings)],
          checkpointRef: createCheckpointRef(request.turnId),
          frameRef: pendingExecution.frameRef,
          continuation: {
            schemaVersion: 1,
            contractVersion: EXECUTION_CONTROL_CONTRACT_VERSION,
            frameRef: pendingExecution.frameRef,
            checkpointRef: pendingExecution.checkpointRef,
            continuationKind: "resume",
            allowedActions: pendingExecution.frame.continuation.allowedActions,
            metadata: {
              pendingExecutionId: pendingExecution.pendingExecutionId,
              ...pendingExecution.frame.continuation.metadata
            }
          },
          artifacts: runtimeOutput.artifacts,
          costRecord,
          nextSessionStateRef
        });
      }

      const costRecord = await recordTurnCost({
        request,
        session,
        budget,
        assembly,
        usage: runtimeOutput.usage,
        toolResultTokensUsed: runtimeOutput.toolResultTokensUsed,
        toolCallCount: runtimeOutput.toolCallCount,
        loopCount: runtimeOutput.loopCount,
        stopReason: runtimeOutput.stopReason,
        startedAt
      });

      const nextSessionStateRef = await deps.sessionStore.finalize({
        turnId: request.turnId,
        sessionId: session.sessionId,
        status: "interrupted"
      });

      return TurnResultSchema.parse({
        turnId: request.turnId,
        sessionId: session.sessionId,
        resolvedMode: budget.resolvedMode,
        status: "interrupted",
        messages: [],
        toolEvents: runtimeOutput.toolExecutionResults,
        taskUpdates: [],
        usage: runtimeOutput.usage,
        warnings: [...assembly.warnings, ...renderWarnings(runtimeOutput.warnings)],
        checkpointRef: createCheckpointRef(request.turnId),
        artifacts: runtimeOutput.artifacts,
        costRecord,
        nextSessionStateRef
      });
    }

    const legacyToolBatch = shouldUseLegacyToolBatch(runtimeOutput)
      ? ToolBatchResultSchema.parse(await deps.toolPort.handleBatch({
          batchId: `batch:${request.turnId}`,
          turnId: request.turnId,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          requestedToolCalls: runtimeOutput.requestedToolCalls,
          contextAssembly: assembly
        }))
      : null;
    const permissionDecisions = legacyToolBatch?.permissionDecisions ?? runtimeOutput.permissionDecisions;
    const toolExecutionResults = legacyToolBatch?.executionResults ?? runtimeOutput.toolExecutionResults;
    const pendingToolBatch = projectPendingToolBatch({
      requestedToolCalls: runtimeOutput.requestedToolCalls,
      permissionDecisions
    });
    const askDecision = pendingToolBatch.pendingDecision;

    if (askDecision) {
      const pendingExecution = createPendingExecution({
        request,
        session,
        phase: "awaiting_permission",
        step: "tool_batch",
        loopCount: runtimeOutput.loopCount,
        toolCallCount: runtimeOutput.toolCallCount,
        usage: runtimeOutput.usage,
        pendingToolCalls: pendingToolBatch.pendingToolCalls,
        pendingPermissionDecisions: pendingToolBatch.pendingPermissionDecisions,
        allowedActions: ["approve", "deny", "cancel"],
        metadata: {
          stopReason: "permission_required"
        },
        runtimeSelfAwareness: createBlockedRuntimeSelfAwareness({
          base: assembly.runtimeRequest.turnContext?.selfAwareness,
          pendingPermissionDecisions: pendingToolBatch.pendingPermissionDecisions,
          pendingApprovalRef: askDecision.decisionId
        }),
        authoritativeTruth: assembly.runtimeRequest.turnContext?.authoritativeTruth,
        observability: assembly.runtimeRequest.turnContext?.observability
      });

      await deps.sessionStore.markInflight?.({
        turnId: request.turnId,
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        state: "awaiting_permission",
        waitingReason: "permission",
        resumePolicy: "resume",
        loopCount: runtimeOutput.loopCount,
        toolCallCount: runtimeOutput.toolCallCount,
        pendingApprovalRef: askDecision.decisionId,
        checkpointRef: pendingExecution.checkpointRef ?? createCheckpointRef(request.turnId),
        frameRef: pendingExecution.frameRef,
        contractVersion: pendingExecution.contractVersion,
        pendingExecution
      });

      const costRecord = await recordTurnCost({
        request,
        session,
        budget,
        assembly,
        usage: runtimeOutput.usage,
        toolResultTokensUsed: runtimeOutput.toolResultTokensUsed,
        toolCallCount: runtimeOutput.toolCallCount,
        loopCount: runtimeOutput.loopCount,
        stopReason: "permission_required",
        startedAt
      });

      const nextSessionStateRef = await deps.sessionStore.finalize({
        turnId: request.turnId,
        sessionId: session.sessionId,
        status: "blocked"
      });

      return createBlockedTurnResult({
        request,
        sessionId: session.sessionId,
        resolvedMode: budget.resolvedMode,
        messages: runtimeOutput.messages,
        toolEvents: toolExecutionResults,
        usage: runtimeOutput.usage,
        warnings: [...assembly.warnings, ...renderWarnings(runtimeOutput.warnings, ["permission required"])],
        artifacts: runtimeOutput.artifacts,
        approvals: permissionDecisions,
        blockedBy: "permission",
        pendingExecution,
        costRecord,
        nextSessionStateRef
      });
    }

    const memoryWrites = await deps.memoryPort.enqueueWrites([
      {
        writeId: `write:${request.turnId}`,
        sourceTurnId: request.turnId,
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        actorId: request.actorId,
        writeKind: "candidate_extract",
        evidenceRefs: [request.turnId],
        taskId: request.taskId,
        scope: "session",
        proposedMemoryType: request.taskId ? "task_continuity" : "turn_summary",
        content: buildTurnMemoryWriteContent({
          request,
          resolvedMode: budget.resolvedMode,
          messages: runtimeOutput.messages
        })
      } satisfies MemoryWriteRequest
    ]);

    const costRecord = await recordTurnCost({
      request,
      session,
      budget,
      assembly,
      usage: runtimeOutput.usage,
      toolResultTokensUsed: runtimeOutput.toolResultTokensUsed,
      toolCallCount: runtimeOutput.toolCallCount,
      loopCount: runtimeOutput.loopCount,
      stopReason: runtimeOutput.stopReason,
      startedAt
    });

    const nextSessionStateRef = await deps.sessionStore.finalize({
      turnId: request.turnId,
      sessionId: session.sessionId,
      status: "completed"
    });

    return TurnResultSchema.parse({
      turnId: request.turnId,
      sessionId: session.sessionId,
      resolvedMode: budget.resolvedMode,
      status: "completed",
      messages: runtimeOutput.messages,
      toolEvents: toolExecutionResults,
      taskUpdates: [],
      usage: runtimeOutput.usage,
      warnings: [...assembly.warnings, ...renderWarnings(runtimeOutput.warnings)],
      checkpointRef: createCheckpointRef(request.turnId),
      memoryWrites,
      artifacts: runtimeOutput.artifacts,
      costRecord,
      nextSessionStateRef
    });
  }

  return {
    async executeTurn(request: TurnRequest): Promise<TurnResult> {
      return executeTurnInternal({ request });
    },

    async continueExecution(input: {
      session: ExecutionSessionContext;
      pendingExecution: PendingExecution;
      control: ExecutionControlInput;
    }): Promise<TurnResult> {
      if (input.control.frameRef && input.control.frameRef !== input.pendingExecution.frameRef) {
        throw new Error(
          `Execution control targeted frame ${input.control.frameRef}, but pending execution is ${input.pendingExecution.frameRef}.`
        );
      }

      if (input.control.turnId && input.control.turnId !== input.pendingExecution.frame.turnId) {
        throw new Error(
          `Execution control targeted turn ${input.control.turnId}, but pending execution belongs to ${input.pendingExecution.frame.turnId}.`
        );
      }

      const allowsRequestedAction = input.pendingExecution.frame.continuation.allowedActions.includes(input.control.action);
      const allowsGenericResume = input.control.action === "resume"
        && input.pendingExecution.status === "blocked"
        && input.pendingExecution.frame.continuation.continuationKind === "awaiting_operator";

      if (!allowsRequestedAction && !allowsGenericResume) {
        throw new Error(
          `Execution action ${input.control.action} is not allowed for frame ${input.pendingExecution.frameRef}.`
        );
      }

      return executeTurnInternal({
        request: createContinuationRequest(input),
        session: {
          sessionId: input.session.sessionId,
          workspaceId: input.session.workspaceId
        },
        continuation: {
          pendingExecution: input.pendingExecution,
          control: input.control
        }
      });
    }
  };
}
