import type { ProviderRegistration, ProviderTransport } from "@endec/ai";
import type { AppStatusSnapshot } from "./status.ts";
import type {
  ActivationHint,
  AdmissionDecision,
  ApprovePairClaimResult,
  ApprovalScope,
  ArtifactPreview,
  ArtifactReadQuery,
  ArtifactReadResult,
  ArtifactRef,
  AuthoritativeTurnTruth,
  BackgroundCancelResult,
  BackgroundInspectOutboundState,
  BackgroundInspectTaskDetail,
  BackgroundInspectTaskSummary,
  ContextAssemblyBudget,
  ContextAssemblyObservability,
  ContextAssemblyResult,
  ContextAssemblySelection,
  ContextToolExposure,
  ConversationBoundaryDescriptor,
  ConversationDirectoryEntry,
  ConversationLifecycleEvent,
  ConversationRef,
  ConversationScope,
  DisclosureMode,
  ImActivationKind,
  ImCommandIntent,
  ImCommandName,
  ModelOverrideRecord,
  PersonaScopeKind,
  ResolvedPersona,
  CorrectionInspection,
  CorrectionRequest,
  CorrectionRequestInput,
  CorrectionResult,
  EvidenceSearchQuery,
  EvidenceSearchResult,
  InspectOperatorTurnRequest,
  InspectOwnerBindingRequest,
  InspectOwnerBindingResult,
  ListPairClaimsRequest,
  ListPairClaimsResult,
  ListTrustedConversationsRequest,
  ListTrustedConversationsResult,
  OutboundConversationLegality,
  RevokeTrustedConversationRequestInput,
  RevokeTrustedConversationResult,
  ResetOwnerBindingRequestInput,
  ResetOwnerBindingResult,
  OperatorActiveRunStatus,
  OperatorLastTurnStatus,
  OperatorTurnInspection,
  OperatorRecoverySnapshot,
  PromptContract,
  PromptContractLayer,
  PromptOverlayHook,
  RuntimeRequest,
  RuntimeSelfAwarenessSurface,
  RuntimeToolDefinition,
  SessionBrowseResult,
  SessionEventLookupQuery,
  SessionEventLookupResult,
  SessionEventSearchQuery,
  SessionEventSearchResult,
  SessionHistoryQuery,
  SessionListQuery,
  SessionListResult,
  Source,
  TurnRequest,
  TurnResult,
  ApprovePairClaimRequestInput
} from "@endec/domain";
import type { ShellCommandPort } from "@endec/core";
import type { ToolLoopConfigOverride } from "@endec/budget";
import type {
  EndecCurrentModelSelection,
  EndecModelCapabilityKind,
  EndecStatusWarning
} from "./provider-selection.ts";

export interface EndecCurrentModelWarning {
  code: EndecStatusWarning["code"];
  message: string;
  providerId: string;
  modelId?: string;
}

export type EndecRuntimeConfigStatus = {
  source: string;
  loadedAt: string;
  schemaVersion: number;
};

export type EndecImSource = Extract<Source, "telegram" | "feishu">;
export type EndecConversationBoundaryDescriptor = ConversationBoundaryDescriptor;
export type EndecConversationDirectoryEntry = ConversationDirectoryEntry;
export type EndecDisclosureMode = DisclosureMode;
export type EndecImActivationKind = ImActivationKind;
export type EndecImCommandIntent = ImCommandIntent;
export type EndecImCommandName = ImCommandName;
export type EndecPersonaScopeKind = PersonaScopeKind;
export type EndecResolvedPersona = ResolvedPersona;
export type EndecModelOverrideRecord = ModelOverrideRecord;

export interface EndecImSessionResolutionInput {
  source: EndecImSource;
  workspaceId: string;
  accountId: string;
  conversationRef: ConversationRef;
  binding?: {
    sessionId?: string;
  };
}

export interface EndecImActorResolutionInput {
  source: EndecImSource;
  workspaceId: string;
  accountId: string;
  senderId: string;
  conversationRef: ConversationRef;
  binding?: {
    actorId?: string;
  };
}

export interface EndecImOwnerInitPreflightInput {
  turnRequest: TurnRequest;
  conversationScope: ConversationScope;
}

export type EndecImOwnerInitPreflightResult =
  | { outcome: "continue" }
  | {
      outcome: "consumed";
      controlKind: "owner_init";
      completionReason: "fields_captured" | "explicit_skip";
      replyText: string;
    };

export type EndecImModelPickerOption = {
  providerId: string;
  modelId: string;
  label: string;
};

export type EndecImCommandPostReplyAction = () => void | Promise<void>;

export type EndecImCommandExecutionResult =
  | { kind: "reply_text"; replyText: string; afterReplyDelivered?: EndecImCommandPostReplyAction }
  | { kind: "reply_model_picker"; replyText: string; options: EndecImModelPickerOption[]; afterReplyDelivered?: EndecImCommandPostReplyAction }
  | { kind: "dispatch_turn"; turnRequest: TurnRequest };

export interface EndecImCommandExecutionInput {
  turnRequest: TurnRequest;
  commandIntent: ImCommandIntent;
  conversationScope: ConversationScope;
}

export interface EndecImConversationActivityInput {
  source: EndecImSource;
  accountId: string;
  conversationRef: ConversationRef;
  sessionId: string;
  conversationLabel?: string;
  observedAt?: string;
}

export interface EndecImPassiveIngressInput {
  turnRequest: TurnRequest;
}

export interface EndecImHostPort {
  resolveSessionId(input: EndecImSessionResolutionInput): Promise<string>;
  resolveActorId(input: EndecImActorResolutionInput): Promise<string>;
  preflightOwnerInit?(input: EndecImOwnerInitPreflightInput): Promise<EndecImOwnerInitPreflightResult>;
  executeCommand(input: EndecImCommandExecutionInput): Promise<EndecImCommandExecutionResult>;
  recordPassiveIngress(input: EndecImPassiveIngressInput): Promise<void>;
  recordConversationActivity(input: EndecImConversationActivityInput): Promise<EndecConversationDirectoryEntry>;
  evaluateInboundAdmission(input: {
    source: EndecImSource;
    workspaceId: string;
    accountId: string;
    senderId: string;
    conversationRef: ConversationRef;
    conversationScope: ConversationScope;
    activationHint: ActivationHint;
  }): Promise<AdmissionDecision>;
  applyConversationLifecycleEvent(input: ConversationLifecycleEvent): Promise<void>;
  evaluateOutboundConversationLegality(input: {
    source: EndecImSource;
    accountId: string;
    conversationRef: ConversationRef;
  }): Promise<OutboundConversationLegality>;
}

export type EndecToolExposure = ContextToolExposure | {
  toolSchemas: RuntimeToolDefinition[];
  hiddenToolNames?: string[];
  exposureSource?: ContextToolExposure["exposureSource"];
};

export type EndecToolExposureResolver = (input: {
  request: Parameters<ShellCommandPort["executeTurn"]>[0];
  session: { sessionId: string; workspaceId: string };
  budget: Pick<RuntimeRequest, "resolvedMode" | "model" | "limits">;
}) => Promise<EndecToolExposure> | EndecToolExposure;

export interface EndecBackgroundPort {
  runWorkerOnce(input: {
    workerId: string;
    leaseDurationMs: number;
    now?: string;
    onClaimedRun?: (input: { runId: string; taskId: string }) => Promise<void> | void;
    onAfterShell?: (input: { runId: string; taskId: string; turnResult: TurnResult }) => Promise<void> | void;
  }): Promise<{
    status: "idle" | "claimed";
    taskId?: string;
    runId?: string;
    outcome?: "succeeded" | "failed" | "interrupted" | "canceled" | "suspended";
    callbackKind?: "final" | "failed" | "interrupted" | "canceled" | "blocked";
    turnResultStatus?: TurnResult["status"];
    shellExecuted?: boolean;
  }>;
}

export interface EndecApp {
  shell: ShellCommandPort;
  operator: EndecOperatorPort;
  im: EndecImHostPort;
  background: EndecBackgroundPort;
}

export interface EndecAppOptions {
  dataDir: string;
  env?: Record<string, string | undefined>;
  providerTransport?: ProviderTransport;
  providerRegistrations?: ProviderRegistration[];
  toolExposureResolver?: EndecToolExposureResolver;
  toolLoop?: ToolLoopConfigOverride;
  requestExit?: (input: { code: number; reason: string }) => void | Promise<void>;
}

export interface EndecOperatorSnapshotTarget {
  sessionId: string;
  turnId?: string;
  frameRef?: string;
}

export type EndecPromptContract = PromptContract;
export type EndecPromptContractLayer = PromptContractLayer;
export type EndecPromptOverlayHook = PromptOverlayHook;
export type EndecContextAssemblyBudget = ContextAssemblyBudget;
export type EndecContextAssemblySelection = ContextAssemblySelection;
export type EndecContextAssemblyObservability = ContextAssemblyObservability;
export type EndecContextAssemblyResult = ContextAssemblyResult;
export type EndecOperatorRecoverySnapshot = OperatorRecoverySnapshot;
export type EndecOperatorActiveRunStatus = OperatorActiveRunStatus;
export type EndecOperatorLastTurnStatus = OperatorLastTurnStatus;
export type EndecAuthoritativeTurnTruth = AuthoritativeTurnTruth;
export type EndecRuntimeSelfAwarenessSurface = RuntimeSelfAwarenessSurface;
export type EndecCorrectionInspection = CorrectionInspection;
export type EndecCorrectionRequest = CorrectionRequestInput;
export type EndecCorrectionResult = CorrectionResult;
export type EndecInspectOperatorTurnRequest = InspectOperatorTurnRequest;
export type EndecOperatorTurnInspection = OperatorTurnInspection;
export type EndecBackgroundInspectTaskSummary = BackgroundInspectTaskSummary;
export type EndecBackgroundInspectTaskDetail = BackgroundInspectTaskDetail;
export type EndecBackgroundInspectOutboundState = BackgroundInspectOutboundState;
export type EndecBackgroundCancelResult = BackgroundCancelResult;

export interface EndecOperatorPort {
  getStatus(): Promise<AppStatusSnapshot>;
  inspectOwnerBinding(input: InspectOwnerBindingRequest): Promise<InspectOwnerBindingResult>;
  listPairClaims(input: ListPairClaimsRequest): Promise<ListPairClaimsResult>;
  approvePairClaim(input: ApprovePairClaimRequestInput): Promise<ApprovePairClaimResult>;
  resetOwnerBinding(input: ResetOwnerBindingRequestInput): Promise<ResetOwnerBindingResult>;
  listTrustedConversations(input: ListTrustedConversationsRequest): Promise<ListTrustedConversationsResult>;
  revokeTrustedConversation(input: RevokeTrustedConversationRequestInput): Promise<RevokeTrustedConversationResult>;
  getRecoverySnapshot(input: EndecOperatorSnapshotTarget): Promise<EndecOperatorRecoverySnapshot | null>;
  getRuntimeSelfAwareness(input: EndecOperatorSnapshotTarget): Promise<EndecRuntimeSelfAwarenessSurface | null>;
  inspectOperatorTurn(input: EndecInspectOperatorTurnRequest): Promise<EndecOperatorTurnInspection | null>;
  listBackgroundTasks(input?: {
    workspaceId?: string;
    sessionId?: string;
    agentStatus?: EndecBackgroundInspectTaskSummary["task"]["agentStatus"];
    limit?: number;
  }): Promise<EndecBackgroundInspectTaskSummary[]>;
  inspectBackgroundTask(input: { taskId: string }): Promise<EndecBackgroundInspectTaskDetail | null>;
  listBackgroundOutbox(input: { taskId?: string; runId?: string }): Promise<EndecBackgroundInspectOutboundState[]>;
  cancelBackgroundTask(input: {
    taskId: string;
    runId?: string;
    actorId?: string;
    reason?: string;
  }): Promise<EndecBackgroundCancelResult>;
  inspectCorrectionSurface(input: { sessionId: string; workspaceId: string; actorId?: string }): Promise<EndecCorrectionInspection>;
  applyCorrection(input: EndecCorrectionRequest): Promise<EndecCorrectionResult>;
  listSessions(input: SessionListQuery): Promise<SessionListResult>;
  browseSessionHistory(input: SessionHistoryQuery): Promise<SessionBrowseResult>;
  searchSessionEvents(input: SessionEventSearchQuery): Promise<SessionEventSearchResult>;
  lookupSessionEvent(input: SessionEventLookupQuery): Promise<SessionEventLookupResult>;
  getArtifactPreview(query: Pick<ArtifactRef, "artifactId">): Promise<ArtifactPreview | null>;
  readArtifact(query: ArtifactReadQuery): Promise<ArtifactReadResult | null>;
  searchEvidence(query: EvidenceSearchQuery): Promise<EvidenceSearchResult>;
}
