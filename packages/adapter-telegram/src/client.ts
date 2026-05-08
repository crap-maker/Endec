import { z } from "zod";
import {
  TelegramUpdateSchema,
  TelegramUserSchema,
  type TelegramAnswerCallbackQueryParams,
  type TelegramBotClient,
  type TelegramGetUpdatesParams,
  type TelegramSendChatActionParams,
  type TelegramSendMessageParams,
  type TelegramSendMessageResult,
  type TelegramSetMyCommandsParams,
  type TelegramUpdate,
  type TelegramUser
} from "./telegram-types.ts";

const TelegramResponseEnvelopeSchema = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({
    ok: z.boolean(),
    result: schema.optional(),
    description: z.string().optional(),
    error_code: z.number().int().optional()
  });

export class TelegramBotApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly errorCode?: number
  ) {
    super(message);
    this.name = "TelegramBotApiError";
  }
}

export function createTelegramBotApiClient(input: {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
}): TelegramBotClient {
  const apiBase = input.apiBase ?? "https://api.telegram.org";
  const fetchImpl = input.fetch ?? fetch;

  async function callTelegramApi<T>(method: string, body: Record<string, unknown>, schema: z.ZodType<T>) {
    const response = await fetchImpl(`${apiBase}/bot${input.token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const json = await response.json();
    const envelope = TelegramResponseEnvelopeSchema(schema).parse(json);
    if (!response.ok || envelope.ok !== true || typeof envelope.result === "undefined") {
      throw new TelegramBotApiError(
        envelope.description ?? `telegram ${method} failed`,
        response.status,
        envelope.error_code
      );
    }
    return envelope.result;
  }

  return {
    async getUpdates(params: TelegramGetUpdatesParams): Promise<TelegramUpdate[]> {
      return callTelegramApi(
        "getUpdates",
        {
          offset: params.offset,
          timeout: params.timeoutSeconds,
          allowed_updates: params.allowedUpdates
        },
        z.array(TelegramUpdateSchema)
      );
    },

    async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSendMessageResult> {
      const result = await callTelegramApi(
        "sendMessage",
        {
          chat_id: params.chatId,
          text: params.text,
          message_thread_id: params.messageThreadId,
          reply_to_message_id: params.replyToMessageId,
          reply_markup: params.replyMarkup
        },
        z.object({
          message_id: z.number().int(),
          chat: z.object({
            id: z.union([z.number().int(), z.string()])
          }).passthrough()
        }).passthrough()
      );

      return {
        messageId: String(result.message_id),
        chatId: String(result.chat.id)
      };
    },

    async setMyCommands(params: TelegramSetMyCommandsParams): Promise<void> {
      await callTelegramApi(
        "setMyCommands",
        {
          commands: params.commands,
          scope: params.scope
        },
        z.boolean()
      );
    },

    async answerCallbackQuery(params: TelegramAnswerCallbackQueryParams): Promise<void> {
      await callTelegramApi(
        "answerCallbackQuery",
        {
          callback_query_id: params.callbackQueryId,
          text: params.text
        },
        z.boolean()
      );
    },

    async sendChatAction(params: TelegramSendChatActionParams): Promise<void> {
      await callTelegramApi(
        "sendChatAction",
        {
          chat_id: params.chatId,
          action: params.action,
          message_thread_id: params.messageThreadId
        },
        z.boolean()
      );
    },

    async getMe(): Promise<TelegramUser> {
      return callTelegramApi("getMe", {}, TelegramUserSchema);
    }
  };
}
