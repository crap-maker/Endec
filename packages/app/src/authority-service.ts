import { randomUUID, createHash } from "node:crypto";
import type { createAccessStore } from "@endec/access";
import {
  AuthorityControlPayloadSchema,
  deriveConversationScopeFromPeerKind,
  type ActivationHint,
  type AdmissionDecision,
  type ApprovePairClaimRequestInput,
  type ApprovePairClaimResult,
  type ConversationLifecycleEvent,
  type ConversationRef,
  type ConversationScope,
  type InspectOwnerBindingRequest,
  type InspectOwnerBindingResult,
  type ListPairClaimsRequest,
  type ListPairClaimsResult,
  type ListTrustedConversationsRequest,
  type ListTrustedConversationsResult,
  type OutboundConversationLegality,
  type PairingSuccessNoticeStatus,
  type RevokeTrustedConversationRequestInput,
  type RevokeTrustedConversationResult,
  type ResetOwnerBindingRequestInput,
  type ResetOwnerBindingResult
} from "@endec/domain";
import { resolveOwnerPreferences } from "./owner-init.ts";
import { resolveServerTimezone } from "./time-context.ts";
import type { EndecImSource } from "./types.ts";

const SYSTEM_LIFECYCLE_ACTOR_ID = "system:authority-lifecycle";

function createAuthorityActorId(input: {
  source: EndecImSource;
  accountId: string;
  senderId: string;
}) {
  return `actor_im_${createHash("sha256")
    .update([input.source, input.accountId, input.senderId].join("\u001f"))
    .digest("hex")
    .slice(0, 24)}`;
}

function createDirectReply(text: string, outcome: Extract<AdmissionDecision["outcome"], "reply_direct" | "reject_direct">): AdmissionDecision {
  return {
    outcome,
    expectsUserVisibleReply: true,
    directReply: { text }
  };
}

function createDropDecision(): AdmissionDecision {
  return {
    outcome: "drop",
    expectsUserVisibleReply: false
  };
}

function createDispatchDecision(): AdmissionDecision {
  return {
    outcome: "dispatch_turn",
    expectsUserVisibleReply: true
  };
}

function createPassiveIngestDecision(): AdmissionDecision {
  return {
    outcome: "passive_ingest",
    expectsUserVisibleReply: false
  };
}

function formatPairClaimReply(input: { pairCode: string; expiresAt: string; now?: string }) {
  const remainingMs = Math.max(0, new Date(input.expiresAt).getTime() - new Date(input.now ?? new Date().toISOString()).getTime());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `Pair code: ${input.pairCode}\nTTL: ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}.\nApprove this claim through the operator surface to finish pairing.`;
}

function nonOwnerDirectText() {
  return "This instance is already bound to another owner. This direct conversation is not available.";
}

function pairingSuccessNoticeText() {
  return [
    "Pairing complete. Normal chat is ready now.",
    "",
    "Optional setup: reply in this direct chat with any of the following if you want:",
    "- your display name",
    "- my display name (default: Endec)",
    "- your timezone (default: server timezone)",
    "",
    "Silence is okay; you can start chatting normally anytime."
  ].join("\n");
}

function trustedConversationGrantedText(conversationRef: ConversationRef) {
  const conversationLabel = conversationRef.baseConversationId
    ?? conversationRef.parentConversationId
    ?? conversationRef.conversationId;
  return `Trusted conversation granted for ${conversationLabel}. You can now use the bot in that shared conversation, and normal owner chat remains available here.`;
}

type AuthorityStore = ReturnType<typeof createAccessStore>;
type StoredApprovePairClaimResult = Awaited<ReturnType<AuthorityStore["approvePairClaim"]>>;
type StoredEnsureTrustedConversationResult = Awaited<ReturnType<AuthorityStore["ensureTrustedConversation"]>>;

type AuthorityServiceInput = {
  accessStore: AuthorityStore;
  resolveSessionId: (input: {
    source: EndecImSource;
    workspaceId: string;
    accountId: string;
    conversationRef: ConversationRef;
    binding?: { sessionId?: string };
  }) => Promise<string>;
  resolveActorId: (input: {
    source: EndecImSource;
    workspaceId: string;
    accountId: string;
    senderId: string;
    conversationRef: ConversationRef;
    binding?: { actorId?: string };
  }) => Promise<string>;
  enqueueOutboundEvent: (input: {
    outboundEventId: string;
    workspaceId: string;
    sessionId?: string;
    actorId?: string;
    taskId?: string;
    runId?: string;
    conversationRef: ConversationRef;
    channel: "telegram" | "feishu" | "web" | "sdk";
    eventKind: "operator_notice";
    renderPayload: unknown;
    idempotencyKey: string;
    availableAt?: string;
    now?: string;
  }) => Promise<unknown>;
  projectOwnerNotice?: (input: {
    source: EndecImSource;
    workspaceId: string;
    sessionId: string;
    summary: string;
    text: string;
    createdAt: string;
    sourceRefs?: string[];
  }) => Promise<void>;
  resolveServerTimezone?: () => string;
  now?: () => string;
};

function resolveAuthorityNoticeChannel(source: string): "telegram" | "feishu" {
  return source === "feishu" ? "feishu" : "telegram";
}

function readWorkspaceIdFromLifecycleEvent(event: ConversationLifecycleEvent) {
  const workspaceId = event.metadata?.workspaceId;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : undefined;
}

function readLifecycleActorSubjectRef(event: ConversationLifecycleEvent) {
  const actorId = event.metadata?.actorId;
  return typeof actorId === "string" && actorId.length > 0 ? actorId : undefined;
}

function lifecycleEventMatchesOwner(input: {
  event: ConversationLifecycleEvent;
  ownerBinding: NonNullable<Awaited<ReturnType<AuthorityStore["inspectOwnerBinding"]>>>;
}) {
  return input.event.subjectRef === input.ownerBinding.ownerSubjectRef
    || input.event.actorId === input.ownerBinding.ownerActorId;
}

export function createAuthorityService(input: AuthorityServiceInput) {
  const now = () => input.now?.() ?? new Date().toISOString();

  async function evaluateInboundAdmission(request: {
    source: EndecImSource;
    workspaceId: string;
    accountId: string;
    senderId: string;
    conversationRef: ConversationRef;
    conversationScope: ConversationScope;
    activationHint: ActivationHint;
  }): Promise<AdmissionDecision> {
    const state = await input.accessStore.getAuthorityState({
      source: request.source,
      accountId: request.accountId
    });

    if (state.status !== "bound") {
      if (request.conversationScope === "direct") {
        const requesterActorId = await input.resolveActorId({
          source: request.source,
          workspaceId: request.workspaceId,
          accountId: request.accountId,
          senderId: request.senderId,
          conversationRef: request.conversationRef
        });
        const claim = await input.accessStore.createOrReusePairClaim({
          source: request.source,
          accountId: request.accountId,
          requesterSubjectRef: request.senderId,
          requesterActorId,
          requestWorkspaceId: request.workspaceId,
          requestConversationRef: request.conversationRef,
          now: now()
        });

        if (!claim.claim || claim.outcome === "authority_bound") {
          return createDirectReply(nonOwnerDirectText(), "reject_direct");
        }

        return createDirectReply(formatPairClaimReply({
          pairCode: claim.claim.pairCode,
          expiresAt: claim.claim.expiresAt,
          now: now()
        }), "reply_direct");
      }

      if (request.activationHint.pairRequested || request.activationHint.explicitActivation || request.activationHint.mentionMatched) {
        return createDropDecision();
      }

      return createDropDecision();
    }

    const ownerBinding = await input.accessStore.inspectOwnerBinding({
      source: request.source,
      accountId: request.accountId
    });
    if (!ownerBinding) {
      return createDropDecision();
    }

    if (request.conversationScope === "direct") {
      return request.senderId === ownerBinding.ownerSubjectRef
        ? createDispatchDecision()
        : createDirectReply(nonOwnerDirectText(), "reject_direct");
    }

    const trusted = await input.accessStore.matchTrustedConversation({
      source: request.source,
      accountId: request.accountId,
      conversationRef: request.conversationRef
    });

    if (trusted) {
      return request.activationHint.explicitActivation
        ? createDispatchDecision()
        : createPassiveIngestDecision();
    }

    return createDropDecision();
  }

  async function enqueueOwnerNotice(inputValue: {
    workspaceId: string;
    sessionId?: string;
    source: EndecImSource;
    accountId: string;
    conversationRef: ConversationRef;
    ownerBindingId: string;
    ownerGeneration: number;
    noticeKind: "pairing_success" | "trusted_conversation_granted";
    message: string;
    actorId: string;
    idempotencyKey: string;
    nowValue: string;
    sourceRefs?: string[];
  }) {
    const sessionId = inputValue.sessionId ?? await input.resolveSessionId({
      source: inputValue.source,
      workspaceId: inputValue.workspaceId,
      accountId: inputValue.accountId,
      conversationRef: inputValue.conversationRef,
      binding: inputValue.sessionId ? { sessionId: inputValue.sessionId } : undefined
    });
    const payload = AuthorityControlPayloadSchema.parse({
      schemaVersion: 1,
      contractVersion: "im.authority-control.v1",
      noticeKind: inputValue.noticeKind,
      message: inputValue.message,
      ownerBindingId: inputValue.ownerBindingId,
      ownerGeneration: inputValue.ownerGeneration,
      conversationRef: inputValue.conversationRef
    });

    await input.enqueueOutboundEvent({
      outboundEventId: `outbound_${randomUUID()}`,
      workspaceId: inputValue.workspaceId,
      sessionId,
      actorId: inputValue.actorId,
      conversationRef: inputValue.conversationRef,
      channel: resolveAuthorityNoticeChannel(inputValue.source),
      eventKind: "operator_notice",
      renderPayload: payload,
      idempotencyKey: inputValue.idempotencyKey,
      availableAt: inputValue.nowValue,
      now: inputValue.nowValue
    });

    await input.projectOwnerNotice?.({
      source: inputValue.source,
      workspaceId: inputValue.workspaceId,
      sessionId,
      summary: inputValue.message,
      text: inputValue.message,
      createdAt: inputValue.nowValue,
      sourceRefs: inputValue.sourceRefs
    });

    return payload;
  }

  async function enqueueTrustedConversationGrantedNotice(inputValue: {
    event: ConversationLifecycleEvent;
    ownerBinding: NonNullable<Awaited<ReturnType<AuthorityStore["inspectOwnerBinding"]>>>;
    trustResult: StoredEnsureTrustedConversationResult;
  }) {
    if (inputValue.trustResult.outcome !== "created") {
      return;
    }

    const workspaceId = readWorkspaceIdFromLifecycleEvent(inputValue.event);
    if (!workspaceId) {
      return;
    }

    const nowValue = inputValue.event.observedAt ?? now();
    await enqueueOwnerNotice({
      workspaceId,
      source: inputValue.ownerBinding.source as EndecImSource,
      accountId: inputValue.ownerBinding.accountId,
      conversationRef: inputValue.ownerBinding.pairedConversationRef,
      ownerBindingId: inputValue.ownerBinding.ownerBindingId,
      ownerGeneration: inputValue.ownerBinding.ownerGeneration,
      noticeKind: "trusted_conversation_granted",
      message: trustedConversationGrantedText(inputValue.event.conversationRef),
      actorId: SYSTEM_LIFECYCLE_ACTOR_ID,
      idempotencyKey: `authority:${inputValue.ownerBinding.source}:${inputValue.ownerBinding.accountId}:trusted_conversation_granted:${inputValue.trustResult.binding?.trustId ?? inputValue.ownerBinding.ownerBindingId}`,
      nowValue,
      sourceRefs: [inputValue.event.conversationRef.conversationId]
    });
  }

  async function applyConversationLifecycleEvent(event: ConversationLifecycleEvent) {
    const ownerBinding = await input.accessStore.inspectOwnerBinding({
      source: event.source,
      accountId: event.accountId,
      now: event.observedAt
    });

    if (!ownerBinding || event.conversationScope !== "shared") {
      if (event.eventKind === "bot_removed") {
        await input.accessStore.applyConversationLifecycleEvent(event);
      }
      return;
    }

    if (event.eventKind === "bot_added") {
      if (!lifecycleEventMatchesOwner({ event, ownerBinding })) {
        return;
      }

      const trustResult = await input.accessStore.ensureTrustedConversation({
        source: event.source,
        accountId: event.accountId,
        conversationRef: event.conversationRef,
        coverage: "descendants",
        grantKind: "owner_auto",
        now: event.observedAt ?? now()
      });
      await enqueueTrustedConversationGrantedNotice({
        event,
        ownerBinding,
        trustResult
      });
      return;
    }

    if (event.eventKind === "bot_removed") {
      await input.accessStore.applyConversationLifecycleEvent(event);
      await input.accessStore.revokeTrustedConversation({
        source: event.source,
        accountId: event.accountId,
        conversationKey: event.conversationRef.baseConversationId ?? event.conversationRef.conversationId,
        operatorActorId: SYSTEM_LIFECYCLE_ACTOR_ID,
        reason: "bot_removed",
        now: event.observedAt ?? now()
      });
      return;
    }

    if (event.eventKind === "owner_left") {
      if (!lifecycleEventMatchesOwner({ event, ownerBinding })) {
        return;
      }

      await input.accessStore.revokeTrustedConversation({
        source: event.source,
        accountId: event.accountId,
        conversationKey: event.conversationRef.baseConversationId ?? event.conversationRef.conversationId,
        operatorActorId: SYSTEM_LIFECYCLE_ACTOR_ID,
        reason: "owner_left",
        now: event.observedAt ?? now()
      });
    }
  }

  async function evaluateOutboundConversationLegality(request: {
    source: EndecImSource;
    accountId: string;
    conversationRef: ConversationRef;
  }): Promise<OutboundConversationLegality> {
    const state = await input.accessStore.getAuthorityState({
      source: request.source,
      accountId: request.accountId
    });

    if (state.status !== "bound") {
      return {
        status: "blocked",
        reason: "authority_unbound"
      };
    }

    const conversationScope = deriveConversationScopeFromPeerKind(request.conversationRef.peerKind);
    const ownerBinding = await input.accessStore.inspectOwnerBinding({
      source: request.source,
      accountId: request.accountId
    });
    if (!ownerBinding) {
      return {
        status: "blocked",
        reason: "authority_unbound"
      };
    }

    if (conversationScope === "direct") {
      const ownerDirectPeerId = ownerBinding.pairedConversationRef.peerId;
      return request.conversationRef.peerId === ownerDirectPeerId
        ? {
            status: "allowed",
            reason: "owner_direct",
            ownerGeneration: ownerBinding.ownerGeneration,
            ownerBindingId: ownerBinding.ownerBindingId
          }
        : {
            status: "blocked",
            reason: "owner_mismatch",
            ownerGeneration: ownerBinding.ownerGeneration,
            ownerBindingId: ownerBinding.ownerBindingId
          };
    }

    if (conversationScope === "broadcast" || conversationScope === "unknown") {
      return {
        status: "blocked",
        reason: "unsupported_conversation_scope",
        ownerGeneration: ownerBinding.ownerGeneration,
        ownerBindingId: ownerBinding.ownerBindingId
      };
    }

    const trusted = await input.accessStore.matchTrustedConversation({
      source: request.source,
      accountId: request.accountId,
      conversationRef: request.conversationRef
    });

    return trusted
      ? {
          status: "allowed",
          reason: "trusted_conversation",
          ownerGeneration: trusted.ownerGeneration,
          ownerBindingId: ownerBinding.ownerBindingId,
          trustId: trusted.trustId
        }
      : {
          status: "blocked",
          reason: "conversation_not_trusted",
          ownerGeneration: ownerBinding.ownerGeneration,
          ownerBindingId: ownerBinding.ownerBindingId
        };
  }

  async function inspectOwnerBinding(request: InspectOwnerBindingRequest): Promise<InspectOwnerBindingResult> {
    const [state, ownerBinding, ownerPreferences, ownerInitState] = await Promise.all([
      input.accessStore.getAuthorityState(request),
      input.accessStore.inspectOwnerBinding(request),
      input.accessStore.getOwnerPreferences(request),
      input.accessStore.getOwnerInitState(request)
    ]);

    return {
      state,
      ownerBinding,
      ownerPreferences,
      resolvedOwnerPreferences: ownerBinding
        ? resolveOwnerPreferences({
            serverTimezone: input.resolveServerTimezone?.() ?? resolveServerTimezone({}),
            stored: ownerPreferences
          })
        : undefined,
      ownerInitState
    };
  }

  async function listPairClaims(request: ListPairClaimsRequest): Promise<ListPairClaimsResult> {
    const state = await input.accessStore.getAuthorityState(request);
    const claims = await input.accessStore.listPairClaims(request);
    return {
      state,
      claims
    };
  }

  async function enqueuePairingSuccessNotice(result: StoredApprovePairClaimResult, operatorActorId: string): Promise<PairingSuccessNoticeStatus> {
    if (result.outcome !== "approved") {
      return "not_approved";
    }

    if (!result.ownerBinding || !result.consumedClaim) {
      return "impossible_missing_approved_claim_context";
    }

    const claim = result.consumedClaim;
    if (!claim.requestWorkspaceId) {
      return "skipped_missing_request_routing";
    }

    const nowValue = now();
    await enqueueOwnerNotice({
      workspaceId: claim.requestWorkspaceId,
      sessionId: claim.requestSessionId,
      source: result.ownerBinding.source as EndecImSource,
      accountId: result.ownerBinding.accountId,
      conversationRef: claim.requestConversationRef,
      ownerBindingId: result.ownerBinding.ownerBindingId,
      ownerGeneration: result.ownerBinding.ownerGeneration,
      noticeKind: "pairing_success",
      message: pairingSuccessNoticeText(),
      actorId: operatorActorId,
      idempotencyKey: `authority:${result.ownerBinding.source}:${result.ownerBinding.accountId}:pairing_success:${result.ownerBinding.ownerBindingId}`,
      nowValue,
      sourceRefs: [claim.claimId]
    });

    await input.accessStore.markOwnerInitPrompted({
      source: result.ownerBinding.source,
      accountId: result.ownerBinding.accountId,
      ownerBindingId: result.ownerBinding.ownerBindingId,
      now: nowValue
    });

    return "enqueued";
  }

  async function approvePairClaim(request: ApprovePairClaimRequestInput): Promise<ApprovePairClaimResult> {
    const result = await input.accessStore.approvePairClaim({
      ...request,
      now: now()
    });
    const pairingSuccessNoticeStatus = await enqueuePairingSuccessNotice(result, request.operatorActorId);
    return {
      ...result,
      pairingSuccessNoticeStatus
    };
  }

  async function resetOwnerBinding(request: ResetOwnerBindingRequestInput): Promise<ResetOwnerBindingResult> {
    return input.accessStore.resetOwnerBinding({
      ...request,
      now: now()
    });
  }

  async function listTrustedConversations(request: ListTrustedConversationsRequest): Promise<ListTrustedConversationsResult> {
    const state = await input.accessStore.getAuthorityState(request);
    const bindings = await input.accessStore.listTrustedConversations(request);
    return {
      state,
      bindings
    };
  }

  async function revokeTrustedConversation(request: RevokeTrustedConversationRequestInput): Promise<RevokeTrustedConversationResult> {
    return input.accessStore.revokeTrustedConversation({
      ...request,
      now: now()
    });
  }

  return {
    evaluateInboundAdmission,
    applyConversationLifecycleEvent,
    evaluateOutboundConversationLegality,
    inspectOwnerBinding,
    listPairClaims,
    approvePairClaim,
    resetOwnerBinding,
    listTrustedConversations,
    revokeTrustedConversation
  };
}
