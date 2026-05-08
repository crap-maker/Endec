import { z } from "zod";
import type { ConversationLifecycleEvent, ConversationRef, TurnResult } from "@endec/domain";
import type { InboundHandleResult } from "@endec/im-adapter";

export const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  username: z.string().optional()
}).passthrough();

export const TelegramEntitySchema = z.object({
  type: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  user: TelegramUserSchema.optional()
}).passthrough();

export const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  is_forum: z.boolean().optional()
}).passthrough();

export const TelegramReplyMessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional()
}).passthrough();

export const TelegramMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  text: z.string().optional(),
  entities: z.array(TelegramEntitySchema).optional(),
  message_thread_id: z.number().int().optional(),
  is_topic_message: z.boolean().optional(),
  reply_to_message: TelegramReplyMessageSchema.optional(),
  chat: TelegramChatSchema,
  from: TelegramUserSchema.optional()
}).passthrough();

export const TelegramBotCommandSchema = z.object({
  command: z.string().min(1),
  description: z.string().min(1)
});

export const TelegramInlineKeyboardButtonSchema = z.object({
  text: z.string().min(1),
  callback_data: z.string().optional(),
  url: z.string().optional()
}).passthrough();

export const TelegramInlineKeyboardMarkupSchema = z.object({
  inline_keyboard: z.array(z.array(TelegramInlineKeyboardButtonSchema))
}).passthrough();

export const TelegramCallbackQuerySchema = z.object({
  id: z.string().min(1),
  from: TelegramUserSchema,
  data: z.string().optional(),
  message: TelegramMessageSchema.optional()
}).passthrough();

export const TelegramChatMemberStatusSchema = z.enum([
  "creator",
  "administrator",
  "member",
  "restricted",
  "left",
  "kicked"
]);

export const TelegramChatMemberSchema = z.object({
  user: TelegramUserSchema,
  status: TelegramChatMemberStatusSchema
}).passthrough();

export const TelegramChatMemberUpdatedSchema = z.object({
  date: z.number().int(),
  chat: TelegramChatSchema,
  from: TelegramUserSchema.optional(),
  old_chat_member: TelegramChatMemberSchema,
  new_chat_member: TelegramChatMemberSchema
}).passthrough();

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
  edited_message: TelegramMessageSchema.optional(),
  my_chat_member: TelegramChatMemberUpdatedSchema.optional(),
  chat_member: TelegramChatMemberUpdatedSchema.optional(),
  callback_query: TelegramCallbackQuerySchema.optional()
}).passthrough();

export type TelegramUser = z.infer<typeof TelegramUserSchema>;
export type TelegramEntity = z.infer<typeof TelegramEntitySchema>;
export type TelegramChat = z.infer<typeof TelegramChatSchema>;
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;
export type TelegramBotCommand = z.infer<typeof TelegramBotCommandSchema>;
export type TelegramBotCommandScope = {
  type: "default" | "all_private_chats" | "all_group_chats";
};
export type TelegramInlineKeyboardButton = z.infer<typeof TelegramInlineKeyboardButtonSchema>;
export type TelegramInlineKeyboardMarkup = z.infer<typeof TelegramInlineKeyboardMarkupSchema>;
export type TelegramCallbackQuery = z.infer<typeof TelegramCallbackQuerySchema>;
export type TelegramChatMemberStatus = z.infer<typeof TelegramChatMemberStatusSchema>;
export type TelegramChatMember = z.infer<typeof TelegramChatMemberSchema>;
export type TelegramChatMemberUpdated = z.infer<typeof TelegramChatMemberUpdatedSchema>;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export type TelegramBotIdentity = {
  userId?: number;
  username?: string;
};

export type TelegramParsedTextUpdate = {
  updateId: number;
  updateKind: "message" | "edited_message";
  message: {
    messageId: number;
    date: number;
    text: string;
    chatId: number;
    chatType: TelegramChat["type"];
    chatTitle?: string;
    chatIsForum: boolean;
    senderId: number;
    senderUsername?: string;
    entities: TelegramEntity[];
    messageThreadId?: number;
    isTopicMessage: boolean;
    replyToMessageId?: number;
    replyToSenderId?: number;
    replyToSenderIsBot?: boolean;
    replyToSenderUsername?: string;
  };
  raw: TelegramUpdate;
};

export type TelegramParsedLifecycleUpdate = {
  updateId: number;
  updateKind: "my_chat_member" | "chat_member";
  eventKind: "bot_added" | "bot_removed" | "owner_left";
  membership: {
    date: number;
    chatId: number;
    chatType: TelegramChat["type"];
    actorId?: number;
    actorUsername?: string;
    subjectId: number;
    subjectUsername?: string;
    oldStatus: TelegramChatMemberStatus;
    newStatus: TelegramChatMemberStatus;
  };
  raw: TelegramUpdate;
};

export type TelegramParsedCallbackQueryUpdate = {
  updateId: number;
  updateKind: "callback_query";
  callbackQuery: {
    id: string;
    data: string;
    actorId: number;
    actorUsername?: string;
    messageId: number;
    messageDate: number;
    chatId: number;
    chatType: TelegramChat["type"];
    chatTitle?: string;
    chatIsForum: boolean;
    messageThreadId?: number;
    isTopicMessage: boolean;
  };
  raw: TelegramUpdate;
};

export type TelegramSessionBinding = {
  sessionId: string;
  conversationRef: ConversationRef;
  updatedAt: string;
};

export interface TelegramAdapterStateStore {
  loadSessionBindingByConversation(input: {
    source: "telegram";
    workspaceId: string;
    accountId: string;
    conversationRef: ConversationRef;
  }): Promise<TelegramSessionBinding | undefined>;
  loadSessionBindingBySessionId(sessionId: string): Promise<TelegramSessionBinding | undefined>;
  saveSessionBinding(input: {
    source: "telegram";
    workspaceId: string;
    accountId: string;
    sessionId: string;
    conversationRef: ConversationRef;
  }): Promise<void>;
  loadActorBinding(input: {
    source: "telegram";
    workspaceId: string;
    accountId: string;
    senderId: string;
  }): Promise<string | undefined>;
  saveActorBinding(input: {
    source: "telegram";
    workspaceId: string;
    accountId: string;
    senderId: string;
    actorId: string;
  }): Promise<void>;
  claimInboundDedup(input: {
    dedupKey: string;
    expiresAtMs: number;
  }): Promise<boolean>;
  readPollingOffset(input: { accountId: string }): Promise<number | null>;
  writePollingOffset(input: { accountId: string; nextUpdateId: number }): Promise<void>;
  close(): void;
}

export interface TelegramGetUpdatesParams {
  offset?: number;
  timeoutSeconds?: number;
  allowedUpdates?: string[];
}

export interface TelegramSendMessageParams {
  chatId: string;
  text: string;
  messageThreadId?: number;
  replyToMessageId?: number;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramSetMyCommandsParams {
  commands: TelegramBotCommand[];
  scope?: TelegramBotCommandScope;
}

export interface TelegramAnswerCallbackQueryParams {
  callbackQueryId: string;
  text?: string;
}

export interface TelegramSendChatActionParams {
  chatId: string;
  action: "typing";
  messageThreadId?: number;
}

export interface TelegramSendMessageResult {
  messageId: string;
  chatId: string;
}

export interface TelegramBotClient {
  getUpdates(params: TelegramGetUpdatesParams): Promise<TelegramUpdate[]>;
  sendMessage(params: TelegramSendMessageParams): Promise<TelegramSendMessageResult>;
  setMyCommands?(params: TelegramSetMyCommandsParams): Promise<void>;
  answerCallbackQuery?(params: TelegramAnswerCallbackQueryParams): Promise<void>;
  sendChatAction(params: TelegramSendChatActionParams): Promise<void>;
  getMe?(): Promise<TelegramUser>;
}

export type TelegramIgnoredHandleResult = {
  status: "ignored";
  reasonCode: "unsupported_update";
};

export type TelegramLifecycleHandleResult = {
  status: "lifecycle_applied";
  lifecycleEvent: ConversationLifecycleEvent;
};

export type TelegramHandleResult = TelegramIgnoredHandleResult | TelegramLifecycleHandleResult | InboundHandleResult;

export type TelegramPollResult = {
  receivedCount: number;
  ignoredCount: number;
  droppedCount: number;
  dispatchedCount: number;
  nextUpdateId: number;
};

export type TelegramFallbackReplyInput = Pick<TurnResult, "status" | "warnings" | "blockedBy">;
