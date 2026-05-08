import { describe, expect, it } from "vitest";
import {
  AdmissionDecisionOutcomeSchema,
  ApprovePairClaimResultSchema,
  AuthorityControlPayloadSchema,
  InspectOwnerBindingResultSchema,
  OwnerInitStateSchema,
  OwnerPreferencesSchema,
  PairClaimSchema,
  ResolvedOwnerPreferencesSchema,
  TrustedConversationBindingSchema,
  deriveConversationScopeFromPeerKind,
  deriveTrustedConversationKey,
  isPairClaimCurrentGeneration,
  isTrustedConversationCurrentGeneration
} from "./authority.ts";
import { CurrentTurnTimeContextSchema } from "./runtime.ts";

describe("authority contracts", () => {
  it("maps peer kinds into canonical conversation scopes", () => {
    expect(deriveConversationScopeFromPeerKind("dm")).toBe("direct");
    expect(deriveConversationScopeFromPeerKind("group")).toBe("shared");
    expect(deriveConversationScopeFromPeerKind("channel")).toBe("broadcast");
    expect(deriveConversationScopeFromPeerKind("unknown")).toBe("unknown");
  });

  it("derives descendant trust keys from base conversation identity", () => {
    expect(deriveTrustedConversationKey({
      conversationId: "group:chat_100:topic:77",
      baseConversationId: "group:chat_100"
    }, "descendants")).toBe("group:chat_100");

    expect(deriveTrustedConversationKey({
      conversationId: "group:chat_100"
    }, "descendants")).toBe("group:chat_100");

    expect(deriveTrustedConversationKey({
      conversationId: "dm:chat_200"
    }, "exact")).toBe("dm:chat_200");
  });

  it("freezes canonical admission outcomes", () => {
    expect(AdmissionDecisionOutcomeSchema.options).toEqual([
      "dispatch_turn",
      "reply_direct",
      "reject_direct",
      "drop",
      "passive_ingest"
    ]);
  });

  it("treats generation as the stale-boundary for claims and trusted conversations", () => {
    const claim = PairClaimSchema.parse({
      claimId: "claim_001",
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerGeneration: 0,
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      },
      pairCode: "ABCD1234",
      status: "pending",
      expiresAt: "2026-04-29T00:10:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z"
    });

    const trust = TrustedConversationBindingSchema.parse({
      trustId: "trust_001",
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerGeneration: 0,
      conversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "group:chat_100",
        peerId: "chat_100",
        peerKind: "group",
        baseConversationId: "group:chat_100"
      },
      conversationKey: "group:chat_100",
      coverage: "descendants",
      grantKind: "owner_auto",
      grantedByOwnerBindingId: "binding_001",
      status: "active",
      grantedAt: "2026-04-29T00:00:00.000Z"
    });

    expect(isPairClaimCurrentGeneration(claim, 0)).toBe(true);
    expect(isPairClaimCurrentGeneration(claim, 1)).toBe(false);
    expect(isTrustedConversationCurrentGeneration(trust, 0)).toBe(true);
    expect(isTrustedConversationCurrentGeneration(trust, 1)).toBe(false);
  });

  it("extends owner inspection contracts with stored/resolved preferences and init state", () => {
    const result = InspectOwnerBindingResultSchema.parse({
      state: {
        source: "telegram",
        accountId: "telegram:bot:endec",
        ownerGeneration: 0,
        ownerBindingId: "binding_001",
        status: "bound",
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:01:00.000Z"
      },
      ownerBinding: {
        ownerBindingId: "binding_001",
        source: "telegram",
        accountId: "telegram:bot:endec",
        ownerGeneration: 0,
        ownerSubjectRef: "telegram-user:42",
        ownerActorId: "actor_42",
        pairedConversationRef: {
          accountId: "telegram:bot:endec",
          conversationId: "dm:chat_42",
          peerId: "chat_42",
          peerKind: "dm"
        },
        consumedClaimId: "claim_001",
        status: "active",
        boundAt: "2026-04-29T00:01:00.000Z",
        approvedByOperatorId: "operator_alpha"
      },
      ownerPreferences: {
        source: "telegram",
        accountId: "telegram:bot:endec",
        ownerGeneration: 0,
        ownerBindingId: "binding_001",
        ownerActorId: "actor_42",
        timezone: "Asia/Shanghai",
        createdAt: "2026-04-29T00:02:00.000Z",
        updatedAt: "2026-04-29T00:02:00.000Z"
      },
      resolvedOwnerPreferences: {
        assistantDisplayName: "Endec",
        timezone: "Asia/Shanghai",
        timezoneSource: "owner_preference"
      },
      ownerInitState: {
        source: "telegram",
        accountId: "telegram:bot:endec",
        ownerGeneration: 0,
        ownerBindingId: "binding_001",
        status: "prompted",
        promptVersion: 1,
        promptSentAt: "2026-04-29T00:03:00.000Z",
        updatedAt: "2026-04-29T00:03:00.000Z"
      }
    });

    expect(OwnerPreferencesSchema.parse(result.ownerPreferences)).toMatchObject({
      timezone: "Asia/Shanghai",
      ownerActorId: "actor_42"
    });
    expect(ResolvedOwnerPreferencesSchema.parse(result.resolvedOwnerPreferences)).toMatchObject({
      assistantDisplayName: "Endec",
      timezoneSource: "owner_preference"
    });
    expect(OwnerInitStateSchema.parse(result.ownerInitState)).toMatchObject({
      status: "prompted",
      promptVersion: 1
    });
  });

  it("rejects invalid owner-init lifecycle combinations", () => {
    expect(() => OwnerInitStateSchema.parse({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerGeneration: 0,
      ownerBindingId: "binding_001",
      status: "pending_prompt",
      promptVersion: 1,
      completionReason: "fields_captured",
      updatedAt: "2026-04-29T00:03:00.000Z"
    })).toThrow();

    expect(() => OwnerInitStateSchema.parse({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerGeneration: 0,
      ownerBindingId: "binding_001",
      status: "prompted",
      promptVersion: 1,
      updatedAt: "2026-04-29T00:03:00.000Z"
    })).toThrow();

    expect(() => OwnerInitStateSchema.parse({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerGeneration: 0,
      ownerBindingId: "binding_001",
      status: "completed",
      promptVersion: 1,
      updatedAt: "2026-04-29T00:04:00.000Z"
    })).toThrow();

    expect(OwnerInitStateSchema.parse({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerGeneration: 0,
      ownerBindingId: "binding_001",
      status: "completed",
      promptVersion: 1,
      promptSentAt: "2026-04-29T00:03:00.000Z",
      completionReason: "fields_captured",
      completedAt: "2026-04-29T00:04:00.000Z",
      updatedAt: "2026-04-29T00:04:00.000Z"
    })).toMatchObject({
      status: "completed",
      completionReason: "fields_captured"
    });
  });

  it("parses the current-turn time context with frozen fields", () => {
    const timeContext = CurrentTurnTimeContextSchema.parse({
      timezone: "Asia/Shanghai",
      timezoneSource: "server_default",
      nowUtc: "2026-04-29T01:14:00.000Z",
      localNow: "2026-04-29T09:14:00+08:00",
      localDate: "2026-04-29",
      localTime: "09:14",
      weekday: "Tue",
      dayPart: "morning",
      previousInteractionAtUtc: "2026-04-28T23:14:00.000Z",
      previousInteractionLocal: "2026-04-29T07:14:00+08:00",
      elapsedSincePreviousInteractionMinutes: 120,
      calendarDayDelta: 0,
      gapKind: "same_day",
      summary: "Local time is Tue 2026-04-29 09:14 (Asia/Shanghai), morning. The last observed interaction was earlier today, 120 minutes ago."
    });

    expect(timeContext.gapKind).toBe("same_day");
    expect(timeContext.timezoneSource).toBe("server_default");
  });

  it("rejects malformed deterministic time-context fields", () => {
    const base = {
      timezone: "Asia/Shanghai",
      timezoneSource: "server_default" as const,
      nowUtc: "2026-04-29T01:14:00.000Z",
      localNow: "2026-04-29T09:14:00+08:00",
      localDate: "2026-04-29",
      localTime: "09:14",
      weekday: "Tue" as const,
      dayPart: "morning" as const,
      gapKind: "first_turn" as const,
      summary: "Local time is Tue 2026-04-29 09:14 (Asia/Shanghai), morning. This is the first observed interaction in this session."
    };

    expect(() => CurrentTurnTimeContextSchema.parse({
      ...base,
      nowUtc: "2026-04-29T01:14:00Z"
    })).toThrow();
    expect(() => CurrentTurnTimeContextSchema.parse({
      ...base,
      localNow: "2026-04-29 09:14:00+08:00"
    })).toThrow();
    expect(() => CurrentTurnTimeContextSchema.parse({
      ...base,
      localDate: "2026/04/29"
    })).toThrow();
    expect(() => CurrentTurnTimeContextSchema.parse({
      ...base,
      localTime: "9:14"
    })).toThrow();
  });

  it("freezes approve results with explicit pairing-success notice status", () => {
    const result = ApprovePairClaimResultSchema.parse({
      outcome: "approved",
      state: {
        source: "telegram",
        accountId: "telegram:bot:endec",
        ownerGeneration: 0,
        ownerBindingId: "binding_001",
        status: "bound",
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:01:00.000Z"
      },
      ownerBinding: {
        ownerBindingId: "binding_001",
        source: "telegram",
        accountId: "telegram:bot:endec",
        ownerGeneration: 0,
        ownerSubjectRef: "telegram-user:42",
        ownerActorId: "actor_42",
        pairedConversationRef: {
          accountId: "telegram:bot:endec",
          conversationId: "dm:chat_42",
          peerId: "chat_42",
          peerKind: "dm"
        },
        consumedClaimId: "claim_001",
        status: "active",
        boundAt: "2026-04-29T00:01:00.000Z",
        approvedByOperatorId: "operator_alpha"
      },
      consumedClaim: {
        claimId: "claim_001",
        source: "telegram",
        accountId: "telegram:bot:endec",
        ownerGeneration: 0,
        requesterSubjectRef: "telegram-user:42",
        requesterActorId: "actor_42",
        requestConversationRef: {
          accountId: "telegram:bot:endec",
          conversationId: "dm:chat_42",
          peerId: "chat_42",
          peerKind: "dm"
        },
        pairCode: "ABCD1234",
        status: "consumed",
        expiresAt: "2026-04-29T00:10:00.000Z",
        createdAt: "2026-04-29T00:00:00.000Z",
        consumedAt: "2026-04-29T00:01:00.000Z",
        approvedByOperatorId: "operator_alpha"
      },
      supersededClaimCount: 0,
      pairingSuccessNoticeStatus: "skipped_missing_request_routing"
    });

    expect(result.pairingSuccessNoticeStatus).toBe("skipped_missing_request_routing");
  });

  it("freezes the authority control payload shape for pairing and trust notices", () => {
    const payload = AuthorityControlPayloadSchema.parse({
      schemaVersion: 1,
      contractVersion: "im.authority-control.v1",
      noticeKind: "pairing_success",
      message: "Pairing complete.",
      ownerBindingId: "binding_001",
      ownerGeneration: 0,
      conversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      }
    });
    const trustPayload = AuthorityControlPayloadSchema.parse({
      schemaVersion: 1,
      contractVersion: "im.authority-control.v1",
      noticeKind: "trusted_conversation_granted",
      message: "Trusted conversation granted.",
      ownerBindingId: "binding_001",
      ownerGeneration: 0,
      conversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      }
    });

    expect(payload.contractVersion).toBe("im.authority-control.v1");
    expect(payload.noticeKind).toBe("pairing_success");
    expect(trustPayload.noticeKind).toBe("trusted_conversation_granted");
    expect(payload.ownerGeneration).toBe(0);
  });
});
