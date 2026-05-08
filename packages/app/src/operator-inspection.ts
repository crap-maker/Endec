import {
  InspectOperatorTurnRequestSchema,
  OperatorTurnInspectionSchema,
  type AuthoritativeTurnTruth,
  type ContextAssemblyObservability,
  type ContextAssemblyTruncationItem,
  type DurableMemorySelectionItem,
  type InspectOperatorTurnRequest,
  type OperatorActionHint,
  type OperatorContextSummary,
  type OperatorCorrectionTargetHint,
  type OperatorExplanationItem,
  type OperatorRecoverySnapshot,
  type OperatorTurnInspection,
  type OperatorTurnInspectionDetailSection,
  type OperatorTurnInspectionSummaryState,
  type WorkingSetCorrectionTarget
} from "@endec/domain";

type OperatorInspectionRecoverySource = {
  getRecoverySnapshot(input: { sessionId: string; turnId?: string; frameRef?: string }): Promise<OperatorRecoverySnapshot | null>;
};

function resolveOriginalOperatorContext(snapshot: OperatorRecoverySnapshot): {
  truth: AuthoritativeTurnTruth;
  observability: ContextAssemblyObservability;
} | null {
  const originalTruth = snapshot.authoritativeTruth;
  const originalObservability = snapshot.observability;
  if (!originalTruth || !originalObservability) {
    return null;
  }

  return {
    truth: originalTruth,
    observability: originalObservability
  };
}

export function createOperatorTurnInspector(deps: {
  recoveryStore: OperatorInspectionRecoverySource;
}) {
  return async function inspectOperatorTurn(input: InspectOperatorTurnRequest): Promise<OperatorTurnInspection | null> {
    const request = InspectOperatorTurnRequestSchema.parse(input);
    const snapshot = await deps.recoveryStore.getRecoverySnapshot({
      sessionId: request.target.sessionId,
      turnId: request.target.turnId,
      frameRef: request.target.frameRef
    });

    if (!snapshot?.runtimeSelfAwareness) {
      return null;
    }

    if (snapshot.workspaceId !== request.target.workspaceId) {
      return null;
    }

    const originalContext = resolveOriginalOperatorContext(snapshot);
    if (!originalContext) {
      return null;
    }
    const truth = originalContext.truth;
    const observability = originalContext.observability;
    const correction = buildCorrectionSummary({ observability });
    const continuation = buildContinuation({
      snapshot,
      truth,
      observability,
      correctionTargets: correction.recommendedTargets
    });
    const contextSummary = buildContextSummary({
      observability,
      correctionSummary: correction.summaryText,
      continuation
    });
    const summary = buildTopLevelSummary({ snapshot, truth });
    const nextActions = buildNextActions({ snapshot, correctionTargets: correction.recommendedTargets });
    const explanationItems = buildExplanationItems({
      snapshot,
      truth,
      observability,
      continuation,
      correctionTargets: correction.recommendedTargets,
      detail: request.detail
    });
    const inspection = OperatorTurnInspectionSchema.parse({
      target: {
        ...request.target,
        turnId: request.target.turnId ?? snapshot.turnId,
        frameRef: request.target.frameRef ?? snapshot.frameRef
      },
      summary,
      explanation: {
        headline: buildExplanationHeadline({ summary }),
        summary: buildExplanationSummary({ summary, truth, snapshot, contextSummary }),
        nextActions,
        explanations: explanationItems
      },
      truth,
      context: {
        observability,
        summary: contextSummary
      },
      continuation,
      correction: {
        available: correction.available,
        workingSetTarget: correction.workingSetTarget,
        typedMemoryTargetCount: correction.typedMemoryTargetCount,
        recommendedTargets: correction.recommendedTargets
      }
    });

    return inspection;
  };
}

function buildCorrectionSummary(input: { observability: ContextAssemblyObservability }): {
  available: boolean;
  workingSetTarget?: WorkingSetCorrectionTarget;
  typedMemoryTargetCount: number;
  recommendedTargets: OperatorCorrectionTargetHint[];
  summaryText: string;
} {
  const workingSetTarget = input.observability.continuity.blocks.workingSet.correctionTarget;
  const typedMemoryTargets = input.observability.durableMemory.items
    .filter((item) => item.selectionStatus !== "corrected-out")
    .map((item) => ({ item, target: item.correctionTarget }))
    .filter((entry): entry is {
      item: DurableMemorySelectionItem;
      target: NonNullable<DurableMemorySelectionItem["correctionTarget"]>;
    } => !!entry.target);
  const typedMemoryTargetHints = dedupeByTargetId(typedMemoryTargets.map(({ item, target }): OperatorCorrectionTargetHint => ({
    targetId: target.memoryId,
    targetKind: "typed_memory",
    summary: summarizeTypedMemoryCorrectionTarget(item, target.memoryId),
    reason: explainTypedMemoryCorrectionTarget(item),
    status: `${item.selectionStatus}/${item.injectionStatus}`,
    detailRef: `typed_memory:${target.memoryId}`,
    sourceRefs: [target.memoryId, item.writeId, item.sourceTurnId].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    ),
    recommendedOperation: "mark_memory_stale"
  })));
  const recommendedTargets: OperatorCorrectionTargetHint[] = [
    ...(workingSetTarget
      ? [
          {
            targetId: workingSetTarget.workingSetRef ?? `${workingSetTarget.sessionId}:working_set`,
            targetKind: "working_set" as const,
            summary: "Working set correction target is available.",
            reason: "Continuity observability exposed a working-set correction target.",
            status: input.observability.continuity.blocks.workingSet.injectionStatus,
            detailRef: "working_set",
            sourceRefs: [
              workingSetTarget.workingSetRef,
              ...input.observability.continuity.blocks.workingSet.sourceRefs
            ].filter((value): value is string => typeof value === "string" && value.length > 0),
            recommendedOperation: "refresh_working_set" as const
          }
        ]
      : []),
    ...typedMemoryTargetHints
  ];

  return {
    available: recommendedTargets.length > 0,
    workingSetTarget,
    typedMemoryTargetCount: typedMemoryTargetHints.length,
    recommendedTargets,
    summaryText: summarizeCorrectionAvailability({
      hasWorkingSetTarget: !!workingSetTarget,
      typedMemoryTargetCount: typedMemoryTargetHints.length
    })
  };
}

function dedupeByTargetId(targets: OperatorCorrectionTargetHint[]) {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.targetId)) {
      return false;
    }

    seen.add(target.targetId);
    return true;
  });
}

function summarizeTypedMemoryCorrectionTarget(item: DurableMemorySelectionItem, targetId: string) {
  const memoryLabel = item.summary ?? item.writeId ?? targetId;
  return `Typed memory ${targetId} can be corrected (${memoryLabel}).`;
}

function explainTypedMemoryCorrectionTarget(item: DurableMemorySelectionItem) {
  const reasons = item.reasons.length > 0 ? ` Reasons: ${item.reasons.join(", ")}.` : "";
  return `Durable memory observability exposed an active typed-memory correction target with selectionStatus=${item.selectionStatus} and injectionStatus=${item.injectionStatus}.${reasons}`;
}

function summarizeCorrectionAvailability(input: {
  hasWorkingSetTarget: boolean;
  typedMemoryTargetCount: number;
}) {
  const parts = [
    input.hasWorkingSetTarget ? "working set correction target available" : undefined,
    input.typedMemoryTargetCount > 0 ? `${input.typedMemoryTargetCount} typed memory correction target(s) available` : undefined
  ].filter((value): value is string => !!value);

  return parts.length > 0
    ? `${parts.join("; ")}.`
    : "No correction targets are available.";
}

function buildContinuation(input: {
  snapshot: OperatorRecoverySnapshot;
  truth: AuthoritativeTurnTruth;
  observability: ContextAssemblyObservability;
  correctionTargets: OperatorCorrectionTargetHint[];
}): NonNullable<OperatorTurnInspection["continuation"]> {
  const constraints = mergeContinuationConstraints(
    input.truth.constraints,
    input.snapshot.runtimeSelfAwareness?.constraints ?? []
  );
  const actionAuthorization = resolveRelevantAuthorization(input.truth, input.snapshot.pendingDecision?.reasonText);

  return {
    state: mapContinuationState(input.snapshot),
    replyPath: input.snapshot.runtimeSelfAwareness?.replyPath ?? input.truth.replyPath,
    allowedActions: input.snapshot.allowedActions.map((action) => ({
      code: `${action}-pending-execution`,
      kind: action,
      summary: summarizeExecutionAction(action, input.snapshot),
      targetRef: action === "approve" || action === "deny" ? input.snapshot.pendingApprovalRef : input.snapshot.pendingExecutionId,
      relatedRefs: [input.snapshot.turnId, input.snapshot.frameRef, input.snapshot.checkpointRef].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      ),
      requiresApproval: action === "approve"
    })),
    blockedBy: input.snapshot.blockedBy,
    waitingReason: input.snapshot.waitingReason,
    pendingExecutionId: input.snapshot.pendingExecutionId,
    frameRef: input.snapshot.frameRef,
    checkpointRef: input.snapshot.checkpointRef,
    pendingDecision: input.snapshot.pendingDecision,
    constraints,
    actionAuthorization,
    activeTaskSummary: summarizeContinuityBlock("activeTask", input.observability.continuity.blocks.activeTask),
    workingSetSummary: summarizeContinuityBlock("workingSet", input.observability.continuity.blocks.workingSet),
    correctionHints: input.correctionTargets
  };
}

function mapContinuationState(snapshot: OperatorRecoverySnapshot): NonNullable<OperatorTurnInspection["continuation"]>["state"] {
  if (snapshot.state === "awaiting_permission" || snapshot.state === "awaiting_user_decision") {
    return "blocked";
  }

  if (snapshot.state === "ready") {
    return "recoverable";
  }

  if (snapshot.runtimeSelfAwareness?.replyPath === "continuation") {
    return "continuation";
  }

  if (snapshot.hasPendingExecution) {
    return "blocked";
  }

  return "normal";
}

function mergeContinuationConstraints(
  truthConstraints: AuthoritativeTurnTruth["constraints"],
  runtimeConstraints: NonNullable<OperatorRecoverySnapshot["runtimeSelfAwareness"]>["constraints"]
) {
  const seen = new Set<string>();
  return [...truthConstraints, ...runtimeConstraints].filter((constraint) => {
    const signature = JSON.stringify([constraint.code, constraint.summary, constraint.blocking, constraint.metadata ?? null]);
    if (seen.has(signature)) {
      return false;
    }

    seen.add(signature);
    return true;
  });
}

function summarizeContinuityBlock(
  label: "activeTask" | "workingSet",
  block: ContextAssemblyObservability["continuity"]["blocks"][typeof label]
) {
  const title = block.title ? `${block.title}: ` : "";
  const reason = block.reason ? ` Reason: ${block.reason}` : "";
  const refs = block.sourceRefs.length > 0 ? ` Refs: ${block.sourceRefs.join(", ")}.` : "";
  const selectedBy = block.selectedBy ? ` Selected by ${block.selectedBy}.` : "";

  return `${title}${label} ${block.selectionStatus}/${block.injectionStatus}.${reason}${selectedBy}${refs}`;
}

function buildContextSummary(input: {
  observability: ContextAssemblyObservability;
  correctionSummary: string;
  continuation: NonNullable<OperatorTurnInspection["continuation"]>;
}): OperatorContextSummary {
  const truth = input.observability.authoritativeTruth.summary;
  const continuity = input.observability.continuity.blocks;
  const durableItems = input.observability.durableMemory.items;
  const truncation = input.observability.truncation;
  const driftIssues = input.observability.driftDiagnostics.issues;
  const contextBudget = input.observability.contextBudget;
  const budgetSummary = contextBudget ? summarizeBudgetSummary(contextBudget) : undefined;

  return {
    headline: `Operator context is ${truth.replyPath}.`,
    truthSummary: `${truth.guaranteedToolNames.length} guaranteed tool(s); ${truth.approvalRequiredCapabilities.length} approval-required capability/capabilities; ${truth.notGuaranteedCapabilities.length} not-guaranteed capability/capabilities.`,
    continuitySummary: `activeTask=${continuity.activeTask.injectionStatus}; workingSet=${continuity.workingSet.injectionStatus}; recentHistory=${continuity.recentHistory.injectionStatus}.`,
    durableMemorySummary: durableItems.length > 0
      ? `${durableItems.filter((item) => item.selectionStatus === "selected").length}/${durableItems.length} durable memory item(s) selected.`
      : "No durable memory items are exposed in this inspection projection.",
    truncationSummary: truncation.memoryTruncated
      ? `${countTruncationOutcomes(truncation.items, "dropped")} context item(s) dropped; memory budget ${truncation.memoryTokensUsed}/${truncation.memoryInjectionBudget}.${budgetSummary ? ` ${budgetSummary}` : ""}`
      : `No memory truncation reported; memory budget ${truncation.memoryTokensUsed}/${truncation.memoryInjectionBudget}.${budgetSummary ? ` ${budgetSummary}` : ""}`,
    driftDiagnosticsSummary: driftIssues.length > 0
      ? `${driftIssues.length} diagnostic item(s): ${driftIssues.map((issue) => issue.code).join(", ")}.`
      : "No drift diagnostics reported.",
    budgetSummary,
    continuationSummary: summarizeContinuationForContext(input.continuation),
    correctionSummary: input.correctionSummary,
    selectedBy: [
      continuity.activeTask.selectedBy,
      continuity.workingSet.selectedBy,
      continuity.recentHistory.selectedBy
    ].filter((value): value is NonNullable<typeof value> => !!value)
  };
}

function summarizeContinuationForContext(continuation: NonNullable<OperatorTurnInspection["continuation"]>) {
  const blocker = continuation.blockedBy ?? continuation.waitingReason ?? "operator action";
  const pendingDecision = continuation.pendingDecision?.decisionId
    ? ` decision ${continuation.pendingDecision.decisionId}`
    : " no pending decision";
  const allowed = continuation.allowedActions.length > 0
    ? continuation.allowedActions.map((action) => action.kind).join(", ")
    : "none";
  const auth = continuation.actionAuthorization
    ? ` ${continuation.actionAuthorization.actionClass} is ${continuation.actionAuthorization.authorizationLevel}.`
    : "";

  return `${continuation.state} continuation via ${continuation.replyPath}; blocked by ${blocker};${pendingDecision}; allowed actions: ${allowed}.${auth}`;
}

function buildTopLevelSummary(input: {
  snapshot: OperatorRecoverySnapshot;
  truth: AuthoritativeTurnTruth;
}): OperatorTurnInspection["summary"] {
  const state = mapSummaryState(input.snapshot);
  return {
    state,
    headline: state === "blocked"
      ? `Turn ${input.snapshot.turnId ?? input.snapshot.sessionId} is blocked by ${input.snapshot.blockedBy ?? input.snapshot.waitingReason ?? "operator action"}.`
      : `Turn ${input.snapshot.turnId ?? input.snapshot.sessionId} is ${state} with ${input.truth.replyPath} reply path.`
  };
}

function mapSummaryState(snapshot: OperatorRecoverySnapshot): OperatorTurnInspectionSummaryState {
  if (snapshot.state === "awaiting_permission" || snapshot.state === "awaiting_user_decision") {
    return "blocked";
  }

  if (snapshot.state === "ready") {
    return "recoverable";
  }

  return snapshot.runtimeSelfAwareness?.replyPath === "continuation" ? "continuation" : "normal";
}

function buildExplanationHeadline(input: { summary: OperatorTurnInspection["summary"] }) {
  return input.summary.headline;
}

function buildExplanationSummary(input: {
  summary: OperatorTurnInspection["summary"];
  truth: AuthoritativeTurnTruth;
  snapshot: OperatorRecoverySnapshot;
  contextSummary: OperatorContextSummary;
}) {
  const pending = input.snapshot.pendingDecision
    ? `Pending decision ${input.snapshot.pendingDecision.decisionId} requires ${input.snapshot.pendingDecision.behavior} handling because ${input.snapshot.pendingDecision.reasonText}.`
    : "No pending permission decision is exposed.";
  const continuation = input.contextSummary.continuationSummary
    ? ` Continuation: ${input.contextSummary.continuationSummary}`
    : "";

  return `${input.summary.headline} ${pending}${continuation} Truth reports ${input.contextSummary.truthSummary} Use structured nextActions for operator decisions.`;
}

function buildNextActions(input: {
  snapshot: OperatorRecoverySnapshot;
  correctionTargets: OperatorCorrectionTargetHint[];
}): OperatorActionHint[] {
  const executionActions = input.snapshot.allowedActions.length === 0
    ? [
        {
          code: "inspect-recovery-state",
          kind: "inspect" as const,
          summary: "Inspect recovery state before taking action.",
          targetRef: input.snapshot.turnId
        }
      ]
    : input.snapshot.allowedActions.map((action): OperatorActionHint => ({
      code: action === "approve"
        ? "approve-pending-decision"
        : action === "deny"
          ? "deny-pending-decision"
          : action === "cancel"
            ? "cancel-pending-execution"
            : "resume-pending-execution",
      kind: action,
      summary: summarizeExecutionAction(action, input.snapshot),
      targetRef: action === "approve" || action === "deny" ? input.snapshot.pendingApprovalRef : input.snapshot.pendingExecutionId,
      relatedRefs: [input.snapshot.turnId, input.snapshot.frameRef, input.snapshot.checkpointRef].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      ),
      riskLevel: action === "approve" ? "medium" : "low",
      requiresApproval: action === "approve"
    }));

  if (input.correctionTargets.length === 0) {
    return executionActions;
  }

  const primaryTarget = input.correctionTargets[0];
  return [
    ...executionActions,
    {
      code: "inspect-correction-targets",
      kind: "inspect",
      summary: `${input.correctionTargets.length} correction target(s) are available for detail inspection.`,
      targetRef: "correction",
      relatedRefs: input.correctionTargets.map((target) => target.targetId),
      riskLevel: "low",
      requiresApproval: false
    },
    {
      code: "apply-correction",
      kind: "correct",
      summary: `Apply correction through the canonical correction write seam for ${primaryTarget.targetKind} target ${primaryTarget.targetId}.`,
      targetRef: primaryTarget.targetId,
      relatedRefs: input.correctionTargets.map((target) => target.targetId),
      riskLevel: "medium",
      requiresApproval: false
    }
  ];
}

function summarizeExecutionAction(action: OperatorRecoverySnapshot["allowedActions"][number], snapshot: OperatorRecoverySnapshot) {
  switch (action) {
    case "approve":
      return `Approve pending decision ${snapshot.pendingApprovalRef ?? snapshot.pendingDecision?.decisionId ?? "unknown"}.`;
    case "deny":
      return `Deny pending decision ${snapshot.pendingApprovalRef ?? snapshot.pendingDecision?.decisionId ?? "unknown"}.`;
    case "cancel":
      return `Cancel pending execution ${snapshot.pendingExecutionId ?? snapshot.turnId ?? "unknown"}.`;
    case "resume":
      return `Resume pending execution ${snapshot.pendingExecutionId ?? snapshot.turnId ?? "unknown"}.`;
  }
}

function buildExplanationItems(input: {
  snapshot: OperatorRecoverySnapshot;
  truth: AuthoritativeTurnTruth;
  observability: ContextAssemblyObservability;
  continuation: NonNullable<OperatorTurnInspection["continuation"]>;
  correctionTargets: OperatorCorrectionTargetHint[];
  detail?: InspectOperatorTurnRequest["detail"];
}): OperatorExplanationItem[] {
  const items: OperatorExplanationItem[] = [
    {
      code: "truth-source",
      summary: "Capability and reply-path facts come from AuthoritativeTurnTruth.",
      subjectRef: "truth",
      severity: "info"
    },
    {
      code: "observability-summary",
      summary: input.observability.humanSummary ?? "Context observability is summarized for operator consumption.",
      subjectRef: "context.summary",
      severity: "info"
    }
  ];

  const relevantAuthorization = input.continuation.actionAuthorization;
  if (input.continuation.state === "blocked" || input.snapshot.pendingDecision) {
    const constraintCodes = (input.continuation.constraints ?? [])
      .filter((constraint) => constraint.blocking)
      .map((constraint) => constraint.code);
    items.push({
      code: "blocked-continuation",
      summary: `Continuation is blocked by ${input.continuation.blockedBy ?? input.continuation.waitingReason ?? "operator action"}${input.snapshot.pendingDecision ? ` on decision ${input.snapshot.pendingDecision.decisionId}` : ""}${constraintCodes.length > 0 ? ` with blocking constraint(s): ${constraintCodes.join(", ")}` : ""}.`,
      subjectRef: "continuation",
      relatedRefs: [input.continuation.pendingExecutionId, input.continuation.frameRef, input.continuation.checkpointRef].filter(
        (value): value is string => !!value
      ),
      severity: "warning"
    });
  }

  if (relevantAuthorization) {
    items.push({
      code: "action-authorization",
      summary: `${relevantAuthorization.actionClass} is ${relevantAuthorization.authorizationLevel}: ${relevantAuthorization.boundaryReason}`,
      subjectRef: "truth.capabilityTruth.actionAuthorizations",
      severity: relevantAuthorization.authorizationLevel === "guaranteed" ? "info" : "warning"
    });
  }

  if (input.snapshot.pendingDecision) {
    items.push({
      code: "pending-decision",
      summary: input.snapshot.pendingDecision.reasonText,
      subjectRef: `pendingDecision:${input.snapshot.pendingDecision.decisionId}`,
      relatedRefs: [input.snapshot.frameRef, input.snapshot.checkpointRef].filter((value): value is string => !!value),
      severity: "warning"
    });
  }

  if (input.correctionTargets.length > 0) {
    items.push({
      code: "correction-available",
      summary: `${input.correctionTargets.length} correction target(s) are available from context observability.`,
      detail: input.correctionTargets.map((target) => `${target.targetKind}:${target.targetId}`).join(", "),
      subjectRef: "correction",
      relatedRefs: input.correctionTargets.map((target) => target.targetId),
      severity: "info"
    });
  } else {
    items.push({
      code: "correction-summary",
      summary: "No correction targets are available.",
      subjectRef: "correction",
      severity: "info"
    });
  }

  if (input.observability.contextBudget) {
    const budgetResolution = input.observability.contextBudget.budgetResolution;
    const providerModel = [budgetResolution.providerId, budgetResolution.modelId].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    ).join("/") || "unknown";
    items.push({
      code: "budget-profile",
      summary: `Budget profile ${budgetResolution.budgetProfile} resolved input=${budgetResolution.effectiveInputTokenBudget} and memory=${budgetResolution.effectiveMemoryInjectionBudget} from provider capability ${providerModel} maxContextTokens=${budgetResolution.maxContextTokens ?? "unknown"}.`,
      detail: summarizeBudgetResolutionDetail(input.observability.contextBudget),
      subjectRef: "context.observability.contextBudget",
      severity: "info"
    });
  }

  if (shouldExpandSection(input.detail, "continuation")) {
    items.push({
      code: "continuation-detail",
      summary: `state=${input.continuation.state}; replyPath=${input.continuation.replyPath}; allowedActions=${input.continuation.allowedActions.map((action) => action.kind).join(",") || "none"}; pendingExecution=${input.continuation.pendingExecutionId ?? "none"}; constraints=${(input.continuation.constraints ?? []).map((constraint) => constraint.code).join(",") || "none"}; activeTask=${input.continuation.activeTaskSummary ?? "unavailable"}; workingSet=${input.continuation.workingSetSummary ?? "unavailable"}.`,
      subjectRef: "continuation",
      relatedRefs: [input.snapshot.turnId, input.snapshot.frameRef, input.snapshot.checkpointRef].filter((value): value is string => !!value),
      severity: "info"
    });
  }

  if ((shouldExpandSection(input.detail, "budget") || shouldExpandSection(input.detail, "truncation")) && input.observability.contextBudget) {
    const budget = input.observability.contextBudget;
    items.push({
      code: "budget-detail",
      summary: `selected=${budget.selectedMemoryCount}; injected=${budget.injectedMemoryCount}; dropped=${budget.droppedMemoryCount}; profile=${budget.budgetResolution.budgetProfile}; input=${budget.budgetResolution.effectiveInputTokenBudget}; memory=${budget.budgetResolution.effectiveMemoryInjectionBudget}; usableContext=${budget.budgetResolution.usableContext ?? "unknown"}.`,
      detail: summarizeBudgetResolutionDetail(budget),
      subjectRef: "context.observability.contextBudget",
      severity: "info"
    });
  }

  if (shouldExpandSection(input.detail, "correction")) {
    items.push({
      code: "correction-detail",
      summary: input.correctionTargets.length > 0
        ? `${input.correctionTargets.length} correction target(s) are recommended.`
        : "Correction detail requested; no correction targets are available.",
      subjectRef: "correction",
      severity: "info"
    });
  }

  return items;
}

function summarizeBudgetSummary(contextBudget: NonNullable<ContextAssemblyObservability["contextBudget"]>) {
  const { budgetResolution } = contextBudget;
  const providerModel = [budgetResolution.providerId, budgetResolution.modelId].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  ).join("/") || "unknown";
  const capHits = budgetResolution.capHits ?? [];
  const unestimatedComponents = budgetResolution.unestimatedComponents ?? [];
  const parts = [
    `profile=${budgetResolution.budgetProfile}`,
    `provider=${providerModel}`,
    `maxContextTokens=${budgetResolution.maxContextTokens ?? "unknown"}`,
    `usableContext=${budgetResolution.usableContext ?? "unknown"}`,
    `input=${budgetResolution.effectiveInputTokenBudget}`,
    `memory=${budgetResolution.effectiveMemoryInjectionBudget}`,
    `caps=${capHits.length > 0 ? capHits.join(",") : "none"}`,
    `unestimated=${unestimatedComponents.length > 0 ? unestimatedComponents.join(",") : "none"}`
  ];

  return parts.join("; ");
}

function summarizeBudgetResolutionDetail(contextBudget: NonNullable<ContextAssemblyObservability["contextBudget"]>) {
  const { budgetResolution } = contextBudget;
  const reserveParts = [
    `outputReserveTokens=${budgetResolution.outputReserveTokens ?? "unknown"}`,
    `toolSchemaTokenEstimate=${budgetResolution.toolSchemaTokenEstimate ?? "unknown"}`,
    `safetyReserveTokens=${budgetResolution.safetyReserveTokens ?? "unknown"}`
  ];
  const unestimatedComponents = budgetResolution.unestimatedComponents ?? [];
  const capHitsList = budgetResolution.capHits ?? [];
  const capReasonsList = budgetResolution.capReasons ?? [];
  const unestimated = unestimatedComponents.length > 0
    ? `; unestimated=${unestimatedComponents.join(",")}`
    : "";
  const capHits = capHitsList.length > 0
    ? `; capHits=${capHitsList.join(",")}`
    : "";
  const capReasons = capReasonsList.length > 0
    ? `; capReasons=${capReasonsList.join(",")}`
    : "";
  const fallbackReason = budgetResolution.fallbackReason
    ? `; fallbackReason=${budgetResolution.fallbackReason}`
    : "";
  const selectedRefs = contextBudget.selectedMemorySourceRefs.length > 0
    ? `; selectedMemorySourceRefs=${contextBudget.selectedMemorySourceRefs.join(",")}`
    : "";
  const injectedRefs = contextBudget.injectedMemorySourceRefs.length > 0
    ? `; injectedMemorySourceRefs=${contextBudget.injectedMemorySourceRefs.join(",")}`
    : "";
  const droppedRefs = contextBudget.droppedMemorySourceRefs.length > 0
    ? `; droppedMemorySourceRefs=${contextBudget.droppedMemorySourceRefs.join(",")}`
    : "";
  const promptBlocks = contextBudget.promptBlocks.length > 0
    ? `; promptBlocks=${contextBudget.promptBlocks.map((block) => `${block.blockId}:${block.layer}:${block.status}:${block.estimatedTokens}${block.reason ? `:${block.reason}` : ""}`).join("|")}`
    : "";
  const toolSchemaAccounting = `; toolSchemaAccounting=${contextBudget.toolSchemaAccounting.status}:${contextBudget.toolSchemaAccounting.totalTokens ?? "unknown"}`;
  const perTool = contextBudget.toolSchemaAccounting.perTool.length > 0
    ? `; perTool=${contextBudget.toolSchemaAccounting.perTool.map((tool) => `${tool.toolName}:${tool.estimatedTokens}`).join(",")}`
    : "";

  return `${reserveParts.join("; ")}${unestimated}${capHits}${capReasons}${fallbackReason}${selectedRefs}${injectedRefs}${droppedRefs}${promptBlocks}${toolSchemaAccounting}${perTool}`;
}

function shouldExpandSection(
  detail: InspectOperatorTurnRequest["detail"] | undefined,
  section: OperatorTurnInspectionDetailSection
) {
  return detail?.verbosity === "full" || detail?.sections?.includes(section) === true;
}

function resolveRelevantAuthorization(truth: AuthoritativeTurnTruth, reasonText: string | undefined) {
  if (reasonText) {
    const lower = reasonText.toLowerCase();
    const matching = truth.capabilityTruth.actionAuthorizations.find((entry) =>
      lower.includes(entry.actionClass.replaceAll("_", " "))
      || lower.includes(entry.actionClass)
      || entry.examples.some((example) => lower.includes(example.toLowerCase().split(" ")[0] ?? ""))
    );
    if (matching) {
      return matching;
    }
  }

  return truth.capabilityTruth.actionAuthorizations.find((entry) => entry.authorizationLevel === "approval-required")
    ?? truth.capabilityTruth.actionAuthorizations.find((entry) => entry.authorizationLevel !== "guaranteed")
    ?? truth.capabilityTruth.actionAuthorizations[0];
}

function countTruncationOutcomes(items: ContextAssemblyTruncationItem[], outcome: ContextAssemblyTruncationItem["outcome"]) {
  return items.filter((item) => item.outcome === outcome).length;
}
