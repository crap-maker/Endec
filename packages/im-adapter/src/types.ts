import type {
  EndecApp,
  EndecImActorResolutionInput,
  EndecImCommandExecutionResult,
  EndecImOwnerInitPreflightInput,
  EndecImOwnerInitPreflightResult,
  EndecImSessionResolutionInput,
  EndecImSource
} from "@endec/app";
import type {
  ActivationHint,
  AdmissionDecision,
  ConversationRef,
  ConversationScope,
  ErrorExposureMode,
  ImActivationKind,
  ImCommandIntent,
  OutboundEvent,
  TurnRequest,
  TurnResult
} from "@endec/domain";

export type ImSource = EndecImSource;

export interface NormalizedInboundMessage {
  source: ImSource;
  workspaceId: string;
  accountId: string;
  senderId: string;
  text: string;
  attachments: unknown[];
  transportMessageId: string;
  conversationRef: ConversationRef;
  conversationScope: ConversationScope;
  channelContext: Record<string, unknown>;
  activationHint: ActivationHint;
  activationKind?: ImActivationKind;
  commandIntent?: ImCommandIntent;
  requestedMode?: TurnRequest["requestedMode"];
  requestedCapabilities?: TurnRequest["requestedCapabilities"];
  taskId?: string;
  resumeFrom?: string;
}

export type SessionResolutionInput = EndecImSessionResolutionInput;
export type ActorResolutionInput = EndecImActorResolutionInput;

export interface SessionBindingLookupResult {
  sessionId?: string;
}

export interface ActorBindingLookupResult {
  actorId?: string;
}

export type PreAgentGateDecision =
  | { kind: "allow" }
  | {
      kind: "drop";
      reasonCode: string;
      reasonText: string;
    };

export type PreAgentGate =
  (input: NormalizedInboundMessage) => PreAgentGateDecision | Promise<PreAgentGateDecision>;

export type ImCommandReplyPayload = Extract<
  EndecImCommandExecutionResult,
  { kind: "reply_text" | "reply_model_picker" }
>;

export type OutboundCommandReplyMetadata = Record<string, unknown> & {
  controlReply?: boolean;
  commandReply?: boolean;
  commandName?: string;
  commandReplyPayload?: ImCommandReplyPayload;
};

export interface OutboundMessage {
  turnId: string;
  sessionId?: string;
  conversationRef: ConversationRef;
  text: string;
  replyToMessageId?: string;
  metadata?: OutboundCommandReplyMetadata;
}

export interface OutboundDispatchReceipt {
  deliveryId: string;
  messageId: string;
  message: OutboundMessage;
}

export interface DurableOutboundMessage {
  outboundEventId: string;
  sessionId?: string;
  conversationRef: ConversationRef;
  text: string;
  metadata?: OutboundCommandReplyMetadata;
}

export interface DurableOutboundDispatchReceipt {
  deliveryId: string;
  messageId: string;
  message: DurableOutboundMessage;
}

export interface DurableOutboundDispatcher {
  dispatch(messages: DurableOutboundMessage[]): Promise<DurableOutboundDispatchReceipt[]>;
}

export interface OutboundDispatcher {
  errorExposureMode?: ErrorExposureMode;
  dispatch(messages: OutboundMessage[]): Promise<OutboundDispatchReceipt[]>;
}

export interface ImAdapterDeps<TInbound> {
  app: {
    shell: Pick<EndecApp["shell"], "executeTurn">;
    im: Pick<EndecApp["im"], "resolveSessionId" | "resolveActorId" | "evaluateInboundAdmission"> & {
      preflightOwnerInit?: EndecApp["im"]["preflightOwnerInit"];
      executeCommand?: EndecApp["im"]["executeCommand"];
      recordPassiveIngress?: EndecApp["im"]["recordPassiveIngress"];
    };
  };
  normalizeInbound(input: TInbound): Promise<NormalizedInboundMessage> | NormalizedInboundMessage;
  gates?: PreAgentGate[];
  outbound: OutboundDispatcher;
  lookupSessionBinding?(input: SessionResolutionInput): Promise<SessionBindingLookupResult | null> | SessionBindingLookupResult | null;
  lookupActorBinding?(input: ActorResolutionInput): Promise<ActorBindingLookupResult | null> | ActorBindingLookupResult | null;
  recordOutboundSessionBinding?(input: {
    sessionId: string;
    conversationRef: ConversationRef;
    turnId: string;
  }): Promise<void> | void;
}

export type DroppedInboundHandleResult = {
  status: "dropped";
  normalized: NormalizedInboundMessage;
  gateDecision: Extract<PreAgentGateDecision, { kind: "drop" }>;
};

export type DispatchedInboundHandleResult = {
  status: "dispatched";
  normalized: NormalizedInboundMessage;
  gateDecision: Extract<PreAgentGateDecision, { kind: "allow" }>;
  turnRequest: TurnRequest;
  turnResult: TurnResult;
  outboundMessages: OutboundMessage[];
  deliveryReceipts: OutboundDispatchReceipt[];
};

export type PreflightConsumedInboundHandleResult = {
  status: "preflight_consumed";
  normalized: NormalizedInboundMessage;
  gateDecision: Extract<PreAgentGateDecision, { kind: "allow" }>;
  preflightDecision: Extract<EndecImOwnerInitPreflightResult, { outcome: "consumed" }>;
  turnRequest: TurnRequest;
  outboundMessages: OutboundMessage[];
  deliveryReceipts: OutboundDispatchReceipt[];
};

export type DirectReplyInboundHandleResult = {
  status: "direct_replied";
  normalized: NormalizedInboundMessage;
  gateDecision: Extract<PreAgentGateDecision, { kind: "allow" }>;
  admissionDecision: Extract<AdmissionDecision, { outcome: "reply_direct" | "reject_direct" }>;
  outboundMessages: OutboundMessage[];
  deliveryReceipts: OutboundDispatchReceipt[];
};

export type PassiveIngestedInboundHandleResult = {
  status: "passive_ingested";
  normalized: NormalizedInboundMessage;
  gateDecision: Extract<PreAgentGateDecision, { kind: "allow" }>;
  admissionDecision: Extract<AdmissionDecision, { outcome: "passive_ingest" }>;
  turnRequest: TurnRequest;
};

export type CommandReplyInboundHandleResult = {
  status: "command_replied";
  normalized: NormalizedInboundMessage;
  gateDecision: Extract<PreAgentGateDecision, { kind: "allow" }>;
  admissionDecision: Extract<AdmissionDecision, { outcome: "dispatch_turn" }>;
  turnRequest: TurnRequest;
  outboundMessages: OutboundMessage[];
  deliveryReceipts: OutboundDispatchReceipt[];
};

export type InboundHandleResult =
  | DroppedInboundHandleResult
  | PreflightConsumedInboundHandleResult
  | DirectReplyInboundHandleResult
  | PassiveIngestedInboundHandleResult
  | CommandReplyInboundHandleResult
  | DispatchedInboundHandleResult;

export interface DurableOutboundRenderInput {
  event: OutboundEvent;
}
