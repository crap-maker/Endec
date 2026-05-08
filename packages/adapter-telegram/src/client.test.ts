import { describe, expect, it, vi } from "vitest";
import { createTelegramBotApiClient } from "./client.ts";
import { createTelegramPollingWorker } from "./polling.ts";

function createTelegramOkResponse(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

describe("createTelegramBotApiClient", () => {
  it("sends setMyCommands payloads with Telegram scope metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createTelegramOkResponse(true));
    const client = createTelegramBotApiClient({
      token: "bot-token",
      fetch: fetchMock
    });

    expect(client.setMyCommands).toBeTypeOf("function");

    await client.setMyCommands!({
      scope: { type: "all_private_chats" },
      commands: [
        { command: "help", description: "Show supported commands" },
        { command: "models", description: "Choose the active Telegram model" }
      ]
    } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/setMyCommands",
      expect.objectContaining({
        method: "POST"
      })
    );
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toBeDefined();
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      commands: [
        { command: "help", description: "Show supported commands" },
        { command: "models", description: "Choose the active Telegram model" }
      ],
      scope: { type: "all_private_chats" }
    });
  });

  it("passes inline keyboards through sendMessage.reply_markup", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createTelegramOkResponse({
      message_id: 123,
      chat: {
        id: 42
      }
    }));
    const client = createTelegramBotApiClient({
      token: "bot-token",
      fetch: fetchMock
    });

    await client.sendMessage({
      chatId: "42",
      text: "Choose the active model:",
      replyMarkup: {
        inline_keyboard: [[{ text: "GPT 5.4", callback_data: "model:openai:gpt5.4" }]]
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "42",
          text: "Choose the active model:",
          message_thread_id: undefined,
          reply_to_message_id: undefined,
          reply_markup: {
            inline_keyboard: [[{ text: "GPT 5.4", callback_data: "model:openai:gpt5.4" }]]
          }
        })
      })
    );
  });

  it("sends answerCallbackQuery payloads with the callback id and optional text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createTelegramOkResponse(true));
    const client = createTelegramBotApiClient({
      token: "bot-token",
      fetch: fetchMock
    });

    expect(client.answerCallbackQuery).toBeTypeOf("function");

    await client.answerCallbackQuery!({
      callbackQueryId: "cbq_123",
      text: "Updated active model"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token/answerCallbackQuery",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          callback_query_id: "cbq_123",
          text: "Updated active model"
        })
      })
    );
  });
});

describe("createTelegramPollingWorker", () => {
  it("includes callback_query in default allowedUpdates", async () => {
    const getUpdates = vi.fn(async () => []);
    const worker = createTelegramPollingWorker({
      accountId: "acct_bot",
      client: {
        getUpdates,
        sendMessage: vi.fn(async () => ({ messageId: "sent_1", chatId: "42" })),
        sendChatAction: vi.fn(async () => undefined)
      },
      adapter: {
        handleUpdate: vi.fn(async () => ({ status: "ignored" }))
      },
      stateStore: {
        readPollingOffset: vi.fn(async () => null),
        writePollingOffset: vi.fn(async () => undefined)
      }
    });

    await worker.pollOnce();

    expect(getUpdates).toHaveBeenCalledWith({
      offset: 0,
      timeoutSeconds: 30,
      allowedUpdates: ["message", "edited_message", "my_chat_member", "chat_member", "callback_query"]
    });
  });
});
