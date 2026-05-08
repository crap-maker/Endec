import { createAccessStore } from "@endec/access";
import { describe, expect, it } from "vitest";
import { createPersonaResolver } from "./persona-resolver.ts";

describe("persona resolver", () => {
  it("resolves owner-direct, shared-default, and conversation-override personas in the correct order", async () => {
    const accessStore = createAccessStore({ filename: ":memory:" });
    const resolver = createPersonaResolver({ accessStore });

    await accessStore.upsertPersonaProfile({
      source: "telegram",
      accountId: "acct_bot",
      ownerBindingId: "owner_001",
      ownerGeneration: 1,
      scopeKind: "owner_direct",
      styleInstructions: "private, direct tone",
      behaviorInstructions: "answer the owner first",
      updatedByActorId: "actor_owner",
      now: "2026-05-01T09:00:00.000Z"
    });
    await accessStore.upsertPersonaProfile({
      source: "telegram",
      accountId: "acct_bot",
      ownerBindingId: "owner_001",
      ownerGeneration: 1,
      scopeKind: "shared_default",
      styleInstructions: "friendly but terse",
      behaviorInstructions: "prefer bullets",
      updatedByActorId: "actor_owner",
      now: "2026-05-01T09:01:00.000Z"
    });
    await accessStore.upsertPersonaProfile({
      source: "telegram",
      accountId: "acct_bot",
      ownerBindingId: "owner_001",
      ownerGeneration: 1,
      scopeKind: "conversation_override",
      conversationKey: "supergroup:-100123",
      styleInstructions: "release-room urgency",
      behaviorInstructions: "lead with blockers",
      updatedByActorId: "actor_owner",
      now: "2026-05-01T09:02:00.000Z"
    });

    const baseInput = {
      source: "telegram" as const,
      accountId: "acct_bot",
      ownerBindingId: "owner_001",
      ownerGeneration: 1,
      conversationScope: "shared" as const
    };

    await expect(resolver.resolvePersona({
      ...baseInput,
      conversationScope: "direct",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      }
    })).resolves.toMatchObject({
      scopeKind: "owner_direct",
      styleInstructions: "private, direct tone",
      behaviorInstructions: "answer the owner first",
      sourceRefs: ["persona:owner_direct"]
    });

    await expect(resolver.resolvePersona({
      ...baseInput,
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "supergroup:-100123",
        peerId: "-100123",
        peerKind: "group",
        baseConversationId: "supergroup:-100123"
      }
    })).resolves.toMatchObject({
      scopeKind: "shared_default",
      styleInstructions: "friendly but terse",
      behaviorInstructions: "prefer bullets",
      sourceRefs: ["persona:shared_default"]
    });

    await expect(resolver.resolvePersona({
      ...baseInput,
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "supergroup:-100123:topic:77",
        peerId: "-100123",
        peerKind: "group",
        parentConversationId: "supergroup:-100123",
        baseConversationId: "supergroup:-100123",
        topicId: "77"
      }
    })).resolves.toMatchObject({
      scopeKind: "conversation_override",
      styleInstructions: "friendly but terse\nrelease-room urgency",
      behaviorInstructions: "prefer bullets\nlead with blockers",
      sourceRefs: ["persona:shared_default", "persona:conversation:supergroup:-100123"]
    });
  });
});
