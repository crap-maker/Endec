import { randomUUID } from "node:crypto";
import type { OutboundDelivery, OutboundEvent } from "@endec/domain";
import type {
  DurableOutboundMessage,
  OutboundDispatcher,
  OutboundMessage,
  OutboundDispatchReceipt
} from "@endec/im-adapter";
import { renderDurableOutboundEventToMessages } from "@endec/im-adapter";
import { TelegramBotApiError } from "./client.ts";
import type { TelegramBotClient, TelegramSendMessageResult } from "./telegram-types.ts";

function parseOptionalInteger(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function addMs(iso: string, ms: number) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function collectErrorSignals(error: unknown) {
  if (!(error instanceof Error)) {
    return [] as string[];
  }

  const signals = [error.name, error.message];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    const message = (cause as { message?: unknown }).message;
    if (typeof code === "string") {
      signals.push(code);
    }
    if (typeof message === "string") {
      signals.push(message);
    }
  }

  return signals.map((value) => value.toLowerCase());
}

export function classifyTelegramSendFailure(error: unknown): "failed" | "delivery_unknown" {
  if (error instanceof Error && (error as Error & { ambiguousDelivery?: unknown }).ambiguousDelivery === true) {
    return "delivery_unknown";
  }

  if (error instanceof TelegramBotApiError) {
    return "failed";
  }

  const signals = collectErrorSignals(error);
  const ambiguousMarkers = [
    "aborted",
    "aborterror",
    "econnreset",
    "socket hang up",
    "timed out",
    "timeout",
    "request body write",
    "fetch failed",
    "connection reset"
  ];

  return signals.some((signal) => ambiguousMarkers.some((marker) => signal.includes(marker)))
    ? "delivery_unknown"
    : "failed";
}

function normalizeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ambiguousDelivery: classifyTelegramSendFailure(error) === "delivery_unknown",
      cause: (() => {
        const cause = (error as Error & { cause?: unknown }).cause;
        return cause === undefined ? undefined : normalizeError(cause);
      })()
    };
  }

  return error;
}

export function chunkTelegramText(text: string, limit = 4000) {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0) {
      splitAt = limit;
    }

    const chunk = remaining.slice(0, splitAt).trimEnd();
    chunks.push(chunk.length > 0 ? chunk : remaining.slice(0, limit));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendTelegramTextChunks(input: {
  client: TelegramBotClient;
  message: Pick<OutboundMessage, "conversationRef" | "text" | "replyToMessageId"> | Pick<DurableOutboundMessage, "conversationRef" | "text">;
  chunkLimit: number;
}) {
  const receipts: TelegramSendMessageResult[] = [];
  const chunks = chunkTelegramText(input.message.text, input.chunkLimit);

  for (const chunk of chunks) {
    const sent = await input.client.sendMessage({
      chatId: input.message.conversationRef.peerId,
      text: chunk,
      messageThreadId:
        parseOptionalInteger(input.message.conversationRef.topicId) ??
        parseOptionalInteger(input.message.conversationRef.threadId),
      replyToMessageId: "replyToMessageId" in input.message
        ? parseOptionalInteger(input.message.replyToMessageId)
        : undefined
    });
    receipts.push(sent);
  }

  return receipts;
}

export function createTelegramOutboundDispatcher(input: {
  client: TelegramBotClient;
  chunkLimit?: number;
  app?: {
    im: {
      evaluateOutboundConversationLegality(input: {
        source: "telegram";
        accountId: string;
        conversationRef: OutboundMessage["conversationRef"];
      }): Promise<{ status: string }>;
    };
  };
  shouldBypassLegalityCheck?: (message: OutboundMessage) => boolean;
}): OutboundDispatcher {
  const chunkLimit = input.chunkLimit ?? 4000;

  return {
    async dispatch(messages: OutboundMessage[]): Promise<OutboundDispatchReceipt[]> {
      const receipts: OutboundDispatchReceipt[] = [];

      for (const message of messages) {
        const legality = input.app && !input.shouldBypassLegalityCheck?.(message)
          ? await input.app.im.evaluateOutboundConversationLegality({
              source: "telegram",
              accountId: message.conversationRef.accountId,
              conversationRef: message.conversationRef
            })
          : { status: "allowed" };
        if (legality.status !== "allowed") {
          continue;
        }

        const sentMessages = await sendTelegramTextChunks({
          client: input.client,
          message,
          chunkLimit
        });

        for (const sent of sentMessages) {
          receipts.push({
            deliveryId: `telegram:${message.turnId}:${receipts.length + 1}`,
            messageId: sent.messageId,
            message
          });
        }
      }

      return receipts;
    }
  };
}

type MarkDeliverySendingResult = {
  delivery: OutboundDelivery;
  wonTransition: boolean;
};

type TelegramOutboxStore = {
  claimPendingOutboundEvent(input: {
    channel: "telegram";
    leaseOwner: string;
    leaseToken: string;
    leaseDurationMs: number;
    now?: string;
  }): Promise<OutboundEvent | undefined>;
  createOutboundDelivery(input: {
    deliveryId: string;
    outboundEventId: string;
    transport: "telegram";
    transportTarget: unknown;
    idempotencyKey: string;
    now?: string;
  }): Promise<OutboundDelivery>;
  markDeliverySending(input: {
    deliveryId: string;
    claimOwner?: string;
    claimExpiresAt?: string;
    sendStartedAt?: string;
  }): Promise<MarkDeliverySendingResult | undefined>;
  markDeliveryDelivered(input: {
    deliveryId: string;
    deliveredAt?: string;
    transportMessageId?: string;
    receipt?: unknown;
  }): Promise<OutboundDelivery | undefined>;
  markDeliveryFailed(input: {
    deliveryId: string;
    failedAt?: string;
    error: unknown;
  }): Promise<OutboundDelivery | undefined>;
  markDeliveryUnknown(input: {
    deliveryId: string;
    deliveryUnknownAt?: string;
    error?: unknown;
  }): Promise<OutboundDelivery | undefined>;
  cancelOutboundEvent?(input: {
    outboundEventId: string;
    now?: string;
  }): Promise<unknown>;
};

export type TelegramBackgroundOutboxDrainResult =
  | { status: "idle" }
  | {
      status: "delivered" | "failed" | "delivery_unknown" | "canceled";
      outboundEventId: string;
      deliveryId?: string;
      messageCount: number;
    };

export function createTelegramBackgroundOutboxDrain(input: {
  store: TelegramOutboxStore;
  client: TelegramBotClient;
  leaseOwner: string;
  leaseDurationMs: number;
  chunkLimit?: number;
  now?: () => string;
  app?: {
    im: {
      evaluateOutboundConversationLegality(input: {
        source: "telegram";
        accountId: string;
        conversationRef: OutboundEvent["conversationRef"];
      }): Promise<{ status: string }>;
    };
  };
}) {
  const chunkLimit = input.chunkLimit ?? 4000;
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async drainOnce(runInput: { now?: string } = {}): Promise<TelegramBackgroundOutboxDrainResult> {
      const claimNow = runInput.now ?? now();
      const event = await input.store.claimPendingOutboundEvent({
        channel: "telegram",
        leaseOwner: input.leaseOwner,
        leaseToken: `telegram-drain:${randomUUID()}`,
        leaseDurationMs: input.leaseDurationMs,
        now: claimNow
      });

      if (!event) {
        return { status: "idle" };
      }

      const legality = input.app
        ? await input.app.im.evaluateOutboundConversationLegality({
            source: "telegram",
            accountId: event.conversationRef.accountId,
            conversationRef: event.conversationRef
          })
        : { status: "allowed" };
      if (legality.status !== "allowed") {
        await input.store.cancelOutboundEvent?.({
          outboundEventId: event.outboundEventId,
          now: claimNow
        });
        return {
          status: "canceled",
          outboundEventId: event.outboundEventId,
          messageCount: 0
        };
      }

      const transportTarget = {
        chatId: event.conversationRef.peerId,
        messageThreadId:
          parseOptionalInteger(event.conversationRef.topicId) ??
          parseOptionalInteger(event.conversationRef.threadId)
      };
      const delivery = await input.store.createOutboundDelivery({
        deliveryId: `delivery_${randomUUID()}`,
        outboundEventId: event.outboundEventId,
        transport: "telegram",
        transportTarget,
        idempotencyKey: `outbound:${event.outboundEventId}:telegram`,
        now: claimNow
      });

      if (delivery.status === "delivered" || delivery.status === "failed" || delivery.status === "delivery_unknown" || delivery.status === "sending" || delivery.status === "canceled") {
        return { status: "idle" };
      }

      const sendStartedAt = runInput.now ?? now();
      const sending = await input.store.markDeliverySending({
        deliveryId: delivery.deliveryId,
        claimOwner: input.leaseOwner,
        claimExpiresAt: addMs(sendStartedAt, input.leaseDurationMs),
        sendStartedAt
      });

      if (!sending || !sending.wonTransition) {
        return { status: "idle" };
      }

      try {
        const rendered = renderDurableOutboundEventToMessages({ event });
        const sentReceipts: TelegramSendMessageResult[] = [];

        for (const message of rendered) {
          const receipts = await sendTelegramTextChunks({
            client: input.client,
            message,
            chunkLimit
          });
          sentReceipts.push(...receipts);
        }

        const deliveredAt = now();
        const lastReceipt = sentReceipts[sentReceipts.length - 1];
        await input.store.markDeliveryDelivered({
          deliveryId: delivery.deliveryId,
          deliveredAt,
          transportMessageId: lastReceipt?.messageId,
          receipt: sentReceipts.length === 1 ? sentReceipts[0] : sentReceipts
        });

        return {
          status: "delivered",
          outboundEventId: event.outboundEventId,
          deliveryId: delivery.deliveryId,
          messageCount: sentReceipts.length
        };
      } catch (error) {
        const serializedError = normalizeError(error);
        const classification = classifyTelegramSendFailure(error);
        if (classification === "delivery_unknown") {
          await input.store.markDeliveryUnknown({
            deliveryId: delivery.deliveryId,
            deliveryUnknownAt: now(),
            error: serializedError
          });
          return {
            status: "delivery_unknown",
            outboundEventId: event.outboundEventId,
            deliveryId: delivery.deliveryId,
            messageCount: 0
          };
        }

        await input.store.markDeliveryFailed({
          deliveryId: delivery.deliveryId,
          failedAt: now(),
          error: serializedError
        });
        return {
          status: "failed",
          outboundEventId: event.outboundEventId,
          deliveryId: delivery.deliveryId,
          messageCount: 0
        };
      }
    }
  };
}
