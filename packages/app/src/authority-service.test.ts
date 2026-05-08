import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createAccessStore } from "@endec/access";
import type { ConversationRef, PairClaim } from "@endec/domain";
import { createAuthorityService } from "./authority-service.ts";
import type { EndecImSource } from "./types.ts";

function directConversationRef(id = "chat_42"): ConversationRef {
  return {
    accountId: "acct_bot",
    conversationId: `dm:${id}`,
    peerId: id,
    peerKind: "dm"
  };
}

function reboundDirectConversationRef(id = "chat_42"): ConversationRef {
  return {
    accountId: "acct_bot",
    conversationId: `private:${id}:owner-current`,
    peerId: id,
    peerKind: "dm"
  };
}

function sharedConversationRef(id = "chat_100"): ConversationRef {
  return {
    accountId: "acct_bot",
    conversationId: `group:${id}:thread:thread_1`,
    peerId: id,
    peerKind: "group",
    parentConversationId: `group:${id}`,
    baseConversationId: `group:${id}`,
    threadId: "thread_1"
  };
}

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

describe("authority service", () => {
  it("creates and reuses unbound direct-message pair claims with routing metadata but without session creation", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const resolveSessionId = vi.fn(async () => "session_pair_001");
    const resolveActorId = vi.fn(async () => "actor_pair_001");
    const enqueueOutboundEvent = vi.fn(async () => undefined);
    const authority = createAuthorityService({
      accessStore,
      resolveSessionId,
      resolveActorId,
      enqueueOutboundEvent
    });

    const first = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "user_42",
      conversationRef: directConversationRef(),
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });
    const second = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "user_42",
      conversationRef: directConversationRef(),
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });

    expect(first).toMatchObject({
      outcome: "reply_direct",
      expectsUserVisibleReply: true,
      directReply: {
        text: expect.stringMatching(/pair code/i)
      }
    });
    expect(second).toMatchObject({
      outcome: "reply_direct",
      directReply: {
        text: expect.stringMatching(/pair code/i)
      }
    });
    expect(first.directReply?.text).toMatch(/[A-Z0-9]{8}/);
    expect(second.directReply?.text).toContain(first.directReply?.text.match(/[A-Z0-9]{8}/)?.[0] ?? "");

    const claims = await authority.listPairClaims({
      source: "telegram",
      accountId: "acct_bot",
      includeInactive: true
    });
    expect(claims.claims).toHaveLength(1);
    expect(claims.claims[0]).toMatchObject({
      requesterSubjectRef: "user_42",
      requesterActorId: "actor_pair_001",
      requestWorkspaceId: "workspace_local",
      requestConversationRef: directConversationRef()
    });
    expect(claims.claims[0]?.requestSessionId).toBeUndefined();
    expect(resolveSessionId).not.toHaveBeenCalled();
    expect(resolveActorId).toHaveBeenCalledTimes(2);
    expect(enqueueOutboundEvent).not.toHaveBeenCalled();
  });

  it("creates pair claims for any unbound direct message", async () => {
    const authority = createAuthorityService({
      accessStore: createAccessStore({ filename: ":memory:" }),
      resolveSessionId: vi.fn(async () => "session_unused"),
      resolveActorId: vi.fn(async () => "actor_unused"),
      enqueueOutboundEvent: vi.fn(async () => undefined)
    });

    const decision = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "user_42",
      conversationRef: directConversationRef(),
      conversationScope: "direct",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: true
      }
    });

    expect(decision).toMatchObject({
      outcome: "reply_direct",
      expectsUserVisibleReply: true,
      directReply: {
        text: expect.stringMatching(/pair code/i)
      }
    });
  });

  it("silently drops unbound non-direct activation attempts across shared, broadcast, and unknown scopes", async () => {
    const authority = createAuthorityService({
      accessStore: createAccessStore({ filename: ":memory:" }),
      resolveSessionId: vi.fn(async () => "session_unused"),
      resolveActorId: vi.fn(async () => "actor_unused"),
      enqueueOutboundEvent: vi.fn(async () => undefined)
    });

    await expect(Promise.all([
      authority.evaluateInboundAdmission({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "member_shared",
        conversationRef: sharedConversationRef(),
        conversationScope: "shared",
        activationHint: {
          pairRequested: false,
          explicitActivation: true,
          mentionMatched: true
        }
      }),
      authority.evaluateInboundAdmission({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "member_broadcast",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "channel:announcements",
          peerId: "announcements",
          peerKind: "channel"
        },
        conversationScope: "broadcast",
        activationHint: {
          pairRequested: false,
          explicitActivation: true,
          mentionMatched: true
        }
      }),
      authority.evaluateInboundAdmission({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "member_unknown",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "unknown:chat_999",
          peerId: "chat_999",
          peerKind: "unknown"
        },
        conversationScope: "unknown",
        activationHint: {
          pairRequested: true,
          explicitActivation: true,
          mentionMatched: true
        }
      })
    ])).resolves.toEqual([
      {
        outcome: "drop",
        expectsUserVisibleReply: false
      },
      {
        outcome: "drop",
        expectsUserVisibleReply: false
      },
      {
        outcome: "drop",
        expectsUserVisibleReply: false
      }
    ]);
  });

  it("dispatches bound owner direct messages and rejects non-owner direct messages", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const authority = createAuthorityService({
      accessStore,
      resolveSessionId: vi.fn(async () => "session_pair_001"),
      resolveActorId: vi.fn(async () => "actor_owner_001"),
      enqueueOutboundEvent: vi.fn(async () => undefined)
    });

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: directConversationRef(),
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

    const ownerDecision = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: directConversationRef(),
      conversationScope: "direct",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: true
      }
    });
    const strangerDecision = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "stranger_user",
      conversationRef: directConversationRef(),
      conversationScope: "direct",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: true
      }
    });

    expect(ownerDecision).toMatchObject({
      outcome: "dispatch_turn",
      expectsUserVisibleReply: true
    });
    expect(strangerDecision).toMatchObject({
      outcome: "reject_direct",
      directReply: {
        text: expect.stringMatching(/already bound/i)
      }
    });
  });

  it("allows direct outbound replies by owner peer identity even when the current private conversation ref changes", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const authority = createAuthorityService({
      accessStore,
      resolveSessionId: vi.fn(async () => "session_pair_001"),
      resolveActorId: vi.fn(async () => "actor_owner_001"),
      enqueueOutboundEvent: vi.fn(async () => undefined)
    });

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: directConversationRef(),
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

    const reboundLegality = await authority.evaluateOutboundConversationLegality({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: reboundDirectConversationRef()
    });
    const strangerLegality = await authority.evaluateOutboundConversationLegality({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: directConversationRef("chat_99")
    });

    expect(reboundLegality).toMatchObject({
      status: "allowed",
      reason: "owner_direct"
    });
    expect(strangerLegality).toMatchObject({
      status: "blocked",
      reason: "owner_mismatch"
    });
  });

  it("dispatches only trusted shared conversations with explicit activation", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const authority = createAuthorityService({
      accessStore,
      resolveSessionId: vi.fn(async () => "session_pair_001"),
      resolveActorId: vi.fn(async () => "actor_owner_001"),
      enqueueOutboundEvent: vi.fn(async () => undefined)
    });

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: directConversationRef(),
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

    await authority.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "owner_user",
      metadata: {
        workspaceId: "workspace_local"
      }
    });

    const trustedDispatch = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "member_1",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: true
      }
    });
    const trustedNoise = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "member_1",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      activationHint: {
        pairRequested: false,
        explicitActivation: false,
        mentionMatched: false
      }
    });
    const untrustedActivation = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "member_2",
      conversationRef: sharedConversationRef("chat_200"),
      conversationScope: "shared",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: true
      }
    });

    expect(trustedDispatch).toMatchObject({ outcome: "dispatch_turn" });
    expect(trustedNoise).toMatchObject({ outcome: "passive_ingest", expectsUserVisibleReply: false });
    expect(untrustedActivation).toMatchObject({
      outcome: "drop",
      expectsUserVisibleReply: false
    });
  });

  it("dispatches trusted shared mentions after re-add when lifecycle events carry actor identity separately from subject identity", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const authority = createAuthorityService({
      accessStore,
      resolveSessionId: vi.fn(async () => "session_pair_001"),
      resolveActorId: vi.fn(async ({ source, accountId, senderId, workspaceId: _workspaceId, conversationRef: _conversationRef, binding: _binding }: {
        source: EndecImSource;
        workspaceId: string;
        accountId: string;
        senderId: string;
        conversationRef: ConversationRef;
        binding?: { actorId?: string };
      }) => createAuthorityActorId({ source, accountId, senderId })),
      enqueueOutboundEvent: vi.fn(async () => undefined)
    });

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: directConversationRef(),
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

    await authority.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "999",
      actorId: createAuthorityActorId({ source: "telegram", accountId: "acct_bot", senderId: "owner_user" }),
      observedAt: "2026-04-29T00:00:00.000Z",
      metadata: {
        workspaceId: "workspace_local",
        actorId: "7",
        subjectId: "999"
      }
    });
    await authority.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      eventKind: "bot_removed",
      observedAt: "2026-04-29T00:01:00.000Z"
    });
    await authority.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "999",
      actorId: createAuthorityActorId({ source: "telegram", accountId: "acct_bot", senderId: "owner_user" }),
      observedAt: "2026-04-29T00:02:00.000Z",
      metadata: {
        workspaceId: "workspace_local",
        actorId: "7",
        subjectId: "999"
      }
    });

    const trustedDispatch = await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "member_1",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: true
      }
    });

    expect(trustedDispatch).toMatchObject({ outcome: "dispatch_turn" });
  });

  it("resets owner authority and blocks stale owner direct conversations afterward", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const authority = createAuthorityService({
      accessStore,
      resolveSessionId: vi.fn(async () => "session_pair_001"),
      resolveActorId: vi.fn(async () => "actor_owner_001"),
      enqueueOutboundEvent: vi.fn(async () => undefined)
    });

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: directConversationRef(),
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

    const reset = await authority.resetOwnerBinding({
      source: "telegram",
      accountId: "acct_bot",
      operatorActorId: "operator_reset",
      reason: "rotate owner"
    });
    const legality = await authority.evaluateOutboundConversationLegality({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: directConversationRef()
    });

    expect(reset).toMatchObject({
      outcome: "reset",
      newOwnerGeneration: 1,
      revokedOwnerBinding: {
        revokedByOperatorId: "operator_reset",
        revokedReason: "rotate owner"
      }
    });
    expect(legality).toMatchObject({
      status: "blocked",
      reason: "authority_unbound"
    });
  });

  it("persists operator actor ids across approve, reset, and revoke paths", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const enqueueOutboundEvent = vi.fn(async () => undefined);
    const authority = createAuthorityService({
      accessStore,
      resolveSessionId: vi.fn(async () => "session_pair_001"),
      resolveActorId: vi.fn(async () => "actor_owner_001"),
      enqueueOutboundEvent
    });

    await authority.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: directConversationRef(),
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
    const approved = await authority.approvePairClaim({
      source: "telegram",
      accountId: "acct_bot",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha"
    });

    await authority.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: sharedConversationRef(),
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "owner_user",
      metadata: {
        workspaceId: "workspace_local"
      }
    });
    const trusts = await authority.listTrustedConversations({
      source: "telegram",
      accountId: "acct_bot",
      includeInactive: true
    });
    const revoked = await authority.revokeTrustedConversation({
      source: "telegram",
      accountId: "acct_bot",
      trustId: trusts.bindings[0]?.trustId,
      operatorActorId: "operator_bravo",
      reason: "manual revoke"
    });
    const reset = await authority.resetOwnerBinding({
      source: "telegram",
      accountId: "acct_bot",
      operatorActorId: "operator_charlie",
      reason: "owner reset"
    });

    expect(approved.outcome).toBe("approved");
    expect(enqueueOutboundEvent).toHaveBeenCalledTimes(2);
    expect(enqueueOutboundEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: "session_pair_001",
      eventKind: "operator_notice"
    }));
    expect(enqueueOutboundEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: "session_pair_001",
      eventKind: "operator_notice"
    }));
    expect(approved.pairingSuccessNoticeStatus).toBe("enqueued");
    expect(approved.ownerBinding?.approvedByOperatorId).toBe("operator_alpha");
    expect(approved.consumedClaim?.approvedByOperatorId).toBe("operator_alpha");
    expect(revoked).toMatchObject({
      outcome: "revoked",
      revokedBinding: {
        revokedByOperatorId: "operator_bravo",
        revokedReason: "manual revoke"
      }
    });
    expect(reset).toMatchObject({
      outcome: "reset",
      revokedOwnerBinding: {
        revokedByOperatorId: "operator_charlie",
        revokedReason: "owner reset"
      }
    });
  });

  it("reports skipped pairing-success notice when the approved claim lacks request routing metadata", async () => {
    const enqueueOutboundEvent = vi.fn(async () => undefined);
    const claim: PairClaim = {
      claimId: "claim_legacy_001",
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      requesterSubjectRef: "owner_user",
      requesterActorId: "actor_owner_001",
      requestConversationRef: directConversationRef(),
      pairCode: "ABCD1234",
      status: "consumed",
      expiresAt: "2026-04-29T00:10:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      consumedAt: "2026-04-29T00:01:00.000Z",
      approvedByOperatorId: "operator_alpha"
    };
    const authority = createAuthorityService({
      accessStore: {
        approvePairClaim: vi.fn(async () => ({
          outcome: "approved",
          state: {
            source: "telegram",
            accountId: "acct_bot",
            ownerGeneration: 0,
            ownerBindingId: "owner_binding_001",
            status: "bound",
            createdAt: "2026-04-29T00:00:00.000Z",
            updatedAt: "2026-04-29T00:01:00.000Z"
          },
          ownerBinding: {
            ownerBindingId: "owner_binding_001",
            source: "telegram",
            accountId: "acct_bot",
            ownerGeneration: 0,
            ownerSubjectRef: "owner_user",
            ownerActorId: "actor_owner_001",
            pairedConversationRef: directConversationRef(),
            consumedClaimId: claim.claimId,
            status: "active",
            boundAt: "2026-04-29T00:01:00.000Z",
            approvedByOperatorId: "operator_alpha"
          },
          consumedClaim: claim,
          supersededClaimCount: 0
        })),
        getAuthorityState: vi.fn(),
        inspectOwnerBinding: vi.fn(),
        listPairClaims: vi.fn(),
        createOrReusePairClaim: vi.fn(),
        matchTrustedConversation: vi.fn(),
        applyConversationLifecycleEvent: vi.fn(),
        ensureTrustedConversation: vi.fn(),
        resetOwnerBinding: vi.fn(),
        listTrustedConversations: vi.fn(),
        revokeTrustedConversation: vi.fn(),
        evaluateClaimExpiry: vi.fn()
      } as unknown as ReturnType<typeof createAccessStore>,
      resolveSessionId: vi.fn(async () => "session_unused"),
      resolveActorId: vi.fn(async () => "actor_unused"),
      enqueueOutboundEvent
    });

    const result = await authority.approvePairClaim({
      source: "telegram",
      accountId: "acct_bot",
      claimId: claim.claimId,
      operatorActorId: "operator_alpha"
    });

    expect(result.pairingSuccessNoticeStatus).toBe("skipped_missing_request_routing");
    expect(enqueueOutboundEvent).not.toHaveBeenCalled();
  });

  it("reports pairing-success notice as not approved when approval fails", async () => {
    const enqueueOutboundEvent = vi.fn(async () => undefined);
    const authority = createAuthorityService({
      accessStore: {
        approvePairClaim: vi.fn(async () => ({
          outcome: "claim_not_found",
          state: {
            source: "telegram",
            accountId: "acct_bot",
            ownerGeneration: 0,
            status: "unbound",
            createdAt: "2026-04-29T00:00:00.000Z",
            updatedAt: "2026-04-29T00:01:00.000Z"
          },
          supersededClaimCount: 0
        })),
        getAuthorityState: vi.fn(),
        inspectOwnerBinding: vi.fn(),
        listPairClaims: vi.fn(),
        createOrReusePairClaim: vi.fn(),
        matchTrustedConversation: vi.fn(),
        applyConversationLifecycleEvent: vi.fn(),
        ensureTrustedConversation: vi.fn(),
        resetOwnerBinding: vi.fn(),
        listTrustedConversations: vi.fn(),
        revokeTrustedConversation: vi.fn(),
        evaluateClaimExpiry: vi.fn()
      } as unknown as ReturnType<typeof createAccessStore>,
      resolveSessionId: vi.fn(async () => "session_unused"),
      resolveActorId: vi.fn(async () => "actor_unused"),
      enqueueOutboundEvent
    });

    const result = await authority.approvePairClaim({
      source: "telegram",
      accountId: "acct_bot",
      claimId: "missing_claim",
      operatorActorId: "operator_alpha"
    });

    expect(result.outcome).toBe("claim_not_found");
    expect(result.pairingSuccessNoticeStatus).toBe("not_approved");
    expect(enqueueOutboundEvent).not.toHaveBeenCalled();
  });
});
