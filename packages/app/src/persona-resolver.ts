import type {
  ConversationRef,
  ResolvedPersona,
  PersonaScopeKind,
  Source
} from "@endec/domain";

type PersonaProfileRecord = {
  styleInstructions: string;
  behaviorInstructions: string;
};

type PersonaStore = {
  getPersonaProfile(input: {
    source: Source;
    accountId: string;
    ownerGeneration: number;
    scopeKind: PersonaScopeKind;
    conversationKey?: string;
  }): Promise<PersonaProfileRecord | undefined>;
};

export type ResolvePersonaInput = {
  source: Extract<Source, "telegram" | "feishu">;
  accountId: string;
  ownerBindingId: string;
  ownerGeneration: number;
  conversationRef: ConversationRef;
  conversationScope: "direct" | "shared" | "broadcast" | "unknown";
};

function joinInstructions(...values: Array<string | undefined>) {
  return values
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join("\n");
}

function resolveConversationOverrideKey(conversationRef: ConversationRef) {
  return conversationRef.baseConversationId ?? conversationRef.conversationId;
}

async function resolvePersonaWithStore(input: ResolvePersonaInput, store: PersonaStore): Promise<ResolvedPersona> {
  if (input.conversationScope === "direct") {
    const ownerDirect = await store.getPersonaProfile({
      source: input.source,
      accountId: input.accountId,
      ownerGeneration: input.ownerGeneration,
      scopeKind: "owner_direct"
    });

    return {
      scopeKind: "owner_direct",
      styleInstructions: ownerDirect?.styleInstructions ?? "",
      behaviorInstructions: ownerDirect?.behaviorInstructions ?? "",
      sourceRefs: ownerDirect ? ["persona:owner_direct"] : []
    };
  }

  const conversationKey = resolveConversationOverrideKey(input.conversationRef);
  const shouldLoadConversationOverride = input.conversationRef.conversationId !== conversationKey
    || typeof input.conversationRef.parentConversationId === "string"
    || typeof input.conversationRef.topicId === "string"
    || typeof input.conversationRef.threadId === "string";
  const [sharedDefault, conversationOverride] = await Promise.all([
    store.getPersonaProfile({
      source: input.source,
      accountId: input.accountId,
      ownerGeneration: input.ownerGeneration,
      scopeKind: "shared_default"
    }),
    shouldLoadConversationOverride
      ? store.getPersonaProfile({
          source: input.source,
          accountId: input.accountId,
          ownerGeneration: input.ownerGeneration,
          scopeKind: "conversation_override",
          conversationKey
        })
      : Promise.resolve(undefined)
  ]);

  if (conversationOverride) {
    return {
      scopeKind: "conversation_override",
      styleInstructions: joinInstructions(sharedDefault?.styleInstructions, conversationOverride.styleInstructions),
      behaviorInstructions: joinInstructions(sharedDefault?.behaviorInstructions, conversationOverride.behaviorInstructions),
      sourceRefs: [
        ...(sharedDefault ? ["persona:shared_default"] : []),
        `persona:conversation:${conversationKey}`
      ]
    };
  }

  return {
    scopeKind: "shared_default",
    styleInstructions: sharedDefault?.styleInstructions ?? "",
    behaviorInstructions: sharedDefault?.behaviorInstructions ?? "",
    sourceRefs: sharedDefault ? ["persona:shared_default"] : []
  };
}

export function createPersonaResolver(deps: {
  accessStore: PersonaStore;
}) {
  return {
    resolvePersona(input: ResolvePersonaInput) {
      return resolvePersonaWithStore(input, deps.accessStore);
    }
  };
}

export function resolvePersona(input: ResolvePersonaInput, deps: { accessStore: PersonaStore }) {
  return resolvePersonaWithStore(input, deps.accessStore);
}
