import {
  createFallbackOutboundText,
  createImAdapter,
  evaluatePreAgentGates,
  type ImAdapterDeps,
  type OutboundMessage,
  type PreAgentGate,
  type PreAgentGateDecision
} from "@endec/im-adapter";
import type {
  AdmissionDecision,
  ErrorExposureMode,
  TurnResult
} from "@endec/domain";
import { createTelegramOutboundDispatcher, createTelegramBackgroundOutboxDrain } from "./outbound.ts";
import {
  normalizeTelegramLifecycleUpdate,
  normalizeTelegramModelSelectionCallbackUpdate,
  normalizeTelegramTextUpdate,
  parseTelegramModelSelectionCallbackUpdate
} from "./normalize.ts";
import { parseTelegramLifecycleUpdate, parseTelegramTextUpdate } from "./parse.ts";
import { createTelegramAllowGate, createTelegramDedupGate, type TelegramAllowGateOptions } from "./gates.ts";
import { createInMemoryTelegramAdapterStateStore } from "./state-store.ts";
import {
  createTelegramActorBindingLookup,
  createTelegramOutboundSessionBindingRecorder,
  createTelegramSessionBindingLookup
} from "./resolution.ts";
import { createTelegramTypingLease } from "./typing-lease.ts";
import type {
  TelegramAdapterStateStore,
  TelegramBotClient,
  TelegramBotIdentity,
  TelegramHandleResult,
  TelegramParsedTextUpdate,
  TelegramSendMessageParams
} from "./telegram-types.ts";

const DEFAULT_ERROR_EXPOSURE_MODE: ErrorExposureMode = "passthrough";

async function resolveBotIdentity(input: {
  explicit?: TelegramBotIdentity;
  client: TelegramBotClient;
  memoized?: Promise<TelegramBotIdentity>;
}) {
  if (input.explicit?.userId || input.explicit?.username) {
    return input.explicit;
  }

  if (!input.memoized) {
    return {};
  }

  return input.memoized;
}

function withTelegramReplyFallback(
  turnResult: TurnResult,
  errorExposureMode: ErrorExposureMode = DEFAULT_ERROR_EXPOSURE_MODE
): TurnResult {
  if (turnResult.status === "blocked") {
    return {
      ...turnResult,
      messages: [
        {
          role: "assistant",
          content: createTelegramReplyFallbackText(turnResult, errorExposureMode)
        }
      ]
    };
  }

  const hasAssistantText = turnResult.messages.some((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    return role === "assistant" && typeof content === "string" && content.trim().length > 0;
  });

  if (hasAssistantText) {
    return turnResult;
  }

  return {
    ...turnResult,
    messages: [
      {
        role: "assistant",
        content: createTelegramReplyFallbackText(turnResult, errorExposureMode)
      }
    ]
  };
}

function parseOptionalInteger(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createNormalizedCacheKey(input: {
  source: string;
  workspaceId: string;
  accountId: string;
  senderId: string;
  conversationId: string;
  transportMessageId: string;
}) {
  return JSON.stringify(input);
}

function createAdmissionCacheKey(input: {
  source: string;
  workspaceId: string;
  accountId: string;
  senderId: string;
  conversationId: string;
  conversationScope: string;
  activationHint: {
    pairRequested: boolean;
    explicitActivation: boolean;
    mentionMatched: boolean;
    replyToBot?: boolean;
  };
}) {
  return JSON.stringify(input);
}

function createOutboundLegalityBypass(message: OutboundMessage) {
  return message.metadata?.controlReply === true;
}

type TelegramModelPickerInbound = TelegramParsedTextUpdate | NonNullable<ReturnType<typeof parseTelegramModelSelectionCallbackUpdate>>;

function isModelPickerInbound(parsed: TelegramModelPickerInbound): parsed is NonNullable<ReturnType<typeof parseTelegramModelSelectionCallbackUpdate>> {
  return "callbackQueryId" in parsed;
}

function readModelPickerPayload(message: OutboundMessage) {
  const payload = message.metadata?.commandReplyPayload;
  return payload?.kind === "reply_model_picker" ? payload : undefined;
}

function buildModelPickerReplyMarkup(message: OutboundMessage): TelegramSendMessageParams["replyMarkup"] | undefined {
  const payload = readModelPickerPayload(message);
  if (!payload) {
    return undefined;
  }

  return {
    inline_keyboard: payload.options.map((option) => [{
      text: option.label,
      callback_data: `/models select ${option.providerId}/${option.modelId}`
    }])
  };
}

function trimCallbackAckText(text: string | undefined) {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

async function answerTelegramCallbackQuery(client: TelegramBotClient, input: { callbackQueryId: string; text?: string }) {
  if (!client.answerCallbackQuery) {
    return;
  }

  await client.answerCallbackQuery(input);
}

async function startTypingLeaseSafely(typingLease: { start(): Promise<void> } | null) {
  if (!typingLease) {
    return;
  }

  try {
    await typingLease.start();
  } catch {
    // typing is best-effort transport presence; reply/dispatch flow must continue
  }
}

async function stopTypingLeaseSafely(typingLease: { stop(): Promise<void> } | null) {
  if (!typingLease) {
    return;
  }

  try {
    await typingLease.stop();
  } catch {
    // typing lease cleanup should not mask the real handling result
  }
}

export function createTelegramReplyFallbackText(
  input: Pick<TurnResult, "status" | "warnings" | "blockedBy">,
  errorExposureMode: ErrorExposureMode = DEFAULT_ERROR_EXPOSURE_MODE
) {
  if (input.status === "blocked") {
    if (input.blockedBy === "permission") {
      return "当前请求已被阻塞，等待 Endec 侧审批。请通过 Endec operator / CLI 完成审批或恢复；Telegram 聊天内暂不支持审批。";
    }

    if (input.blockedBy === "user_decision") {
      return "当前请求已暂停，等待 Endec 侧继续/恢复操作。请通过 Endec operator / CLI 继续；Telegram 聊天内暂不支持直接恢复。";
    }

    return "当前请求已被阻塞。请通过 Endec operator / CLI 查看并恢复；Telegram 聊天内暂不支持处理该阻塞状态。";
  }

  return createFallbackOutboundText({
    status: input.status,
    warnings: input.warnings,
    blockedBy: input.blockedBy,
    continuation: undefined
  }, errorExposureMode);
}

export function createTelegramAdapter(input: {
  workspaceId: string;
  accountId: string;
  app: ImAdapterDeps<TelegramParsedTextUpdate>["app"] & {
    im: ImAdapterDeps<TelegramParsedTextUpdate>["app"]["im"] & {
      executeCommand: NonNullable<ImAdapterDeps<TelegramParsedTextUpdate>["app"]["im"]["executeCommand"]>;
      recordPassiveIngress: NonNullable<ImAdapterDeps<TelegramParsedTextUpdate>["app"]["im"]["recordPassiveIngress"]>;
      applyConversationLifecycleEvent: (event: ReturnType<typeof normalizeTelegramLifecycleUpdate>) => Promise<void>;
      evaluateOutboundConversationLegality: (request: {
        source: "telegram";
        accountId: string;
        conversationRef: ReturnType<typeof normalizeTelegramTextUpdate>["conversationRef"];
      }) => Promise<{ status: string }>;
    };
  };
  client: TelegramBotClient;
  stateStore?: TelegramAdapterStateStore;
  botIdentity?: TelegramBotIdentity;
  allow?: TelegramAllowGateOptions;
  requireMentionInGroups?: boolean;
  dedupTtlMs?: number;
  chunkLimit?: number;
  gates?: PreAgentGate[];
  errorExposureMode?: ErrorExposureMode;
}) {
  const stateStore = input.stateStore ?? createInMemoryTelegramAdapterStateStore();
  const baseOutbound = createTelegramOutboundDispatcher({
    client: input.client,
    chunkLimit: input.chunkLimit,
    app: {
      im: input.app.im
    },
    shouldBypassLegalityCheck: createOutboundLegalityBypass
  });
  const outbound = {
    errorExposureMode: input.errorExposureMode,
    async dispatch(messages: OutboundMessage[]) {
      const receipts = [] as Awaited<ReturnType<typeof baseOutbound.dispatch>>;

      for (const message of messages) {
        const replyMarkup = buildModelPickerReplyMarkup(message);
        if (!replyMarkup) {
          const plainReceipts = await baseOutbound.dispatch([message]);
          receipts.push(...plainReceipts.map((receipt, index) => ({
            ...receipt,
            deliveryId: `telegram:${message.turnId}:${receipts.length + index + 1}`
          })));
          continue;
        }

        const legality = !createOutboundLegalityBypass(message)
          ? await input.app.im.evaluateOutboundConversationLegality({
              source: "telegram",
              accountId: message.conversationRef.accountId,
              conversationRef: message.conversationRef
            })
          : { status: "allowed" as const };
        if (legality.status !== "allowed") {
          continue;
        }

        const sent = await input.client.sendMessage({
          chatId: message.conversationRef.peerId,
          text: message.text,
          messageThreadId:
            parseOptionalInteger(message.conversationRef.topicId)
            ?? parseOptionalInteger(message.conversationRef.threadId),
          replyToMessageId: parseOptionalInteger(message.replyToMessageId),
          replyMarkup
        });
        receipts.push({
          deliveryId: `telegram:${message.turnId}:${receipts.length + 1}`,
          messageId: sent.messageId,
          message
        });
      }

      return receipts;
    }
  };
  const botIdentityPromise = input.botIdentity?.userId || input.botIdentity?.username || !input.client.getMe
    ? undefined
    : input.client.getMe().then((user) => ({
        userId: user.id,
        username: user.username
      }));

  const defaultGates: PreAgentGate[] = [
    createTelegramDedupGate({
      stateStore,
      ttlMs: input.dedupTtlMs
    })
  ];
  if (input.allow) {
    defaultGates.push(createTelegramAllowGate(input.allow));
  }
  if (input.gates) {
    defaultGates.push(...input.gates);
  }

  let pendingGateDecision:
    | {
        key: string;
        decision: PreAgentGateDecision;
      }
    | undefined;
  let pendingAdmission:
    | {
        key: string;
        decision: AdmissionDecision;
      }
    | undefined;

  const configuredGates = defaultGates;

  const imAdapter = createImAdapter<TelegramModelPickerInbound>({
    app: {
      shell: {
        executeTurn: async (turnRequest) => withTelegramReplyFallback(
          await input.app.shell.executeTurn(turnRequest),
          input.errorExposureMode
        )
      },
      im: {
        ...input.app.im,
        evaluateInboundAdmission: async (request) => {
          const cacheKey = createAdmissionCacheKey({
            source: request.source,
            workspaceId: request.workspaceId,
            accountId: request.accountId,
            senderId: request.senderId,
            conversationId: request.conversationRef.conversationId,
            conversationScope: request.conversationScope,
            activationHint: request.activationHint
          });

          if (pendingAdmission?.key === cacheKey) {
            const decision = pendingAdmission.decision;
            pendingAdmission = undefined;
            return decision;
          }

          return input.app.im.evaluateInboundAdmission(request);
        }
      }
    },
    normalizeInbound: async (parsed) => {
      const botIdentity = await resolveBotIdentity({
        explicit: input.botIdentity,
        client: input.client,
        memoized: botIdentityPromise
      });

      if (isModelPickerInbound(parsed)) {
        const normalized = normalizeTelegramModelSelectionCallbackUpdate(parsed, {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          botUsername: botIdentity.username
        });
        if (!normalized) {
          throw new Error("Unsupported Telegram callback command.");
        }
        return normalized;
      }

      return normalizeTelegramTextUpdate(parsed, {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        botUserId: botIdentity.userId,
        botUsername: botIdentity.username
      });
    },
    gates: [async (normalized) => {
      const cacheKey = createNormalizedCacheKey({
        source: normalized.source,
        workspaceId: normalized.workspaceId,
        accountId: normalized.accountId,
        senderId: normalized.senderId,
        conversationId: normalized.conversationRef.conversationId,
        transportMessageId: normalized.transportMessageId
      });

      if (pendingGateDecision?.key === cacheKey) {
        const decision = pendingGateDecision.decision;
        pendingGateDecision = undefined;
        return decision;
      }

      return evaluatePreAgentGates(normalized, configuredGates);
    }],
    outbound,
    lookupSessionBinding: createTelegramSessionBindingLookup({
      stateStore
    }),
    lookupActorBinding: createTelegramActorBindingLookup({
      stateStore
    }),
    recordOutboundSessionBinding: createTelegramOutboundSessionBindingRecorder({
      stateStore,
      workspaceId: input.workspaceId,
      accountId: input.accountId
    })
  });

  async function handleParsedInbound(parsed: TelegramModelPickerInbound): Promise<TelegramHandleResult> {
    const botIdentity = await resolveBotIdentity({
      explicit: input.botIdentity,
      client: input.client,
      memoized: botIdentityPromise
    });
    const normalized = isModelPickerInbound(parsed)
      ? normalizeTelegramModelSelectionCallbackUpdate(parsed, {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          botUsername: botIdentity.username
        })
      : normalizeTelegramTextUpdate(parsed, {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          botUserId: botIdentity.userId,
          botUsername: botIdentity.username
        });
    if (!normalized) {
      return {
        status: "ignored",
        reasonCode: "unsupported_update"
      };
    }

    const gateDecision = await evaluatePreAgentGates(normalized, configuredGates);
    pendingGateDecision = {
      key: createNormalizedCacheKey({
        source: normalized.source,
        workspaceId: normalized.workspaceId,
        accountId: normalized.accountId,
        senderId: normalized.senderId,
        conversationId: normalized.conversationRef.conversationId,
        transportMessageId: normalized.transportMessageId
      }),
      decision: gateDecision
    };

    if (gateDecision.kind === "drop") {
      return {
        status: "dropped",
        normalized,
        gateDecision
      } satisfies TelegramHandleResult;
    }

    const admission = await input.app.im.evaluateInboundAdmission({
      source: normalized.source,
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
      conversationRef: normalized.conversationRef,
      conversationScope: normalized.conversationScope,
      activationHint: normalized.activationHint
    });
    pendingAdmission = {
      key: createAdmissionCacheKey({
        source: normalized.source,
        workspaceId: normalized.workspaceId,
        accountId: normalized.accountId,
        senderId: normalized.senderId,
        conversationId: normalized.conversationRef.conversationId,
        conversationScope: normalized.conversationScope,
        activationHint: normalized.activationHint
      }),
      decision: admission
    };

    const shouldType = !isModelPickerInbound(parsed) && admission.expectsUserVisibleReply;
    if (admission.outcome === "drop") {
      return {
        status: "dropped",
        normalized,
        gateDecision: {
          kind: "drop",
          reasonCode: "authority_drop",
          reasonText: "inbound admission dropped this message"
        }
      } satisfies TelegramHandleResult;
    }

    const typingLease = shouldType
      ? createTelegramTypingLease({
          sendTyping: async () => {
            await input.client.sendChatAction({
              chatId: normalized.conversationRef.peerId,
              action: "typing",
              messageThreadId:
                parseOptionalInteger(normalized.conversationRef.topicId)
                ?? parseOptionalInteger(normalized.conversationRef.threadId)
            });
          }
        })
      : null;

    try {
      if (shouldType) {
        await startTypingLeaseSafely(typingLease);
      }
      const handled = await imAdapter.handleInbound(parsed) as TelegramHandleResult;
      if (isModelPickerInbound(parsed) && handled.status === "command_replied") {
        await answerTelegramCallbackQuery(input.client, {
          callbackQueryId: parsed.callbackQueryId,
          text: trimCallbackAckText(handled.outboundMessages[0]?.text) ?? "Done"
        });
      }
      return handled;
    } finally {
      if (shouldType) {
        await stopTypingLeaseSafely(typingLease);
      }
      pendingGateDecision = undefined;
      pendingAdmission = undefined;
    }
  }

  return {
    stateStore,
    client: input.client,

    async handleUpdate(update: unknown): Promise<TelegramHandleResult> {
      const lifecycle = parseTelegramLifecycleUpdate(update);
      if (lifecycle) {
        const lifecycleEvent = normalizeTelegramLifecycleUpdate(lifecycle, {
          accountId: input.accountId,
          workspaceId: input.workspaceId
        });
        await input.app.im.applyConversationLifecycleEvent(lifecycleEvent);
        return {
          status: "lifecycle_applied",
          lifecycleEvent
        };
      }

      const callbackSelection = parseTelegramModelSelectionCallbackUpdate(update);
      if (callbackSelection) {
        return handleParsedInbound(callbackSelection);
      }

      const parsed = parseTelegramTextUpdate(update);
      if (!parsed) {
        return {
          status: "ignored",
          reasonCode: "unsupported_update"
        };
      }

      return handleParsedInbound(parsed);
    },

    async dispatchTurnResultForSession(request: {
      sessionId: string;
      turnResult: TurnResult;
      replyToMessageId?: string;
    }) {
      const binding = await stateStore.loadSessionBindingBySessionId(request.sessionId);
      if (!binding) {
        throw new Error(`no telegram conversation binding found for session ${request.sessionId}`);
      }

      return imAdapter.dispatchTurnResult({
        turnResult: withTelegramReplyFallback(request.turnResult, input.errorExposureMode),
        sessionId: request.sessionId,
        conversationRef: binding.conversationRef,
        replyToMessageId: request.replyToMessageId
      });
    },

    async drainBackgroundOutboxOnce(drainInput: {
      store: {
        claimPendingOutboundEvent: Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"]["claimPendingOutboundEvent"];
        createOutboundDelivery: Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"]["createOutboundDelivery"];
        markDeliverySending: Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"]["markDeliverySending"];
        markDeliveryDelivered: Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"]["markDeliveryDelivered"];
        markDeliveryFailed: Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"]["markDeliveryFailed"];
        markDeliveryUnknown: Parameters<typeof createTelegramBackgroundOutboxDrain>[0]["store"]["markDeliveryUnknown"];
        cancelOutboundEvent?: (input: { outboundEventId: string; now?: string }) => Promise<unknown>;
      };
      leaseOwner: string;
      leaseDurationMs: number;
      chunkLimit?: number;
      now?: string;
    }) {
      const drain = createTelegramBackgroundOutboxDrain({
        store: drainInput.store,
        client: input.client,
        leaseOwner: drainInput.leaseOwner,
        leaseDurationMs: drainInput.leaseDurationMs,
        chunkLimit: drainInput.chunkLimit,
        app: {
          im: input.app.im
        }
      });
      return drain.drainOnce({ now: drainInput.now });
    }
  };
}
