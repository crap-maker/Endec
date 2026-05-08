import { describe, expect, it, vi } from "vitest";
import { createSessionStore } from "@endec/sessions";
import { createEndecImHost } from "./im-host.ts";

describe("createEndecImHost", () => {
  it("resolves canonical session ids through a sanctioned open-or-create seam", async () => {
    const loadById = vi.fn(async () => ({
      sessionId: "session_existing_001",
      workspaceId: "workspace_local",
      status: "active" as const,
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
      createdFrom: "telegram" as const,
      lastSource: "telegram" as const,
      mode: "chat" as const,
      currentGoal: "",
      workingSetRef: "working_set:initial",
      workingSetVersion: 0,
      activeTaskIds: [],
      recentTurnRefs: [],
      lastEventSeq: 0,
      lastTurnAt: "2026-04-29T00:00:00.000Z"
    }));
    const openOrCreateSession = vi.fn(async ({ sessionId }: { sessionId?: string }) => sessionId ?? "session_created_001");
    const host = createEndecImHost({
      sessionStore: {
        loadById,
        openOrCreateSession,
        commitTurn: vi.fn()
      },
      authority: {
        evaluateInboundAdmission: vi.fn(),
        applyConversationLifecycleEvent: vi.fn(),
        evaluateOutboundConversationLegality: vi.fn()
      }
    });

    const resolvedSessionId = await host.resolveSessionId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_001:thread:thread_777",
        peerId: "chat_001",
        peerKind: "group",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: "thread_777"
      }
    });

    const reboundSessionId = await host.resolveSessionId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_001:thread:thread_777",
        peerId: "chat_001",
        peerKind: "group",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: "thread_777"
      },
      binding: {
        sessionId: resolvedSessionId
      }
    });

    expect(resolvedSessionId).toBe("session_created_001");
    expect(reboundSessionId).toBe("session_created_001");
    expect(loadById).toHaveBeenCalledWith("session_created_001");
    expect(openOrCreateSession).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace_local",
      source: "telegram"
    });
    expect(openOrCreateSession).toHaveBeenNthCalledWith(2, {
      sessionId: "session_created_001",
      workspaceId: "workspace_local",
      source: "telegram"
    });
  });

  it("resolves canonical actor ids and forwards authority seam calls", async () => {
    const evaluateInboundAdmission = vi.fn(async () => ({
      outcome: "reply_direct" as const,
      expectsUserVisibleReply: true,
      directReply: { text: "Pair code: ABCD1234" }
    }));
    const applyConversationLifecycleEvent = vi.fn(async () => undefined);
    const evaluateOutboundConversationLegality = vi.fn(async () => ({
      status: "allowed" as const,
      reason: "trusted_conversation" as const,
      ownerGeneration: 0,
      ownerBindingId: "owner_001",
      trustId: "trust_001"
    }));
    const host = createEndecImHost({
      sessionStore: {
        loadById: vi.fn(),
        openOrCreateSession: vi.fn(async () => "session_unused"),
        commitTurn: vi.fn()
      },
      authority: {
        evaluateInboundAdmission,
        applyConversationLifecycleEvent,
        evaluateOutboundConversationLegality
      }
    });

    const actorId = await host.resolveActorId({
      source: "feishu",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "open_id_user_001",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_001:topic:topic_009:sender:tenant_abc",
        peerId: "chat_001",
        peerKind: "group",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        topicId: "topic_009",
        senderScope: "tenant_abc"
      }
    });
    const reboundActorId = await host.resolveActorId({
      source: "feishu",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "open_id_user_001",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_001:topic:topic_009:sender:tenant_abc",
        peerId: "chat_001",
        peerKind: "group",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        topicId: "topic_009",
        senderScope: "tenant_abc"
      },
      binding: {
        actorId
      }
    });
    const otherActorId = await host.resolveActorId({
      source: "feishu",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "open_id_user_002",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_001:topic:topic_009:sender:tenant_abc",
        peerId: "chat_001",
        peerKind: "group",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        topicId: "topic_009",
        senderScope: "tenant_abc"
      }
    });

    const admission = await host.evaluateInboundAdmission({
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
    await host.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_100",
        peerId: "chat_100",
        peerKind: "group"
      },
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "owner_user"
    });
    const legality = await host.evaluateOutboundConversationLegality({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_100",
        peerId: "chat_100",
        peerKind: "group"
      }
    });

    expect(actorId).toMatch(/^actor_im_/);
    expect(actorId).not.toBe("open_id_user_001");
    expect(reboundActorId).toBe(actorId);
    expect(otherActorId).not.toBe(actorId);
    expect(admission).toMatchObject({ outcome: "reply_direct" });
    expect(evaluateInboundAdmission).toHaveBeenCalledTimes(1);
    expect(applyConversationLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(legality).toMatchObject({ status: "allowed", reason: "trusted_conversation" });
    expect(evaluateOutboundConversationLegality).toHaveBeenCalledTimes(1);
  });

  it("consumes prompted owner-init replies before model dispatch and returns a confirmation", async () => {
    const sessionStore = createSessionStore({ filename: ":memory:" });
    const commitTurn = vi.fn(sessionStore.commitTurn);
    const upsertOwnerPreferences = vi.fn(async () => undefined);
    const upsertOwnerInitState = vi.fn(async () => undefined);
    const host = createEndecImHost({
      sessionStore: {
        loadById: sessionStore.loadById,
        openOrCreateSession: sessionStore.openOrCreateSession,
        commitTurn
      },
      authority: {
        evaluateInboundAdmission: vi.fn(),
        applyConversationLifecycleEvent: vi.fn(),
        evaluateOutboundConversationLegality: vi.fn()
      },
      ownerInit: {
        inspectOwnerBinding: vi.fn(async () => ({
          ownerBinding: {
            ownerBindingId: "owner_binding_001",
            ownerActorId: "actor_owner_001"
          },
          ownerInitState: {
            status: "prompted" as const,
            promptSentAt: "2026-04-29T00:00:00.000Z",
            updatedAt: "2026-04-29T00:00:00.000Z"
          }
        })),
        upsertOwnerPreferences,
        upsertOwnerInitState,
        resolveServerTimezone: () => "Asia/Shanghai"
      }
    });

    const sessionId = await sessionStore.openOrCreateSession({
      sessionId: "session_owner_init_001",
      workspaceId: "workspace_local",
      source: "telegram"
    });

    const decision = await host.preflightOwnerInit?.({
      turnRequest: {
        turnId: "turn_owner_init_001",
        sessionId,
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: "actor_owner_001",
        input: "Call me Alice and timezone is Beijing time.",
        attachments: [],
        requestedMode: "chat",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "dm:chat_42",
          peerId: "chat_42",
          peerKind: "dm"
        },
        channelContext: {
          messageId: "msg_owner_init_001"
        }
      },
      conversationScope: "direct"
    });

    expect(decision).toMatchObject({
      outcome: "consumed",
      completionReason: "fields_captured",
      replyText: expect.stringContaining("Alice")
    });
    expect(upsertOwnerPreferences).toHaveBeenCalledWith(expect.objectContaining({
      ownerDisplayName: "Alice",
      timezone: "Asia/Shanghai"
    }));
    expect(upsertOwnerInitState).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      completionReason: "fields_captured"
    }));
    expect(commitTurn).toHaveBeenCalledTimes(1);
    const committed = commitTurn.mock.calls[0]?.[0];
    expect(committed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKind: "user_message", summary: expect.stringContaining("Call me Alice") }),
      expect.objectContaining({ eventKind: "assistant_message", summary: expect.stringContaining("Saved") })
    ]));
  });

  it("records passive ingress into session history and updates command activity", async () => {
    const sessionStore = createSessionStore({ filename: ":memory:" });
    const commitTurn = vi.fn(sessionStore.commitTurn);
    const recordConversationActivity = vi.fn(async (input: { sessionId: string; conversationLabel?: string }) => ({
      source: "telegram" as const,
      accountId: "acct_bot",
      conversationKey: "supergroup:-100123:topic:77",
      baseConversationKey: "supergroup:-100123",
      conversationLabel: input.conversationLabel,
      latestSessionId: input.sessionId,
      observedAt: "2026-05-01T09:00:00.000Z"
    }));
    const execute = vi.fn(async () => ({
      kind: "reply_text" as const,
      replyText: "conversation: supergroup:-100123"
    }));
    const host = createEndecImHost({
      sessionStore: {
        loadById: sessionStore.loadById,
        openOrCreateSession: sessionStore.openOrCreateSession,
        commitTurn
      },
      authority: {
        evaluateInboundAdmission: vi.fn(),
        applyConversationLifecycleEvent: vi.fn(),
        evaluateOutboundConversationLegality: vi.fn()
      },
      commandService: {
        execute
      },
      conversationDirectory: {
        recordConversationActivity
      }
    });

    const sessionId = await sessionStore.openOrCreateSession({
      sessionId: "session_shared_001",
      workspaceId: "workspace_local",
      source: "telegram"
    });

    const passiveTurn = {
      turnId: "turn_passive_001",
      sessionId,
      workspaceId: "workspace_local",
      source: "telegram" as const,
      actorId: "actor_member_001",
      input: "release slipped by one day",
      attachments: [],
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "supergroup:-100123:topic:77",
        peerId: "-100123",
        peerKind: "group" as const,
        parentConversationId: "supergroup:-100123",
        baseConversationId: "supergroup:-100123",
        threadId: "77",
        topicId: "77"
      },
      channelContext: {
        messageId: "msg_051",
        messageDate: 1_714_000_001,
        chatTitle: "release-room"
      },
      imContext: {
        activationKind: "passive_ingest" as const,
        boundary: {
          boundaryKey: "supergroup:-100123:topic:77",
          conversationScope: "shared" as const,
          disclosureMode: "local_only" as const,
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    };

    await host.recordPassiveIngress({
      turnRequest: passiveTurn
    });
    await host.executeCommand({
      turnRequest: {
        ...passiveTurn,
        turnId: "turn_command_001",
        input: "/status",
        imContext: {
          ...passiveTurn.imContext,
          activationKind: "command_execution",
          commandIntent: {
            name: "status",
            args: [],
            options: {},
            rawText: "/status",
            helpRequested: false
          }
        }
      },
      commandIntent: {
        name: "status",
        args: [],
        options: {},
        rawText: "/status",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(commitTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn_passive_001",
      sessionId,
      events: [
        expect.objectContaining({
          eventKind: "user_message",
          text: "release slipped by one day",
          sourceRefs: ["turn_passive_001", "msg_051"]
        })
      ]
    }));
    expect(recordConversationActivity).toHaveBeenCalledTimes(2);
    expect(recordConversationActivity).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId,
      conversationLabel: "release-room"
    }));
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
