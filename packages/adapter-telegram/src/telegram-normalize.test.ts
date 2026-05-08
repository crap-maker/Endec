import { describe, expect, it } from "vitest";
import {
  parseTelegramCallbackQueryUpdate,
  parseTelegramLifecycleUpdate,
  parseTelegramTextUpdate
} from "./parse.ts";
import { normalizeTelegramLifecycleUpdate, normalizeTelegramTextUpdate } from "./normalize.ts";

describe("telegram inbound normalization", () => {
  it("normalizes direct-message text into shared conversationScope and activationHint", () => {
    const parsed = parseTelegramTextUpdate({
      update_id: 101,
      message: {
        message_id: 11,
        date: 1_712_000_000,
        text: "/pair",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(parsed).toMatchObject({
      updateId: 101,
      updateKind: "message",
      message: {
        messageId: 11,
        chatId: 42,
        chatType: "private",
        senderId: 7,
        text: "/pair"
      }
    });

    const normalized = normalizeTelegramTextUpdate(parsed!, {
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      botUsername: "endec"
    });

    expect(normalized).toMatchObject({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "7",
      text: "/pair",
      transportMessageId: "11",
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: false
      },
      conversationRef: {
        accountId: "acct_bot",
        peerId: "42",
        peerKind: "dm",
        conversationId: "private:42",
        baseConversationId: "private:42"
      }
    });
  });

  it("normalizes trusted-group style mentions without creating a group pair code path", () => {
    const parsed = parseTelegramTextUpdate({
      update_id: 102,
      message: {
        message_id: 22,
        date: 1_712_000_111,
        text: "@endec summarize the topic",
        message_thread_id: 77,
        is_topic_message: true,
        chat: {
          id: -100123,
          type: "supergroup",
          is_forum: true,
          title: "release-room"
        },
        from: {
          id: 9,
          is_bot: false,
          username: "bob"
        },
        entities: [
          {
            type: "mention",
            offset: 0,
            length: 6
          }
        ]
      }
    });

    const normalized = normalizeTelegramTextUpdate(parsed!, {
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      botUsername: "endec"
    });

    expect(normalized).toMatchObject({
      senderId: "9",
      conversationScope: "shared",
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: true,
        replyToBot: false
      },
      activationKind: "interactive_turn",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "-100123",
        peerKind: "group",
        conversationId: "supergroup:-100123:topic:77",
        parentConversationId: "supergroup:-100123",
        baseConversationId: "supergroup:-100123",
        threadId: "77",
        topicId: "77"
      },
      channelContext: {
        updateId: "102",
        updateKind: "message",
        messageId: "22",
        chatId: "-100123",
        chatType: "supergroup",
        chatTitle: "release-room",
        messageThreadId: "77",
        isTopicMessage: true
      }
    });
  });

  it("treats recognized slash commands in shared chats as activating command executions", () => {
    const sharedSlash = normalizeTelegramTextUpdate(parseTelegramTextUpdate({
      update_id: 104,
      message: {
        message_id: 24,
        date: 1_712_000_113,
        text: "/status",
        chat: {
          id: -100321,
          type: "supergroup"
        },
        from: {
          id: 11,
          is_bot: false,
          username: "eve"
        }
      }
    })!, {
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      botUsername: "endec"
    });

    expect(sharedSlash).toMatchObject({
      activationHint: {
        pairRequested: false,
        explicitActivation: true,
        mentionMatched: false,
        replyToBot: false
      },
      activationKind: "command_execution",
      commandIntent: {
        name: "status",
        args: [],
        options: {},
        rawText: "/status",
        helpRequested: false
      }
    });
  });

  it("accepts reply-to-bot activation even without an @mention", () => {
    const normalized = normalizeTelegramTextUpdate(parseTelegramTextUpdate({
      update_id: 503,
      message: {
        message_id: 53,
        date: 1_714_000_003,
        text: "can you summarize that?",
        chat: { id: -100123, type: "supergroup" },
        from: { id: 9, is_bot: false, username: "alice" },
        reply_to_message: {
          message_id: 44,
          from: { id: 999, is_bot: true, username: "endec" }
        }
      }
    })!, {
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      botUsername: "endec",
      botUserId: 999
    });

    expect(normalized.activationHint.explicitActivation).toBe(true);
    expect(normalized.activationHint.replyToBot).toBe(true);
    expect(normalized.activationKind).toBe("interactive_turn");
  });

  it("preserves Telegram entity offsets when text starts with whitespace", () => {
    const normalized = normalizeTelegramTextUpdate(parseTelegramTextUpdate({
      update_id: 504,
      message: {
        message_id: 54,
        date: 1_714_000_004,
        text: "   @endec summarize that",
        chat: { id: -100124, type: "supergroup" },
        from: { id: 10, is_bot: false, username: "eve" },
        entities: [{ type: "mention", offset: 3, length: 6 }]
      }
    })!, {
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      botUsername: "endec"
    });

    expect(normalized.text.startsWith("   @endec")).toBe(true);
    expect(normalized.activationHint.mentionMatched).toBe(true);
    expect(normalized.activationHint.explicitActivation).toBe(true);
  });

  it("parses and normalizes membership lifecycle updates", () => {
    const botAdded = parseTelegramLifecycleUpdate({
      update_id: 201,
      my_chat_member: {
        date: 1_712_000_222,
        chat: {
          id: -100555,
          type: "supergroup"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        },
        old_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "left"
        },
        new_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "member"
        }
      }
    });

    expect(botAdded).toMatchObject({
      updateKind: "my_chat_member",
      eventKind: "bot_added",
      membership: {
        chatId: -100555,
        chatType: "supergroup",
        actorId: 7,
        subjectId: 999,
        oldStatus: "left",
        newStatus: "member"
      }
    });

    const normalized = normalizeTelegramLifecycleUpdate(botAdded!, {
      accountId: "acct_bot",
      workspaceId: "workspace_local"
    });

    expect(normalized).toMatchObject({
      source: "telegram",
      accountId: "acct_bot",
      eventKind: "bot_added",
      conversationScope: "shared",
      subjectRef: "999",
      actorId: "actor_im_744a2f09c35c59fbc3d16d3b",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "-100555",
        peerKind: "group",
        conversationId: "supergroup:-100555",
        baseConversationId: "supergroup:-100555"
      },
      metadata: {
        workspaceId: "workspace_local",
        updateKind: "my_chat_member",
        actorId: "7",
        actorUsername: "owner",
        subjectId: "999"
      }
    });

    const ownerLeft = parseTelegramLifecycleUpdate({
      update_id: 202,
      chat_member: {
        date: 1_712_000_333,
        chat: {
          id: -100555,
          type: "supergroup"
        },
        from: {
          id: 17,
          is_bot: false,
          username: "admin"
        },
        old_chat_member: {
          user: { id: 7, is_bot: false, username: "owner" },
          status: "member"
        },
        new_chat_member: {
          user: { id: 7, is_bot: false, username: "owner" },
          status: "left"
        }
      }
    });

    expect(normalizeTelegramLifecycleUpdate(ownerLeft!, {
      accountId: "acct_bot",
      workspaceId: "workspace_local"
    })).toMatchObject({
      eventKind: "owner_left",
      subjectRef: "7",
      conversationScope: "shared"
    });
  });

  it("parses callback_query updates with message context instead of ignoring them", () => {
    expect(parseTelegramCallbackQueryUpdate).toBeTypeOf("function");
    expect(
      parseTelegramCallbackQueryUpdate({
        update_id: 301,
        callback_query: {
          id: "cbq_1",
          from: {
            id: 12,
            is_bot: false,
            username: "alice"
          },
          data: "model:openai:gpt5.4",
          message: {
            message_id: 44,
            date: 1_712_000_222,
            message_thread_id: 88,
            is_topic_message: true,
            chat: {
              id: -100500,
              type: "supergroup",
              title: "operators",
              is_forum: true
            },
            from: {
              id: 999,
              is_bot: true,
              username: "endec"
            }
          }
        }
      })
    ).toMatchObject({
      updateId: 301,
      callbackQuery: {
        id: "cbq_1",
        data: "model:openai:gpt5.4",
        actorId: 12,
        actorUsername: "alice",
        messageId: 44,
        chatId: -100500,
        chatType: "supergroup",
        chatTitle: "operators",
        chatIsForum: true,
        messageThreadId: 88,
        isTopicMessage: true
      }
    });
  });

  it("ignores unsupported or non-text updates", () => {
    expect(
      parseTelegramTextUpdate({
        update_id: 302,
        message: {
          message_id: 44,
          date: 1_712_000_222,
          chat: {
            id: -100500,
            type: "group"
          },
          from: {
            id: 12,
            is_bot: false
          },
          sticker: {
            file_id: "sticker_1"
          }
        }
      })
    ).toBeNull();

    expect(
      parseTelegramLifecycleUpdate({
        update_id: 303,
        message: {
          message_id: 55,
          date: 1,
          text: "hello",
          chat: {
            id: 1,
            type: "private"
          },
          from: {
            id: 2,
            is_bot: false
          }
        }
      })
    ).toBeNull();
  });
});
