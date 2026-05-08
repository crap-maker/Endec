import type { TurnRequest } from "@endec/domain";
import type { ImSource, NormalizedInboundMessage } from "./types.ts";

export interface FakeTransportInboundEvent {
  source: ImSource;
  workspaceId: string;
  accountId: string;
  chatType: "dm" | "group";
  chatId: string;
  senderId: string;
  messageId: string;
  text: string;
  mentionsBot?: boolean;
  threadId?: string;
  topicId?: string;
  senderScope?: string;
  replyToMessageId?: string;
  attachments?: unknown[];
  requestedMode?: TurnRequest["requestedMode"];
  requestedCapabilities?: TurnRequest["requestedCapabilities"];
  taskId?: string;
  resumeFrom?: string;
}

export function normalizeFakeTransportInbound(input: FakeTransportInboundEvent): NormalizedInboundMessage {
  const baseConversationId = `${input.chatType}:${input.chatId}`;
  let conversationId = baseConversationId;
  let parentConversationId: string | undefined;

  if (input.threadId) {
    conversationId = `${conversationId}:thread:${input.threadId}`;
    parentConversationId = baseConversationId;
  }

  if (input.topicId) {
    conversationId = `${conversationId}:topic:${input.topicId}`;
    parentConversationId ??= baseConversationId;
  }

  if (input.senderScope) {
    parentConversationId ??= conversationId;
    conversationId = `${conversationId}:sender:${input.senderScope}`;
  }

  return {
    source: input.source,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    senderId: input.senderId,
    text: input.text,
    attachments: input.attachments ?? [],
    transportMessageId: input.messageId,
    conversationRef: {
      accountId: input.accountId,
      conversationId,
      peerId: input.chatId,
      peerKind: input.chatType === "dm" ? "dm" : "group",
      parentConversationId,
      baseConversationId,
      threadId: input.threadId,
      topicId: input.topicId,
      senderScope: input.senderScope
    },
    conversationScope: input.chatType === "dm" ? "direct" : "shared",
    channelContext: {
      messageId: input.messageId,
      chatType: input.chatType,
      replyToMessageId: input.replyToMessageId ?? input.messageId
    },
    activationHint: {
      pairRequested: /^\s*\/pair\b/i.test(input.text),
      explicitActivation: input.chatType === "dm" ? true : input.mentionsBot ?? false,
      mentionMatched: input.chatType === "dm" ? true : input.mentionsBot ?? false,
      replyToBot: false
    },
    requestedMode: input.requestedMode,
    requestedCapabilities: input.requestedCapabilities,
    taskId: input.taskId,
    resumeFrom: input.resumeFrom
  };
}
