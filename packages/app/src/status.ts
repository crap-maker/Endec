import type {
  ContextAssemblyObservability,
  OperatorActiveRunStatus,
  OperatorLastTurnStatus,
  OperatorRecoverySnapshot,
  OperatorStatusCache,
  OperatorStatusContext,
  OperatorStatusUsage,
  SessionState,
  TaskRunSnapshot,
  TurnResult
} from "@endec/domain";
import type { EndecCurrentModelSelection, EndecModelCapabilityKind, EndecStatusWarning } from "./provider-selection.ts";

type StatusSessionTruth = {
  sessionId: string;
  workspaceId: string;
  focusTaskId?: string;
  focusRunId?: string;
  focusUpdatedAt?: string;
  lastTurnAt: string;
  lastTurn?: {
    turnId: string;
    status: TurnResult["status"];
    createdAt: string;
    usage?: UsageLike;
  };
};

type StatusSessionQueryStore = {
  loadStatusSessionTruth(input?: { sessionId?: string }): Promise<StatusSessionTruth | null>;
  getRecoverySnapshot(input: { sessionId: string }): Promise<OperatorRecoverySnapshot | null>;
};

type StatusRunStore = {
  loadRunById(runId: string): Promise<TaskRunSnapshot | undefined>;
};

type StatusSliceStore = {
  loadLatestSliceByRun(runId: string): Promise<OperatorActiveRunStatus["latestSlice"] | undefined>;
};

type StatusControlStore = {
  listPendingControls(runId: string): Promise<Array<unknown>>;
};

type StatusCostLedger = {
  loadByTurnId(turnId: string): Promise<UsageLike | undefined>;
};

type StatusCurrentModel = {
  providerId: string;
  modelId: string;
  baseUrl?: string;
  selectionSource: EndecCurrentModelSelection["selectionSource"];
  providerConfigured: boolean;
  modelConfigured: boolean;
  modelCapability: EndecModelCapabilityKind;
  executeCapable: boolean;
};

export type StatusWarningDetail = {
  code: EndecStatusWarning["code"];
  message: string;
  providerId: string;
  modelId?: string;
};

export type AppStatusSnapshot = {
  productName: string;
  dataDir: string;
  defaultProviderId: string;
  defaultModelId: string;
  capabilities: {
    execute: boolean;
    history: boolean;
    artifactRead: boolean;
    evidenceRead: boolean;
  };
  currentModel: StatusCurrentModel;
  config: {
    source: string;
    loadedAt: string;
    schemaVersion: number;
  };
  warningDetails: StatusWarningDetail[];
  warnings: string[];
  activeRun: OperatorActiveRunStatus;
  lastTurn: OperatorLastTurnStatus;
};

export type StatusAudience = "operator" | "owner_private" | "shared";

type BuildAppStatusSnapshotInput = {
  productName: string;
  dataDir: string;
  currentModel: StatusCurrentModel;
  config?: {
    source: string;
    loadedAt: string;
    schemaVersion: number;
  };
  warningDetails: StatusWarningDetail[];
  warnings: string[];
  capabilities: {
    execute: boolean;
    history: boolean;
    artifactRead: boolean;
    evidenceRead: boolean;
  };
  sessionId?: string;
  sessionQueryStore: StatusSessionQueryStore;
  runStore: StatusRunStore;
  sliceStore: StatusSliceStore;
  controlStore: StatusControlStore;
  costLedger?: StatusCostLedger;
};

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsedTokens?: number;
  maxContextTokens?: number;
};

export function deriveSessionStatus(input: {
  resultStatus: TurnResult["status"];
  blockedBy?: string;
}): SessionState["status"] {
  if (input.resultStatus === "completed") {
    return "active";
  }

  if (input.resultStatus === "blocked") {
    return input.blockedBy === "permission" ? "waiting_approval" : "waiting_input";
  }

  return "paused";
}

function buildCacheStatus(usage: UsageLike | undefined): OperatorStatusCache | undefined {
  if (!usage) {
    return undefined;
  }

  if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) {
    return {
      state: "available",
      readTokens: usage.cacheReadTokens,
      writeTokens: usage.cacheWriteTokens
    };
  }

  return {
    state: "not_reported"
  };
}

function buildContextStatus(input: {
  usage?: UsageLike;
  observability?: ContextAssemblyObservability;
}): OperatorStatusContext | undefined {
  const usage = input.usage;
  if (usage?.contextUsedTokens !== undefined || usage?.maxContextTokens !== undefined) {
    return {
      state: "available",
      usedTokens: usage.contextUsedTokens,
      maxTokens: usage.maxContextTokens
    };
  }

  const budget = input.observability?.contextBudget;
  const estimatedUsedTokens = budget?.projectedInputTokensAfterFitting;
  const estimatedMaxTokens = budget?.budgetResolution.maxContextTokens;
  if (estimatedUsedTokens !== undefined || estimatedMaxTokens !== undefined) {
    return {
      state: "estimated",
      usedTokens: estimatedUsedTokens,
      maxTokens: estimatedMaxTokens
    };
  }

  if (usage) {
    return {
      state: "not_reported"
    };
  }

  return undefined;
}

function buildUsage(input: {
  usage?: UsageLike;
  observability?: ContextAssemblyObservability;
}): OperatorStatusUsage | undefined {
  const usage = input.usage;
  const cache = buildCacheStatus(usage);
  const context = buildContextStatus(input);

  if (!usage && !cache && !context) {
    return undefined;
  }

  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    estimatedCost: usage?.estimatedCost,
    cache,
    context
  };
}

function buildLastTurnFromRecovery(snapshot: OperatorRecoverySnapshot): OperatorLastTurnStatus {
  if (!snapshot.turnId) {
    return { state: "unknown" };
  }

  return {
    state: "available",
    turnId: snapshot.turnId,
    status: "blocked",
    blockedBy: snapshot.blockedBy,
    usage: buildUsage({
      observability: snapshot.observability
    })
  };
}

function buildLastTurnFromCommitted(input: {
  lastTurn: NonNullable<StatusSessionTruth["lastTurn"]>;
  costLedgerUsage?: UsageLike;
}): OperatorLastTurnStatus {
  return {
    state: "available",
    turnId: input.lastTurn.turnId,
    status: input.lastTurn.status,
    completedAt: input.lastTurn.createdAt,
    usage: buildUsage({
      usage: input.lastTurn.usage ?? input.costLedgerUsage
    })
  };
}

function isFocusRunVisibleAsActive(run: TaskRunSnapshot | undefined) {
  return run?.status === "queued" || run?.status === "running" || run?.status === "blocked";
}

async function buildActiveRun(input: {
  sessionTruth: StatusSessionTruth | null;
  runStore: StatusRunStore;
  sliceStore: StatusSliceStore;
  controlStore: StatusControlStore;
  recoverySnapshot: OperatorRecoverySnapshot | null;
}): Promise<OperatorActiveRunStatus> {
  const focusRunId = input.sessionTruth?.focusRunId;
  const focusTaskId = input.sessionTruth?.focusTaskId;
  if (!focusRunId || !focusTaskId) {
    return { state: "none" };
  }

  const run = await input.runStore.loadRunById(focusRunId);
  if (!run) {
    return { state: "unknown", taskId: focusTaskId, runId: focusRunId };
  }

  if (!isFocusRunVisibleAsActive(run)) {
    return { state: "none" };
  }

  const [latestSlice, pendingControls] = await Promise.all([
    input.sliceStore.loadLatestSliceByRun(run.runId),
    input.controlStore.listPendingControls(run.runId)
  ]);

  const activeUsage = buildUsage({
    usage: latestSlice?.usageSummary,
    observability: input.recoverySnapshot?.turnId === run.runId
      ? input.recoverySnapshot.observability
      : undefined
  });

  return {
    state: "active",
    taskId: run.taskId,
    runId: run.runId,
    runStatus: run.status,
    attentionMode: run.attentionMode,
    latestSlice,
    pendingControlCount: pendingControls.length,
    lastHumanInputAt: run.lastHumanInputAt,
    usage: activeUsage
  };
}

function humanizeStatusValue(value: string) {
  return value.replaceAll("_", " ");
}

function formatTokenSummary(usage: OperatorStatusUsage | undefined) {
  if (!usage) {
    return "unavailable";
  }

  const parts = [
    usage.inputTokens !== undefined ? `in=${usage.inputTokens}` : undefined,
    usage.outputTokens !== undefined ? `out=${usage.outputTokens}` : undefined,
    usage.totalTokens !== undefined ? `total=${usage.totalTokens}` : undefined
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join(" ") : "unavailable";
}

function formatCacheSummary(cache: OperatorStatusCache | undefined) {
  if (!cache) {
    return "unavailable";
  }

  if (cache.state !== "available") {
    return humanizeStatusValue(cache.state);
  }

  const parts = [
    cache.readTokens !== undefined ? `read=${cache.readTokens}` : undefined,
    cache.writeTokens !== undefined ? `write=${cache.writeTokens}` : undefined
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join(" ") : "unavailable";
}

function formatContextSummary(context: OperatorStatusContext | undefined) {
  if (!context) {
    return "unavailable";
  }

  if (context.state !== "available" && context.state !== "estimated") {
    return humanizeStatusValue(context.state);
  }

  const usedTokens = context.usedTokens !== undefined ? String(context.usedTokens) : "unknown";
  const maxTokens = context.maxTokens !== undefined ? String(context.maxTokens) : "unknown";
  return `${context.state === "estimated" ? "estimated " : ""}${usedTokens}/${maxTokens}`;
}

function hasReportedUsageMetrics(usage: OperatorStatusUsage | undefined) {
  return !!usage && (
    usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.totalTokens !== undefined
    || usage.cache?.state === "available"
    || usage.context?.state === "available"
    || usage.context?.state === "estimated"
  );
}

function formatUsageSummaryLines(input: {
  activeRun: OperatorActiveRunStatus | undefined;
  lastTurn: OperatorLastTurnStatus | undefined;
}) {
  const activeRunUsage = input.activeRun?.state === "active"
    ? input.activeRun.usage
    : undefined;
  const lastTurnUsage = input.lastTurn?.state === "available"
    ? input.lastTurn.usage
    : undefined;
  const activeRunHasReportedUsage = hasReportedUsageMetrics(activeRunUsage);
  const lastTurnHasReportedUsage = hasReportedUsageMetrics(lastTurnUsage);
  const selected = activeRunHasReportedUsage
    ? { label: "active run", usage: activeRunUsage }
    : lastTurnHasReportedUsage
      ? { label: "last turn", usage: lastTurnUsage }
      : activeRunUsage
        ? { label: "active run", usage: activeRunUsage }
        : lastTurnUsage
          ? { label: "last turn", usage: lastTurnUsage }
          : input.activeRun?.state === "active"
            ? { label: "active run", usage: undefined }
            : input.lastTurn?.state === "available"
              ? { label: "last turn", usage: undefined }
              : undefined;

  if (!selected) {
    if (input.activeRun?.state === "unknown" || input.lastTurn?.state === "unknown") {
      return ["usage: unknown"];
    }
    return ["usage: no usage yet"];
  }

  if (!selected.usage || !hasReportedUsageMetrics(selected.usage)) {
    return [selected.label ? `usage: ${selected.label} (not reported)` : "usage: not reported"];
  }

  return [
    `usage: ${selected.label}`,
    `tokens: ${formatTokenSummary(selected.usage)}`,
    `cache: ${formatCacheSummary(selected.usage.cache)}`,
    `context: ${formatContextSummary(selected.usage.context)}`
  ];
}

function formatActiveRunSummary(input: {
  activeRun: OperatorActiveRunStatus | undefined;
  audience: StatusAudience;
}) {
  const activeRun = input.activeRun;
  if (!activeRun || activeRun.state === "none") {
    return ["activeRun: none"];
  }

  if (activeRun.state === "unknown") {
    const parts = [
      "activeRun: unknown",
      input.audience !== "shared" && activeRun.taskId ? `taskId=${activeRun.taskId}` : undefined,
      input.audience !== "shared" && activeRun.runId ? `runId=${activeRun.runId}` : undefined
    ].filter((part): part is string => part !== undefined);
    return [parts.join(" ")];
  }

  const summaryParts = [
    `status=${activeRun.runStatus ?? "unknown"}`,
    input.audience !== "shared" && activeRun.taskId ? `taskId=${activeRun.taskId}` : undefined,
    input.audience !== "shared" && activeRun.runId ? `runId=${activeRun.runId}` : undefined,
    input.audience !== "shared" && activeRun.attentionMode ? `attention=${activeRun.attentionMode}` : undefined
  ].filter((part): part is string => part !== undefined);

  const lines = [`activeRun: ${summaryParts.join(" ")}`];
  if (activeRun.latestSlice) {
    lines.push(
      input.audience === "shared"
        ? `activeRunSlice: status=${activeRun.latestSlice.status}`
        : `activeRunSlice: sliceId=${activeRun.latestSlice.sliceId} status=${activeRun.latestSlice.status}`
    );
  }
  if (input.audience !== "shared" && activeRun.pendingControlCount !== undefined) {
    lines.push(`activeRunPendingControls: ${activeRun.pendingControlCount}`);
  }
  if (input.audience !== "shared" && activeRun.lastHumanInputAt) {
    lines.push(`activeRunLastHumanInputAt: ${activeRun.lastHumanInputAt}`);
  }

  return lines;
}

function formatLastTurnSummary(input: {
  lastTurn: OperatorLastTurnStatus | undefined;
  audience: StatusAudience;
}) {
  const lastTurn = input.lastTurn;
  if (!lastTurn || lastTurn.state === "none") {
    return ["lastTurn: none"];
  }

  if (lastTurn.state === "unknown") {
    return ["lastTurn: unknown"];
  }

  const summaryParts = [
    `status=${lastTurn.status ?? "unknown"}`,
    input.audience !== "shared" && lastTurn.turnId ? `turnId=${lastTurn.turnId}` : undefined,
    input.audience !== "shared" && lastTurn.blockedBy ? `blockedBy=${lastTurn.blockedBy}` : undefined,
    input.audience !== "shared" && lastTurn.completedAt ? `completedAt=${lastTurn.completedAt}` : undefined
  ].filter((part): part is string => part !== undefined);

  return [`lastTurn: ${summaryParts.join(" ")}`];
}

function formatSharedWarningDetail(warning: StatusWarningDetail) {
  switch (warning.code) {
    case "default_model_unconfigured":
      return "warning: current model needs owner configuration";
    case "default_model_misaligned":
    case "provider_embeddings_only":
    case "provider_model_capability_mismatch":
    case "provider_model_capability_unknown":
      return "warning: current model is not ready for execution";
    default:
      return "warning: model status needs owner attention";
  }
}

function formatWarningLines(input: {
  warningDetails: StatusWarningDetail[];
  warnings: string[];
  audience: StatusAudience;
}) {
  if (input.warningDetails.length > 0) {
    return input.warningDetails.map((warning) =>
      input.audience === "shared"
        ? formatSharedWarningDetail(warning)
        : `warning[${warning.code}]: ${warning.message}`
    );
  }

  return input.warnings.map((warning) => `warning: ${warning}`);
}

export function formatStatusSnapshotLines(input: {
  status: AppStatusSnapshot;
  audience: StatusAudience;
}) {
  const lines = [`model: ${input.status.currentModel.providerId}/${input.status.currentModel.modelId}`];
  lines.push(`config: source=${input.status.config.source} version=${input.status.config.schemaVersion} loadedAt=${input.status.config.loadedAt}`);
  const modelStateParts = [
    `capability=${input.status.currentModel.modelCapability}`,
    `execute=${input.status.currentModel.executeCapable ? "yes" : "no"}`,
    input.audience !== "shared" ? `source=${input.status.currentModel.selectionSource}` : undefined,
    input.audience !== "shared"
      ? `providerConfigured=${input.status.currentModel.providerConfigured ? "yes" : "no"}`
      : undefined,
    input.audience !== "shared"
      ? `modelConfigured=${input.status.currentModel.modelConfigured ? "yes" : "no"}`
      : undefined
  ].filter((part): part is string => part !== undefined);
  lines.push(`modelState: ${modelStateParts.join(" ")}`);

  if (input.audience !== "shared" && input.status.currentModel.baseUrl) {
    lines.push(`baseUrl: ${input.status.currentModel.baseUrl}`);
  }

  lines.push(...formatWarningLines({
    warningDetails: input.status.warningDetails,
    warnings: input.status.warnings,
    audience: input.audience
  }));
  lines.push(...formatActiveRunSummary({
    activeRun: input.status.activeRun,
    audience: input.audience
  }));
  lines.push(...formatLastTurnSummary({
    lastTurn: input.status.lastTurn,
    audience: input.audience
  }));
  lines.push(...formatUsageSummaryLines({
    activeRun: input.status.activeRun,
    lastTurn: input.status.lastTurn
  }));

  return lines;
}

export async function buildAppStatusSnapshot(input: BuildAppStatusSnapshotInput): Promise<AppStatusSnapshot> {
  const sessionTruth = await input.sessionQueryStore.loadStatusSessionTruth(
    input.sessionId ? { sessionId: input.sessionId } : undefined
  );
  const recoverySnapshot = sessionTruth
    ? await input.sessionQueryStore.getRecoverySnapshot({ sessionId: sessionTruth.sessionId })
    : null;

  const costLedgerUsage = sessionTruth?.lastTurn && !sessionTruth.lastTurn.usage
    ? await input.costLedger?.loadByTurnId(sessionTruth.lastTurn.turnId)
    : undefined;

  const [activeRun, lastTurn] = await Promise.all([
    buildActiveRun({
      sessionTruth,
      runStore: input.runStore,
      sliceStore: input.sliceStore,
      controlStore: input.controlStore,
      recoverySnapshot
    }),
    Promise.resolve(
      recoverySnapshot
        ? buildLastTurnFromRecovery(recoverySnapshot)
        : sessionTruth?.lastTurn
          ? buildLastTurnFromCommitted({
              lastTurn: sessionTruth.lastTurn,
              costLedgerUsage
            })
          : { state: "none" as const }
    )
  ]);

  return {
    productName: input.productName,
    dataDir: input.dataDir,
    defaultProviderId: input.currentModel.providerId,
    defaultModelId: input.currentModel.modelId,
    capabilities: input.capabilities,
    currentModel: input.currentModel,
    config: input.config ?? { source: "unknown", loadedAt: "unknown", schemaVersion: 0 },
    warningDetails: input.warningDetails,
    warnings: input.warnings,
    activeRun,
    lastTurn
  };
}
