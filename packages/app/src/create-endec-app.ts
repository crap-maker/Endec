import { createAccessStore } from "@endec/access";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createHttpProviderTransport,
  createProviderAdapter,
  createProviderCatalog,
  resolveAuth,
  type ProviderCatalog,
  type ProviderTransport
} from "@endec/ai";
import { createArtifactStore } from "@endec/artifacts";
import { createBudgetService, createCostLedger } from "@endec/budget";
import { createAgentCore, createShellCommandPort } from "@endec/core";
import {
  ApprovalScopeSchema,
  ApprovalScopeValues,
  ExecutionControlInputSchema,
  renderRuntimeErrorText,
  resolveErrorExposureMode,
  type ActiveTaskSnapshot,
  type ErrorExposureMode,
  type ExecutionControlInput,
  type PendingExecution,
  type SessionHistoryEntry,
  type TaskRunSnapshot,
  type TaskState,
  type TurnRequest,
  type TurnResult
} from "@endec/domain";
import { createMemoryStore } from "@endec/memory";
import { createRuntimeService } from "@endec/runtime";
import { createSessionQueryStore, createSessionStore } from "@endec/sessions";
import {
  createTaskEventStore,
  createTaskRunStore,
  createTaskStore,
  createRuntimeSliceStore,
  createRunControlStore
} from "@endec/tasks";
import { createBackgroundAckTurnResult } from "./background-ack.ts";
import { hasBackgroundExecutionMarker, parseBackgroundIntent } from "./background-intent.ts";
import { createBackgroundWorker } from "./background-worker.ts";
import { createBackgroundOperator } from "./background-operator.ts";
import { createContextAssembler } from "./context-assembler.ts";
import { commitAdministrativeTurn, commitTurnProjection } from "./commit-turn.ts";
import { createAppToolPort } from "./tool-port.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";
import { ensureModelsConfig, loadModelsConfig, type EndecModelsConfig } from "./models-config-store.ts";
import { createEndecConfigService } from "./endec-config-service.ts";
import { createEndecImHost } from "./im-host.ts";
import { createConversationDirectory } from "./conversation-directory.ts";
import { createImCommandService } from "./im-command-service.ts";
import { createProviderControlService } from "./provider-control-service.ts";
import {
  createSelfInspectionRuntimeTools,
  createSelfInspectionService
} from "./self-inspection-service.ts";
import { filterImMemoryWrites } from "./memory-write-policy.ts";
import { createPersonaResolver } from "./persona-resolver.ts";
import { resolveServerTimezone } from "./time-context.ts";
import { createAuthorityService } from "./authority-service.ts";
import { resolveOwnerPreferences } from "./owner-init.ts";
import { createOperatorTurnInspector } from "./operator-inspection.ts";
import { synthesizeWorkingSet } from "./working-set-synthesis.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import { classifyBackgroundTurnResult, createCanceledBackgroundResult, extractBlockedSuspendRefs, isResumableInterruptedTurnResult } from "./background-result.ts";
import { inspectSelfAwarenessIntent, resolveSelfAwarenessPolicy } from "./self-awareness-policy.ts";
import { buildAppStatusSnapshot } from "./status.ts";
import {
  createDetachedTask2AckTurnResult,
  isAcceptedDetachedTask2ContinuationHead,
  resolveAcceptedDetachedTask2ClaimRace
} from "./task2-detached-control.ts";
import {
  createProviderRegistrations,
  inferModelCapability,
  DEFAULT_PROVIDER_ID,
  PROVIDER_MODEL_DISCOVERY_PATH,
  resolveConfiguredExecuteModelSelections,
  resolveCurrentModelSelection,
  type EndecCurrentModelSelection,
  type EndecStatusWarning,
  type ProviderSelectionOverride,
  type ProviderSelectionResolution
} from "./provider-selection.ts";
import type {
  EndecApp,
  EndecAppOptions,
  EndecCurrentModelWarning,
  EndecImModelPickerOption,
  EndecImSource,
  EndecOperatorPort,
  EndecOperatorSnapshotTarget
} from "./types.ts";

const DEFAULT_SELF_INSPECTION_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function currentModelIdCandidates(modelId: string) {
  if (modelId === "gpt-5.4") {
    return [modelId, "gpt5.4"];
  }

  if (modelId === "gpt-5.5") {
    return [modelId, "gpt5.5"];
  }

  if (modelId === "gpt5.4") {
    return ["gpt-5.4", modelId];
  }

  if (modelId === "gpt5.5") {
    return ["gpt-5.5", modelId];
  }

  return [modelId];
}

function findSelectionMetadata(input: {
  catalog: ProviderCatalog;
  selection: { providerId: string; modelId: string };
}) {
  for (const candidateModelId of currentModelIdCandidates(input.selection.modelId)) {
    const matched = input.catalog.findModel({
      providerId: input.selection.providerId,
      modelId: candidateModelId
    });
    if (matched) {
      return matched.metadata;
    }
  }

  return undefined;
}

function resolveSelectionMetadata(input: {
  catalog: ProviderCatalog;
  selection: { providerId: string; modelId: string };
}) {
  const metadata = findSelectionMetadata(input);
  if (!metadata) {
    throw new Error(`No provider registration found for ${input.selection.providerId}/${input.selection.modelId}`);
  }

  return metadata;
}

function selectionMatchesAvailableModel(selectionModelId: string, availableModelIds: string[]) {
  const candidates = new Set(currentModelIdCandidates(selectionModelId));
  return availableModelIds.some((modelId) => candidates.has(modelId));
}

function createSelectableModelLabel(input: {
  displayName?: string;
  providerId: string;
  modelId: string;
  duplicateDisplayNames: Set<string>;
}) {
  if (!input.displayName) {
    return `${input.providerId}/${input.modelId}`;
  }

  if (input.duplicateDisplayNames.has(input.displayName)) {
    return `${input.displayName} (${input.providerId}/${input.modelId})`;
  }

  return input.displayName;
}

function normalizeOwnerVisibleModelRef(input: { providerId: string; modelId: string }) {
  return input.providerId === DEFAULT_PROVIDER_ID && ["cheap-default", "strong-default"].includes(input.modelId)
    ? `${input.providerId}/default`
    : `${input.providerId}/${input.modelId}`;
}

function listSelectableModelsFromConfig(config: EndecModelsConfig): EndecImModelPickerOption[] {
  return config.models.map((model) => ({
    providerId: model.providerId,
    modelId: model.modelId,
    label: model.providerId === DEFAULT_PROVIDER_ID && ["cheap-default", "strong-default"].includes(model.modelId)
      ? normalizeOwnerVisibleModelRef({ providerId: model.providerId, modelId: model.modelId })
      : model.label
  }));
}

const ARTIFACT_SPILL_THRESHOLD_CHARS = 2_000;
const EXECUTION_CONTROL_CONTRACT_VERSION = "ws0.execution-control.v1";
const TASK2_SLICE_RECOVERY_PAYLOAD_CONTRACT_VERSION = "im.task2.slice-recovery.v1";
const SUPPORTED_APPROVAL_SCOPES = new Set(ApprovalScopeValues);

function createAppProviderCatalog(options: {
  env: Record<string, string | undefined>;
  providerRegistrations?: EndecAppOptions["providerRegistrations"];
}) {
  return createProviderCatalog(createProviderRegistrations(options));
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function extractModelIds(entries: unknown[]) {
  return [...new Set(entries.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }

    if (!entry || typeof entry !== "object") {
      return [];
    }

    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  }))];
}

function parseProviderModelIds(payload: unknown) {
  if (Array.isArray(payload)) {
    return extractModelIds(payload);
  }

  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return extractModelIds(data);
    }
  }

  return [];
}

function supportsAccountProviderControl(source: TurnRequest["source"]) {
  return source === "telegram" || source === "feishu";
}

function createProviderAuthOverrideBlock(input: {
  turnId: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  if (!input.baseUrl && !input.apiKey) {
    return undefined;
  }

  return {
    blockId: `provider_auth_override:${input.turnId}`,
    kind: "resource" as const,
    title: "provider auth override",
    content: "",
    sourceRefs: [input.turnId],
    metadata: {
      providerAuthOverride: {
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey ? { apiKey: input.apiKey } : {})
      }
    }
  };
}

function isImConversationSource(source: TurnRequest["source"]) {
  return source === "telegram" || source === "feishu";
}

function isOwnerPrivateConversation(request: Pick<TurnRequest, "source" | "conversationRef" | "imContext">) {
  return isImConversationSource(request.source)
    && !!request.conversationRef?.accountId
    && request.imContext?.boundary.conversationScope === "direct";
}

function normalizeSelfAwarenessIntentText(input: string) {
  return input.toLowerCase();
}

function hasAnyNeedle(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function classifySelfAwarenessIntent(request: Pick<TurnRequest, "input">) {
  const normalized = normalizeSelfAwarenessIntentText(request.input);
  const selfAwarenessNeedles = [
    "your own",
    "your code",
    "your source",
    "your docs",
    "your config",
    "your repo",
    "this repo",
    "source code",
    "configuration",
    "api key",
    "secret",
    ".env",
    "models.json",
    "endec",
    "你自己的",
    "你的源码",
    "你的代码",
    "你的文档",
    "你的配置",
    "这个仓库",
    "源码",
    "文档",
    "配置",
    "密钥"
  ];
  if (!hasAnyNeedle(normalized, selfAwarenessNeedles)) {
    return {
      kind: "none" as const,
      explicitReveal: false,
      explicitMutation: false
    };
  }

  const explicitReveal = hasAnyNeedle(normalized, [
    "show full",
    "full api key",
    "reveal",
    "display",
    "raw secret",
    "full secret",
    "完整",
    "显示",
    "原样",
    "不要掩码",
    "不脱敏"
  ]) && hasAnyNeedle(normalized, ["api key", "secret", "key", "密钥"]);
  const explicitMutation = hasAnyNeedle(normalized, [
    "edit",
    "modify",
    "change",
    "update",
    "rewrite",
    "fix",
    "patch",
    "写",
    "修改",
    "更新",
    "编辑",
    "改写",
    "修复"
  ]);

  return {
    kind: "self_awareness" as const,
    explicitReveal,
    explicitMutation
  };
}

function createDefaultProviderTransport(providerTransport: ProviderTransport | undefined) {
  if (providerTransport) {
    return {
      transport: providerTransport,
      fetchImplementation: undefined as typeof fetch | undefined
    };
  }

  const fetchImplementation = globalThis.fetch;

  return {
    transport: createHttpProviderTransport({
      fetch: fetchImplementation
    }),
    fetchImplementation
  };
}

function createProviderModelDiscovery(input: {
  env: Record<string, string | undefined>;
  catalog: ProviderCatalog;
  fetchImplementation: typeof fetch | undefined;
}) {
  if (typeof input.fetchImplementation !== "function") {
    return null;
  }

  const fetchImplementation = input.fetchImplementation;

  return {
    async inspectProviderAvailability(providerId: string) {
      const bootstrapModel = input.catalog.listModels().find((model) => model.providerId === providerId);
      if (!bootstrapModel) {
        throw new Error(`No provider registration found for ${providerId}`);
      }

      const resolvedModel = input.catalog.resolveModel({
        providerId: bootstrapModel.providerId,
        modelId: bootstrapModel.modelId
      });
      const auth = resolveAuth(resolvedModel, input.env);
      const response = await fetchImplementation(joinUrl(auth.baseUrl, PROVIDER_MODEL_DISCOVERY_PATH), {
        method: "GET",
        headers: auth.headers
      });
      const bodyText = await response.text();

      if (!response.ok) {
        throw new Error(
          `Provider model discovery failed with status ${response.status} ${response.statusText}\nBody: ${bodyText}`
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Provider model discovery returned invalid JSON: ${reason}\nBody: ${bodyText}`);
      }

      return {
        providerId,
        baseUrl: auth.baseUrl,
        availableModelIds: parseProviderModelIds(payload)
      };
    }
  };
}

function createToolExposureResolver(input: {
  toolPort: ReturnType<typeof createAppToolPort>;
  resolver: EndecAppOptions["toolExposureResolver"] | undefined;
  selfInspectionService: ReturnType<typeof createSelfInspectionService>;
  canRevealSelfInspectionSecrets: (request: Pick<TurnRequest, "source" | "actorId" | "conversationRef" | "imContext">) => Promise<boolean>;
}) {
  if (input.resolver) {
    return input.resolver;
  }

  return async (requestInput: Parameters<NonNullable<EndecAppOptions["toolExposureResolver"]>>[0]) => {
    const ownerValidated = await input.canRevealSelfInspectionSecrets(requestInput.request);
    const policy = resolveSelfAwarenessPolicy(requestInput.request, { ownerValidated });
    if (policy.policy === "canonical" || policy.policy === "none") {
      return input.toolPort.describeExposure({
        turnId: requestInput.request.turnId,
        sessionId: requestInput.session.sessionId,
        workspaceId: requestInput.session.workspaceId,
        resolvedMode: requestInput.budget.resolvedMode,
        policy: policy.policy
      });
    }

    return input.toolPort.describeExposure({
      turnId: requestInput.request.turnId,
      sessionId: requestInput.session.sessionId,
      workspaceId: requestInput.session.workspaceId,
      resolvedMode: requestInput.budget.resolvedMode,
      policy: policy.policy,
      additionalTools: createSelfInspectionRuntimeTools({
        service: input.selfInspectionService,
        source: requestInput.request.source,
        accountId: policy.accountId!,
        allowSecretReveal: inspectSelfAwarenessIntent(requestInput.request).explicitReveal && ownerValidated
      })
    });
  };
}

function createArtifactPolicy(artifactStore: ReturnType<typeof createArtifactStore>) {
  return {
    async spillIfNeeded(input: {
      turnId: string;
      sessionId: string;
      kind: "runtime_output" | "tool_result";
      mimeType?: string;
      content: string;
    }) {
      if (input.content.length <= ARTIFACT_SPILL_THRESHOLD_CHARS) {
        return {
          kind: "inline" as const,
          content: input.content
        };
      }

      const spilled = await artifactStore.spillArtifact(input);
      return {
        kind: "artifact" as const,
        ref: spilled.ref,
        preview: spilled.preview
      };
    }
  };
}

class ExecutePathSelectionError extends Error {
  readonly warnings: string[];
  readonly warningDetails: EndecCurrentModelWarning[];

  constructor(warningDetails: EndecCurrentModelWarning[]) {
    super(warningDetails.map((warning) => warning.message).join("\n"));
    this.name = "ExecutePathSelectionError";
    this.warnings = warningDetails.map((warning) => warning.message);
    this.warningDetails = warningDetails;
  }
}

type EndecCurrentModelStatus = EndecCurrentModelSelection & {
  modelCapability: ReturnType<typeof inferModelCapability>;
  executeCapable: boolean;
};

function createCurrentModelWarning(input: {
  code: EndecStatusWarning["code"];
  providerId: string;
  modelId?: string;
  message: string;
}): EndecCurrentModelWarning {
  return {
    code: input.code,
    providerId: input.providerId,
    modelId: input.modelId,
    message: input.message
  } satisfies EndecCurrentModelWarning;
}

function evaluateCurrentModelStatus(input: {
  selection: EndecCurrentModelSelection;
  inspection?: {
    providerId: string;
    baseUrl: string;
    availableModelIds: string[];
  } | null;
  catalog: ProviderCatalog;
}) {
  const metadata = findSelectionMetadata({
    catalog: input.catalog,
    selection: input.selection
  });
  const modelCapability = inferModelCapability({
    modelId: input.selection.modelId,
    metadata
  });
  const executeCapable = modelCapability === "embedding"
    ? false
    : modelCapability === "chat"
      ? true
      : input.selection.modelConfigured;
  const warnings: EndecCurrentModelWarning[] = [];

  if (modelCapability === "embedding") {
    warnings.push(createCurrentModelWarning({
      code: "provider_model_capability_mismatch",
      providerId: input.selection.providerId,
      modelId: input.selection.modelId,
      message:
        `Configured current model ${input.selection.providerId}/${input.selection.modelId} is embedding-only, ` +
        "so it cannot be used on Endec's execute path."
    }));
  }

  if (modelCapability === "unknown" && !executeCapable) {
    warnings.push(createCurrentModelWarning({
      code: "provider_model_capability_unknown",
      providerId: input.selection.providerId,
      modelId: input.selection.modelId,
      message:
        `Configured current model ${input.selection.providerId}/${input.selection.modelId} could not be pre-classified, ` +
        "so Endec cannot confirm execute compatibility before live provider inspection."
    }));
  }

  if (input.inspection) {
    const availableModels = input.inspection.availableModelIds.join(", ") || "<none>";
    const availableSummary = input.inspection.availableModelIds.reduce(
      (summary, modelId) => {
        const capability = inferModelCapability({ modelId });
        if (capability === "chat") {
          summary.chat += 1;
        } else if (capability === "embedding") {
          summary.embedding += 1;
        } else {
          summary.unknown += 1;
        }

        return summary;
      },
      { chat: 0, embedding: 0, unknown: 0 }
    );
    const providerHasNoChatModels =
      input.inspection.availableModelIds.length > 0 && availableSummary.chat === 0 && availableSummary.embedding > 0;

    if (providerHasNoChatModels) {
      warnings.push(createCurrentModelWarning({
        code: "provider_embeddings_only",
        providerId: input.selection.providerId,
        message:
          `Provider ${input.selection.providerId} is reachable at ${input.inspection.baseUrl} but only embedding models were reported. ` +
          `Available models: ${availableModels}`
      }));
    }

    if (
      input.inspection.availableModelIds.length > 0 &&
      !selectionMatchesAvailableModel(input.selection.modelId, input.inspection.availableModelIds)
    ) {
      warnings.push(createCurrentModelWarning({
        code: input.selection.modelConfigured ? "default_model_misaligned" : "default_model_unconfigured",
        providerId: input.selection.providerId,
        modelId: input.selection.modelId,
        message: input.selection.modelConfigured
          ? `Configured current model ${input.selection.providerId}/${input.selection.modelId} is not exposed by the reachable provider. Available models: ${availableModels}`
          : `No current model is configured. Fallback ${input.selection.providerId}/${input.selection.modelId} is not exposed by the reachable provider. Available models: ${availableModels}`
      }));
    }
  }

  return {
    currentModel: {
      ...input.selection,
      modelCapability,
      executeCapable
    } satisfies EndecCurrentModelStatus,
    warningDetails: warnings,
    warnings: warnings.map((warning) => warning.message),
    executeReady: executeCapable && warnings.length === 0
  };
}

function createFailedTurnResult(
  request: TurnRequest,
  error: unknown,
  errorExposureMode: ErrorExposureMode
): TurnResult {
  const warnings = error instanceof ExecutePathSelectionError
    ? error.warnings
    : [renderRuntimeErrorText({ mode: errorExposureMode, error })];

  return {
    turnId: request.turnId,
    sessionId: request.sessionId,
    resolvedMode: request.requestedMode ?? "chat",
    status: "failed",
    messages: [],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    },
    warnings,
    checkpointRef: `checkpoint:${request.turnId}`,
    nextSessionStateRef: `session_state_ref:${request.turnId}`
  };
}

function createSyntheticTurnId(prefix: string, turnId: string) {
  return `${prefix}_${turnId}_${randomUUID()}`;
}

function createDetachedTask2TerminalTurnResult(input: {
  run: Pick<TaskRunSnapshot, "status" | "resultSummary" | "cancelReason">;
  turnId: string;
  sessionId: string;
  resolvedMode: TurnResult["resolvedMode"];
  checkpointRef: string;
  frameRef?: string;
}): TurnResult | undefined {
  if (input.run.status !== "completed" && input.run.status !== "failed" && input.run.status !== "canceled") {
    return undefined;
  }

  const completedSummary = input.run.resultSummary?.trim();
  const warning = input.run.status === "canceled"
    ? (input.run.cancelReason?.trim() || completedSummary || "background task canceled")
    : input.run.status === "failed"
      ? completedSummary
      : undefined;

  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    resolvedMode: input.resolvedMode,
    status: input.run.status === "completed"
      ? "completed"
      : input.run.status === "failed"
        ? "failed"
        : "interrupted",
    messages: input.run.status === "completed" && completedSummary
      ? [{ role: "assistant", content: completedSummary }]
      : [],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    },
    warnings: warning ? [warning] : [],
    checkpointRef: input.checkpointRef,
    frameRef: input.frameRef
  };
}

type SessionRecoveryContext = NonNullable<Awaited<ReturnType<ReturnType<typeof createSessionStore>["loadRecoveryContext"]>>>;
type SessionSnapshot = NonNullable<Awaited<ReturnType<ReturnType<typeof createSessionStore>["loadById"]>>>;
type DurableSliceRecoveryPayload = {
  schemaVersion: 1;
  contractVersion: typeof TASK2_SLICE_RECOVERY_PAYLOAD_CONTRACT_VERSION;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  source: TurnRequest["source"];
  mode: SessionSnapshot["mode"];
  checkpointRef?: string;
  frameRef?: string;
  pendingApprovalRef?: string;
  pendingExecution: PendingExecution;
};

type ContinuationSlicePayload = Record<string, unknown> & {
  control?: ExecutionControlInput;
  checkpointRef?: string;
  recovery?: DurableSliceRecoveryPayload;
};

type ResolvedContinuationRecovery = {
  recoveryContext: SessionRecoveryContext;
  source: TurnRequest["source"];
  mode: SessionSnapshot["mode"];
};

function createExecutionControlActorId(action: ExecutionControlInput["action"]) {
  return `system:execution-control:${action}`;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readContinuationSlicePayload(value: unknown): ContinuationSlicePayload | undefined {
  const payload = asObjectRecord(value);
  return payload ? payload as ContinuationSlicePayload : undefined;
}

function buildDurableSliceRecoveryPayload(input: {
  recoveryContext: SessionRecoveryContext;
  source: TurnRequest["source"];
  mode: SessionSnapshot["mode"];
  basePayload?: unknown;
  control?: ExecutionControlInput;
}): ContinuationSlicePayload {
  const basePayload = readContinuationSlicePayload(input.basePayload) ?? {};
  const pendingExecution = input.recoveryContext.inflight.pendingExecution;
  const checkpointRef = pendingExecution?.checkpointRef ?? input.recoveryContext.checkpointRef;

  return {
    ...basePayload,
    ...(input.control ? { control: input.control } : {}),
    ...(checkpointRef ? { checkpointRef } : {}),
    ...(pendingExecution
      ? {
          recovery: {
            schemaVersion: 1,
            contractVersion: TASK2_SLICE_RECOVERY_PAYLOAD_CONTRACT_VERSION,
            turnId: input.recoveryContext.inflight.turnId,
            sessionId: input.recoveryContext.session.sessionId,
            workspaceId: input.recoveryContext.session.workspaceId,
            source: input.source,
            mode: input.mode,
            checkpointRef,
            frameRef: input.recoveryContext.inflight.frameRef,
            pendingApprovalRef: input.recoveryContext.inflight.pendingApprovalRef,
            pendingExecution
          } satisfies DurableSliceRecoveryPayload
        }
      : {})
  };
}

function resolveContinuationActorId(recoveryContext: SessionRecoveryContext) {
  const actorId = recoveryContext.inflight.pendingExecution?.frame.continuation.metadata?.actorId;
  return typeof actorId === "string" && actorId.length > 0 ? actorId : undefined;
}

function resolveRecoverableTurn(input: {
  recovery: ResolvedContinuationRecovery | null | undefined;
  sessionId: string;
  requestedTurnId?: string;
  requestedFrameRef?: string;
}) {
  if (!input.recovery) {
    throw new Error(`No recoverable turn is open for session ${input.sessionId}.`);
  }

  const currentTurnId = input.recovery.recoveryContext.inflight.turnId;
  if (input.requestedTurnId && currentTurnId !== input.requestedTurnId) {
    throw new Error(
      `Session ${input.sessionId} is waiting on turn ${currentTurnId}, not ${input.requestedTurnId}. Retry with --turn ${currentTurnId}, or omit --turn to target the current recoverable turn.`
    );
  }

  const currentFrameRef = input.recovery.recoveryContext.inflight.frameRef;
  if (input.requestedFrameRef) {
    if (!currentFrameRef) {
      throw new Error(`Session ${input.sessionId} does not expose a recoverable execution frame.`);
    }

    if (currentFrameRef !== input.requestedFrameRef) {
      throw new Error(`Session ${input.sessionId} is waiting on frame ${currentFrameRef}, not ${input.requestedFrameRef}.`);
    }
  }

  return {
    ...input.recovery,
    turnId: currentTurnId,
    frameRef: currentFrameRef
  };
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

function summarizeRecentHistory(items: SessionHistoryEntry[]) {
  const recent = items.slice(0, 3).reverse();
  return {
    summary: recent.map((item) => `${item.eventKind}: ${item.summary}`).join("\n"),
    refs: [...new Set(recent.flatMap((item) => item.sourceRefs ?? [item.turnId]))],
    turnRefs: [...new Set(recent.map((item) => item.turnId))]
  };
}

export function createEndecApp(options: EndecAppOptions): EndecApp {
  const env = options.env ?? process.env;
  const errorExposureMode = resolveErrorExposureMode(env.ENDEC_ERROR_EXPOSURE_MODE);
  const paths = ensureEndecDataLayout(options.dataDir);
  const { transport: providerTransport, fetchImplementation } = createDefaultProviderTransport(options.providerTransport);
  const providerCatalog = createAppProviderCatalog({
    env,
    providerRegistrations: options.providerRegistrations
  });
  const providerModelDiscovery = createProviderModelDiscovery({
    env,
    catalog: providerCatalog,
    fetchImplementation
  });
  const providerAvailabilityCache = new Map<
    string,
    Promise<{
      providerId: string;
      baseUrl: string;
      availableModelIds: string[];
    } | null>
  >();

  const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
  const sessionQueryStore = createSessionQueryStore({ filename: paths.sessionsDbPath });
  const taskStore = createTaskStore({ filename: paths.tasksDbPath });
  const taskRunStore = createTaskRunStore({ filename: paths.tasksDbPath });
  const taskEventStore = createTaskEventStore({ filename: paths.tasksDbPath });
  const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
  const runControlStore = createRunControlStore({ filename: paths.tasksDbPath });
  const accessStore = createAccessStore({ filename: paths.accessDbPath });
  const memoryStore = createMemoryStore({
    filename: paths.memoryDbPath,
    dailyMemoryProjectionDir: paths.dailyMemoryProjectionDir
  });
  const artifactStore = createArtifactStore({ rootDir: paths.artifactsDir });
  const costLedger = createCostLedger({ filename: paths.costLedgerDbPath });
  const budgetService = createBudgetService({ ledger: costLedger, toolLoop: options.toolLoop });

  async function resolveLegacyDefaultCurrentModel(): Promise<EndecCurrentModelSelection> {
    const modelsConfig = await loadModelsConfig({ paths });
    if (modelsConfig) {
      return resolveCurrentModelSelection({
        env,
        catalog: providerCatalog,
        modelsConfig
      });
    }

    const initialSelection = resolveCurrentModelSelection({
      env,
      catalog: providerCatalog,
      modelsConfig: undefined
    });
    await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: initialSelection.providerId,
        modelId: initialSelection.modelId
      }
    });

    return resolveCurrentModelSelection({
      env,
      catalog: providerCatalog,
      modelsConfig: await loadModelsConfig({ paths })
    });
  }

  async function resolveConfigSeedProvider(input: {
    source?: TurnRequest["source"];
    accountId?: string;
  } = {}) {
    const fallbackSelection = await resolveLegacyDefaultCurrentModel();

    if (!input.source || !input.accountId || !supportsAccountProviderControl(input.source)) {
      return {
        providerId: fallbackSelection.providerId,
        modelId: fallbackSelection.modelId,
        baseUrl: fallbackSelection.baseUrl
      };
    }

    const [providerControl, providerSecret] = await Promise.all([
      accessStore.getProviderControl({
        source: input.source,
        accountId: input.accountId
      }),
      accessStore.getProviderSecret({
        source: input.source,
        accountId: input.accountId
      })
    ]);

    return {
      providerId: providerControl?.providerId ?? fallbackSelection.providerId,
      modelId: providerControl?.modelId ?? fallbackSelection.modelId,
      baseUrl: providerControl?.baseUrlOverride ?? fallbackSelection.baseUrl,
      apiKey: providerSecret?.apiKey
    };
  }

  const endecConfigService = createEndecConfigService({
    paths,
    env,
    catalog: providerCatalog,
    resolveSeedProvider: resolveConfigSeedProvider
  });

  async function resolveConfiguredCurrentModel(input: {
    source?: TurnRequest["source"];
    accountId?: string;
  } = {}): Promise<EndecCurrentModelSelection> {
    const [modelsConfig, configSnapshot, legacyProviderControl] = await Promise.all([
      loadModelsConfig({ paths }),
      endecConfigService.getSnapshot({
        source: input.source,
        accountId: input.accountId
      }),
      input.source && input.accountId && supportsAccountProviderControl(input.source)
        ? accessStore.getProviderControl({
            source: input.source,
            accountId: input.accountId
          })
        : Promise.resolve(undefined)
    ]);

    const explicitProviderControl = legacyProviderControl?.providerId && legacyProviderControl.modelId
      ? {
          providerId: legacyProviderControl.providerId,
          modelId: legacyProviderControl.modelId,
          baseUrl: legacyProviderControl.baseUrlOverride
        }
      : undefined;

    if (!configSnapshot.config.ownerSelected && !explicitProviderControl) {
      const selection = resolveCurrentModelSelection({
        env,
        catalog: providerCatalog,
        modelsConfig
      });
      return {
        ...selection,
        baseUrl: selection.baseUrl
      };
    }

    const providerControl = explicitProviderControl ?? {
      providerId: configSnapshot.config.provider.providerId,
      modelId: configSnapshot.config.provider.modelId,
      baseUrl: configSnapshot.config.provider.baseUrl
    };

    const selection = resolveCurrentModelSelection({
      env,
      catalog: providerCatalog,
      modelsConfig,
      providerControl: {
        providerId: providerControl.providerId,
        modelId: providerControl.modelId
      }
    });

    return {
      ...selection,
      baseUrl: providerControl.baseUrl ?? selection.baseUrl
    };
  }

  async function resolveExecutionCurrentModel(input: {
    source: TurnRequest["source"];
    accountId?: string;
  }): Promise<EndecCurrentModelSelection> {
    return resolveConfiguredCurrentModel(input);
  }

  async function resolveRuntimeProviderAuth(input: {
    source: TurnRequest["source"];
    accountId?: string;
  }) {
    const [selection, configSnapshot] = await Promise.all([
      resolveConfiguredCurrentModel(input),
      endecConfigService.getSnapshot({
        source: input.source,
        accountId: input.accountId
      })
    ]);

    if (!input.accountId || !supportsAccountProviderControl(input.source) || configSnapshot.config.ownerSelected) {
      return {
        baseUrl: selection.baseUrl,
        apiKey: configSnapshot.config.provider.apiKey
      };
    }

    const providerSecret = await accessStore.getProviderSecret({
      source: input.source,
      accountId: input.accountId
    });

    return {
      baseUrl: selection.baseUrl,
      apiKey: providerSecret?.apiKey ?? configSnapshot.config.provider.apiKey
    };
  }

  async function resolveImCurrentModel(input: {
    source: TurnRequest["source"];
    accountId?: string;
  }) {
    return resolveConfiguredCurrentModel(input);
  }

  async function listSelectableModelsForIm() {
    const currentModel = await resolveConfiguredCurrentModel();
    const modelsConfig = await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: currentModel.providerId,
        modelId: currentModel.modelId
      }
    });
    return listSelectableModelsFromConfig(modelsConfig);
  }

  const conversationDirectory = createConversationDirectory({
    accessStore
  });
  const providerControlService = createProviderControlService({
    configService: endecConfigService,
    accessStore,
    catalog: providerCatalog,
    env
  });
  const selfInspectionService = createSelfInspectionService({
    repoRoot: DEFAULT_SELF_INSPECTION_REPO_ROOT,
    dataDir: paths.dataDir,
    env,
    providerCatalog,
    accessStore,
    configService: endecConfigService
  });

  async function getStatusSnapshot(input: {
    sessionId?: string;
    source?: EndecImSource;
    accountId?: string;
    suppressSessionTruth?: boolean;
  } = {}) {
    const [currentModelSelection, configSnapshot] = await Promise.all([
      input.source && input.accountId
        ? resolveImCurrentModel({
            source: input.source,
            accountId: input.accountId
          })
        : resolveConfiguredCurrentModel(),
      endecConfigService.getSnapshot({
        source: input.source,
        accountId: input.accountId
      })
    ]);
    const currentModelStatus = await buildCurrentModelStatus(currentModelSelection);

    const snapshot = await buildAppStatusSnapshot({
      productName: "endec",
      dataDir: paths.dataDir,
      capabilities: {
        execute: true,
        history: true,
        artifactRead: true,
        evidenceRead: true
      },
      currentModel: currentModelStatus.currentModel,
      config: {
        source: configSnapshot.source,
        loadedAt: configSnapshot.loadedAt,
        schemaVersion: configSnapshot.schemaVersion
      },
      warningDetails: currentModelStatus.warningDetails,
      warnings: currentModelStatus.warnings,
      sessionId: input.sessionId,
      sessionQueryStore,
      runStore: taskRunStore,
      sliceStore,
      controlStore: runControlStore,
      costLedger: {
        async loadByTurnId(turnId: string) {
          const row = await costLedger.loadByTurnId(turnId);
          if (!row) {
            return undefined;
          }

          return {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            totalTokens: row.totalTokens,
            estimatedCost: row.estimatedCost,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens
          };
        }
      }
    });

    if (!input.suppressSessionTruth) {
      return snapshot;
    }

    return {
      ...snapshot,
      activeRun: { state: "unknown" as const },
      lastTurn: { state: "unknown" as const }
    };
  }

  const commandService = createImCommandService({
    accessStore,
    resolveConversationTarget: conversationDirectory.resolveConversationTarget,
    resolveCurrentModel: ({ source, accountId }) => resolveImCurrentModel({ source, accountId }),
    listSelectableModels: () => listSelectableModelsForIm(),
    providerControlService,
    selfInspectionService,
    updateCurrentModel: async ({ source, accountId, providerId, modelId, updatedByActorId, clearProviderScopedSecrets }) => {
      const snapshot = await endecConfigService.updateProvider({
        providerId,
        modelId,
        updatedByActorId,
        clearBaseUrl: clearProviderScopedSecrets,
        clearApiKey: clearProviderScopedSecrets
      });
      await accessStore.upsertProviderControl({
        source,
        accountId,
        providerId: snapshot.config.provider.providerId,
        modelId: snapshot.config.provider.modelId,
        baseUrlOverride: snapshot.config.provider.baseUrl,
        updatedByActorId
      }).catch(() => undefined);
      if (clearProviderScopedSecrets) {
        await accessStore.clearProviderSecret({
          source,
          accountId
        }).catch(() => undefined);
      }
    },
    reloadConfig: async ({ source, accountId }) => {
      const snapshot = await endecConfigService.reload();
      return {
        source: snapshot.source,
        loadedAt: snapshot.loadedAt,
        schemaVersion: snapshot.schemaVersion
      };
    },
    requestRestart: options.requestExit
      ? async ({ source, accountId, actorId }) => async () => {
          await options.requestExit!({
            code: 0,
            reason: `owner private restart via ${source}/${accountId ?? "unknown"} requested by ${actorId}`
          });
        }
      : undefined,
    getStatusSnapshot
  });

  const budgetPort = {
    async resolve(request: TurnRequest) {
      const baseResolution = await budgetService.resolve(request);
      const selection = await resolveExecutionCurrentModel({
        source: request.source,
        accountId: request.conversationRef?.accountId
      });
      const metadata = resolveSelectionMetadata({
        catalog: providerCatalog,
        selection
      });
      const resolution = await budgetService.resolve(request, {
        providerCapability: metadata.capabilities,
        providerId: selection.providerId,
        modelId: selection.modelId,
        protocolFamily: metadata.protocolFamily,
        outputReserveTokens: baseResolution.outputTokenBudget,
        safetyReserveTokens: 0
      });

      return {
        resolvedMode: resolution.resolvedMode,
        model: {
          providerId: selection.providerId,
          modelId: selection.modelId
        },
        limits: {
          inputTokenBudget: resolution.inputTokenBudget,
          outputTokenBudget: resolution.outputTokenBudget,
          memoryInjectionBudget: resolution.memoryInjectionBudget,
          toolResultInjectionBudget: resolution.toolResultInjectionBudget,
          maxLoopCount: resolution.maxLoopCount,
          maxToolCallsPerBatch: resolution.maxToolCallsPerBatch,
          maxToolCallsPerTurn: resolution.maxToolCallsPerTurn,
          toolLoop: resolution.toolLoop
        },
        budgetDebug: resolution.budgetDebug
      };
    },
    evaluateBudget: budgetService.evaluateBudget,
    recordCost: budgetService.recordCost
  };
  const provider = createProviderAdapter({
    catalog: providerCatalog,
    transport: providerTransport,
    env
  });
  const artifactPolicy = createArtifactPolicy(artifactStore);
  const toolPort = createAppToolPort({
    artifacts: artifactPolicy
  });
  const runtimeService = createRuntimeService({
    provider,
    tools: toolPort,
    artifacts: artifactPolicy
  });
  const toolExposureResolver = createToolExposureResolver({
    toolPort,
    resolver: options.toolExposureResolver,
    selfInspectionService,
    async canRevealSelfInspectionSecrets(request) {
      if ((request.source !== "telegram" && request.source !== "feishu")
        || !request.conversationRef?.accountId
        || request.imContext?.boundary.conversationScope !== "direct") {
        return false;
      }

      const ownerBinding = await accessStore.inspectOwnerBinding({
        source: request.source,
        accountId: request.conversationRef.accountId
      });
      return ownerBinding?.ownerActorId === request.actorId;
    }
  });
  const personaResolver = createPersonaResolver({
    accessStore
  });
  const activeTurnRequests = new Map<string, TurnRequest>();
  const runtimePort = {
    async run(input: Parameters<typeof runtimeService.run>[0]) {
      const request = activeTurnRequests.get(input.turnId);
      if (!request?.conversationRef?.accountId || !supportsAccountProviderControl(request.source)) {
        return runtimeService.run(input);
      }

      const providerAuth = await resolveRuntimeProviderAuth({
        source: request.source,
        accountId: request.conversationRef.accountId
      });
      const providerAuthOverride = createProviderAuthOverrideBlock({
        turnId: input.turnId,
        baseUrl: providerAuth.baseUrl,
        apiKey: providerAuth.apiKey
      });

      return runtimeService.run({
        ...input,
        contextBlocks: providerAuthOverride
          ? [...input.contextBlocks, providerAuthOverride]
          : input.contextBlocks
      });
    }
  };
  const contextAssembler = createContextAssembler({
    historyStore: {
      loadRecentHistory: sessionQueryStore.loadRecentHistory
    },
    memoryStore: {
      retrieve: memoryStore.retrieve
    },
    taskStore,
    ownerStateStore: {
      inspectOwnerBinding: async (request) => {
        const inspection = await accessStore.inspectOwnerBinding({
          source: request.source,
          accountId: request.accountId
        });
        if (!inspection) {
          return undefined;
        }

        const ownerPreferences = await accessStore.getOwnerPreferences({
          source: request.source,
          accountId: request.accountId
        });

        return {
          ownerBinding: inspection,
          resolvedOwnerPreferences: resolveOwnerPreferences({
            serverTimezone: resolveServerTimezone({ env }),
            stored: ownerPreferences
          })
        };
      },
      resolveServerTimezone: () => resolveServerTimezone({ env })
    },
    resolvePersona: personaResolver.resolvePersona,
    resolveToolExposure: toolExposureResolver
  });
  const core = createAgentCore({
    sessionStore,
    contextAssembler,
    memoryPort: {
      enqueueWrites: async (writes) => {
        const writesByTurnId = new Map<string, typeof writes>();
        for (const write of writes) {
          const grouped = writesByTurnId.get(write.sourceTurnId) ?? [];
          grouped.push(write);
          writesByTurnId.set(write.sourceTurnId, grouped);
        }

        const filteredWrites = [...writesByTurnId.entries()].flatMap(([turnId, grouped]) => {
          const request = activeTurnRequests.get(turnId);
          return request
            ? filterImMemoryWrites({ request, memoryWrites: grouped })
            : grouped;
        });

        return memoryStore.enqueueWrites(filteredWrites);
      }
    },
    toolPort,
    budgetPort,
    runtimePort,
    errorExposureMode
  });

  async function inspectProviderAvailability(providerId: string) {
    if (!providerModelDiscovery) {
      return null;
    }

    let inspectionPromise = providerAvailabilityCache.get(providerId);
    if (!inspectionPromise) {
      inspectionPromise = providerModelDiscovery.inspectProviderAvailability(providerId)
        .catch(() => null);
      providerAvailabilityCache.set(providerId, inspectionPromise);
    }

    return inspectionPromise;
  }

  async function buildCurrentModelStatus(selection: EndecCurrentModelSelection) {
    const inspection = await inspectProviderAvailability(selection.providerId);
    return evaluateCurrentModelStatus({
      selection,
      inspection,
      catalog: providerCatalog
    });
  }

  async function ensureResolvedModelIsAvailable(request: TurnRequest) {
    const selection = await resolveExecutionCurrentModel({
      source: request.source,
      accountId: request.conversationRef?.accountId
    });
    const selectionStatus = await buildCurrentModelStatus(selection);

    if (!selectionStatus.executeReady) {
      throw new ExecutePathSelectionError(selectionStatus.warningDetails);
    }
  }

  async function updateWorkingSetAfterCommit(request: TurnRequest, result: TurnResult) {
    if (result.status === "failed") {
      return;
    }

    const [requestedTask, recentHistory] = await Promise.all([
      request.taskId
        ? taskStore.loadById(request.taskId)
        : taskStore.loadLatestActiveBySession(request.sessionId),
      sessionQueryStore.loadRecentHistory({
        sessionId: request.sessionId,
        limit: 6
      })
    ]);
    const workingSetUpdate = synthesizeWorkingSet({
      request,
      result,
      activeTask: mapTaskSnapshot(requestedTask),
      recentHistory
    });

    if (!workingSetUpdate.summary) {
      return;
    }

    const updatedWorkingSet = await memoryStore.updateWorkingSet({
      sessionId: request.sessionId,
      summary: workingSetUpdate.summary,
      highlights: workingSetUpdate.highlights,
      sourceRefs: workingSetUpdate.sourceRefs,
      blockerSnapshot: result.status === "blocked" ? result.blockedBy : undefined,
      objective: workingSetUpdate.objective,
      recentProgress: workingSetUpdate.recentProgress,
      recentDecisions: workingSetUpdate.recentDecisions,
      blockers: workingSetUpdate.blockers,
      openLoops: workingSetUpdate.openLoops,
      activeMemoryRefs: workingSetUpdate.activeMemoryRefs,
      activeTaskRefs: workingSetUpdate.activeTaskRefs,
      recentEventRefs: workingSetUpdate.recentEventRefs
    });
    await sessionStore.updateWorkingSetPointer({
      sessionId: request.sessionId,
      workingSetRef: updatedWorkingSet.workingSetRef,
      workingSetVersion: updatedWorkingSet.version
    });
  }

  async function drainMemoryOutboxBestEffort() {
    try {
      await memoryStore.drainOutbox({
        maxItems: 8,
        includeFailed: true
      });
    } catch {
      // best-effort only; durable enqueue remains the source of truth
    }
  }

  async function recordInteractiveConversationActivity(request: TurnRequest) {
    if (!request.conversationRef?.accountId || (request.source !== "telegram" && request.source !== "feishu")) {
      return;
    }

    await conversationDirectory.recordConversationActivity({
      source: request.source,
      accountId: request.conversationRef.accountId,
      conversationRef: request.conversationRef,
      sessionId: request.sessionId
    });
  }

  async function runAndCommit(input: {
    request: TurnRequest;
    sourceRefs?: string[];
    run: () => Promise<TurnResult>;
  }): Promise<TurnResult> {
    activeTurnRequests.set(input.request.turnId, input.request);
    try {
      await ensureResolvedModelIsAvailable(input.request);
      await recordInteractiveConversationActivity(input.request);

      const result = await input.run();
      await commitTurnProjection({
        sessionStore,
        request: input.request,
        result,
        sourceRefs: input.sourceRefs
      });
      await updateWorkingSetAfterCommit(input.request, result);
      await drainMemoryOutboxBestEffort();
      return result;
    } catch (error) {
      await sessionStore.finalize({
        turnId: input.request.turnId,
        sessionId: input.request.sessionId,
        status: "failed"
      });

      const failedResult = createFailedTurnResult(input.request, error, errorExposureMode);
      await commitTurnProjection({
        sessionStore,
        request: input.request,
        result: failedResult,
        sourceRefs: input.sourceRefs
      });

      return failedResult;
    } finally {
      activeTurnRequests.delete(input.request.turnId);
    }
  }

  async function executeAndCommit(request: TurnRequest): Promise<TurnResult> {
    return runAndCommit({
      request,
      run: () => core.executeTurn(request)
    });
  }

  function buildBackgroundEnqueueIdempotencyKey(request: TurnRequest, normalizedIntent: string) {
    const conversationId = request.conversationRef?.conversationId ?? "no_conversation";
    return [
      "bg_enqueue",
      request.sessionId,
      request.turnId,
      conversationId,
      normalizedIntent
    ].join(":");
  }

  function createDeterministicBackgroundEntityId(input: {
    prefix: "task_bg" | "run_bg";
    scope: "task" | "run";
    idempotencyKey: string;
  }) {
    const digest = createHash("sha256")
      .update(`${input.scope}\u001f${input.idempotencyKey}`)
      .digest("hex")
      .slice(0, 32);
    return `${input.prefix}_${digest}`;
  }

  async function enqueueExplicitBackgroundTask(request: TurnRequest) {
    const intent = parseBackgroundIntent(request);
    if (!intent) {
      return null;
    }

    const idempotencyKey = buildBackgroundEnqueueIdempotencyKey(request, intent.normalizedIntent);
    const taskId = createDeterministicBackgroundEntityId({
      prefix: "task_bg",
      scope: "task",
      idempotencyKey
    });
    const runId = createDeterministicBackgroundEntityId({
      prefix: "run_bg",
      scope: "run",
      idempotencyKey
    });
    const now = new Date().toISOString();

    const existing = await taskStore.listActiveBySession(request.sessionId);
    for (const candidate of existing) {
      const runs = await taskRunStore.listRunsByTask(candidate.taskId);
      const matched = runs.find((run) => run.idempotencyKey === idempotencyKey);
      if (!matched) {
        continue;
      }

      await taskEventStore.appendTaskEvent({
        taskId: candidate.taskId,
        runId: matched.runId,
        workspaceId: matched.workspaceId,
        eventType: "task_created",
        severity: "info",
        message: `background task created: ${intent.title}`,
        idempotencyKey: `${idempotencyKey}:task_created`,
        now: new Date(now)
      });

      await taskEventStore.appendTaskEvent({
        taskId: candidate.taskId,
        runId: matched.runId,
        workspaceId: matched.workspaceId,
        eventType: "run_queued",
        severity: "info",
        message: `background run queued: ${matched.runId}`,
        idempotencyKey: `${idempotencyKey}:run_queued`,
        now: new Date(now)
      });

      const ack = createBackgroundAckTurnResult({
        turnId: request.turnId,
        sessionId: request.sessionId,
        resolvedMode: request.requestedMode ?? "chat",
        checkpointRef: `checkpoint:${request.turnId}`,
        taskId: candidate.taskId,
        summary: intent.title
      });
      await commitTurnProjection({
        sessionStore,
        request,
        result: ack
      });
      await updateWorkingSetAfterCommit(request, ack);
      await drainMemoryOutboxBestEffort();
      return ack;
    }

    await taskRunStore.createBackgroundTask({
      taskId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      conversationRef: request.conversationRef,
      title: intent.title,
      description: intent.description,
      sourceTurnId: request.turnId,
      now
    });

    await taskRunStore.enqueueRun({
      runId,
      taskId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      conversationRef: request.conversationRef,
      idempotencyKey,
      turnRequest: {
        turnId: request.turnId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        source: request.source,
        input: intent.input,
        conversationRef: request.conversationRef,
        requestedMode: request.requestedMode,
        originTurnId: request.turnId
      },
      sourceTurnId: request.turnId,
      maxAttempts: 1,
      seedInitialSlice: true,
      now
    });

    await taskEventStore.appendTaskEvent({
      taskId,
      runId,
      workspaceId: request.workspaceId,
      eventType: "task_created",
      severity: "info",
      message: `background task created: ${intent.title}`,
      idempotencyKey: `${idempotencyKey}:task_created`,
      now: new Date(now)
    });

    await taskEventStore.appendTaskEvent({
      taskId,
      runId,
      workspaceId: request.workspaceId,
      eventType: "run_queued",
      severity: "info",
      message: `background run queued: ${runId}`,
      idempotencyKey: `${idempotencyKey}:run_queued`,
      now: new Date(now)
    });

    const ack = createBackgroundAckTurnResult({
      turnId: request.turnId,
      sessionId: request.sessionId,
      resolvedMode: request.requestedMode ?? "chat",
      checkpointRef: `checkpoint:${request.turnId}`,
      taskId,
      summary: intent.title
    });

    await commitTurnProjection({
      sessionStore,
      request,
      result: ack
    });
    await updateWorkingSetAfterCommit(request, ack);
    await drainMemoryOutboxBestEffort();
    return ack;
  }

  const authority = createAuthorityService({
    accessStore,
    resolveSessionId: async (resolution) => sessionStore.openOrCreateSession({
      sessionId: resolution.binding?.sessionId,
      workspaceId: resolution.workspaceId,
      source: resolution.source
    }),
    resolveActorId: async (resolution) => {
      if (resolution.binding?.actorId) {
        return resolution.binding.actorId;
      }

      return `actor_im_${createHash("sha256")
        .update([resolution.source, resolution.accountId, resolution.senderId].join("\u001f"))
        .digest("hex")
        .slice(0, 24)}`;
    },
    enqueueOutboundEvent: taskStore.enqueueOutboundEvent,
    projectOwnerNotice: async (notice) => {
      await commitAdministrativeTurn({
        sessionStore,
        turnId: `authority_notice_${randomUUID()}`,
        sessionId: notice.sessionId,
        workspaceId: notice.workspaceId,
        source: notice.source,
        mode: "chat",
        status: "completed",
        summary: notice.summary,
        text: notice.text,
        sourceRefs: notice.sourceRefs,
        eventKind: "assistant_message",
        createdAt: notice.createdAt
      });
    },
    resolveServerTimezone: () => resolveServerTimezone({ env })
  });

  const im = createEndecImHost({
    sessionStore,
    authority,
    commandService,
    conversationDirectory,
    ownerInit: {
      inspectOwnerBinding: async (request) => authority.inspectOwnerBinding({
        source: request.source,
        accountId: request.accountId
      }),
      upsertOwnerPreferences: async (request) => {
        await accessStore.upsertOwnerPreferences(request);
      },
      upsertOwnerInitState: async (request) => {
        await accessStore.upsertOwnerInitState(request);
      },
      resolveServerTimezone: () => resolveServerTimezone({ env })
    }
  });

  function hasAuthoritativeDetachedRecoveryTruth(run: Awaited<ReturnType<typeof taskRunStore.loadRunById>> | null | undefined) {
    return run?.attentionMode === "background_detached"
      && (run.recoveryTruthState === "consumed" || run.recoveryTruthState === "closed");
  }

  async function clearDetachedBackgroundSessionTruth(input: {
    sessionId: string;
    runId: string;
    clearRecovery?: boolean;
  }) {
    if (input.clearRecovery) {
      const recovery = await sessionStore.loadRecoveryContext(input.sessionId);
      if (recovery?.inflight.turnId === input.runId) {
        await sessionStore.finalize({
          turnId: input.runId,
          sessionId: input.sessionId,
          status: "interrupted"
        });
      }
    }

    const focus = await sessionStore.loadFocusRun?.(input.sessionId);
    if (focus?.runId === input.runId) {
      await sessionStore.clearFocusRun?.({
        sessionId: input.sessionId
      });
    }
  }

  async function loadActiveRecoveryContext(sessionId: string) {
    const recovery = await sessionStore.loadRecoveryContext(sessionId);
    if (!recovery) {
      return null;
    }

    const run = await taskRunStore.loadRunById(recovery.inflight.turnId);
    if (run
      && run.sessionId === sessionId
      && hasAuthoritativeDetachedRecoveryTruth(run)) {
      await clearDetachedBackgroundSessionTruth({
        sessionId,
        runId: run.runId,
        clearRecovery: true
      });
      return null;
    }

    if (run
      && run.sessionId === sessionId
      && run.attentionMode === "background_detached"
      && run.status !== "blocked"
      && run.status !== "running") {
      await clearDetachedBackgroundSessionTruth({
        sessionId,
        runId: run.runId,
        clearRecovery: true
      });
      return null;
    }

    if (run && run.sessionId === sessionId && run.attentionMode === "background_detached") {
      await clearDetachedBackgroundSessionTruth({
        sessionId,
        runId: run.runId,
        clearRecovery: false
      });
    }

    return recovery;
  }

  function createApprovalRequiredResumeError(sessionId: string, decisionId: string) {
    return new Error(
      `Session ${sessionId} is waiting on approval decision ${decisionId}. Use approve/deny with --decision ${decisionId} instead of resume.`
    );
  }

  async function recoverResolvedContinuationFromPayload(input: {
    sessionId: string;
    payload?: unknown;
    session?: SessionSnapshot;
  }): Promise<ResolvedContinuationRecovery | null> {
    const durableRecovery = readContinuationSlicePayload(input.payload)?.recovery;
    if (!durableRecovery) {
      return null;
    }

    const session = input.session ?? await sessionStore.loadById(input.sessionId);
    if (!session) {
      return null;
    }

    const checkpointRef = durableRecovery.checkpointRef
      ?? durableRecovery.pendingExecution.checkpointRef
      ?? durableRecovery.pendingExecution.frame.checkpointRef
      ?? `checkpoint:${durableRecovery.turnId}`;
    const frameRef = durableRecovery.frameRef ?? durableRecovery.pendingExecution.frameRef;

    return {
      source: durableRecovery.source,
      mode: durableRecovery.mode,
      recoveryContext: {
        session,
        inflight: {
          turnId: durableRecovery.turnId,
          sessionId: durableRecovery.sessionId,
          workspaceId: durableRecovery.workspaceId,
          state: durableRecovery.pendingApprovalRef ? "awaiting_permission" : "awaiting_user_decision",
          waitingReason: durableRecovery.pendingApprovalRef ? "permission" : "user_decision",
          resumePolicy: "resume",
          loopCount: durableRecovery.pendingExecution.frame.loopCount,
          toolCallCount: durableRecovery.pendingExecution.frame.toolCallCount,
          pendingApprovalRef: durableRecovery.pendingApprovalRef,
          checkpointRef,
          frameRef,
          contractVersion: durableRecovery.pendingExecution.contractVersion,
          pendingExecution: durableRecovery.pendingExecution,
          createdAt: session.updatedAt,
          updatedAt: session.updatedAt
        },
        checkpointRef,
        recentTurnRefs: session.recentTurnRefs
      }
    };
  }

  async function resolveSliceRecoveryContext(input: {
    run: Pick<Awaited<ReturnType<typeof taskRunStore.loadRunById>> & { runId: string; sessionId: string; workspaceId: string }, "runId" | "sessionId" | "workspaceId">;
    slice: { continuationPayload?: unknown };
  }): Promise<ResolvedContinuationRecovery | null> {
    const recoveryContext = await loadActiveRecoveryContext(input.run.sessionId);
    if (recoveryContext?.inflight.turnId === input.run.runId && recoveryContext.inflight.pendingExecution) {
      return {
        recoveryContext,
        source: recoveryContext.session.lastSource,
        mode: recoveryContext.session.mode
      };
    }

    const resolvedFromSlice = await recoverResolvedContinuationFromPayload({
      sessionId: input.run.sessionId,
      payload: input.slice.continuationPayload
    });
    if (resolvedFromSlice?.recoveryContext.inflight.turnId === input.run.runId) {
      return resolvedFromSlice;
    }

    const currentRun = await taskRunStore.loadRunById(input.run.runId);
    const resolvedFromRun = await recoverResolvedContinuationFromPayload({
      sessionId: input.run.sessionId,
      payload: currentRun?.continuationPayload
    });
    return resolvedFromRun?.recoveryContext.inflight.turnId === input.run.runId ? resolvedFromRun : null;
  }

  async function resolveTask2DurableBackgroundRecovery(input: {
    control: ExecutionControlInput;
  }): Promise<ResolvedContinuationRecovery | null> {
    if ((input.control.action !== "resume"
      && input.control.action !== "approve"
      && input.control.action !== "deny"
      && input.control.action !== "cancel")
      || !input.control.turnId) {
      return null;
    }

    const run = await taskRunStore.loadRunById(input.control.turnId);
    if (!run
      || run.sessionId !== input.control.sessionId
      || run.attentionMode !== "background_detached"
      || run.status === "completed"
      || run.status === "failed"
      || run.status === "canceled"
      || run.recoveryTruthState === "closed") {
      return null;
    }

    const session = await sessionStore.loadById(run.sessionId);
    if (!session) {
      return null;
    }

    const slices = await sliceStore.listSlicesByRun(run.runId);
    if (run.status === "queued" || run.status === "running") {
      for (const slice of [...slices]
        .filter((candidate) => candidate.status === "queued" || candidate.status === "running")
        .sort((left, right) => left.sliceNo - right.sliceNo)) {
        const resolvedFromSlice = await recoverResolvedContinuationFromPayload({
          sessionId: run.sessionId,
          payload: slice.continuationPayload,
          session
        });
        if (resolvedFromSlice?.recoveryContext.inflight.turnId === run.runId) {
          return resolvedFromSlice;
        }
      }
    }

    const resolvedFromRun = await recoverResolvedContinuationFromPayload({
      sessionId: run.sessionId,
      payload: run.continuationPayload,
      session
    });
    if (resolvedFromRun?.recoveryContext.inflight.turnId === run.runId) {
      return resolvedFromRun;
    }

    for (const slice of [...slices].sort((left, right) => right.sliceNo - left.sliceNo)) {
      const resolvedFromSlice = await recoverResolvedContinuationFromPayload({
        sessionId: run.sessionId,
        payload: slice.continuationPayload,
        session
      });
      if (resolvedFromSlice?.recoveryContext.inflight.turnId === run.runId) {
        return resolvedFromSlice;
      }
    }

    return null;
  }

  async function tryHandleDetachedQueuedOrRunningCancelWithoutRecovery(input: {
    control: Extract<ExecutionControlInput, { action: "cancel" }>;
    inflightRecoveryContext: Awaited<ReturnType<typeof sessionStore.loadRecoveryContext>> | null;
  }): Promise<TurnResult | undefined> {
    if (!input.control.turnId) {
      return undefined;
    }

    const run = await taskRunStore.loadRunById(input.control.turnId);
    if (!run
      || run.sessionId !== input.control.sessionId
      || run.attentionMode !== "background_detached"
      || (run.status !== "queued" && run.status !== "running")) {
      return undefined;
    }

    const continuation = input.inflightRecoveryContext?.inflight.turnId === run.runId
      ? {
          recoveryContext: input.inflightRecoveryContext,
          source: input.inflightRecoveryContext.session.lastSource,
          mode: input.inflightRecoveryContext.session.mode
        }
      : await resolveTask2DurableBackgroundRecovery({ control: input.control });

    const cancelOutcome = await lifecycle.cancelDetachedRun({
      sessionId: run.sessionId,
      taskId: run.taskId,
      runId: run.runId,
      attentionMode: run.attentionMode,
      reason: input.control.reason ?? "cancelled",
      requestedBy: createExecutionControlActorId(input.control.action)
    });

    const [runAfterControl, session] = await Promise.all([
      taskRunStore.loadRunById(run.runId),
      sessionStore.loadById(run.sessionId)
    ]);
    const requestedMode = typeof run.turnRequest === "object"
      && run.turnRequest
      && typeof (run.turnRequest as { requestedMode?: unknown }).requestedMode === "string"
      ? (run.turnRequest as { requestedMode: SessionSnapshot["mode"] }).requestedMode
      : undefined;
    const resolvedMode = continuation?.mode ?? session?.mode ?? requestedMode ?? "chat";
    const checkpointRef = continuation?.recoveryContext.checkpointRef ?? `checkpoint:${run.runId}`;
    const frameRef = continuation?.recoveryContext.inflight.frameRef ?? run.pendingControlRef;

    if (cancelOutcome.status === "canceled" || cancelOutcome.status === "cancel_requested") {
      return createDetachedTask2AckTurnResult({
        turnId: run.runId,
        sessionId: run.sessionId,
        resolvedMode,
        checkpointRef,
        frameRef,
        warning: input.control.reason ?? "cancelled"
      });
    }

    return runAfterControl
      ? createDetachedTask2TerminalTurnResult({
          run: runAfterControl,
          turnId: run.runId,
          sessionId: run.sessionId,
          resolvedMode,
          checkpointRef,
          frameRef
        })
      : undefined;
  }

  function createContinuationProjectionRequest(input: {
    control: ExecutionControlInput;
    continuation: ResolvedContinuationRecovery;
  }): TurnRequest {
    const pendingExecution = input.continuation.recoveryContext.inflight.pendingExecution;
    if (!pendingExecution) {
      throw new Error(`Session ${input.continuation.recoveryContext.session.sessionId} does not expose a recoverable pending execution.`);
    }

    return {
      turnId: pendingExecution.frame.turnId,
      sessionId: pendingExecution.frame.sessionId,
      workspaceId: pendingExecution.frame.workspaceId,
      source: input.continuation.source,
      actorId: resolveContinuationActorId(input.continuation.recoveryContext) ?? createExecutionControlActorId(input.control.action),
      input: input.control.action === "resume" ? (input.control.input ?? "") : "",
      attachments: [],
      requestedMode: input.continuation.mode,
      resumeFrom: pendingExecution.checkpointRef ?? input.continuation.recoveryContext.checkpointRef,
      channelContext: {
        executionControl: input.control,
        executionControlActorId: createExecutionControlActorId(input.control.action),
        continuationFrameRef: pendingExecution.frameRef,
        pendingExecutionId: pendingExecution.pendingExecutionId
      }
    };
  }

  async function continueAndCommit(input: {
    control: ExecutionControlInput;
    continuation: ResolvedContinuationRecovery;
  }): Promise<TurnResult> {
    const pendingExecution = input.continuation.recoveryContext.inflight.pendingExecution;
    if (!pendingExecution) {
      throw new Error(`Session ${input.continuation.recoveryContext.session.sessionId} does not expose a recoverable pending execution.`);
    }

    const request = createContinuationProjectionRequest(input);
    const sourceRefs = [
      pendingExecution.frame.turnId,
      pendingExecution.checkpointRef,
      pendingExecution.frameRef
    ].filter((value): value is string => typeof value === "string" && value.length > 0);

    return runAndCommit({
      request,
      sourceRefs,
      run: () => core.continueExecution({
        session: {
          sessionId: input.continuation.recoveryContext.session.sessionId,
          workspaceId: input.continuation.recoveryContext.session.workspaceId,
          source: input.continuation.source,
          mode: input.continuation.mode
        },
        pendingExecution,
        control: input.control
      })
    });
  }

  let shellExecuteTurn: ((request: TurnRequest) => Promise<TurnResult>) | undefined;

  const lifecycle = createRunLifecycle({
    tasksDbPath: paths.tasksDbPath,
    runStore: taskRunStore,
    sliceStore,
    controlStore: runControlStore,
    sessionStore,
    executeTurnSlice: async (request) => {
      if (!shellExecuteTurn) {
        throw new Error("shell executeTurn is not initialized");
      }
      return shellExecuteTurn(request);
    },
    continueSlice: async ({ run, slice }) => {
      const continuation = await resolveSliceRecoveryContext({ run, slice });
      const turnId = run.runId;
      const recoveryContext = continuation?.recoveryContext;
      if (!continuation || !recoveryContext || recoveryContext.inflight.turnId !== turnId || !recoveryContext.inflight.pendingExecution) {
        throw new Error(`No recoverable turn is open for session ${run.sessionId}.`);
      }

      const storedControl = readContinuationSlicePayload(slice.continuationPayload)?.control;
      const parsedControl = storedControl && typeof storedControl === "object"
        ? ExecutionControlInputSchema.parse(storedControl)
        : undefined;
      const control = parsedControl ?? {
        schemaVersion: 1,
        contractVersion: EXECUTION_CONTROL_CONTRACT_VERSION,
        action: "resume",
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        turnId,
        frameRef: recoveryContext.inflight.frameRef,
        input: typeof run.turnRequest === "object" && run.turnRequest && typeof (run.turnRequest as { input?: unknown }).input === "string"
          ? (run.turnRequest as { input: string }).input
          : ""
      };

      await lifecycle.persistRunningSliceContinuationPayload({
        runId: run.runId,
        sliceId: slice.sliceId,
        continuationPayload: buildDurableSliceRecoveryPayload({
          recoveryContext,
          source: continuation.source,
          mode: continuation.mode,
          basePayload: slice.continuationPayload,
          control
        })
      });

      await sessionStore.finalize({
        turnId,
        sessionId: run.sessionId,
        status: "interrupted"
      });

      return continueAndCommit({
        control,
        continuation
      });
    },
    resolveApprovalSlice: async ({ run, slice }) => {
      const continuation = await resolveSliceRecoveryContext({ run, slice });
      const turnId = run.runId;
      const recoveryContext = continuation?.recoveryContext;
      if (!continuation || !recoveryContext || recoveryContext.inflight.turnId !== turnId || !recoveryContext.inflight.pendingExecution) {
        throw new Error(`No recoverable turn is open for session ${run.sessionId}.`);
      }
      const storedControl = readContinuationSlicePayload(slice.continuationPayload)?.control;
      const parsedControl = storedControl && typeof storedControl === "object"
        ? ExecutionControlInputSchema.parse(storedControl)
        : undefined;
      const decisionId = recoveryContext.inflight.pendingApprovalRef;
      if (!decisionId) {
        throw new Error(`Session ${run.sessionId} is not waiting on an approval decision.`);
      }
      const control = parsedControl ?? {
        schemaVersion: 1,
        contractVersion: EXECUTION_CONTROL_CONTRACT_VERSION,
        action: "approve",
        sessionId: run.sessionId,
        turnId,
        frameRef: recoveryContext.inflight.frameRef,
        decisionId,
        scope: "once"
      };

      await lifecycle.persistRunningSliceContinuationPayload({
        runId: run.runId,
        sliceId: slice.sliceId,
        continuationPayload: buildDurableSliceRecoveryPayload({
          recoveryContext,
          source: continuation.source,
          mode: continuation.mode,
          basePayload: slice.continuationPayload,
          control
        })
      });

      await sessionStore.finalize({
        turnId,
        sessionId: run.sessionId,
        status: "interrupted"
      });

      return continueAndCommit({
        control,
        continuation
      });
    }
  });

  function continuationKindForResumableSliceTrigger(triggerKind: "initial" | "legacy_cutover" | "auto_continue" | "user_resume" | "approval_resume" | "operator_resume" | "recovery_retry") {
    switch (triggerKind) {
      case "approval_resume":
        return "operator_resume" as const;
      case "auto_continue":
      case "user_resume":
      case "operator_resume":
      case "recovery_retry":
        return triggerKind;
      case "initial":
      case "legacy_cutover":
      default:
        return "auto_continue" as const;
    }
  }

  function mapTurnUsageToSliceUsageSummary(turnResult: TurnResult) {
    return {
      inputTokens: turnResult.usage.inputTokens,
      outputTokens: turnResult.usage.outputTokens,
      totalTokens: turnResult.usage.totalTokens,
      estimatedCost: turnResult.usage.estimatedCost,
      cacheReadTokens: turnResult.usage.cacheReadTokens,
      cacheWriteTokens: turnResult.usage.cacheWriteTokens,
      contextUsedTokens: turnResult.usage.contextUsedTokens,
      maxContextTokens: turnResult.usage.maxContextTokens,
      toolCallCount: turnResult.toolEvents.length
    };
  }

  function mapBackgroundTurnResultToSliceResult(turnResult: TurnResult, triggerKind: "initial" | "legacy_cutover" | "auto_continue" | "user_resume" | "approval_resume" | "operator_resume" | "recovery_retry") {
    const classified = classifyBackgroundTurnResult(turnResult, errorExposureMode);
    switch (classified.outcome) {
      case "succeeded":
        return {
          terminalStatus: "completed" as const,
          resultSummary: classified.resultSummary,
          usageSummary: mapTurnUsageToSliceUsageSummary(turnResult)
        };
      case "failed":
        return {
          terminalStatus: "failed" as const,
          resultSummary: classified.resultSummary,
          error: classified.error,
          usageSummary: mapTurnUsageToSliceUsageSummary(turnResult)
        };
      case "interrupted": {
        if (isResumableInterruptedTurnResult(turnResult)) {
          const refs = extractBlockedSuspendRefs(turnResult);
          return {
            terminalStatus: "yielded" as const,
            resultSummary: classified.resultSummary,
            continuation: {
              kind: continuationKindForResumableSliceTrigger(triggerKind),
              payload: turnResult.continuation,
              pendingControlRef: refs.pendingControlRef
            },
            usageSummary: mapTurnUsageToSliceUsageSummary(turnResult)
          };
        }

        return {
          terminalStatus: "failed" as const,
          resultSummary: classified.resultSummary,
          error: classified.error,
          usageSummary: mapTurnUsageToSliceUsageSummary(turnResult)
        };
      }
      case "canceled":
        return {
          terminalStatus: "canceled" as const,
          resultSummary: classified.resultSummary,
          usageSummary: mapTurnUsageToSliceUsageSummary(turnResult)
        };
      case "suspended": {
        const refs = extractBlockedSuspendRefs(turnResult);
        return {
          terminalStatus: "blocked" as const,
          resultSummary: classified.resultSummary,
          error: classified.error,
          continuation: {
            kind: refs.pendingApprovalRef ? "approval_resume" as const : "operator_resume" as const,
            payload: turnResult.continuation,
            pendingApprovalRef: refs.pendingApprovalRef,
            pendingControlRef: refs.pendingControlRef,
            blockedBy: refs.blockedBy
          },
          usageSummary: mapTurnUsageToSliceUsageSummary(turnResult)
        };
      }
    }
  }

  async function resolveDetachedTask2ResumeOrApproveRaceOutcome(input: {
    action: Extract<ExecutionControlInput["action"], "approve" | "resume">;
    runId: string;
    sessionId: string;
    resolvedMode: TurnResult["resolvedMode"];
    checkpointRef: string;
    frameRef?: string;
    decisionId?: string;
    expectedTriggerKind: "approval_resume" | "operator_resume";
    allowOriginalRunningAck?: boolean;
  }): Promise<TurnResult | undefined> {
    const [runAfterRace, slicesAfterRace] = await Promise.all([
      taskRunStore.loadRunById(input.runId),
      sliceStore.listSlicesByRun(input.runId)
    ]);
    if (!runAfterRace) {
      return undefined;
    }

    return createDetachedTask2TerminalTurnResult({
      run: runAfterRace,
      turnId: input.runId,
      sessionId: input.sessionId,
      resolvedMode: input.resolvedMode,
      checkpointRef: input.checkpointRef,
      frameRef: input.frameRef
    }) ?? resolveAcceptedDetachedTask2ClaimRace({
      control: {
        action: input.action,
        turnId: input.runId,
        sessionId: input.sessionId,
        frameRef: input.frameRef,
        decisionId: input.decisionId
      },
      turnId: input.runId,
      sessionId: input.sessionId,
      resolvedMode: input.resolvedMode,
      checkpointRef: input.checkpointRef,
      frameRef: input.frameRef,
      expectedTriggerKind: input.expectedTriggerKind,
      runStatus: runAfterRace.status,
      slices: slicesAfterRace,
      allowOriginalRunningAck: input.allowOriginalRunningAck
    });
  }

  async function resolveDetachedTask2TerminalControlRaceOutcome(input: {
    action: "deny" | "cancel";
    runId: string;
    sessionId: string;
    resolvedMode: TurnResult["resolvedMode"];
    checkpointRef: string;
    frameRef?: string;
    decisionId?: string;
    reason: string;
  }): Promise<TurnResult | undefined> {
    const [runAfterRace, slicesAfterRace] = await Promise.all([
      taskRunStore.loadRunById(input.runId),
      sliceStore.listSlicesByRun(input.runId)
    ]);
    if (!runAfterRace) {
      return undefined;
    }

    const terminalOutcome = createDetachedTask2TerminalTurnResult({
      run: runAfterRace,
      turnId: input.runId,
      sessionId: input.sessionId,
      resolvedMode: input.resolvedMode,
      checkpointRef: input.checkpointRef,
      frameRef: input.frameRef
    });
    if (terminalOutcome) {
      return terminalOutcome;
    }

    if (input.action === "cancel"
      && (runAfterRace.status === "queued" || runAfterRace.status === "running")
      && (runAfterRace.cancelRequestedAt || runAfterRace.cancelRequestedBy || runAfterRace.cancelReason)) {
      return createDetachedTask2AckTurnResult({
        turnId: input.runId,
        sessionId: input.sessionId,
        resolvedMode: input.resolvedMode,
        checkpointRef: input.checkpointRef,
        frameRef: input.frameRef,
        warning: input.reason
      });
    }

    if (input.action === "deny") {
      return resolveAcceptedDetachedTask2ClaimRace({
        control: {
          action: "approve",
          turnId: input.runId,
          sessionId: input.sessionId,
          frameRef: input.frameRef,
          decisionId: input.decisionId
        },
        turnId: input.runId,
        sessionId: input.sessionId,
        resolvedMode: input.resolvedMode,
        checkpointRef: input.checkpointRef,
        frameRef: input.frameRef,
        expectedTriggerKind: "approval_resume",
        runStatus: runAfterRace.status,
        slices: slicesAfterRace
      });
    }

    return undefined;
  }

  async function tryHandleTask2BackgroundControl(input: {
    control: ExecutionControlInput;
    continuation: ResolvedContinuationRecovery;
    turnId: string;
  }): Promise<TurnResult | undefined> {
    if (input.control.action !== "resume" && input.control.action !== "approve") {
      return undefined;
    }

    const run = await taskRunStore.loadRunById(input.turnId);
    if (!run || run.attentionMode !== "background_detached") {
      return undefined;
    }

    const triggerKind = input.control.action === "approve" ? "approval_resume" as const : "operator_resume" as const;
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      return undefined;
    }

    let runningAcceptedContinuationTriggerKind: "approval_resume" | "operator_resume" | "recovery_retry" | undefined;

    if (run.status === "blocked") {
      const transitioned = await lifecycle.transitionBlockedRunToQueuedSlice({
        sessionId: run.sessionId,
        taskId: run.taskId,
        runId: run.runId,
        attentionMode: run.attentionMode,
        triggerKind,
        lane: "background",
        control: {
          kind: "continue",
          payload: input.control
        },
        continuationPayload: buildDurableSliceRecoveryPayload({
          recoveryContext: input.continuation.recoveryContext,
          source: input.continuation.source,
          mode: input.continuation.mode,
          control: input.control
        })
      });

      if (transitioned.status !== "queued") {
        const raceOutcome = await resolveDetachedTask2ResumeOrApproveRaceOutcome({
          action: input.control.action,
          runId: run.runId,
          sessionId: input.continuation.recoveryContext.session.sessionId,
          resolvedMode: input.continuation.mode,
          checkpointRef: input.continuation.recoveryContext.checkpointRef,
          frameRef: input.continuation.recoveryContext.inflight.frameRef,
          decisionId: input.control.action === "approve" ? input.control.decisionId : undefined,
          expectedTriggerKind: triggerKind
        });
        if (raceOutcome) {
          return raceOutcome;
        }

        throw new Error(`Run ${run.runId} did not produce a runnable ${triggerKind} slice.`);
      }
    } else if (run.status === "queued" || run.status === "running") {
      const openSlice = (await sliceStore.listSlicesByRun(run.runId))
        .filter((slice) => slice.status === "queued" || slice.status === "running")
        .sort((left, right) => left.sliceNo - right.sliceNo)
        .at(0);

      if (!openSlice) {
        if (run.status === "running"
          && input.continuation.recoveryContext.inflight.turnId === run.runId
          && input.continuation.recoveryContext.inflight.pendingExecution) {
          throw new Error(`Run ${run.runId} is already processing a ${triggerKind} slice.`);
        }

        throw new Error(`Run ${run.runId} is ${run.status} without an open slice.`);
      }

      const acceptedContinuationHead = isAcceptedDetachedTask2ContinuationHead({
        control: {
          action: input.control.action,
          turnId: run.runId,
          sessionId: run.sessionId,
          frameRef: input.continuation.recoveryContext.inflight.frameRef,
          decisionId: input.control.action === "approve" ? input.control.decisionId : undefined
        },
        expectedTriggerKind: triggerKind,
        slice: openSlice
      });

      if (!acceptedContinuationHead) {
        if (run.status === "running") {
          throw new Error(`Run ${run.runId} is already processing a ${openSlice.triggerKind} slice.`);
        }
        throw new Error(`Run ${run.runId} already has a queued ${openSlice.triggerKind} slice.`);
      }

      if (run.status === "running") {
        runningAcceptedContinuationTriggerKind = openSlice.triggerKind === "recovery_retry"
          ? "recovery_retry"
          : triggerKind;
      }
    }

    const claimed = await lifecycle.claimRunnableSliceForRun({
      runId: run.runId,
      workerId: `system:execution-control:${input.control.action}`,
      leaseDurationMs: 60_000
    });
    if (claimed.status !== "claimed") {
      const raceOutcome = await resolveDetachedTask2ResumeOrApproveRaceOutcome({
        action: input.control.action,
        runId: run.runId,
        sessionId: input.continuation.recoveryContext.session.sessionId,
        resolvedMode: input.continuation.mode,
        checkpointRef: input.continuation.recoveryContext.checkpointRef,
        frameRef: input.continuation.recoveryContext.inflight.frameRef,
        decisionId: input.control.action === "approve" ? input.control.decisionId : undefined,
        expectedTriggerKind: triggerKind,
        allowOriginalRunningAck: runningAcceptedContinuationTriggerKind === undefined
      });
      if (raceOutcome) {
        return raceOutcome;
      }

      if (runningAcceptedContinuationTriggerKind && runningAcceptedContinuationTriggerKind !== "recovery_retry") {
        throw new Error(`Run ${run.runId} is already processing a ${runningAcceptedContinuationTriggerKind} slice.`);
      }

      throw new Error(`Run ${run.runId} did not produce a runnable ${triggerKind} slice.`);
    }

    const execution = await lifecycle.executeClaimedSlice({
      run: claimed.run,
      slice: claimed.slice
    });

    await persistTask2BlockedSliceDurableTruth({
      runId: run.runId,
      turnResult: execution.turnResult
    });

    await sessionStore.finalize({
      turnId: input.turnId,
      sessionId: input.continuation.recoveryContext.session.sessionId,
      status: "interrupted"
    });

    const runAfterShell = await taskRunStore.loadRunById(run.runId);
    const canceledAfterShell = runAfterShell?.cancelRequestedAt;
    await lifecycle.finalizeSliceResult({
      sliceId: claimed.slice.sliceId,
      runId: run.runId,
      taskId: run.taskId,
      lane: claimed.slice.lane,
      result: canceledAfterShell
        ? {
            terminalStatus: "canceled",
            resultSummary: createCanceledBackgroundResult({
              reason: runAfterShell?.cancelReason,
              turnResultStatus: execution.turnResult.status
            }).resultSummary,
            usageSummary: {
              inputTokens: execution.turnResult.usage.inputTokens,
              outputTokens: execution.turnResult.usage.outputTokens,
              totalTokens: execution.turnResult.usage.totalTokens,
              estimatedCost: execution.turnResult.usage.estimatedCost,
              toolCallCount: execution.turnResult.toolEvents.length
            }
          }
        : mapBackgroundTurnResultToSliceResult(execution.turnResult, claimed.slice.triggerKind)
    });

    return execution.turnResult;
  }

  async function persistTask2BlockedSliceDurableTruth(input: {
    runId: string;
    turnResult: TurnResult;
  }) {
    if ((!input.turnResult.continuation)
      || (input.turnResult.status !== "blocked" && !isResumableInterruptedTurnResult(input.turnResult))) {
      return;
    }

    const run = await taskRunStore.loadRunById(input.runId);
    if (!run || run.attentionMode !== "background_detached") {
      return;
    }

    const recoveryContext = await sessionStore.loadRecoveryContext(run.sessionId);
    if (!recoveryContext || recoveryContext.inflight.turnId !== run.runId || !recoveryContext.inflight.pendingExecution) {
      return;
    }

    const durablePayload = buildDurableSliceRecoveryPayload({
      recoveryContext,
      source: recoveryContext.session.lastSource,
      mode: recoveryContext.session.mode,
      basePayload: input.turnResult.continuation
    });
    input.turnResult.continuation = durablePayload as TurnResult["continuation"];

    const runningSlice = (await sliceStore.listSlicesByRun(run.runId)).find((slice) => slice.status === "running");
    if (!runningSlice) {
      return;
    }

    await lifecycle.persistRunningSliceContinuationPayload({
      runId: run.runId,
      sliceId: runningSlice.sliceId,
      continuationPayload: durablePayload
    });
  }

  async function tryHandleTask2BackgroundTerminalControl(input: {
    control:
      | (ExecutionControlInput & { action: "deny" })
      | (ExecutionControlInput & { action: "cancel" });
    recoveryContext: NonNullable<Awaited<ReturnType<typeof sessionStore.loadRecoveryContext>>>;
    turnId: string;
    reason: string;
  }): Promise<TurnResult | undefined> {
    const run = await taskRunStore.loadRunById(input.turnId);
    if (!run || run.attentionMode !== "background_detached") {
      return undefined;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      return undefined;
    }

    if (input.control.action === "cancel" && (run.status === "queued" || run.status === "running")) {
      const cancelOutcome = await lifecycle.cancelDetachedRun({
        sessionId: run.sessionId,
        taskId: run.taskId,
        runId: run.runId,
        attentionMode: run.attentionMode,
        reason: input.reason,
        requestedBy: createExecutionControlActorId(input.control.action)
      });

      if (cancelOutcome.status === "canceled" || cancelOutcome.status === "cancel_requested") {
        return createDetachedTask2AckTurnResult({
          turnId: run.runId,
          sessionId: run.sessionId,
          resolvedMode: input.recoveryContext.session.mode,
          checkpointRef: input.recoveryContext.checkpointRef,
          frameRef: input.recoveryContext.inflight.frameRef,
          warning: input.reason
        });
      }

      const runAfterControl = await taskRunStore.loadRunById(run.runId);
      return runAfterControl
        ? createDetachedTask2TerminalTurnResult({
            run: runAfterControl,
            turnId: run.runId,
            sessionId: run.sessionId,
            resolvedMode: input.recoveryContext.session.mode,
            checkpointRef: input.recoveryContext.checkpointRef,
            frameRef: input.recoveryContext.inflight.frameRef
          })
        : undefined;
    }

    if (run.status !== "blocked") {
      return undefined;
    }

    const closedRun = await lifecycle.closeBlockedRunTerminally({
      sessionId: run.sessionId,
      taskId: run.taskId,
      runId: run.runId,
      attentionMode: run.attentionMode,
      terminalStatus: input.control.action === "cancel" ? "canceled" : "failed",
      resultSummary: input.reason,
      cancel: input.control.action === "cancel"
        ? {
            requestedAt: new Date().toISOString(),
            requestedBy: createExecutionControlActorId(input.control.action),
            reason: input.reason
          }
        : undefined,
      control: input.control.action === "cancel"
        ? {
            kind: "cancel",
            payload: {
              reason: input.reason,
              requestedBy: createExecutionControlActorId(input.control.action)
            }
          }
        : undefined
    });

    if (!closedRun) {
      return resolveDetachedTask2TerminalControlRaceOutcome({
        action: input.control.action,
        runId: run.runId,
        sessionId: run.sessionId,
        resolvedMode: input.recoveryContext.session.mode,
        checkpointRef: input.recoveryContext.checkpointRef,
        frameRef: input.recoveryContext.inflight.frameRef,
        decisionId: input.control.action === "deny" ? input.control.decisionId : undefined,
        reason: input.reason
      });
    }

    return commitExecutionControlInterruption({
      action: input.control.action,
      recoveryContext: input.recoveryContext,
      turnId: input.turnId,
      reason: input.reason
    });
  }

  async function commitExecutionControlInterruption(input: {
    action: "deny" | "cancel";
    recoveryContext: NonNullable<Awaited<ReturnType<typeof sessionStore.loadRecoveryContext>>>;
    turnId: string;
    reason: string;
  }): Promise<TurnResult> {
    const nextSessionStateRef = await sessionStore.finalize({
      turnId: input.turnId,
      sessionId: input.recoveryContext.session.sessionId,
      status: "interrupted"
    });

    const administrativeTurnId = createSyntheticTurnId(input.action, input.turnId);
    const frameRef = input.recoveryContext.inflight.frameRef;
    const sourceRefs = [input.turnId, input.recoveryContext.checkpointRef, frameRef].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    );
    const summary = input.action === "deny"
      ? input.reason
      : `turn ${input.turnId} interrupted: ${input.reason}`;

    await commitAdministrativeTurn({
      sessionStore,
      turnId: administrativeTurnId,
      sessionId: input.recoveryContext.session.sessionId,
      workspaceId: input.recoveryContext.session.workspaceId,
      source: input.recoveryContext.session.lastSource,
      mode: input.recoveryContext.session.mode,
      status: "interrupted",
      summary,
      text: input.reason,
      warnings: [input.reason],
      sourceRefs,
      eventKind: input.action === "deny" ? "approval" : "system"
    });

    return {
      turnId: administrativeTurnId,
      sessionId: input.recoveryContext.session.sessionId,
      resolvedMode: input.recoveryContext.session.mode,
      status: "interrupted",
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
      },
      warnings: [input.reason],
      checkpointRef: input.recoveryContext.checkpointRef,
      frameRef,
      nextSessionStateRef
    };
  }

  async function submitExecutionControl(rawInput: ExecutionControlInput): Promise<TurnResult> {
    const rawAction = (rawInput as { action?: unknown }).action;
    const rawScope = (rawInput as { scope?: unknown }).scope;
    if ((rawAction === "approve" || rawAction === "deny")
      && rawScope !== undefined
      && !ApprovalScopeSchema.safeParse(rawScope).success) {
      throw new Error(`Unsupported approval scope "${String(rawScope)}". Supported scopes: ${[...SUPPORTED_APPROVAL_SCOPES].join(", ")}.`);
    }

    const input = ExecutionControlInputSchema.parse(rawInput);
    const inflightRecoveryContext = await loadActiveRecoveryContext(input.sessionId);

    if (input.action === "cancel") {
      const task2DetachedCancel = await tryHandleDetachedQueuedOrRunningCancelWithoutRecovery({
        control: input,
        inflightRecoveryContext
      });
      if (task2DetachedCancel) {
        return task2DetachedCancel;
      }
    }

    const continuation = resolveRecoverableTurn({
      recovery: inflightRecoveryContext
        ? {
            recoveryContext: inflightRecoveryContext,
            source: inflightRecoveryContext.session.lastSource,
            mode: inflightRecoveryContext.session.mode
          }
        : await resolveTask2DurableBackgroundRecovery({ control: input }),
      sessionId: input.sessionId,
      requestedTurnId: input.turnId,
      requestedFrameRef: input.frameRef
    });
    const { recoveryContext, turnId } = continuation;

    switch (input.action) {
      case "resume": {
        const pendingDecisionId = recoveryContext.inflight.pendingApprovalRef;
        if (pendingDecisionId && recoveryContext.inflight.waitingReason === "permission") {
          throw createApprovalRequiredResumeError(input.sessionId, pendingDecisionId);
        }

        const task2Handled = await tryHandleTask2BackgroundControl({
          control: input,
          continuation,
          turnId
        });
        if (task2Handled) {
          return task2Handled;
        }

        if (!recoveryContext.inflight.pendingExecution) {
          throw new Error(`Session ${input.sessionId} does not expose a recoverable pending execution.`);
        }

        await sessionStore.finalize({
          turnId,
          sessionId: recoveryContext.session.sessionId,
          status: "interrupted"
        });

        return continueAndCommit({
          control: input,
          continuation
        });
      }
      case "approve": {
        const pendingDecisionId = recoveryContext.inflight.pendingApprovalRef;
        if (pendingDecisionId !== input.decisionId) {
          throw new Error(
            `Session ${input.sessionId} is waiting on approval decision ${pendingDecisionId}, not ${input.decisionId}. Retry with --decision ${pendingDecisionId}.`
          );
        }

        const task2Handled = await tryHandleTask2BackgroundControl({
          control: input,
          continuation,
          turnId
        });
        if (task2Handled) {
          return task2Handled;
        }

        if (!recoveryContext.inflight.pendingExecution) {
          throw new Error(`Session ${input.sessionId} does not expose a recoverable pending execution.`);
        }

        await sessionStore.finalize({
          turnId,
          sessionId: recoveryContext.session.sessionId,
          status: "interrupted"
        });

        return continueAndCommit({
          control: input,
          continuation
        });
      }
      case "deny": {
        const pendingDecisionId = recoveryContext.inflight.pendingApprovalRef;
        if (pendingDecisionId !== input.decisionId) {
          throw new Error(
            `Session ${input.sessionId} is waiting on approval decision ${pendingDecisionId}, not ${input.decisionId}. Retry with --decision ${pendingDecisionId}.`
          );
        }

        const task2Handled = await tryHandleTask2BackgroundTerminalControl({
          control: { ...input, action: "deny" },
          recoveryContext,
          turnId,
          reason: `approval rejected for ${input.decisionId}`
        });
        if (task2Handled) {
          return task2Handled;
        }

        return commitExecutionControlInterruption({
          action: "deny",
          recoveryContext,
          turnId,
          reason: `approval rejected for ${input.decisionId}`
        });
      }
      case "cancel": {
        const task2Handled = await tryHandleTask2BackgroundTerminalControl({
          control: input,
          recoveryContext,
          turnId,
          reason: input.reason ?? "cancelled"
        });
        if (task2Handled) {
          return task2Handled;
        }

        return commitExecutionControlInterruption({
          action: "cancel",
          recoveryContext,
          turnId,
          reason: input.reason ?? "cancelled"
        });
      }
    }
  }

  function conversationFocusKey(conversationRef: TurnRequest["conversationRef"] | undefined) {
    return conversationRef?.baseConversationId ?? conversationRef?.conversationId;
  }

  function readChannelMessageId(request: TurnRequest) {
    const value = request.channelContext && typeof request.channelContext === "object" && !Array.isArray(request.channelContext)
      ? request.channelContext.messageId
      : undefined;
    return typeof value === "string" && value.length > 0 ? value : request.turnId;
  }

  function createSteerCapturedTurnResult(input: { request: TurnRequest; runId: string }): TurnResult {
    return {
      turnId: input.request.turnId,
      sessionId: input.request.sessionId,
      resolvedMode: input.request.requestedMode ?? "chat",
      status: "interrupted",
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
      },
      warnings: [`Guidance captured for active run ${input.runId}; it will apply at the next slice boundary.`],
      checkpointRef: `checkpoint:${input.request.turnId}`
    };
  }

  async function tryCaptureActiveRunSteer(request: TurnRequest): Promise<TurnResult | null> {
    if (!isImConversationSource(request.source)
      || request.imContext?.activationKind !== "interactive_turn"
      || request.controlIntent
      || !request.conversationRef
      || request.input.trim().length === 0) {
      return null;
    }

    const focus = await sessionStore.loadFocusRun?.(request.sessionId);
    if (!focus) {
      return null;
    }

    const run = await taskRunStore.loadRunById(focus.runId);
    if (!run || run.taskId !== focus.taskId) {
      await sessionStore.clearFocusRun?.({ sessionId: request.sessionId });
      return null;
    }

    if (run.sessionId !== request.sessionId
      || conversationFocusKey(run.conversationRef) !== conversationFocusKey(request.conversationRef)) {
      return null;
    }

    if (run.status === "blocked") {
      return null;
    }

    if (run.status !== "queued" && run.status !== "running") {
      await sessionStore.clearFocusRun?.({ sessionId: request.sessionId });
      return null;
    }

    const now = new Date().toISOString();
    await lifecycle.acceptMessageOrControl({
      sessionId: request.sessionId,
      taskId: run.taskId,
      runId: run.runId,
      attentionMode: run.attentionMode,
      control: {
        controlId: `control_steer_${request.turnId}`,
        kind: "steer",
        payload: {
          text: request.input,
          imControl: {
            messageMode: "steer",
            source: request.source,
            messageId: readChannelMessageId(request),
            senderId: request.actorId,
            text: request.input,
            capturedAt: now
          }
        }
      },
      reengageToForeground: run.attentionMode === "background_detached",
      now
    });

    return createSteerCapturedTurnResult({
      request,
      runId: run.runId
    });
  }

  const shell = createShellCommandPort({
    async executeTurn(request) {
      if (hasBackgroundExecutionMarker(request)) {
        return executeAndCommit(request);
      }

      const ack = await enqueueExplicitBackgroundTask(request);
      if (ack) {
        return ack;
      }

      const steerCapture = await tryCaptureActiveRunSteer(request);
      if (steerCapture) {
        return runAndCommit({
          request,
          run: async () => steerCapture
        });
      }

      return executeAndCommit(request);
    },

    async resumeTurn(input) {
      return submitExecutionControl({
        schemaVersion: 1,
        contractVersion: EXECUTION_CONTROL_CONTRACT_VERSION,
        action: "resume",
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        frameRef: input.frameRef,
        input: input.input
      });
    },

    async resolveApproval(input) {
      return submitExecutionControl({
        schemaVersion: 1,
        contractVersion: EXECUTION_CONTROL_CONTRACT_VERSION,
        action: input.approved ? "approve" : "deny",
        sessionId: input.sessionId,
        turnId: input.turnId,
        frameRef: input.frameRef,
        decisionId: input.decisionId,
        scope: input.scope,
        approverId: input.approverId
      });
    },

    async cancelInflightTurn(input) {
      return submitExecutionControl({
        schemaVersion: 1,
        contractVersion: EXECUTION_CONTROL_CONTRACT_VERSION,
        action: "cancel",
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        frameRef: input.frameRef,
        reason: input.reason
      });
    },

    submitExecutionControl
  });

  shellExecuteTurn = (request) => shell.executeTurn(request);

  const backgroundWorker = createBackgroundWorker({
    tasksDbPath: paths.tasksDbPath,
    runStore: taskRunStore,
    taskStore,
    eventStore: taskEventStore,
    sessionStore,
    shell,
    lifecycle,
    errorExposureMode
  });

  const background = {
    runWorkerOnce(input: Parameters<typeof backgroundWorker.runOnce>[0]) {
      return backgroundWorker.runOnce({
        ...input,
        onAfterShell: async (shellInput) => {
          await persistTask2BlockedSliceDurableTruth({
            runId: shellInput.runId,
            turnResult: shellInput.turnResult
          });
          await input.onAfterShell?.(shellInput);
        }
      });
    }
  };

  async function loadOperatorRecoverySnapshot(input: EndecOperatorSnapshotTarget) {
    const snapshot = await sessionQueryStore.getRecoverySnapshot(input);
    if (!snapshot) {
      return null;
    }

    const turnId = snapshot.turnId;
    if (!turnId) {
      return snapshot;
    }

    const run = await taskRunStore.loadRunById(turnId);
    if (run && hasAuthoritativeDetachedRecoveryTruth(run)) {
      await clearDetachedBackgroundSessionTruth({
        sessionId: snapshot.sessionId,
        runId: turnId,
        clearRecovery: true
      });
      return null;
    }

    if (run && run.attentionMode === "background_detached" && run.status !== "blocked" && run.status !== "running") {
      await clearDetachedBackgroundSessionTruth({
        sessionId: snapshot.sessionId,
        runId: turnId,
        clearRecovery: true
      });
      return null;
    }

    return snapshot;
  }

  const inspectOperatorTurn = createOperatorTurnInspector({
    recoveryStore: {
      getRecoverySnapshot: loadOperatorRecoverySnapshot
    }
  });

  const backgroundOperator = createBackgroundOperator({
    runStore: taskRunStore,
    eventStore: taskEventStore,
    outboundStore: taskStore,
    recoveryStore: sessionStore,
    detachedLifecycle: {
      cancelDetachedRun: lifecycle.cancelDetachedRun,
      closeBlockedRunTerminally: lifecycle.closeBlockedRunTerminally
    }
  });

  const operator: EndecOperatorPort = {
    async getStatus() {
      return getStatusSnapshot();
    },

    inspectOwnerBinding(input) {
      return authority.inspectOwnerBinding(input);
    },

    listPairClaims(input) {
      return authority.listPairClaims(input);
    },

    approvePairClaim(input) {
      return authority.approvePairClaim(input);
    },

    resetOwnerBinding(input) {
      return authority.resetOwnerBinding(input);
    },

    listTrustedConversations(input) {
      return authority.listTrustedConversations(input);
    },

    revokeTrustedConversation(input) {
      return authority.revokeTrustedConversation(input);
    },

    async getRecoverySnapshot(input) {
      return loadOperatorRecoverySnapshot(input);
    },

    async getRuntimeSelfAwareness(input) {
      const snapshot = await loadOperatorRecoverySnapshot(input);
      return snapshot?.runtimeSelfAwareness ?? null;
    },

    inspectOperatorTurn,

    listBackgroundTasks(input) {
      return backgroundOperator.listBackgroundTasks(input);
    },

    inspectBackgroundTask(input) {
      return backgroundOperator.inspectBackgroundTask(input);
    },

    listBackgroundOutbox(input) {
      return backgroundOperator.listBackgroundOutbox(input);
    },

    cancelBackgroundTask(input) {
      return backgroundOperator.cancelBackgroundTask(input);
    },

    async inspectCorrectionSurface(input) {
      return memoryStore.inspectCorrections(input);
    },

    async applyCorrection(input) {
      return memoryStore.applyCorrection(input);
    },

    async listSessions(input) {
      return sessionQueryStore.listSessions(input);
    },

    async browseSessionHistory(input) {
      return sessionQueryStore.browseSessionHistory(input);
    },

    async searchSessionEvents(input) {
      return sessionQueryStore.searchSessionEvents(input);
    },

    async lookupSessionEvent(input) {
      return sessionQueryStore.lookupSessionEvent(input);
    },

    async getArtifactPreview(ref) {
      return artifactStore.getArtifactPreview(ref);
    },

    async readArtifact(query) {
      return artifactStore.readArtifact(query);
    },

    async searchEvidence(query) {
      return {
        items: await memoryStore.searchEvidence(query)
      };
    }
  };

  return {
    shell,
    operator,
    im,
    background
  };
}
