import type {
  ActiveTaskSnapshot,
  AuthoritativeTurnTruth,
  BudgetResolutionDebug,
  ContextAssemblyResult,
  ContextToolExposure,
  CurrentTurnTimeContext,
  DisclosureMode,
  EvidenceRecord,
  EvidenceSurfaceItem,
  ExecutionControlInput,
  PendingExecution,
  ProjectionDerivedRefSurfaceItem,
  RecentHistorySurface,
  ResolvedOwnerPreferences,
  RuntimeConstraintSurface,
  RuntimeContextBlock,
  RuntimeMemoryContext,
  RuntimeRequest,
  RuntimeSelfAwarenessSurface,
  RuntimeToolDefinition,
  TaskState,
  ToolBatchPermissionContext,
  TurnRequest,
  TypedMemorySurfaceItem,
  TurnWarningDetail,
  ToolSchemaAccounting,
  PromptBlockObservability
} from "@endec/domain";
import {
  BudgetResolutionDebugSchema,
  ContextAssemblyResultSchema,
  MEMORY_CONTEXT_TRUNCATED_CODE,
  resolvePendingPermissionDecision
} from "@endec/domain";
import { reclassifyCapabilityTruth } from "@endec/tools";
import {
  createContextAssemblyBudget,
  estimateTextTokens,
  estimateToolSchemaAccounting,
  fitBlocksToBudget,
  truncateTextToTokenBudget
} from "./context-budgeting.ts";
import { inspectSelfAwarenessIntent } from "./self-awareness-policy.ts";
import { createPromptContract } from "./prompt-contract.ts";
import { buildCurrentTimeContextBlock, buildCurrentTurnTimeContext, resolveServerTimezone, selectRecentInteractionAnchor } from "./time-context.ts";
import type { EndecToolExposure } from "./types.ts";

type BudgetResolution = Pick<RuntimeRequest, "resolvedMode" | "model" | "limits"> & {
  budgetDebug?: Partial<BudgetResolutionDebug>;
};

type RecentHistoryEntry = {
  eventId: string;
  turnId: string;
  eventKind: string;
  summary: string;
  text: string;
  createdAt: string;
  sourceRefs: string[];
};

interface ContextAssemblerHistoryStore {
  loadRecentHistory(input: { sessionId: string; limit: number; beforeTurnId?: string }): Promise<RecentHistoryEntry[]>;
}

interface ContextAssemblerOwnerStateStore {
  inspectOwnerBinding?(input: { source: TurnRequest["source"]; accountId: string }): Promise<{
    ownerBinding?: {
      ownerBindingId: string;
      ownerGeneration: number;
    };
    resolvedOwnerPreferences?: Pick<ResolvedOwnerPreferences, "timezone" | "timezoneSource">;
  } | undefined>;
  resolveServerTimezone?(): string;
}

interface ContextAssemblerMemoryStore {
  retrieve(input: {
    query: {
      queryId: string;
      sessionId: string;
      workspaceId: string;
      actorId?: string;
      purpose: "turn_context";
      memoryTypes: string[];
      maxItems: number;
      maxInjectTokens: number;
      queryText?: string;
      taskId?: string;
      resumeFrom?: string;
      conversationBoundaryKey?: string;
      disclosureMode?: DisclosureMode;
      targetConversationKeys?: string[];
      borrowedConversationKeys?: string[];
      transientBorrowed?: boolean;
      visibility?: "owner_private" | "conversation_local" | "global_config";
    };
    recentHistory?: RecentHistorySurface;
    requestedTask?: Omit<ActiveTaskSnapshot, "selectedBy">;
    activeTasks?: Array<Omit<ActiveTaskSnapshot, "selectedBy">>;
    typedMemory?: TypedMemorySurfaceItem[];
    evidence?: EvidenceSurfaceItem[];
  }): Promise<RuntimeMemoryContext>;
  searchEvidence?(input: { workspaceId: string; queryText: string; maxItems: number }): Promise<{ items: EvidenceRecord[] }>;
  listOutbox?(): Promise<unknown[]>;
}

interface ContextAssemblerTaskStore {
  loadById(taskId: string): Promise<TaskState | undefined>;
  loadLatestActiveBySession?(sessionId: string): Promise<TaskState | undefined>;
  listActiveBySession(sessionId: string): Promise<Array<{ taskId: string; status: TaskState["status"]; lastTurnId: string }>>;
}

export interface ContextAssembler {
  assemble(input: {
    request: TurnRequest;
    session: { sessionId: string; workspaceId: string };
    budget: BudgetResolution;
    continuation?: {
      pendingExecution: PendingExecution;
      control: ExecutionControlInput;
    };
  }): Promise<ContextAssemblyResult>;
}

type ToolExposureInput = EndecToolExposure;

function normalizeRuntimeModel(model: RuntimeRequest["model"]): RuntimeRequest["model"] {
  return {
    providerId: model.providerId,
    modelId: model.modelId
  };
}

export function createContextAssembler(deps: {
  historyStore: ContextAssemblerHistoryStore;
  memoryStore: ContextAssemblerMemoryStore;
  taskStore: ContextAssemblerTaskStore;
  ownerStateStore?: ContextAssemblerOwnerStateStore;
  resolvePersona?: (input: {
    source: Extract<TurnRequest["source"], "telegram" | "feishu">;
    accountId: string;
    ownerBindingId: string;
    ownerGeneration: number;
    conversationRef: NonNullable<TurnRequest["conversationRef"]>;
    conversationScope: NonNullable<NonNullable<TurnRequest["imContext"]>["boundary"]>["conversationScope"];
  }) => Promise<NonNullable<NonNullable<TurnRequest["imContext"]>["resolvedPersona"]>>;
  resolveToolExposure?: (input: {
    request: TurnRequest;
    session: { sessionId: string; workspaceId: string };
    budget: BudgetResolution;
  }) => Promise<EndecToolExposure> | EndecToolExposure;
}): ContextAssembler {
  return {
    async assemble(input) {
      const toolExposure = normalizeToolExposure(await deps.resolveToolExposure?.(input));
      const [recentHistoryEntries, activeTask, activeTaskRows, ownerInspection] = await Promise.all([
        deps.historyStore.loadRecentHistory({
          sessionId: input.session.sessionId,
          beforeTurnId: input.request.turnId,
          limit: 6
        }),
        loadActiveTask(deps.taskStore, input.request),
        input.request.taskId
          ? Promise.resolve([])
          : deps.taskStore.listActiveBySession(input.session.sessionId),
        input.request.source === "telegram" || input.request.source === "feishu"
          ? deps.ownerStateStore?.inspectOwnerBinding?.({
              source: input.request.source,
              accountId: input.request.conversationRef?.accountId ?? ""
            })
          : Promise.resolve(undefined)
      ]);

      const requestedTask = mapTaskSnapshot(activeTask);
      const activeTasks = await Promise.all(
        activeTaskRows.slice(0, 6).map(async (task) => deps.taskStore.loadById(task.taskId))
      ).then((items) => items.map(mapTaskSnapshot).filter((task): task is Omit<ActiveTaskSnapshot, "selectedBy"> => !!task));

      const resolvedPersona = input.request.imContext?.resolvedPersona
        ?? (input.request.imContext
          && input.request.conversationRef
          && ownerInspection?.ownerBinding
          && (input.request.source === "telegram" || input.request.source === "feishu")
          ? await deps.resolvePersona?.({
              source: input.request.source,
              accountId: input.request.conversationRef.accountId,
              ownerBindingId: ownerInspection.ownerBinding.ownerBindingId,
              ownerGeneration: ownerInspection.ownerBinding.ownerGeneration,
              conversationRef: input.request.conversationRef,
              conversationScope: input.request.imContext.boundary.conversationScope
            })
          : undefined);
      const request = resolvedPersona && input.request.imContext
        ? {
            ...input.request,
            imContext: {
              ...input.request.imContext,
              resolvedPersona
            }
          }
        : input.request;

      const recentHistory = summarizeRecentHistory(recentHistoryEntries);

      const memoryContext = await deps.memoryStore.retrieve({
        query: {
          queryId: `query:${request.turnId}`,
          sessionId: input.session.sessionId,
          workspaceId: input.session.workspaceId,
          actorId: request.actorId,
          purpose: "turn_context",
          memoryTypes: ["working_set", "recent_history", "active_task", "typed_memory", "evidence"],
          maxItems: 8,
          maxInjectTokens: input.budget.limits.memoryInjectionBudget,
          queryText: request.input,
          taskId: request.taskId,
          resumeFrom: request.resumeFrom,
          conversationBoundaryKey: request.imContext?.boundary.boundaryKey,
          disclosureMode: request.imContext?.boundary.disclosureMode,
          targetConversationKeys: request.imContext?.boundary.targetConversationKeys,
          borrowedConversationKeys: request.imContext?.boundary.borrowedConversationKeys,
          transientBorrowed: request.imContext?.boundary.transientBorrowed
        },
        recentHistory,
        requestedTask,
        activeTasks
      });

      const runtimeSelfAwareness = buildRuntimeSelfAwareness({
        request,
        resolvedMode: input.budget.resolvedMode,
        model: input.budget.model,
        toolExposure,
        activeTask,
        continuation: input.continuation
      });
      const timeContext = buildCurrentTurnTimeContextForAssembly({
        request,
        recentHistoryEntries,
        resolvedOwnerPreferences: ownerInspection?.resolvedOwnerPreferences,
        serverTimezone: deps.ownerStateStore?.resolveServerTimezone?.() ?? resolveServerTimezone({})
      });
      const authoritativeTruth = buildAuthoritativeTurnTruth({
        request,
        session: input.session,
        resolvedMode: input.budget.resolvedMode,
        toolExposure,
        replyPath: runtimeSelfAwareness.replyPath,
        constraints: runtimeSelfAwareness.constraints
      });
      const runtimeContinuation = buildRuntimeContinuation(input.continuation);
      const promptContract = createPromptContract({
        request,
        resolvedMode: input.budget.resolvedMode,
        toolSchemas: toolExposure.exposedTools,
        activeTask,
        disclosureOverlay: buildDisclosureOverlay(request),
        personaOverlay: buildPersonaOverlay(request)
      });

      const basePromptBlocks = promptContract.layers
        .filter((layer) => layer.kind !== "user_input")
        .filter((layer) => layer.applied)
        .map<RuntimeContextBlock>((layer) => ({
          blockId: layer.layerId,
          kind: layer.kind === "system_prompt" ? "system" : "instruction",
          title: layer.title,
          content: layer.content,
          tokenCount: layer.tokenCount,
          sourceRefs: []
        }));

      const authoritativeTruthBlock = buildAuthoritativeTurnTruthBlock({
        turnId: input.request.turnId,
        truth: authoritativeTruth
      });
      const timeContextBlock = buildCurrentTimeContextInstructionBlock({
        turnId: input.request.turnId,
        timeContext
      });
      const runtimeSelfAwarenessBlock = buildRuntimeSelfAwarenessBlock({
        turnId: input.request.turnId,
        surface: runtimeSelfAwareness
      });
      const continuationBlocks = input.continuation ? [buildContinuationBlock(input.continuation)] : [];
      const runtimeContinuity = memoryContext.continuity ?? synthesizeLegacyContinuity({
        request: input.request,
        requestedTask,
        activeTasks,
        recentHistory,
        memoryContext
      });
      const fittedMemory = fitMemoryInjectionBlocks({
        turnId: input.request.turnId,
        memoryContext,
        continuity: runtimeContinuity,
        continuityPresent: !!memoryContext.continuity,
        budget: input.budget.limits.memoryInjectionBudget
      });

      const userInputLayer = promptContract.layers.find((layer) => layer.kind === "user_input");
      const userInputBlock: RuntimeContextBlock = {
        blockId: `user_input:${request.turnId}`,
        kind: "user_input",
        title: userInputLayer?.title,
        content: request.input,
        tokenCount: estimateTextTokens(request.input),
        sourceRefs: [request.turnId]
      };
      const toolSchemaAccounting = estimateToolSchemaAccounting(toolExposure.exposedTools);
      const toolSchemaTokens = toolSchemaAccounting.status === "estimated"
        ? toolSchemaAccounting.totalTokens ?? 0
        : 0;
      const basePromptBlocksTokenCount = basePromptBlocks.reduce(
        (total, block) => total + (block.tokenCount ?? estimateTextTokens(block.content)),
        0
      );
      const continuationBlocksTokenCount = continuationBlocks.reduce(
        (total, block) => total + (block.tokenCount ?? estimateTextTokens(block.content)),
        0
      );
      const projectedInputTokensBeforeFitting = basePromptBlocksTokenCount
        + (authoritativeTruthBlock.tokenCount ?? estimateTextTokens(authoritativeTruthBlock.content))
        + (timeContextBlock.tokenCount ?? estimateTextTokens(timeContextBlock.content))
        + (runtimeSelfAwarenessBlock.tokenCount ?? estimateTextTokens(runtimeSelfAwarenessBlock.content))
        + continuationBlocksTokenCount
        + fittedMemory.projectedMemoryTokensBeforeFitting
        + (userInputBlock.tokenCount ?? estimateTextTokens(userInputBlock.content))
        + toolSchemaTokens;

      const contextBlocks = [
        ...basePromptBlocks,
        authoritativeTruthBlock,
        timeContextBlock,
        runtimeSelfAwarenessBlock,
        ...continuationBlocks,
        ...fittedMemory.blocks,
        userInputBlock
      ];
      const projectedInputTokens = contextBlocks.reduce(
        (total, block) => total + (block.tokenCount ?? estimateTextTokens(block.content)),
        0
      ) + toolSchemaTokens;
      const warningDetails: TurnWarningDetail[] = fittedMemory.truncated
        ? [{
            code: MEMORY_CONTEXT_TRUNCATED_CODE,
            message: "Memory selection was truncated to fit the memory injection budget.",
            category: "memory_budget",
            audience: "operator_debug",
            severity: "info",
            metadata: {
              selectedMemoryTokens: fittedMemory.projectedMemoryTokensBeforeFitting,
              injectedMemoryTokens: fittedMemory.tokenCount,
              droppedMemoryTokens: Math.max(0, fittedMemory.projectedMemoryTokensBeforeFitting - fittedMemory.tokenCount),
              selectedCount: fittedMemory.selectedCount,
              injectedCount: fittedMemory.injectedCount,
              droppedCount: fittedMemory.droppedCount,
              memoryInjectionBudget: input.budget.limits.memoryInjectionBudget,
              ...summarizeMemorySourceRefs(fittedMemory),
              ...(input.budget.budgetDebug?.budgetProfile
                ? { budgetProfile: input.budget.budgetDebug.budgetProfile }
                : {}),
              ...(typeof input.budget.budgetDebug?.effectiveMemoryInjectionBudget === "number"
                ? { effectiveMemoryInjectionBudget: input.budget.budgetDebug.effectiveMemoryInjectionBudget }
                : {}),
              projectedMemoryTokensBeforeFitting: fittedMemory.projectedMemoryTokensBeforeFitting,
              projectedMemoryTokensAfterFitting: fittedMemory.tokenCount
            }
          }]
        : [];
      const warnings = warningDetails.map((warning) => warning.code);
      const budget = createContextAssemblyBudget({
        inputTokenBudget: input.budget.limits.inputTokenBudget,
        projectedInputTokens,
        historyBudget: 0,
        historyTokensUsed: 0,
        historyTruncated: false,
        memoryInjectionBudget: input.budget.limits.memoryInjectionBudget,
        memoryTokensUsed: fittedMemory.tokenCount,
        memoryTruncated: fittedMemory.truncated,
        toolResultInjectionBudget: input.budget.limits.toolResultInjectionBudget,
        toolResultTokensUsed: 0
      });
      const runtimeMemory: RuntimeMemoryContext = {
        ...memoryContext,
        contextBlocks: fittedMemory.blocks,
        tokenEstimate: fittedMemory.tokenCount,
        continuity: runtimeContinuity,
        observability: memoryContext.observability
      };
      const selection = {
        recentHistoryTurnIds: runtimeMemory.continuity?.recentHistory.turnRefs ?? recentHistory.turnRefs,
        memorySourceRefs: memoryContext.sourceRefs,
        activeTaskId: runtimeMemory.continuity?.activeTask?.taskId ?? requestedTask?.taskId,
        evidenceIds: (runtimeMemory.continuity?.evidence ?? [])
          .map((item) => item.ref)
          .filter((value): value is string => typeof value === "string"),
        projectionRefs: (runtimeMemory.continuity?.projectionDerivedRefs ?? []).map((item) => item.ref),
        typedMemoryScopes: [
          ...new Set(
            (runtimeMemory.continuity?.typedMemory ?? [])
              .map((item) => item.scope)
              .filter((value): value is "session" | "workspace" | "user" => typeof value === "string")
          )
        ],
        exposedToolNames: toolExposure.exposedTools.map((tool) => tool.name)
      };
      const observability = buildContextAssemblyObservability({
        authoritativeTruth,
        runtimeSelfAwareness,
        continuity: runtimeContinuity,
        session: input.session,
        selection,
        memoryObservability: runtimeMemory.observability,
        fittedMemory,
        budget,
        budgetResolution: buildBudgetResolutionDebug({
          budget: input.budget,
          toolSchemaAccounting
        }),
        imBoundary: request.imContext
          ? {
              disclosureMode: request.imContext.boundary.disclosureMode,
              borrowedConversationKeys: request.imContext.boundary.borrowedConversationKeys,
              personaScopeKind: request.imContext.resolvedPersona?.scopeKind
            }
          : undefined,
        promptBlocks: buildPromptBlockObservability({
          basePromptBlocks,
          authoritativeTruthBlock,
          timeContextBlock,
          runtimeSelfAwarenessBlock,
          continuationBlocks,
          fittedMemory,
          userInputBlock,
          toolSchemaAccounting
        }),
        diagnostics: warningDetails,
        projectedInputTokensBeforeFitting,
        projectedInputTokensAfterFitting: projectedInputTokens,
        remainingHeadroomEstimate: Math.max(0, input.budget.limits.inputTokenBudget - projectedInputTokens),
        toolSchemaAccounting
      });

      return ContextAssemblyResultSchema.parse({
        schemaVersion: 1,
        contractVersion: "ws0.context-assembly.v1",
        assemblyId: `assembly:${request.turnId}`,
        turnId: request.turnId,
        sessionId: input.session.sessionId,
        workspaceId: input.session.workspaceId,
        resolvedMode: input.budget.resolvedMode,
        runtimeContextBlocks: contextBlocks,
        metadata: {
          assemblySource: "app-layer",
          memorySourceRefs: memoryContext.sourceRefs,
          requestedCapabilities: request.requestedCapabilities ?? []
        },
        budgeting: {
          inputTokenBudget: input.budget.limits.inputTokenBudget,
          outputTokenBudget: input.budget.limits.outputTokenBudget,
          memoryInjectionBudget: input.budget.limits.memoryInjectionBudget,
          toolResultInjectionBudget: input.budget.limits.toolResultInjectionBudget
        },
        toolExposure,
        promptContract,
        runtimeRequest: {
          turnId: request.turnId,
          sessionId: input.session.sessionId,
          workspaceId: input.session.workspaceId,
          resolvedMode: input.budget.resolvedMode,
          correlation: {
            source: request.source,
            actorId: request.actorId
          },
          userInput: {
            text: request.input,
            attachments: request.attachments
          },
          model: normalizeRuntimeModel(input.budget.model),
          toolSchemas: toolExposure.exposedTools,
          contextBlocks,
          turnContext: {
            memory: runtimeMemory,
            selfAwareness: runtimeSelfAwareness,
            authoritativeTruth,
            timeContext,
            observability
          },
          continuation: runtimeContinuation,
          limits: input.budget.limits
        },
        budget,
        selection,
        observability,
        warnings
      });
    }
  };
}

function normalizeToolExposure(exposure: ToolExposureInput | undefined): ContextToolExposure {
  if (!exposure) {
    return {
      exposureSource: "policy",
      exposedTools: [],
      hiddenToolNames: []
    };
  }

  if ("exposedTools" in exposure) {
    return {
      exposureSource: exposure.exposureSource,
      exposedTools: exposure.exposedTools,
      hiddenToolNames: exposure.hiddenToolNames
    };
  }

  return {
    exposureSource: exposure.exposureSource ?? "policy",
    exposedTools: exposure.toolSchemas,
    hiddenToolNames: exposure.hiddenToolNames ?? []
  };
}

async function loadActiveTask(taskStore: ContextAssemblerTaskStore, request: Pick<TurnRequest, "taskId" | "sessionId">) {
  if (request.taskId) {
    return taskStore.loadById(request.taskId);
  }

  if (taskStore.loadLatestActiveBySession) {
    const latest = await taskStore.loadLatestActiveBySession(request.sessionId);
    if (latest) {
      return latest;
    }
  }

  const active = await taskStore.listActiveBySession(request.sessionId);
  const first = active[0];
  return first ? taskStore.loadById(first.taskId) : undefined;
}

function mapTaskSnapshot(task: TaskState | undefined): Omit<ActiveTaskSnapshot, "selectedBy"> | undefined {
  if (!task) {
    return undefined;
  }

  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    checkpointRef: task.checkpointRef,
    currentStep: task.currentStep,
    nextAction: task.nextAction,
    blockingReason: task.blockingReason,
    updatedAt: task.updatedAt
  };
}

function summarizeRecentHistory(items: RecentHistoryEntry[]): RecentHistorySurface {
  const recent = items.slice(0, 3).reverse();
  return {
    summary: recent.map((item) => `${item.eventKind}: ${item.summary}`).join("\n"),
    refs: [...new Set(recent.flatMap((item) => item.sourceRefs.length > 0 ? item.sourceRefs : [item.turnId]))],
    turnRefs: [...new Set(recent.map((item) => item.turnId))],
    carryForwardKinds: [...new Set(recent.map((item) => item.eventKind))]
  };
}

function buildDisclosureOverlay(request: TurnRequest) {
  const boundary = request.imContext?.boundary;
  if (!boundary) {
    return undefined;
  }

  const borrowed = boundary.borrowedConversationKeys.length > 0
    ? ` Borrowed sources: ${boundary.borrowedConversationKeys.join(", ")}.`
    : "";
  const transient = boundary.transientBorrowed
    ? " Borrowed context is transient for this reply and must not become durable memory automatically."
    : "";

  return `privacy boundary: disclosureMode=${boundary.disclosureMode}; conversationBoundary=${boundary.boundaryKey}.${borrowed}${transient}`;
}

function buildPersonaOverlay(request: TurnRequest) {
  const persona = request.imContext?.resolvedPersona;
  if (!persona) {
    return undefined;
  }

  const style = persona.styleInstructions.trim().length > 0
    ? ` Style instructions: ${persona.styleInstructions}.`
    : "";
  const behavior = persona.behaviorInstructions.trim().length > 0
    ? ` Behavior instructions: ${persona.behaviorInstructions}.`
    : "";

  return `persona scope: ${persona.scopeKind}.${style}${behavior} Persona can shape style and behavior only and cannot override privacy or tool rules.`;
}

function synthesizeLegacyContinuity(input: {
  request: Pick<TurnRequest, "resumeFrom">;
  requestedTask?: Omit<ActiveTaskSnapshot, "selectedBy">;
  activeTasks: Array<Omit<ActiveTaskSnapshot, "selectedBy">>;
  recentHistory: RecentHistorySurface;
  memoryContext: RuntimeMemoryContext;
}): NonNullable<RuntimeMemoryContext["continuity"]> {
  return {
    retrievalPolicy: {
      strategy: input.request.resumeFrom ? "continuation" : input.requestedTask || input.activeTasks.length > 0 ? "active_task_preferred" : "ordinary",
      activeTaskSelection: input.requestedTask
        ? { mode: "request_task", taskId: input.requestedTask.taskId }
        : input.activeTasks[0]
          ? { mode: "latest_active_task", taskId: input.activeTasks[0].taskId }
          : { mode: "none" },
      includeWorkingSet: true,
      includeRecentHistory: true,
      includeActiveTask: !!(input.requestedTask || input.activeTasks.length > 0),
      includeTypedMemory: true,
      includeEvidence: true
    },
    recentHistory: input.recentHistory,
    workingSet: {
      summary: input.memoryContext.workingSetSummary,
      objective: undefined,
      recentProgress: [],
      recentDecisions: [],
      blockers: [],
      openLoops: [],
      activeMemoryRefs: [],
      activeTaskRefs: [],
      recentEventRefs: [],
      sourceRefs: input.memoryContext.sourceRefs
    },
    activeTask: undefined,
    typedMemory: [],
    evidence: [],
    projectionDerivedRefs: []
  };
}

type PlannedBlockLayer = "continuity_core" | "durable_memory" | "evidence" | "supplement";
type ContinuityBlockKey = "activeTask" | "workingSet" | "recentHistory";
type PlannedBlock = RuntimeContextBlock & {
  observabilityLayer: PlannedBlockLayer;
};
type BlockOutcome = {
  blockId: string;
  title?: string;
  kind: RuntimeContextBlock["kind"];
  layer: PlannedBlockLayer;
  estimatedTokens: number;
  outcome: "full" | "skeleton" | "partial" | "dropped";
  reason: string;
  sourceRefs: string[];
};
type ContinuityBlockSnapshot = {
  blockId?: string;
  title?: string;
  selectionStatus: "selected" | "not-selected" | "missing";
  injectionStatus: "full" | "skeleton" | "partial" | "dropped" | "not-requested";
  reason?: string;
  sourceRefs: string[];
  carryForwardKinds: string[];
  selectedBy?: "request_task" | "latest_active_task";
};
type MemoryInjectionFit = {
  blocks: RuntimeContextBlock[];
  tokenCount: number;
  truncated: boolean;
  blockOutcomes: BlockOutcome[];
  continuityBlocks: Record<ContinuityBlockKey, ContinuityBlockSnapshot>;
  selectedCount: number;
  injectedCount: number;
  droppedCount: number;
  projectedMemoryTokensBeforeFitting: number;
};

type ContinuityBlockDescriptor = {
  key: ContinuityBlockKey;
  full: PlannedBlock;
  minimal?: PlannedBlock;
  sourceRefs: string[];
  carryForwardKinds: string[];
  selectedBy?: "request_task" | "latest_active_task";
};

type ContinuityMemoryPlan = {
  continuityCore: ContinuityBlockDescriptor[];
  durable: PlannedBlock[];
};

function createDefaultContinuitySnapshots(continuity: NonNullable<RuntimeMemoryContext["continuity"]>): Record<ContinuityBlockKey, ContinuityBlockSnapshot> {
  return {
    activeTask: continuity.retrievalPolicy.includeActiveTask
      ? continuity.activeTask
        ? {
            selectionStatus: "selected",
            injectionStatus: "dropped",
            sourceRefs: [continuity.activeTask.taskId, continuity.activeTask.checkpointRef].filter(
              (value): value is string => typeof value === "string" && value.length > 0
            ),
            carryForwardKinds: [],
            selectedBy: continuity.activeTask.selectedBy,
            reason: "awaiting_budget_fit"
          }
        : {
            selectionStatus: "missing",
            injectionStatus: "not-requested",
            sourceRefs: [],
            carryForwardKinds: [],
            reason: "no_active_task_available"
          }
      : {
          selectionStatus: "not-selected",
          injectionStatus: "not-requested",
          sourceRefs: [],
          carryForwardKinds: []
        },
    workingSet: continuity.retrievalPolicy.includeWorkingSet
      ? {
          selectionStatus: continuity.workingSet.summary.trim().length > 0 ? "selected" : "missing",
          injectionStatus: continuity.workingSet.summary.trim().length > 0 ? "dropped" : "not-requested",
          sourceRefs: continuity.workingSet.sourceRefs,
          carryForwardKinds: [],
          reason: continuity.workingSet.summary.trim().length > 0 ? "awaiting_budget_fit" : "no_working_set_summary_available"
        }
      : {
          selectionStatus: "not-selected",
          injectionStatus: "not-requested",
          sourceRefs: [],
          carryForwardKinds: []
        },
    recentHistory: continuity.retrievalPolicy.includeRecentHistory
      ? {
          selectionStatus: continuity.recentHistory.summary.trim().length > 0 ? "selected" : "missing",
          injectionStatus: continuity.recentHistory.summary.trim().length > 0 ? "dropped" : "not-requested",
          sourceRefs: continuity.recentHistory.refs,
          carryForwardKinds: continuity.recentHistory.carryForwardKinds ?? [],
          reason: continuity.recentHistory.summary.trim().length > 0 ? "awaiting_budget_fit" : "no_recent_history_available"
        }
      : {
          selectionStatus: "not-selected",
          injectionStatus: "not-requested",
          sourceRefs: [],
          carryForwardKinds: []
        }
  };
}

function normalizeContinuityOutcome(input: {
  descriptor: ContinuityBlockDescriptor;
  fittedBlock?: RuntimeContextBlock;
}): BlockOutcome {
  if (!input.fittedBlock) {
    return {
      blockId: input.descriptor.full.blockId,
      title: input.descriptor.full.title,
      kind: input.descriptor.full.kind,
      layer: "continuity_core",
      estimatedTokens: input.descriptor.full.tokenCount ?? estimateTextTokens(input.descriptor.full.content),
      outcome: "dropped",
      reason: "budget_reserved_for_higher_priority_context",
      sourceRefs: input.descriptor.sourceRefs
    };
  }

  if (input.fittedBlock.content === input.descriptor.full.content) {
    return {
      blockId: input.descriptor.full.blockId,
      title: input.descriptor.full.title,
      kind: input.descriptor.full.kind,
      layer: "continuity_core",
      estimatedTokens: input.fittedBlock.tokenCount ?? estimateTextTokens(input.fittedBlock.content),
      outcome: "full",
      reason: "selected_full",
      sourceRefs: input.descriptor.sourceRefs
    };
  }

  if (input.descriptor.minimal && input.fittedBlock.content === input.descriptor.minimal.content) {
    return {
      blockId: input.descriptor.full.blockId,
      title: input.descriptor.full.title,
      kind: input.descriptor.full.kind,
      layer: "continuity_core",
      estimatedTokens: input.fittedBlock.tokenCount ?? estimateTextTokens(input.fittedBlock.content),
      outcome: "skeleton",
      reason: "budget_preserve_continuity_core",
      sourceRefs: input.descriptor.sourceRefs
    };
  }

  return {
    blockId: input.descriptor.full.blockId,
    title: input.descriptor.full.title,
    kind: input.descriptor.full.kind,
    layer: "continuity_core",
    estimatedTokens: input.fittedBlock.tokenCount ?? estimateTextTokens(input.fittedBlock.content),
    outcome: "partial",
    reason: "budget_partial_truncate",
    sourceRefs: input.descriptor.sourceRefs
  };
}

function normalizeDurableOutcome(input: {
  block: PlannedBlock;
  fittedBlock?: RuntimeContextBlock;
}): BlockOutcome {
  if (!input.fittedBlock) {
    return {
      blockId: input.block.blockId,
      title: input.block.title,
      kind: input.block.kind,
      layer: input.block.observabilityLayer,
      estimatedTokens: input.block.tokenCount ?? estimateTextTokens(input.block.content),
      outcome: "dropped",
      reason: "budget_reserved_for_higher_priority_context",
      sourceRefs: input.block.sourceRefs ?? []
    };
  }

  if (input.fittedBlock.content === input.block.content) {
    return {
      blockId: input.block.blockId,
      title: input.block.title,
      kind: input.block.kind,
      layer: input.block.observabilityLayer,
      estimatedTokens: input.fittedBlock.tokenCount ?? estimateTextTokens(input.fittedBlock.content),
      outcome: "full",
      reason: "selected_full",
      sourceRefs: input.block.sourceRefs ?? []
    };
  }

  return {
    blockId: input.block.blockId,
    title: input.block.title,
    kind: input.block.kind,
    layer: input.block.observabilityLayer,
    estimatedTokens: input.fittedBlock.tokenCount ?? estimateTextTokens(input.fittedBlock.content),
    outcome: "partial",
    reason: "budget_partial_truncate",
    sourceRefs: input.block.sourceRefs ?? []
  };
}

function classifyLegacyMemoryBlock(block: RuntimeContextBlock): {
  layer: PlannedBlockLayer;
  continuityKey?: ContinuityBlockKey;
} {
  const blockId = block.blockId.toLowerCase();
  const title = block.title?.toLowerCase() ?? "";
  const sourceRefs = block.sourceRefs ?? [];
  const hasRef = (prefix: string) => sourceRefs.some((ref) => ref.startsWith(prefix));

  if (blockId.includes("active_task") || title === "active task") {
    return {
      layer: "continuity_core",
      continuityKey: "activeTask"
    };
  }

  if (block.kind === "history" || blockId.includes("recent_history") || title === "recent history") {
    return {
      layer: "continuity_core",
      continuityKey: "recentHistory"
    };
  }

  if (blockId.includes("working_set") || title === "session working set" || hasRef("working_set:")) {
    return {
      layer: "continuity_core",
      continuityKey: "workingSet"
    };
  }

  if (blockId.includes("projection") || hasRef("projection:")) {
    return {
      layer: "supplement"
    };
  }

  if (blockId.includes("evidence") || title === "evidence" || hasRef("evidence:")) {
    return {
      layer: "evidence"
    };
  }

  return {
    layer: "durable_memory"
  };
}

function normalizeLegacyOutcome(input: {
  block: RuntimeContextBlock;
  fittedBlock?: RuntimeContextBlock;
}): BlockOutcome {
  const classification = classifyLegacyMemoryBlock(input.block);

  if (!input.fittedBlock) {
    return {
      blockId: input.block.blockId,
      title: input.block.title,
      kind: input.block.kind,
      layer: classification.layer,
      estimatedTokens: input.block.tokenCount ?? estimateTextTokens(input.block.content),
      outcome: "dropped",
      reason: "budget_reserved_for_higher_priority_context",
      sourceRefs: input.block.sourceRefs ?? []
    };
  }

  if (input.fittedBlock.content === input.block.content) {
    return {
      blockId: input.block.blockId,
      title: input.block.title,
      kind: input.block.kind,
      layer: classification.layer,
      estimatedTokens: input.fittedBlock.tokenCount ?? estimateTextTokens(input.fittedBlock.content),
      outcome: "full",
      reason: "selected_full",
      sourceRefs: input.block.sourceRefs ?? []
    };
  }

  return {
    blockId: input.block.blockId,
    title: input.block.title,
    kind: input.block.kind,
    layer: classification.layer,
    estimatedTokens: input.fittedBlock.tokenCount ?? estimateTextTokens(input.fittedBlock.content),
    outcome: "partial",
    reason: "budget_partial_truncate",
    sourceRefs: input.block.sourceRefs ?? []
  };
}

function applyLegacyContinuityOutcomes(input: {
  blocks: RuntimeContextBlock[];
  blockOutcomes: BlockOutcome[];
  continuity: NonNullable<RuntimeMemoryContext["continuity"]>;
}) {
  const continuityBlocks = createDefaultContinuitySnapshots(input.continuity);

  for (const block of input.blocks) {
    const { continuityKey } = classifyLegacyMemoryBlock(block);
    if (!continuityKey) {
      continue;
    }

    const outcome = input.blockOutcomes.find((candidate) => candidate.blockId === block.blockId);
    if (!outcome) {
      continue;
    }

    continuityBlocks[continuityKey] = {
      ...continuityBlocks[continuityKey],
      blockId: block.blockId,
      title: block.title,
      selectionStatus: "selected",
      injectionStatus: outcome.outcome,
      reason: outcome.reason,
      sourceRefs: outcome.sourceRefs
    };
  }

  return continuityBlocks;
}

function fitMemoryInjectionBlocks(input: {
  turnId: string;
  memoryContext: RuntimeMemoryContext;
  continuity: NonNullable<RuntimeMemoryContext["continuity"]>;
  continuityPresent: boolean;
  budget: number;
}): MemoryInjectionFit {
  if (input.continuityPresent) {
    return fitStructuredContinuityMemoryBlocks({
      turnId: input.turnId,
      continuity: input.continuity,
      legacyWorkingSetSummary: input.memoryContext.workingSetSummary,
      budget: input.budget
    });
  }

  if (input.memoryContext.contextBlocks?.length) {
    const plannedBlocks = input.memoryContext.contextBlocks.map((block) => ({
      ...block,
      tokenCount: block.tokenCount ?? estimateTextTokens(block.content)
    }));
    const fitted = fitBlocksToBudget({
      blocks: plannedBlocks,
      budget: input.budget
    });
    const fittedById = new Map(fitted.blocks.map((block) => [block.blockId, block]));
    const blockOutcomes = plannedBlocks.map((block) => normalizeLegacyOutcome({
      block,
      fittedBlock: fittedById.get(block.blockId)
    }));

    return {
      blocks: fitted.blocks,
      tokenCount: fitted.tokenCount,
      truncated: fitted.truncated,
      blockOutcomes,
      continuityBlocks: applyLegacyContinuityOutcomes({
        blocks: plannedBlocks,
        blockOutcomes,
        continuity: input.continuity
      }),
      selectedCount: plannedBlocks.length,
      injectedCount: blockOutcomes.filter((outcome) => outcome.outcome !== "dropped").length,
      droppedCount: blockOutcomes.filter((outcome) => outcome.outcome === "dropped").length,
      projectedMemoryTokensBeforeFitting: plannedBlocks.reduce(
        (total, block) => total + (block.tokenCount ?? estimateTextTokens(block.content)),
        0
      )
    };
  }

  const structuredFit = fitStructuredContinuityMemoryBlocks({
    turnId: input.turnId,
    continuity: input.continuity,
    legacyWorkingSetSummary: input.memoryContext.workingSetSummary,
    budget: input.budget
  });

  if (structuredFit.blocks.length > 0) {
    return structuredFit;
  }

  if (input.memoryContext.workingSetSummary.trim().length > 0) {
    const plannedBlocks = [{
      blockId: `memory:${input.turnId}:working_set`,
      kind: "memory" as const,
      title: "session working set",
      content: input.memoryContext.workingSetSummary,
      tokenCount: estimateTextTokens(input.memoryContext.workingSetSummary),
      sourceRefs: input.memoryContext.sourceRefs
    }];
    const fitted = fitBlocksToBudget({
      blocks: plannedBlocks,
      budget: input.budget
    });
    const fittedById = new Map(fitted.blocks.map((block) => [block.blockId, block]));
    const blockOutcomes = plannedBlocks.map((block) => normalizeLegacyOutcome({
      block,
      fittedBlock: fittedById.get(block.blockId)
    }));

    return {
      blocks: fitted.blocks,
      tokenCount: fitted.tokenCount,
      truncated: fitted.truncated,
      blockOutcomes,
      continuityBlocks: applyLegacyContinuityOutcomes({
        blocks: plannedBlocks,
        blockOutcomes,
        continuity: input.continuity
      }),
      selectedCount: plannedBlocks.length,
      injectedCount: blockOutcomes.filter((outcome) => outcome.outcome !== "dropped").length,
      droppedCount: blockOutcomes.filter((outcome) => outcome.outcome === "dropped").length,
      projectedMemoryTokensBeforeFitting: plannedBlocks.reduce(
        (total, block) => total + (block.tokenCount ?? estimateTextTokens(block.content)),
        0
      )
    };
  }

  return {
    blocks: [],
    tokenCount: 0,
    truncated: false,
    blockOutcomes: [],
    continuityBlocks: createDefaultContinuitySnapshots(input.continuity),
    selectedCount: 0,
    injectedCount: 0,
    droppedCount: 0,
    projectedMemoryTokensBeforeFitting: 0
  };
}

function fitStructuredContinuityMemoryBlocks(input: {
  turnId: string;
  continuity: NonNullable<RuntimeMemoryContext["continuity"]>;
  legacyWorkingSetSummary: string;
  budget: number;
}): MemoryInjectionFit {
  const plan = buildContinuityMemoryPlan(input);
  const projectedMemoryTokensBeforeFitting = [
    ...plan.continuityCore.map((descriptor) => descriptor.full.tokenCount ?? estimateTextTokens(descriptor.full.content)),
    ...plan.durable.map((block) => block.tokenCount ?? estimateTextTokens(block.content))
  ].reduce((total, count) => total + count, 0);
  const fittedContinuity = fitContinuityCoreToBudget({
    descriptors: plan.continuityCore,
    budget: input.budget
  });
  const fittedDurable = fitBlocksToBudget({
    blocks: plan.durable.map((block) => ({
      ...block,
      tokenCount: block.tokenCount ?? estimateTextTokens(block.content)
    })),
    budget: Math.max(0, input.budget - fittedContinuity.tokenCount)
  });
  const continuityBlocks = createDefaultContinuitySnapshots(input.continuity);
  const fittedContinuityById = new Map(fittedContinuity.blocks.map((block) => [block.blockId, block]));
  const fittedDurableById = new Map(fittedDurable.blocks.map((block) => [block.blockId, block]));
  const blockOutcomes: BlockOutcome[] = [];

  for (const descriptor of plan.continuityCore) {
    const outcome = normalizeContinuityOutcome({
      descriptor,
      fittedBlock: fittedContinuityById.get(descriptor.full.blockId)
    });
    blockOutcomes.push(outcome);
    continuityBlocks[descriptor.key] = {
      blockId: descriptor.full.blockId,
      title: descriptor.full.title,
      selectionStatus: "selected",
      injectionStatus: outcome.outcome,
      reason: outcome.reason,
      sourceRefs: descriptor.sourceRefs,
      carryForwardKinds: descriptor.carryForwardKinds,
      selectedBy: descriptor.selectedBy
    };
  }

  for (const block of plan.durable) {
    blockOutcomes.push(normalizeDurableOutcome({
      block,
      fittedBlock: fittedDurableById.get(block.blockId)
    }));
  }

  const selectedCount = blockOutcomes.length;
  const injectedCount = blockOutcomes.filter((outcome) => outcome.outcome !== "dropped").length;
  const droppedCount = blockOutcomes.filter((outcome) => outcome.outcome === "dropped").length;

  return {
    blocks: [...fittedContinuity.blocks, ...fittedDurable.blocks],
    tokenCount: fittedContinuity.tokenCount + fittedDurable.tokenCount,
    truncated: fittedContinuity.truncated || fittedDurable.truncated,
    blockOutcomes,
    continuityBlocks,
    selectedCount,
    injectedCount,
    droppedCount,
    projectedMemoryTokensBeforeFitting
  };
}

function fitContinuityCoreToBudget(input: {
  descriptors: ContinuityBlockDescriptor[];
  budget: number;
}): {
  blocks: RuntimeContextBlock[];
  tokenCount: number;
  truncated: boolean;
} {
  const blocks: RuntimeContextBlock[] = [];
  let tokenCount = 0;
  let truncated = false;

  for (const descriptor of input.descriptors) {
    const full = {
      ...descriptor.full,
      tokenCount: descriptor.full.tokenCount ?? estimateTextTokens(descriptor.full.content)
    };

    if ((full.tokenCount ?? 0) > 0 && tokenCount + (full.tokenCount ?? 0) <= input.budget) {
      blocks.push(full);
      tokenCount += full.tokenCount ?? 0;
      continue;
    }

    const minimal = descriptor.minimal
      ? {
          ...descriptor.minimal,
          tokenCount: descriptor.minimal.tokenCount ?? estimateTextTokens(descriptor.minimal.content)
        }
      : undefined;

    if (minimal && (minimal.tokenCount ?? 0) > 0 && tokenCount + (minimal.tokenCount ?? 0) <= input.budget) {
      blocks.push(minimal);
      tokenCount += minimal.tokenCount ?? 0;
      truncated = true;
      continue;
    }

    const remaining = input.budget - tokenCount;
    const fallback = minimal ?? full;
    if (remaining > 0) {
      const content = truncateTextToTokenBudget(fallback.content, remaining);
      const partialTokenCount = estimateTextTokens(content);
      if (partialTokenCount > 0) {
        blocks.push({
          ...fallback,
          content,
          tokenCount: partialTokenCount
        });
        tokenCount += partialTokenCount;
      }
    }

    truncated = true;
    break;
  }

  if (blocks.length < input.descriptors.length) {
    truncated = true;
  }

  return {
    blocks,
    tokenCount,
    truncated
  };
}

function buildContinuityMemoryPlan(input: {
  turnId: string;
  continuity: NonNullable<RuntimeMemoryContext["continuity"]>;
  legacyWorkingSetSummary: string;
}): ContinuityMemoryPlan {
  const continuityCore: ContinuityBlockDescriptor[] = [];
  const durable: PlannedBlock[] = [];
  const { continuity } = input;

  if (continuity.retrievalPolicy.includeActiveTask && continuity.activeTask) {
    const content = renderActiveTaskContinuityContent(continuity.activeTask);
    if (content.length > 0) {
      const sourceRefs = [continuity.activeTask.taskId, continuity.activeTask.checkpointRef].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      continuityCore.push({
        key: "activeTask",
        sourceRefs,
        carryForwardKinds: [],
        selectedBy: continuity.activeTask.selectedBy,
        full: {
          blockId: `memory:${input.turnId}:active_task`,
          kind: "task",
          title: "active task",
          content,
          tokenCount: estimateTextTokens(content),
          sourceRefs,
          metadata: {
            status: continuity.activeTask.status,
            selectedBy: continuity.activeTask.selectedBy
          },
          observabilityLayer: "continuity_core"
        }
      });
    }
  }

  const workingSetSummary = continuity.workingSet.summary || input.legacyWorkingSetSummary;
  if (continuity.retrievalPolicy.includeWorkingSet && workingSetSummary.trim().length > 0) {
    const full: PlannedBlock = {
      blockId: `memory:${input.turnId}:working_set`,
      kind: "memory",
      title: "session working set",
      content: workingSetSummary,
      tokenCount: estimateTextTokens(workingSetSummary),
      sourceRefs: continuity.workingSet.sourceRefs,
      observabilityLayer: "continuity_core"
    };
    const minimalContent = renderWorkingSetContinuityCoreContent({
      workingSet: continuity.workingSet,
      fallbackSummary: input.legacyWorkingSetSummary
    });
    const minimal = minimalContent.length > 0 && minimalContent !== workingSetSummary
      ? {
          ...full,
          content: minimalContent,
          tokenCount: estimateTextTokens(minimalContent)
        }
      : undefined;

    continuityCore.push({
      key: "workingSet",
      sourceRefs: continuity.workingSet.sourceRefs,
      carryForwardKinds: [],
      full,
      minimal
    });
  }

  if (continuity.retrievalPolicy.includeRecentHistory && continuity.recentHistory.summary.trim().length > 0) {
    continuityCore.push({
      key: "recentHistory",
      sourceRefs: continuity.recentHistory.refs,
      carryForwardKinds: continuity.recentHistory.carryForwardKinds ?? [],
      full: {
        blockId: `memory:${input.turnId}:recent_history`,
        kind: "history",
        title: "recent history",
        content: continuity.recentHistory.summary,
        tokenCount: estimateTextTokens(continuity.recentHistory.summary),
        sourceRefs: continuity.recentHistory.refs,
        observabilityLayer: "continuity_core"
      }
    });
  }

  if (continuity.retrievalPolicy.includeTypedMemory) {
    continuity.typedMemory.forEach((item, index) => {
      const content = renderTypedMemorySurfaceContent(item);
      if (content.length === 0) {
        return;
      }

      durable.push({
        blockId: `memory:${input.turnId}:typed_memory:${item.scope ?? "unknown"}:${index}`,
        kind: "memory",
        title: renderTypedMemoryScopeTitle(item.scope),
        content,
        tokenCount: estimateTextTokens(content),
        sourceRefs: item.sourceRefs,
        metadata: {
          scope: item.scope,
          status: item.status,
          payload: item.payload
        },
        observabilityLayer: "durable_memory"
      });
    });
  }

  if (continuity.retrievalPolicy.includeEvidence) {
    continuity.evidence.forEach((item, index) => {
      const content = [item.topic, item.content]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n");
      if (content.length === 0) {
        return;
      }

      durable.push({
        blockId: `memory:${input.turnId}:evidence:${index}`,
        kind: "resource",
        title: "evidence",
        content,
        tokenCount: estimateTextTokens(content),
        sourceRefs: item.sourceRefs,
        observabilityLayer: "evidence"
      });
    });
  }

  continuity.projectionDerivedRefs.forEach((item, index) => {
    const content = renderProjectionDerivedRefContent(item);
    if (content.length === 0) {
      return;
    }

    durable.push({
      blockId: `memory:${input.turnId}:projection_ref:${index}`,
      kind: "resource",
      title: "projection-derived ref",
      content,
      tokenCount: estimateTextTokens(content),
      sourceRefs: uniqueRefs([item.ref, ...item.sourceRefs, ...item.turnRefs]),
      metadata: {
        ref: item.ref,
        day: item.day,
        section: item.section,
        summary: item.summary,
        sourceRefs: item.sourceRefs,
        turnRefs: item.turnRefs
      },
      observabilityLayer: "supplement"
    });
  });

  return {
    continuityCore,
    durable
  };
}

function compactContinuityText(value: string | undefined, maxLength = 160) {
  if (typeof value !== "string") {
    return "";
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return "";
  }

  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function renderActiveTaskContinuityContent(task: NonNullable<NonNullable<RuntimeMemoryContext["continuity"]>["activeTask"]>) {
  return [
    task.title,
    task.currentStep,
    task.nextAction,
    task.blockingReason
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
}

function renderWorkingSetContinuityCoreContent(input: {
  workingSet: NonNullable<NonNullable<RuntimeMemoryContext["continuity"]>["workingSet"]>;
  fallbackSummary: string;
}) {
  const lines = [
    input.workingSet.objective ? `Objective: ${compactContinuityText(input.workingSet.objective, 100)}` : "",
    input.workingSet.recentProgress[0] ? `Recent progress: ${compactContinuityText(input.workingSet.recentProgress[0], 90)}` : "",
    input.workingSet.recentDecisions[0] ? `Recent decisions: ${compactContinuityText(input.workingSet.recentDecisions[0], 90)}` : "",
    input.workingSet.blockers[0] ? `Blockers: ${compactContinuityText(input.workingSet.blockers[0], 90)}` : "",
    input.workingSet.openLoops[0] ? `Open loops: ${compactContinuityText(input.workingSet.openLoops[0], 90)}` : ""
  ].filter((line) => line.length > 0);

  if (lines.length > 0) {
    return lines.join("\n");
  }

  return compactContinuityText(input.workingSet.summary || input.fallbackSummary, 160);
}

function uniqueRefs(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function stringifyStructuredScalar(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function renderStructuredContent(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => renderStructuredContent(item))
      .filter((item) => item.length > 0)
      .join("\n");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "summary",
    "content",
    "evidence",
    "assistantResponse",
    "assistant",
    "userInput",
    "user",
    "value",
    "topic",
    "note"
  ];
  const lines: string[] = [];

  for (const key of preferredKeys) {
    const entry = record[key];
    if (entry === undefined) {
      continue;
    }

    const rendered = renderStructuredContent(entry);
    if (rendered.length === 0) {
      continue;
    }

    lines.push(`${key}: ${rendered}`);
  }

  for (const [key, entry] of Object.entries(record)) {
    if (preferredKeys.includes(key)) {
      continue;
    }

    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      const rendered = stringifyStructuredScalar(entry).trim();
      if (rendered.length > 0) {
        lines.push(`${key}: ${rendered}`);
      }
    }
  }

  if (lines.length > 0) {
    return lines.join("\n");
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function stripDuplicatedSummary(content: string, summary: string) {
  if (content.length === 0 || summary.length === 0) {
    return content;
  }

  const normalizedSummary = summary.trim();
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== normalizedSummary && trimmed !== `summary: ${normalizedSummary}`;
    })
    .join("\n")
    .trim();
}

function renderTypedMemoryScopeTitle(scope: TypedMemorySurfaceItem["scope"]) {
  switch (scope) {
    case "session":
      return "session durable memory";
    case "workspace":
      return "workspace durable memory";
    case "user":
      return "user durable memory";
    default:
      return "durable memory";
  }
}

function renderTypedMemorySurfaceContent(item: TypedMemorySurfaceItem) {
  if (!item.payload || typeof item.payload !== "object") {
    return item.memoryType ? `type: ${item.memoryType}` : `kind: ${item.kind}`;
  }

  const payload = item.payload as {
    summary?: unknown;
    content?: unknown;
    payload?: unknown;
  };
  const summary = renderStructuredContent(payload.summary);
  const content = stripDuplicatedSummary(
    renderStructuredContent(payload.content ?? payload.payload),
    summary
  );
  const lines = [
    item.scope ? `scope: ${item.scope}` : "",
    item.memoryType ? `type: ${item.memoryType}` : `kind: ${item.kind}`
  ].filter((line) => line.length > 0);

  if (summary.length > 0) {
    lines.push(`summary: ${summary}`);
  }

  if (content.length > 0 && content !== summary) {
    lines.push(content);
  }

  return lines.join("\n");
}

function renderProjectionDerivedRefContent(item: ProjectionDerivedRefSurfaceItem) {
  const lines = [
    `ref: ${item.ref}`,
    `day: ${item.day}`,
    `section: ${item.section}`,
    `summary: ${item.summary}`
  ];

  if (item.sourceRefs.length > 0) {
    lines.push(`canonical refs: ${item.sourceRefs.join(", ")}`);
  }

  if (item.turnRefs.length > 0) {
    lines.push(`turn refs: ${item.turnRefs.join(", ")}`);
  }

  return lines.join("\n");
}

function buildContinuationPermissionContext(continuation: {
  pendingExecution: PendingExecution;
  control: ExecutionControlInput;
} | undefined): ToolBatchPermissionContext | undefined {
  if (!continuation) {
    return undefined;
  }

  const pendingToolCalls = continuation.pendingExecution.frame.pendingToolCalls;
  if (pendingToolCalls.length === 0) {
    return undefined;
  }

  const { control } = continuation;
  if (control.action === "resume") {
    if (continuation.pendingExecution.frame.continuation.continuationKind !== "resume") {
      return undefined;
    }

    return {
      approvedDecisionIds: []
    };
  }

  if (control.action !== "approve") {
    return undefined;
  }

  if (continuation.pendingExecution.frame.phase !== "awaiting_permission") {
    return undefined;
  }

  const approvedScope = control.scope ?? "once";
  const approvedToolCall = pendingToolCalls.find((toolCall) => toolCall.toolCallId === control.decisionId);
  const pendingDecision = resolvePendingPermissionDecision({
    permissionDecisions: continuation.pendingExecution.frame.pendingPermissionDecisions,
    pendingApprovalRef: control.decisionId
  });
  const bashTrust = approvedScope === "turn"
    && approvedToolCall?.toolName === "bash"
    && pendingDecision?.decisionId === control.decisionId
      ? {
          toolName: "bash" as const,
          scope: "turn" as const,
          decisionId: control.decisionId,
          approverId: control.approverId
        }
      : undefined;

  return {
    approvedDecisionIds: [control.decisionId],
    approverId: control.approverId,
    bashTrust
  };
}

function buildRuntimeContinuation(continuation: {
  pendingExecution: PendingExecution;
  control: ExecutionControlInput;
} | undefined): RuntimeRequest["continuation"] | undefined {
  const permissionContext = buildContinuationPermissionContext(continuation);
  if (!continuation || !permissionContext) {
    return undefined;
  }

  return {
    approvedToolBatch: {
      requestedToolCalls: continuation.pendingExecution.frame.pendingToolCalls,
      priorLoopCount: continuation.pendingExecution.frame.loopCount,
      priorToolCallCount: continuation.pendingExecution.frame.toolCallCount,
      ...permissionContext
    }
  };
}

function buildAuthoritativeTurnTruth(input: {
  request: Pick<TurnRequest, "source">;
  session: { workspaceId: string };
  resolvedMode: RuntimeRequest["resolvedMode"];
  toolExposure: ContextToolExposure;
  replyPath: RuntimeSelfAwarenessSurface["replyPath"];
  constraints: RuntimeConstraintSurface[];
}): AuthoritativeTurnTruth {
  return {
    schemaVersion: 1,
    contractVersion: "ws6.authoritative-turn-truth.v1",
    source: input.request.source,
    channel: input.request.source,
    mode: input.resolvedMode,
    replyPath: input.replyPath,
    boundary: {
      workspace: {
        root: input.session.workspaceId,
        kind: "isolated_worktree",
        summary: "Default auto-execution is limited to the isolated workspace boundary for this turn."
      }
    },
    capabilityTruth: reclassifyCapabilityTruth({
      exposure: input.toolExposure
    }),
    constraints: input.constraints,
    antiDriftRules: [
      "Only this packet defines current-turn capability truth.",
      "Do not infer extra current-turn capabilities from history or memory.",
      "History and memory are supporting evidence, not authorization.",
      "When a capability summary and action authorization differ, follow the action authorization boundary."
    ]
  };
}

function buildAuthoritativeTurnTruthBlock(input: {
  turnId: string;
  truth: AuthoritativeTurnTruth;
}): RuntimeContextBlock {
  const lines = [
    `source/channel: ${input.truth.source}`,
    `mode: ${input.truth.mode}`,
    `reply path: ${input.truth.replyPath}`,
    `workspace boundary: ${input.truth.boundary.workspace.summary}`,
    `guaranteed tools: ${input.truth.capabilityTruth.guaranteedToolNames.length > 0 ? input.truth.capabilityTruth.guaranteedToolNames.join(", ") : "(none)"}`,
    `guaranteed capabilities: ${input.truth.capabilityTruth.guaranteedCapabilities.join(", ")}`,
    `approval-required capabilities: ${input.truth.capabilityTruth.approvalRequiredCapabilities.join(", ")}`,
    `not-guaranteed capabilities: ${input.truth.capabilityTruth.notGuaranteedCapabilities.join(", ")}`,
    `action authorization: ${input.truth.capabilityTruth.actionAuthorizations.map((entry) => `${entry.actionClass}=${entry.authorizationLevel}`).join(" | ")}`,
    `anti-drift: ${input.truth.antiDriftRules[1]?.replace(/\.$/, "")?.toLowerCase() ?? "do not infer extra current-turn capabilities from history or memory"}`
  ];

  if (input.truth.constraints.length > 0) {
    lines.push(`constraints: ${input.truth.constraints.map((constraint) => `${constraint.code}=${constraint.summary}`).join(" | ")}`);
  }

  const content = lines.join("\n");

  return {
    blockId: `authoritative_turn_truth:${input.turnId}`,
    kind: "instruction",
    title: "authoritative current-turn truth",
    content,
    tokenCount: estimateTextTokens(content),
    sourceRefs: [input.turnId],
    metadata: {
      authoritativeTruth: input.truth
    }
  };
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function synthesizeSelectedDurableMemoryObservability(input: {
  continuity: NonNullable<RuntimeMemoryContext["continuity"]>;
}) {
  return {
    route: input.continuity.retrievalPolicy.strategy,
    preferredScopes: input.continuity.retrievalPolicy.typedMemoryBias?.preferredScopes ?? [],
    preferredFamilies: input.continuity.retrievalPolicy.typedMemoryBias?.preferredFamilies ?? [],
    preferredBuckets: input.continuity.retrievalPolicy.typedMemoryBias?.preferredBuckets ?? [],
    items: input.continuity.typedMemory.map((item, index) => ({
      scope: item.scope,
      memoryType: item.memoryType ?? item.kind,
      family: "other",
      bucket: item.memoryType ?? item.kind,
      route: input.continuity.retrievalPolicy.strategy,
      rank: index + 1,
      taskMatch: false,
      selectionStatus: "selected" as const,
      injectionStatus: "not-applicable" as const,
      reasons: [],
      summary: renderStructuredContent((item.payload as { summary?: unknown } | undefined)?.summary)
    })),
    summary: `route=${input.continuity.retrievalPolicy.strategy}; selected=${input.continuity.typedMemory.length}`
  };
}

function buildContextAssemblyObservability(input: {
  authoritativeTruth: AuthoritativeTurnTruth;
  runtimeSelfAwareness: RuntimeSelfAwarenessSurface;
  continuity: NonNullable<RuntimeMemoryContext["continuity"]>;
  session: {
    sessionId: string;
    workspaceId: string;
  };
  selection: {
    exposedToolNames: string[];
  };
  memoryObservability: RuntimeMemoryContext["observability"] | undefined;
  fittedMemory: MemoryInjectionFit;
  budget: ReturnType<typeof createContextAssemblyBudget>;
  budgetResolution: BudgetResolutionDebug | undefined;
  imBoundary?: {
    disclosureMode: "local_only" | "owner_targeted" | "owner_cross_group";
    borrowedConversationKeys: string[];
    personaScopeKind?: "owner_direct" | "shared_default" | "conversation_override";
  };
  promptBlocks: PromptBlockObservability[];
  diagnostics: TurnWarningDetail[];
  projectedInputTokensBeforeFitting: number;
  projectedInputTokensAfterFitting: number;
  remainingHeadroomEstimate: number;
  toolSchemaAccounting: ToolSchemaAccounting;
}) {
  const durableMemory = structuredClone(
    input.memoryObservability?.durableMemory ?? synthesizeSelectedDurableMemoryObservability({ continuity: input.continuity })
  );
  const typedMemoryOutcomes = input.fittedMemory.blockOutcomes.filter((outcome) => outcome.blockId.includes(":typed_memory:"));
  let typedMemoryOutcomeIndex = 0;

  durableMemory.items = durableMemory.items.map((item) => {
    if (item.selectionStatus !== "selected") {
      return {
        ...item,
        injectionStatus: "not-applicable" as const
      };
    }

    const outcome = typedMemoryOutcomes[typedMemoryOutcomeIndex];
    typedMemoryOutcomeIndex += 1;

    if (!outcome || outcome.outcome === "dropped") {
      return {
        ...item,
        injectionStatus: "budget-dropped" as const
      };
    }

    return {
      ...item,
      injectionStatus: outcome.outcome === "partial" ? "partial" as const : "injected" as const
    };
  });

  const continuity = {
    route: input.continuity.retrievalPolicy.strategy,
    blocks: {
      ...input.fittedMemory.continuityBlocks,
      workingSet: {
        ...input.fittedMemory.continuityBlocks.workingSet,
        correctionTarget: input.continuity.workingSet.ref
          ? {
              kind: "working_set" as const,
              sessionId: input.session.sessionId,
              workspaceId: input.session.workspaceId,
              workingSetRef: input.continuity.workingSet.ref
            }
          : undefined
      }
    }
  };
  const authoritativeTruth = {
    packet: input.authoritativeTruth,
    summary: {
      replyPath: input.authoritativeTruth.replyPath,
      guaranteedToolNames: input.authoritativeTruth.capabilityTruth.guaranteedToolNames,
      approvalRequiredCapabilities: input.authoritativeTruth.capabilityTruth.approvalRequiredCapabilities,
      notGuaranteedCapabilities: input.authoritativeTruth.capabilityTruth.notGuaranteedCapabilities,
      actionAuthorizations: input.authoritativeTruth.capabilityTruth.actionAuthorizations,
      antiDriftRules: input.authoritativeTruth.antiDriftRules
    },
    consistency: {
      exposedToolsMatchSelection: sameStringSet(
        input.authoritativeTruth.capabilityTruth.visibleToolNames,
        input.selection.exposedToolNames
      ),
      replyPathMatchesSelfAwareness: input.authoritativeTruth.replyPath === input.runtimeSelfAwareness.replyPath,
      constraintCodesMatch: sameStringSet(
        input.authoritativeTruth.constraints.map((constraint) => constraint.code),
        input.runtimeSelfAwareness.constraints.map((constraint) => constraint.code)
      )
    }
  };
  const driftIssues: Array<{
    code: string;
    severity: "info" | "warning";
    message: string;
    evidence: Record<string, unknown>;
  }> = [];

  const actionAuthorizationConflict = input.authoritativeTruth.capabilityTruth.actionAuthorizations
    .filter((entry) => entry.authorizationLevel !== "guaranteed");
  if (actionAuthorizationConflict.length > 0) {
    driftIssues.push({
      code: "mixed_risk_capability_authorization",
      severity: "info",
      message: "Some visible capabilities require approval or remain non-guaranteed at the action level.",
      evidence: {
        visibleToolNames: input.authoritativeTruth.capabilityTruth.visibleToolNames,
        approvalRequiredCapabilities: input.authoritativeTruth.capabilityTruth.approvalRequiredCapabilities,
        notGuaranteedCapabilities: input.authoritativeTruth.capabilityTruth.notGuaranteedCapabilities,
        actionAuthorizations: actionAuthorizationConflict
      }
    });
  }

  const missedUserMemory = durableMemory.items.filter((item) => item.scope === "user" && item.selectionStatus === "scope-mismatch");
  if (missedUserMemory.length > 0) {
    driftIssues.push({
      code: "user_memory_scope_miss",
      severity: "info",
      message: "User-scoped memory candidates were filtered out before injection.",
      evidence: {
        route: durableMemory.route,
        missedScopes: ["user"],
        reasons: [...new Set(missedUserMemory.flatMap((item) => item.reasons))],
        memoryIds: missedUserMemory.map((item) => item.memoryId).filter((value): value is string => typeof value === "string")
      }
    });
  }

  return {
    authoritativeTruth,
    continuity,
    durableMemory,
    truncation: {
      memoryInjectionBudget: input.budget.memoryInjectionBudget,
      memoryTokensUsed: input.budget.memoryTokensUsed,
      memoryTruncated: input.budget.memoryTruncated,
      items: input.fittedMemory.blockOutcomes.map((outcome) => ({
        blockId: outcome.blockId,
        title: outcome.title,
        layer: outcome.layer,
        outcome: outcome.outcome,
        reason: outcome.reason
      }))
    },
    driftDiagnostics: {
      issues: driftIssues
    },
    diagnostics: input.diagnostics,
    ...(input.imBoundary
      ? {
          imBoundary: input.imBoundary
        }
      : {}),
    ...(input.budgetResolution
      ? {
          contextBudget: {
            budgetResolution: input.budgetResolution,
            selectedMemoryCount: input.fittedMemory.selectedCount,
            injectedMemoryCount: input.fittedMemory.injectedCount,
            droppedMemoryCount: input.fittedMemory.droppedCount,
            ...summarizeMemorySourceRefs(input.fittedMemory),
            promptBlocks: input.promptBlocks,
            projectedInputTokensBeforeFitting: input.projectedInputTokensBeforeFitting,
            projectedInputTokensAfterFitting: input.projectedInputTokensAfterFitting,
            projectedMemoryTokensBeforeFitting: input.fittedMemory.projectedMemoryTokensBeforeFitting,
            projectedMemoryTokensAfterFitting: input.fittedMemory.tokenCount,
            remainingHeadroomEstimate: input.remainingHeadroomEstimate,
            toolSchemaAccounting: input.toolSchemaAccounting
          }
        }
      : {}),
    humanSummary: `truth=${input.authoritativeTruth.replyPath}; continuity=${continuity.blocks.activeTask.injectionStatus}/${continuity.blocks.workingSet.injectionStatus}/${continuity.blocks.recentHistory.injectionStatus}; durable=${durableMemory.items.filter((item) => item.selectionStatus === "selected").length}; diagnostics=${driftIssues.length}`
  };
}

function buildBudgetResolutionDebug(input: {
  budget: BudgetResolution;
  toolSchemaAccounting: ToolSchemaAccounting;
}): BudgetResolutionDebug | undefined {
  const budgetDebug = input.budget.budgetDebug;
  if (!budgetDebug) {
    return undefined;
  }

  const parsed = BudgetResolutionDebugSchema.safeParse(budgetDebug);
  return parsed.success ? parsed.data : undefined;
}

function mapPromptContractLayerToObservabilityLayer(block: RuntimeContextBlock): PromptBlockObservability["layer"] {
  if (block.blockId.startsWith("authoritative_turn_truth:")) {
    return "authoritative_truth";
  }

  if (block.blockId.startsWith("runtime_self_awareness:") || block.blockId.startsWith("continuation:")) {
    return "system_instruction";
  }

  if (block.kind === "system") {
    return "system_instruction";
  }

  if (block.kind === "user_input") {
    return "user_input";
  }

  return "system_instruction";
}

function mapMemoryOutcomeToPromptStatus(outcome: BlockOutcome["outcome"]): PromptBlockObservability["status"] {
  switch (outcome) {
    case "full":
      return "included";
    case "skeleton":
    case "partial":
      return "partial";
    case "dropped":
      return "dropped";
  }
}

function buildPromptBlockObservability(input: {
  basePromptBlocks: RuntimeContextBlock[];
  authoritativeTruthBlock: RuntimeContextBlock;
  timeContextBlock: RuntimeContextBlock;
  runtimeSelfAwarenessBlock: RuntimeContextBlock;
  continuationBlocks: RuntimeContextBlock[];
  fittedMemory: MemoryInjectionFit;
  userInputBlock: RuntimeContextBlock;
  toolSchemaAccounting: ToolSchemaAccounting;
}): PromptBlockObservability[] {
  const promptBlocks: PromptBlockObservability[] = [
    ...input.basePromptBlocks.map((block) => ({
      blockId: block.blockId,
      kind: block.kind,
      layer: mapPromptContractLayerToObservabilityLayer(block),
      title: block.title,
      estimatedTokens: block.tokenCount ?? estimateTextTokens(block.content),
      status: "included" as const
    })),
    {
      blockId: input.authoritativeTruthBlock.blockId,
      kind: input.authoritativeTruthBlock.kind,
      layer: "authoritative_truth",
      title: input.authoritativeTruthBlock.title,
      estimatedTokens: input.authoritativeTruthBlock.tokenCount ?? estimateTextTokens(input.authoritativeTruthBlock.content),
      status: "included"
    },
    {
      blockId: input.timeContextBlock.blockId,
      kind: input.timeContextBlock.kind,
      layer: "time_context",
      title: input.timeContextBlock.title,
      estimatedTokens: input.timeContextBlock.tokenCount ?? estimateTextTokens(input.timeContextBlock.content),
      status: "included"
    },
    {
      blockId: input.runtimeSelfAwarenessBlock.blockId,
      kind: input.runtimeSelfAwarenessBlock.kind,
      layer: "system_instruction",
      title: input.runtimeSelfAwarenessBlock.title,
      estimatedTokens: input.runtimeSelfAwarenessBlock.tokenCount ?? estimateTextTokens(input.runtimeSelfAwarenessBlock.content),
      status: "included"
    },
    ...input.continuationBlocks.map((block) => ({
      blockId: block.blockId,
      kind: block.kind,
      layer: "system_instruction" as const,
      title: block.title,
      estimatedTokens: block.tokenCount ?? estimateTextTokens(block.content),
      status: "included" as const
    })),
    ...input.fittedMemory.blockOutcomes.map((outcome) => ({
      blockId: outcome.blockId,
      kind: outcome.kind,
      layer: outcome.layer,
      title: outcome.title,
      estimatedTokens: outcome.estimatedTokens,
      status: mapMemoryOutcomeToPromptStatus(outcome.outcome),
      reason: outcome.reason
    })),
    {
      blockId: input.userInputBlock.blockId,
      kind: input.userInputBlock.kind,
      layer: "user_input",
      title: input.userInputBlock.title,
      estimatedTokens: input.userInputBlock.tokenCount ?? estimateTextTokens(input.userInputBlock.content),
      status: "included"
    }
  ];

  if (input.toolSchemaAccounting.status === "estimated") {
    promptBlocks.push({
      blockId: "tool_schema:all",
      kind: "tool_schema",
      layer: "tool_schema",
      title: "tool schemas",
      estimatedTokens: input.toolSchemaAccounting.totalTokens ?? 0,
      status: "included"
    });
  }

  return promptBlocks;
}

function summarizeMemorySourceRefs(fittedMemory: MemoryInjectionFit) {
  const selected = [...new Set(fittedMemory.blockOutcomes.flatMap((outcome) => outcome.sourceRefs))];
  const injected = [...new Set(
    fittedMemory.blockOutcomes
      .filter((outcome) => outcome.outcome !== "dropped")
      .flatMap((outcome) => outcome.sourceRefs)
  )];
  const dropped = [...new Set(
    fittedMemory.blockOutcomes
      .filter((outcome) => outcome.outcome === "dropped")
      .flatMap((outcome) => outcome.sourceRefs)
  )];

  return {
    selectedMemorySourceRefs: selected,
    injectedMemorySourceRefs: injected,
    droppedMemorySourceRefs: dropped
  };
}

function buildRuntimeSelfAwareness(input: {
  request: Pick<TurnRequest, "source" | "resumeFrom" | "turnId" | "input" | "imContext">;
  resolvedMode: RuntimeRequest["resolvedMode"];
  model: RuntimeRequest["model"];
  toolExposure: ContextToolExposure;
  activeTask?: Pick<TaskState, "taskId" | "status" | "blockingReason" | "checkpointRef">;
  continuation?: {
    pendingExecution: PendingExecution;
    control: ExecutionControlInput;
  };
}): RuntimeSelfAwarenessSurface {
  const replyPath = input.continuation || (typeof input.request.resumeFrom === "string" && input.request.resumeFrom.length > 0)
    ? "continuation"
    : input.activeTask?.status === "blocked" || typeof input.activeTask?.blockingReason === "string"
      ? "blocked"
      : "normal";
  const constraints: RuntimeConstraintSurface[] = replyPath === "blocked" && input.activeTask?.blockingReason
    ? [{
        code: "task_blocked",
        summary: input.activeTask.blockingReason,
        blocking: true,
        metadata: {
          taskId: input.activeTask.taskId,
          checkpointRef: input.activeTask.checkpointRef
        }
      }]
    : [];
  const continuationPermissionContext = buildContinuationPermissionContext(input.continuation);

  if (continuationPermissionContext?.bashTrust) {
    constraints.push({
      code: "bash_trust_active",
      summary: "bash is approved for the rest of this turn",
      blocking: false,
      metadata: {
        decisionId: continuationPermissionContext.bashTrust.decisionId,
        scope: continuationPermissionContext.bashTrust.scope,
        approverId: continuationPermissionContext.bashTrust.approverId
      }
    });
  }

  const exposedToolNames = input.toolExposure.exposedTools.map((tool) => tool.name);
  const hasOwnerPrivateSelfAwarenessTools = ["inspect_source", "inspect_build", "inspect_docs", "inspect_config"]
    .some((toolName) => exposedToolNames.includes(toolName));
  const allowsOwnerPrivateMutation = ["write", "edit", "bash"].some((toolName) => exposedToolNames.includes(toolName));
  const selfAwarenessIntent = inspectSelfAwarenessIntent({ input: input.request.input });
  const conversationScope = input.request.imContext?.boundary.conversationScope;

  if (hasOwnerPrivateSelfAwarenessTools) {
    constraints.push({
      code: "owner_private_self_awareness_read",
      summary: "owner-private read capability covers Endec source/build/docs/config with masked secrets by default",
      blocking: false
    });
    constraints.push({
      code: allowsOwnerPrivateMutation
        ? "owner_private_self_awareness_mutation_enabled"
        : "owner_private_self_awareness_mutation_requires_explicit_request",
      summary: allowsOwnerPrivateMutation
        ? "source/config modification tools are available only because the owner explicitly requested them for this turn"
        : "modify config/source only on an explicit owner request",
      blocking: false
    });
  } else if (conversationScope === "shared" && selfAwarenessIntent.kind === "self_awareness") {
    constraints.push({
      code: "shared_self_awareness_denied",
      summary: "shared chats cannot inspect Endec source/config/secrets or self-modify",
      blocking: true
    });
  }

  return {
    schemaVersion: 1,
    contractVersion: "ws5.runtime-self-awareness.v1",
    source: input.request.source,
    channel: input.request.source,
    mode: input.resolvedMode,
    currentModel: normalizeRuntimeModel(input.model),
    exposedToolNames,
    replyPath,
    constraints
  };
}

function buildRuntimeSelfAwarenessBlock(input: {
  turnId: string;
  surface: RuntimeSelfAwarenessSurface;
}): RuntimeContextBlock {
  const lines = [
    `source/channel: ${input.surface.source}`,
    `mode: ${input.surface.mode}`,
    `current model: ${input.surface.currentModel ? `${input.surface.currentModel.providerId}/${input.surface.currentModel.modelId}` : "unknown"}`,
    `reply path: ${input.surface.replyPath}`,
    `exposed tools: ${input.surface.exposedToolNames.length > 0 ? input.surface.exposedToolNames.join(", ") : "(none)"}`
  ];

  if (input.surface.constraints.length > 0) {
    lines.push(`constraints: ${input.surface.constraints.map((constraint) => `${constraint.code}=${constraint.summary}`).join(" | ")}`);
  }

  const content = lines.join("\n");

  return {
    blockId: `runtime_self_awareness:${input.turnId}`,
    kind: "instruction",
    title: "runtime self-awareness",
    content,
    tokenCount: estimateTextTokens(content),
    sourceRefs: [input.turnId],
    metadata: {
      selfAwareness: input.surface
    }
  };
}

function buildCurrentTurnTimeContextForAssembly(input: {
  request: Pick<TurnRequest, "source" | "conversationRef">;
  recentHistoryEntries: RecentHistoryEntry[];
  resolvedOwnerPreferences?: Pick<ResolvedOwnerPreferences, "timezone" | "timezoneSource">;
  serverTimezone: string;
}): CurrentTurnTimeContext {
  const previousInteraction = selectRecentInteractionAnchor(input.recentHistoryEntries);
  return buildCurrentTurnTimeContext({
    nowUtc: new Date().toISOString(),
    previousInteractionAtUtc: previousInteraction?.createdAt,
    ownerTimezone: input.resolvedOwnerPreferences?.timezoneSource === "owner_preference"
      ? input.resolvedOwnerPreferences.timezone
      : undefined,
    serverTimezone: input.serverTimezone
  });
}

function buildCurrentTimeContextInstructionBlock(input: {
  turnId: string;
  timeContext: CurrentTurnTimeContext;
}): RuntimeContextBlock {
  const block = buildCurrentTimeContextBlock(input);
  return {
    ...block,
    tokenCount: estimateTextTokens(block.content)
  };
}

function buildContinuationBlock(input: {
  pendingExecution: PendingExecution;
  control: ExecutionControlInput;
}): RuntimeContextBlock {
  const checkpointRef = input.pendingExecution.checkpointRef
    ?? input.pendingExecution.frame.checkpointRef
    ?? `checkpoint:${input.pendingExecution.frame.turnId}`;
  const lines = [
    `Continue the existing turn ${input.pendingExecution.frame.turnId} from frame ${input.pendingExecution.frameRef}.`,
    `Checkpoint: ${checkpointRef}.`,
    `Action: ${input.control.action}.`,
    `Phase: ${input.pendingExecution.frame.phase}.`,
    `Step: ${input.pendingExecution.frame.step}.`
  ];

  if (input.control.action === "resume" && input.control.input) {
    lines.push(`Operator input: ${input.control.input}`);
  }

  if ((input.control.action === "approve" || input.control.action === "deny") && input.control.decisionId) {
    lines.push(`Decision: ${input.control.decisionId}.`);
  }

  if (input.pendingExecution.frame.pendingToolCalls.length > 0) {
    lines.push(`Pending tool calls: ${JSON.stringify(input.pendingExecution.frame.pendingToolCalls)}.`);
  }

  if (input.pendingExecution.frame.pendingPermissionDecisions.length > 0) {
    lines.push(`Pending permission decisions: ${JSON.stringify(input.pendingExecution.frame.pendingPermissionDecisions)}.`);
  }

  const content = lines.join("\n");

  return {
    blockId: `continuation:${input.pendingExecution.pendingExecutionId}`,
    kind: "instruction",
    title: "pending execution continuation",
    content,
    tokenCount: estimateTextTokens(content),
    sourceRefs: [
      input.pendingExecution.frame.turnId,
      input.pendingExecution.frameRef,
      checkpointRef
    ],
    metadata: {
      pendingExecutionId: input.pendingExecution.pendingExecutionId,
      frameRef: input.pendingExecution.frameRef,
      checkpointRef,
      continuationAction: input.control.action,
      continuationKind: input.pendingExecution.frame.continuation.continuationKind,
      pendingPhase: input.pendingExecution.frame.phase,
      pendingStep: input.pendingExecution.frame.step
    }
  };
}
