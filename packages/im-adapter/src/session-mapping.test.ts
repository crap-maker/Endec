import { describe, expect, it } from "vitest";
import { createActorResolutionInput, createSessionResolutionInput, normalizeFakeTransportInbound } from "./index.ts";

describe("conversation/session mapping", () => {
  it("keeps conversationRef as explicit session resolution input instead of minting a canonical sessionId", () => {
    const threadedConversation = normalizeFakeTransportInbound({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      threadId: "thread_777",
      senderId: "user_001",
      messageId: "msg_003",
      text: "threaded hello",
      mentionsBot: true
    });

    const sessionResolutionInput = createSessionResolutionInput(threadedConversation);

    expect(sessionResolutionInput).toEqual({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "chat_001",
        peerKind: "group",
        conversationId: "group:chat_001:thread:thread_777",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: "thread_777"
      }
    });
    expect("sessionId" in sessionResolutionInput).toBe(false);
  });

  it("keeps raw sender identity in actor resolution input instead of leaking it as canonical actorId", () => {
    const senderScopedConversation = normalizeFakeTransportInbound({
      source: "feishu",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      chatType: "group",
      chatId: "chat_001",
      topicId: "topic_009",
      senderScope: "tenant_abc",
      senderId: "open_id_user_001",
      messageId: "msg_004",
      text: "hello",
      mentionsBot: true
    });

    const actorResolutionInput = createActorResolutionInput(senderScopedConversation);

    expect(actorResolutionInput).toEqual({
      source: "feishu",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "open_id_user_001",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "chat_001",
        peerKind: "group",
        conversationId: "group:chat_001:topic:topic_009:sender:tenant_abc",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: undefined,
        topicId: "topic_009",
        senderScope: "tenant_abc"
      }
    });
    expect("actorId" in actorResolutionInput).toBe(false);
  });
});
