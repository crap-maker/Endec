import { createHash } from "node:crypto";
import type { ActorResolutionInput, SessionResolutionInput } from "@endec/im-adapter";
import type { TelegramAdapterStateStore } from "./telegram-types.ts";

function stableHash(parts: string[]) {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
}

export function deriveTelegramActorId(input: ActorResolutionInput) {
  return `actor_tg_${stableHash([input.source, input.workspaceId, input.accountId, input.senderId])}`;
}

export function createTelegramSessionBindingLookup(input: {
  stateStore: TelegramAdapterStateStore;
}) {
  return async (resolutionInput: SessionResolutionInput) => {
    const existing = await input.stateStore.loadSessionBindingByConversation({
      source: "telegram",
      workspaceId: resolutionInput.workspaceId,
      accountId: resolutionInput.accountId,
      conversationRef: resolutionInput.conversationRef
    });

    return existing
      ? {
          sessionId: existing.sessionId
        }
      : null;
  };
}

export function createTelegramActorBindingLookup(input: {
  stateStore: TelegramAdapterStateStore;
}) {
  return async (resolutionInput: ActorResolutionInput) => {
    const existing = await input.stateStore.loadActorBinding({
      source: "telegram",
      workspaceId: resolutionInput.workspaceId,
      accountId: resolutionInput.accountId,
      senderId: resolutionInput.senderId
    });

    return existing
      ? {
          actorId: existing
        }
      : null;
  };
}

export function createTelegramOutboundSessionBindingRecorder(input: {
  stateStore: TelegramAdapterStateStore;
  workspaceId: string;
  accountId: string;
}) {
  return async (binding: {
    sessionId: string;
    conversationRef: SessionResolutionInput["conversationRef"];
  }) => {
    await input.stateStore.saveSessionBinding({
      source: "telegram",
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      sessionId: binding.sessionId,
      conversationRef: binding.conversationRef
    });
  };
}
