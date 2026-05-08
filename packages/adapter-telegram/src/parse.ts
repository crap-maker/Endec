import type {
  TelegramBotIdentity,
  TelegramChatMemberStatus,
  TelegramEntity,
  TelegramParsedCallbackQueryUpdate,
  TelegramParsedLifecycleUpdate,
  TelegramParsedTextUpdate
} from "./telegram-types.ts";
import { TelegramUpdateSchema } from "./telegram-types.ts";

function sliceTelegramText(text: string, entity: Pick<TelegramEntity, "offset" | "length">) {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function isJoinedStatus(status: TelegramChatMemberStatus) {
  return status === "member" || status === "administrator" || status === "creator";
}

function isAbsentStatus(status: TelegramChatMemberStatus) {
  return status === "left" || status === "kicked";
}

export function detectTelegramBotMention(input: {
  text: string;
  entities: TelegramEntity[];
  botIdentity?: TelegramBotIdentity;
}) {
  const username = input.botIdentity?.username?.trim().replace(/^@+/, "").toLowerCase();
  const userId = input.botIdentity?.userId;

  return input.entities.some((entity) => {
    if (entity.type === "mention" && username) {
      return sliceTelegramText(input.text, entity).toLowerCase() === `@${username}`;
    }

    if (entity.type === "text_mention" && typeof userId === "number") {
      return entity.user?.id === userId;
    }

    return false;
  });
}

export function parseTelegramTextUpdate(input: unknown): TelegramParsedTextUpdate | null {
  const parsed = TelegramUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }

  const update = parsed.data;
  const selected = update.message
    ? { updateKind: "message" as const, message: update.message }
    : update.edited_message
      ? { updateKind: "edited_message" as const, message: update.edited_message }
      : null;

  if (!selected) {
    return null;
  }

  const text = selected.message.text;
  const senderId = selected.message.from?.id;
  if (!text || text.trim().length === 0 || typeof senderId !== "number") {
    return null;
  }

  return {
    updateId: update.update_id,
    updateKind: selected.updateKind,
    message: {
      messageId: selected.message.message_id,
      date: selected.message.date,
      text,
      chatId: selected.message.chat.id,
      chatType: selected.message.chat.type,
      chatTitle: selected.message.chat.title,
      chatIsForum: selected.message.chat.is_forum === true,
      senderId,
      senderUsername: selected.message.from?.username,
      entities: selected.message.entities ?? [],
      messageThreadId: selected.message.message_thread_id,
      isTopicMessage: selected.message.is_topic_message === true,
      replyToMessageId: selected.message.reply_to_message?.message_id,
      replyToSenderId: selected.message.reply_to_message?.from?.id,
      replyToSenderIsBot: selected.message.reply_to_message?.from?.is_bot,
      replyToSenderUsername: selected.message.reply_to_message?.from?.username
    },
    raw: update
  };
}

export function parseTelegramCallbackQueryUpdate(input: unknown): TelegramParsedCallbackQueryUpdate | null {
  const parsed = TelegramUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }

  const update = parsed.data;
  const callbackQuery = update.callback_query;
  const message = callbackQuery?.message;
  const actorId = callbackQuery?.from?.id;
  const data = callbackQuery?.data;

  if (!callbackQuery || !message || typeof actorId !== "number" || !data || data.trim().length === 0) {
    return null;
  }

  return {
    updateId: update.update_id,
    updateKind: "callback_query",
    callbackQuery: {
      id: callbackQuery.id,
      data,
      actorId,
      actorUsername: callbackQuery.from.username,
      messageId: message.message_id,
      messageDate: message.date,
      chatId: message.chat.id,
      chatType: message.chat.type,
      chatTitle: message.chat.title,
      chatIsForum: message.chat.is_forum === true,
      messageThreadId: message.message_thread_id,
      isTopicMessage: message.is_topic_message === true
    },
    raw: update
  };
}

export function parseTelegramLifecycleUpdate(input: unknown): TelegramParsedLifecycleUpdate | null {
  const parsed = TelegramUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }

  const update = parsed.data;
  const selected = update.my_chat_member
    ? { updateKind: "my_chat_member" as const, membership: update.my_chat_member }
    : update.chat_member
      ? { updateKind: "chat_member" as const, membership: update.chat_member }
      : null;

  if (!selected) {
    return null;
  }

  const oldStatus = selected.membership.old_chat_member.status;
  const newStatus = selected.membership.new_chat_member.status;
  const subjectId = selected.membership.new_chat_member.user.id;
  const actorId = selected.membership.from?.id;

  let eventKind: TelegramParsedLifecycleUpdate["eventKind"] | null = null;
  if (selected.updateKind === "my_chat_member") {
    if (!isJoinedStatus(oldStatus) && isJoinedStatus(newStatus)) {
      eventKind = "bot_added";
    } else if (!isAbsentStatus(oldStatus) && isAbsentStatus(newStatus)) {
      eventKind = "bot_removed";
    }
  } else if (selected.updateKind === "chat_member") {
    if (!isAbsentStatus(oldStatus) && isAbsentStatus(newStatus)) {
      eventKind = "owner_left";
    }
  }

  if (!eventKind) {
    return null;
  }

  return {
    updateId: update.update_id,
    updateKind: selected.updateKind,
    eventKind,
    membership: {
      date: selected.membership.date,
      chatId: selected.membership.chat.id,
      chatType: selected.membership.chat.type,
      actorId,
      actorUsername: selected.membership.from?.username,
      subjectId,
      subjectUsername: selected.membership.new_chat_member.user.username,
      oldStatus,
      newStatus
    },
    raw: update
  };
}
