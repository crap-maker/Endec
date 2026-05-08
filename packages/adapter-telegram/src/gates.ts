import type { PreAgentGate } from "@endec/im-adapter";
import type { TelegramAdapterStateStore } from "./telegram-types.ts";

export type TelegramAllowGateOptions = {
  chatIds?: Array<string | number>;
  senderIds?: Array<string | number>;
};

export function createTelegramAllowGate(options: TelegramAllowGateOptions): PreAgentGate {
  const allowedChatIds = new Set((options.chatIds ?? []).map((value) => String(value)));
  const allowedSenderIds = new Set((options.senderIds ?? []).map((value) => String(value)));

  return (input) => {
    if (allowedChatIds.size > 0 && !allowedChatIds.has(input.conversationRef.peerId)) {
      return {
        kind: "drop",
        reasonCode: "chat_not_allowed",
        reasonText: `telegram chat ${input.conversationRef.peerId} is not in the allow gate`
      } as const;
    }

    if (allowedSenderIds.size > 0 && !allowedSenderIds.has(input.senderId)) {
      return {
        kind: "drop",
        reasonCode: "sender_not_allowed",
        reasonText: `telegram sender ${input.senderId} is not in the allow gate`
      } as const;
    }

    return { kind: "allow" } as const;
  };
}

export function createTelegramInboundDedupKey(input: {
  workspaceId: string;
  accountId: string;
  conversationId: string;
  transportMessageId: string;
}) {
  return [
    "telegram",
    input.workspaceId,
    input.accountId,
    input.conversationId,
    input.transportMessageId
  ].join(":");
}

export function createTelegramDedupGate(input: {
  stateStore: TelegramAdapterStateStore;
  ttlMs?: number;
}): PreAgentGate {
  const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1000;

  return async (message) => {
    const dedupKey = createTelegramInboundDedupKey({
      workspaceId: message.workspaceId,
      accountId: message.accountId,
      conversationId: message.conversationRef.conversationId,
      transportMessageId: message.transportMessageId
    });
    const claimed = await input.stateStore.claimInboundDedup({
      dedupKey,
      expiresAtMs: Date.now() + ttlMs
    });

    if (claimed) {
      return { kind: "allow" } as const;
    }

    return {
      kind: "drop",
      reasonCode: "duplicate_inbound",
      reasonText: `telegram inbound ${dedupKey} was already processed`
    } as const;
  };
}
