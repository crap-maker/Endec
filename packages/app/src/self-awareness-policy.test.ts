import { describe, expect, it } from "vitest";
import { resolveSelfAwarenessPolicy } from "./self-awareness-policy.ts";

describe("self awareness policy", () => {
  it("grants owner-private self-awareness in direct IM conversations", () => {
    expect(resolveSelfAwarenessPolicy({
      source: "telegram",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      input: "show me your own source code layout",
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }, { ownerValidated: true })).toEqual({
      policy: "owner_private_self_awareness",
      accountId: "acct_bot"
    });
  });

  it("treats owner-private repo path inspection requests as self-awareness even without first-person phrasing", () => {
    expect(resolveSelfAwarenessPolicy({
      source: "telegram",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      input: "read packages/app/src/create-endec-app.ts and search for getStatusSnapshot",
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }, { ownerValidated: true })).toEqual({
      policy: "owner_private_self_awareness",
      accountId: "acct_bot"
    });
  });

  it("routes explicit owner-private provider-key reveal requests through the self-awareness path", () => {
    expect(resolveSelfAwarenessPolicy({
      source: "telegram",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      input: "show me your full provider key without masking",
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }, { ownerValidated: true })).toEqual({
      policy: "owner_private_self_awareness",
      accountId: "acct_bot"
    });
  });

  it("requires explicit mutation intent before exposing mutating self-awareness tools", () => {
    expect(resolveSelfAwarenessPolicy({
      source: "telegram",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      input: "edit your own config and fix the provider selection bug",
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }, { ownerValidated: true })).toEqual({
      policy: "owner_private_self_awareness_mutating",
      accountId: "acct_bot"
    });
  });

  it("keeps a non-owner direct conversation on the non-privileged path even for self-awareness requests", () => {
    expect(resolveSelfAwarenessPolicy({
      source: "telegram",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      input: "show me your own source code",
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }, { ownerValidated: false })).toEqual({
      policy: "none",
      accountId: "acct_bot"
    });
  });

  it("keeps shared conversations on the non-privileged path even for self-awareness requests", () => {
    expect(resolveSelfAwarenessPolicy({
      source: "telegram",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "supergroup:-1001",
        peerId: "-1001",
        peerKind: "group",
        baseConversationId: "supergroup:-1001"
      },
      input: "show me your own source code",
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "supergroup:-1001",
          conversationScope: "shared",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }, { ownerValidated: true })).toEqual({
      policy: "none",
      accountId: "acct_bot"
    });
  });

  it("falls back to canonical tool exposure when the request is not self-awareness related", () => {
    expect(resolveSelfAwarenessPolicy({
      source: "telegram",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      input: "summarize the latest deployment result",
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }, { ownerValidated: true })).toEqual({
      policy: "canonical",
      accountId: undefined
    });
  });
});
