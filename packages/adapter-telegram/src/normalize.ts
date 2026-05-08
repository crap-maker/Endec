import type { NormalizedInboundMessage } from "@endec/im-adapter";
import { deriveConversationScopeFromPeerKind, type ConversationLifecycleEvent, type ConversationRef } from "@endec/domain";
import { createHash } from "node:crypto";
import { looksLikeTelegramSlashCommand, parseTelegramCommandIntent } from "./command-intent.ts";
import { detectTelegramBotMention } from "./parse.ts";
import type {
  TelegramBotIdentity,
  TelegramChat,
  TelegramParsedLifecycleUpdate,
  TelegramParsedTextUpdate
} from "./telegram-types.ts";

type TelegramParsedModelSelectionCallbackUpdate = {
  updateId: number;
  callbackQueryId: string;
  commandText: string;
  message: {
    messageId: number;
    date?: number;
    chatId: number;
    chatType: TelegramChat["type"];
    chatTitle?: string;
    chatIsForum: boolean;
    senderId: number;
    senderUsername?: string;
    messageThreadId?: number;
    isTopicMessage: boolean;
  };
  raw: unknown;
};

const CALLBACK_COMMAND_PREFIX = "/models select ";

function isTelegramChatType(value: unknown): value is TelegramChat["type"] {
  return value === "private" || value === "group" || value === "supergroup" || value === "channel";
}

function createAuthorityActorId(input: {
  accountId: string;
  senderId: string;
}) {
  return `actor_im_${createHash("sha256")
    .update(["telegram", input.accountId, input.senderId].join("\u001f"))
    .digest("hex")
    .slice(0, 24)}`;
}

function buildConversationRef(input: {
  accountId: string;
  parsed:
    | Pick<TelegramParsedTextUpdate, "message">
    | Pick<TelegramParsedLifecycleUpdate, "membership">
    | Pick<TelegramParsedModelSelectionCallbackUpdate, "message">;
}): ConversationRef {
  const chatType = "message" in input.parsed ? input.parsed.message.chatType : input.parsed.membership.chatType;
  const chatId = "message" in input.parsed ? input.parsed.message.chatId : input.parsed.membership.chatId;
  const baseConversationId = `${chatType}:${chatId}`;
  const peerKind = chatType === "private"
    ? "dm"
    : chatType === "channel"
      ? "channel"
      : "group";

  if (!("message" in input.parsed)) {
    return {
      accountId: input.accountId,
      conversationId: baseConversationId,
      peerId: String(chatId),
      peerKind,
      baseConversationId
    };
  }

  const threadId = input.parsed.message.messageThreadId != null
    ? String(input.parsed.message.messageThreadId)
    : undefined;
  const topicId = threadId && (input.parsed.message.isTopicMessage || input.parsed.message.chatIsForum)
    ? threadId
    : undefined;
  const conversationId = topicId
    ? `${baseConversationId}:topic:${topicId}`
    : threadId
      ? `${baseConversationId}:thread:${threadId}`
      : baseConversationId;

  return {
    accountId: input.accountId,
    conversationId,
    peerId: String(chatId),
    peerKind,
    parentConversationId: threadId ? baseConversationId : undefined,
    baseConversationId,
    threadId,
    topicId
  };
}

function detectPairRequest(text: string) {
  return /^\/pair(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function parseTelegramModelSelectionCallbackUpdate(input: unknown): TelegramParsedModelSelectionCallbackUpdate | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const update = input as {
    update_id?: unknown;
    callback_query?: {
      id?: unknown;
      data?: unknown;
      from?: { id?: unknown; username?: unknown };
      message?: {
        message_id?: unknown;
        date?: unknown;
        message_thread_id?: unknown;
        is_topic_message?: unknown;
        chat?: {
          id?: unknown;
          type?: unknown;
          title?: unknown;
          is_forum?: unknown;
        };
      };
    };
  };

  if (typeof update.update_id !== "number") {
    return null;
  }

  const callbackQuery = update.callback_query;
  if (!callbackQuery) {
    return null;
  }

  const commandText = typeof callbackQuery.data === "string"
    ? callbackQuery.data.trim()
    : undefined;
  if (!commandText?.startsWith(CALLBACK_COMMAND_PREFIX)) {
    return null;
  }

  const senderId = callbackQuery.from?.id;
  const callbackQueryId = callbackQuery.id;
  const messageId = callbackQuery.message?.message_id;
  const chatId = callbackQuery.message?.chat?.id;
  const chatType = callbackQuery.message?.chat?.type;
  if (
    typeof senderId !== "number"
    || typeof callbackQueryId !== "string"
    || typeof messageId !== "number"
    || typeof chatId !== "number"
    || !isTelegramChatType(chatType)
  ) {
    return null;
  }

  const messageThreadId = callbackQuery.message?.message_thread_id;
  return {
    updateId: update.update_id,
    callbackQueryId,
    commandText,
    message: {
      messageId,
      date: typeof callbackQuery.message?.date === "number" ? callbackQuery.message.date : undefined,
      chatId,
      chatType,
      chatTitle: typeof callbackQuery.message?.chat?.title === "string"
        ? callbackQuery.message.chat.title
        : undefined,
      chatIsForum: callbackQuery.message?.chat?.is_forum === true,
      senderId,
      senderUsername: typeof callbackQuery.from?.username === "string"
        ? callbackQuery.from.username
        : undefined,
      messageThreadId: typeof messageThreadId === "number" ? messageThreadId : undefined,
      isTopicMessage: callbackQuery.message?.is_topic_message === true
    },
    raw: input
  };
}

function detectReplyToBot(input: {
  parsed: TelegramParsedTextUpdate;
  botUsername?: string;
  botUserId?: number;
}) {
  if (input.parsed.message.replyToSenderIsBot !== true) {
    return false;
  }

  if (typeof input.botUserId === "number" && input.parsed.message.replyToSenderId === input.botUserId) {
    return true;
  }

  const normalizedBotUsername = input.botUsername?.trim().replace(/^@+/, "").toLowerCase();
  const normalizedReplyUsername = input.parsed.message.replyToSenderUsername?.trim().replace(/^@+/, "").toLowerCase();
  return !!normalizedBotUsername && normalizedReplyUsername === normalizedBotUsername;
}

export function normalizeTelegramModelSelectionCallbackUpdate(
  parsed: TelegramParsedModelSelectionCallbackUpdate,
  input: {
    workspaceId: string;
    accountId: string;
    botUsername?: string;
  }
): NormalizedInboundMessage | null {
  const commandIntent = parseTelegramCommandIntent({
    text: parsed.commandText,
    botUsername: input.botUsername
  });
  if (!commandIntent || commandIntent.name !== "models" || commandIntent.subcommand !== "select") {
    return null;
  }

  const conversationRef = buildConversationRef({
    accountId: input.accountId,
    parsed
  });

  return {
    source: "telegram",
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    senderId: String(parsed.message.senderId),
    text: parsed.commandText,
    attachments: [],
    transportMessageId: `callback:${parsed.callbackQueryId}`,
    conversationRef,
    conversationScope: deriveConversationScopeFromPeerKind(conversationRef.peerKind),
    channelContext: {
      updateId: String(parsed.updateId),
      updateKind: "callback_query",
      callbackQueryId: parsed.callbackQueryId,
      messageId: String(parsed.message.messageId),
      chatId: String(parsed.message.chatId),
      chatType: parsed.message.chatType,
      chatTitle: parsed.message.chatTitle,
      messageDate: parsed.message.date,
      messageThreadId:
        parsed.message.messageThreadId != null ? String(parsed.message.messageThreadId) : undefined,
      isTopicMessage: parsed.message.isTopicMessage,
      replyToBot: false
    },
    activationHint: {
      pairRequested: false,
      explicitActivation: true,
      mentionMatched: false,
      replyToBot: false
    },
    activationKind: "command_execution",
    commandIntent
  };
}

export function normalizeTelegramTextUpdate(
  parsed: TelegramParsedTextUpdate,
  input: {
    workspaceId: string;
    accountId: string;
    botUsername?: string;
    botUserId?: number;
  }
): NormalizedInboundMessage {
  const conversationRef = buildConversationRef({
    accountId: input.accountId,
    parsed
  });
  const conversationScope = deriveConversationScopeFromPeerKind(conversationRef.peerKind);
  const mentionMatched = detectTelegramBotMention({
    text: parsed.message.text,
    entities: parsed.message.entities,
    botIdentity: {
      username: input.botUsername,
      userId: input.botUserId
    }
  });
  const commandIntent = parseTelegramCommandIntent({
    text: parsed.message.text,
    botUsername: input.botUsername
  });
  const slashCommandCandidate = looksLikeTelegramSlashCommand({
    text: parsed.message.text,
    botUsername: input.botUsername
  });
  const replyToBot = conversationScope === "shared"
    ? detectReplyToBot({
        parsed,
        botUsername: input.botUsername,
        botUserId: input.botUserId
      })
    : false;
  const pairRequested = conversationScope === "direct" && detectPairRequest(parsed.message.text);
  const explicitActivation = conversationScope === "direct"
    ? true
    : mentionMatched || replyToBot || slashCommandCandidate;
  const activationKind = conversationScope === "shared" && !explicitActivation
    ? "passive_ingest"
    : commandIntent
      ? "command_execution"
      : "interactive_turn";

  return {
    source: "telegram",
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    senderId: String(parsed.message.senderId),
    text: parsed.message.text,
    attachments: [],
    transportMessageId: String(parsed.message.messageId),
    conversationRef,
    conversationScope,
    channelContext: {
      updateId: String(parsed.updateId),
      updateKind: parsed.updateKind,
      messageId: String(parsed.message.messageId),
      replyToMessageId:
        parsed.message.replyToMessageId != null ? String(parsed.message.replyToMessageId) : undefined,
      chatId: String(parsed.message.chatId),
      chatType: parsed.message.chatType,
      chatTitle: parsed.message.chatTitle,
      messageDate: parsed.message.date,
      messageThreadId:
        parsed.message.messageThreadId != null ? String(parsed.message.messageThreadId) : undefined,
      isTopicMessage: parsed.message.isTopicMessage,
      replyToBot
    },
    activationHint: {
      pairRequested,
      explicitActivation,
      mentionMatched,
      replyToBot
    },
    activationKind,
    commandIntent: commandIntent ?? undefined
  };
}

export function normalizeTelegramLifecycleUpdate(
  parsed: TelegramParsedLifecycleUpdate,
  input: {
    accountId: string;
    workspaceId?: string;
  }
): ConversationLifecycleEvent {
  const conversationRef = buildConversationRef({
    accountId: input.accountId,
    parsed
  });
  const actorId = parsed.membership.actorId != null
    ? createAuthorityActorId({
        accountId: input.accountId,
        senderId: String(parsed.membership.actorId)
      })
    : undefined;

  return {
    source: "telegram",
    accountId: input.accountId,
    conversationRef,
    conversationScope: deriveConversationScopeFromPeerKind(conversationRef.peerKind),
    eventKind: parsed.eventKind,
    subjectRef: String(parsed.membership.subjectId),
    actorId,
    observedAt: new Date(parsed.membership.date * 1000).toISOString(),
    metadata: {
      workspaceId: input.workspaceId,
      updateId: String(parsed.updateId),
      updateKind: parsed.updateKind,
      actorId: parsed.membership.actorId != null ? String(parsed.membership.actorId) : undefined,
      actorUsername: parsed.membership.actorUsername,
      subjectId: String(parsed.membership.subjectId),
      subjectUsername: parsed.membership.subjectUsername,
      oldStatus: parsed.membership.oldStatus,
      newStatus: parsed.membership.newStatus,
      chatType: parsed.membership.chatType,
      chatId: String(parsed.membership.chatId)
    }
  };
}
