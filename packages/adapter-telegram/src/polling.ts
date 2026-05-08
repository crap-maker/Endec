import type { TelegramAdapterStateStore, TelegramBotClient, TelegramPollResult, TelegramUpdate } from "./telegram-types.ts";

function getUpdateId(update: TelegramUpdate) {
  return update.update_id;
}

export function createTelegramPollingWorker(input: {
  accountId: string;
  client: TelegramBotClient;
  adapter: {
    handleUpdate(update: unknown): Promise<{ status: string }>;
  };
  stateStore: Pick<TelegramAdapterStateStore, "readPollingOffset" | "writePollingOffset">;
  timeoutSeconds?: number;
  allowedUpdates?: string[];
}) {
  const timeoutSeconds = input.timeoutSeconds ?? 30;
  const allowedUpdates = input.allowedUpdates ?? ["message", "edited_message", "my_chat_member", "chat_member", "callback_query"];

  return {
    async pollOnce(): Promise<TelegramPollResult> {
      const currentOffset = (await input.stateStore.readPollingOffset({ accountId: input.accountId })) ?? 0;
      const updates = await input.client.getUpdates({
        offset: currentOffset,
        timeoutSeconds,
        allowedUpdates
      });

      let ignoredCount = 0;
      let droppedCount = 0;
      let dispatchedCount = 0;
      let nextUpdateId = currentOffset;

      for (const update of updates) {
        const handled = await input.adapter.handleUpdate(update);
        if (handled.status === "ignored") {
          ignoredCount += 1;
        } else if (handled.status === "lifecycle_applied") {
          ignoredCount += 1;
        } else if (handled.status === "dropped") {
          droppedCount += 1;
        } else if (
          handled.status === "dispatched"
          || handled.status === "command_replied"
          || handled.status === "passive_ingested"
        ) {
          dispatchedCount += 1;
        }
        nextUpdateId = Math.max(nextUpdateId, getUpdateId(update) + 1);
      }

      if (nextUpdateId !== currentOffset) {
        await input.stateStore.writePollingOffset({
          accountId: input.accountId,
          nextUpdateId
        });
      }

      return {
        receivedCount: updates.length,
        ignoredCount,
        droppedCount,
        dispatchedCount,
        nextUpdateId
      };
    }
  };
}
