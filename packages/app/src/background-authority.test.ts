import { describe, expect, it } from "vitest";
import { createAccessStore } from "@endec/access";
import { createAuthorityService } from "./authority-service.ts";

function createAuthorityHarness() {
  const enqueued: Array<{
    outboundEventId: string;
    workspaceId: string;
    sessionId?: string;
    actorId?: string;
    eventKind: "operator_notice";
    conversationRef: unknown;
    renderPayload: unknown;
    idempotencyKey: string;
  }> = [];

  const authority = createAuthorityService({
    accessStore: createAccessStore({ filename: ":memory:" }),
    resolveSessionId: async () => "session_pair_001",
    resolveActorId: async () => "actor_owner_001",
    enqueueOutboundEvent: async (input) => {
      enqueued.push({
        outboundEventId: input.outboundEventId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        eventKind: input.eventKind,
        conversationRef: input.conversationRef,
        renderPayload: input.renderPayload,
        idempotencyKey: input.idempotencyKey
      });
    }
  });

  return { authority, enqueued };
}

describe("background authority", () => {
  it("approve enqueues one pairing-success operator_notice with stored DM routing metadata and no session truth", async () => {
    const { authority, enqueued } = createAuthorityHarness();

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      },
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });

    const claims = await authority.listPairClaims({
      source: "telegram",
      accountId: "acct_bot",
      includeInactive: true
    });
    const approved = await authority.approvePairClaim({
      source: "telegram",
      accountId: "acct_bot",
      claimId: claims.claims[0]?.claimId,
      operatorActorId: "operator_alpha"
    });

    expect(approved.outcome).toBe("approved");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      workspaceId: "workspace_local",
      sessionId: "session_pair_001",
      actorId: "operator_alpha",
      eventKind: "operator_notice",
      conversationRef: claims.claims[0]?.requestConversationRef,
      renderPayload: {
        contractVersion: "im.authority-control.v1",
        noticeKind: "pairing_success",
        ownerBindingId: approved.ownerBinding?.ownerBindingId,
        ownerGeneration: approved.ownerBinding?.ownerGeneration,
        conversationRef: claims.claims[0]?.requestConversationRef,
        message: expect.stringContaining("Normal chat is ready now")
      }
    });
  });

  it("revoked trust blocks later background callback send legality checks", async () => {
    const { authority } = createAuthorityHarness();

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      },
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });
    const claim = (await authority.listPairClaims({
      source: "telegram",
      accountId: "acct_bot",
      includeInactive: true
    })).claims[0]!;
    await authority.approvePairClaim({
      source: "telegram",
      accountId: "acct_bot",
      claimId: claim.claimId,
      operatorActorId: "operator_alpha"
    });

    const trustedConversationRef = {
      accountId: "acct_bot",
      conversationId: "group:chat_100:thread:thread_1",
      peerId: "chat_100",
      peerKind: "group" as const,
      parentConversationId: "group:chat_100",
      baseConversationId: "group:chat_100",
      threadId: "thread_1"
    };
    await authority.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: trustedConversationRef,
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "owner_user"
    });
    const trust = (await authority.listTrustedConversations({
      source: "telegram",
      accountId: "acct_bot",
      includeInactive: true
    })).bindings[0]!;
    await authority.revokeTrustedConversation({
      source: "telegram",
      accountId: "acct_bot",
      trustId: trust.trustId,
      operatorActorId: "operator_alpha",
      reason: "manual revoke"
    });

    const legality = await authority.evaluateOutboundConversationLegality({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: trustedConversationRef
    });

    expect(legality).toMatchObject({
      status: "blocked",
      reason: "conversation_not_trusted"
    });
  });

  it("does not treat the old owner direct conversation as valid after reset", async () => {
    const { authority } = createAuthorityHarness();
    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_42",
      peerId: "chat_42",
      peerKind: "dm" as const
    };

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });
    const claim = (await authority.listPairClaims({
      source: "telegram",
      accountId: "acct_bot",
      includeInactive: true
    })).claims[0]!;
    await authority.approvePairClaim({
      source: "telegram",
      accountId: "acct_bot",
      claimId: claim.claimId,
      operatorActorId: "operator_alpha"
    });
    await authority.resetOwnerBinding({
      source: "telegram",
      accountId: "acct_bot",
      operatorActorId: "operator_reset",
      reason: "owner rotated"
    });

    const legality = await authority.evaluateOutboundConversationLegality({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: ownerConversationRef
    });

    expect(legality).toMatchObject({
      status: "blocked",
      reason: "authority_unbound"
    });
  });
});
