import type { createAccessStore } from "@endec/access";
import type { ConversationDirectoryEntry, ConversationRef, Source } from "@endec/domain";

export interface ResolveConversationTargetResult {
  conversationKey: string;
  latestSessionId?: string;
  conversationLabel?: string;
}

export interface RecordConversationActivityInput {
  source: Extract<Source, "telegram" | "feishu">;
  accountId: string;
  conversationRef: ConversationRef;
  sessionId: string;
  conversationLabel?: string;
  observedAt?: string;
}

export interface ResolveConversationTargetInput {
  source: Extract<Source, "telegram" | "feishu">;
  accountId: string;
  currentConversationRef?: ConversationRef;
  target?: string;
}

type ConversationDirectoryStore = Pick<ReturnType<typeof createAccessStore>, "resolveConversationTarget" | "upsertConversationDirectoryEntry">;

function canonicalSharedConversationKey(conversationRef: ConversationRef | undefined) {
  if (!conversationRef || conversationRef.peerKind !== "group") {
    return undefined;
  }

  return conversationRef.conversationId;
}

function normalizeTarget(target: string | undefined) {
  const normalized = target?.trim();
  return normalized ? normalized : undefined;
}

export function createConversationDirectory(input: {
  accessStore: ConversationDirectoryStore;
}) {
  async function recordConversationActivity(entry: RecordConversationActivityInput): Promise<ConversationDirectoryEntry> {
    return input.accessStore.upsertConversationDirectoryEntry({
      source: entry.source,
      accountId: entry.accountId,
      conversationKey: entry.conversationRef.conversationId,
      baseConversationKey: entry.conversationRef.baseConversationId,
      conversationLabel: entry.conversationLabel,
      latestSessionId: entry.sessionId,
      observedAt: entry.observedAt ?? new Date().toISOString()
    });
  }

  async function resolveConversationTarget(request: ResolveConversationTargetInput): Promise<ResolveConversationTargetResult | undefined> {
    const normalizedTarget = normalizeTarget(request.target);
    const currentSharedConversationKey = canonicalSharedConversationKey(request.currentConversationRef);

    if (!normalizedTarget || normalizedTarget === "here") {
      if (!currentSharedConversationKey) {
        return undefined;
      }

      return {
        conversationKey: currentSharedConversationKey
      };
    }

    if (normalizedTarget === request.currentConversationRef?.conversationId || normalizedTarget === currentSharedConversationKey) {
      return {
        conversationKey: currentSharedConversationKey ?? request.currentConversationRef?.conversationId ?? normalizedTarget
      };
    }

    const stored = await input.accessStore.resolveConversationTarget({
      source: request.source,
      accountId: request.accountId,
      target: normalizedTarget
    });

    if (!stored) {
      return undefined;
    }

    return {
      conversationKey: stored.conversationKey,
      latestSessionId: stored.latestSessionId,
      conversationLabel: stored.conversationLabel
    };
  }

  return {
    recordConversationActivity,
    resolveConversationTarget
  };
}
