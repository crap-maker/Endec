import type { TurnRequest, TurnResult } from "@endec/domain";
import { dispatchRenderedMessages } from "./outbound.ts";
import { evaluatePreAgentGates } from "./pre-agent-gate.ts";
import { resolveImRequestedMode } from "./requested-mode.ts";
import { createActorResolutionInput, createInboundTurnId, createSessionResolutionInput } from "./session-mapping.ts";
import type { ImAdapterDeps, NormalizedInboundMessage, OutboundMessage } from "./types.ts";

function buildImContext(input: NormalizedInboundMessage): NonNullable<TurnRequest["imContext"]> {
  return {
    activationKind: input.activationKind ?? (input.commandIntent ? "command_execution" : "interactive_turn"),
    boundary: {
      boundaryKey: input.conversationRef.conversationId,
      conversationScope: input.conversationScope,
      disclosureMode: "local_only",
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    },
    commandIntent: input.commandIntent
  };
}

function createReplyToMessageId(input: Pick<NormalizedInboundMessage, "channelContext" | "transportMessageId">) {
  return String(input.channelContext.messageId ?? input.transportMessageId);
}

function createControlOutboundMessage(input: {
  turnId: string;
  sessionId?: string;
  normalized: NormalizedInboundMessage;
  text: string;
  metadata?: OutboundMessage["metadata"];
}) {
  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    conversationRef: input.normalized.conversationRef,
    text: input.text,
    replyToMessageId: createReplyToMessageId(input.normalized),
    metadata: {
      controlReply: true,
      ...(input.metadata ?? {})
    }
  };
}

export function createTurnRequestFromNormalized(
  input: NormalizedInboundMessage,
  resolved: Pick<TurnRequest, "sessionId" | "actorId">
): TurnRequest {
  return {
    turnId: createInboundTurnId(input),
    sessionId: resolved.sessionId,
    workspaceId: input.workspaceId,
    source: input.source,
    actorId: resolved.actorId,
    input: input.text,
    attachments: input.attachments,
    requestedMode: resolveImRequestedMode(input),
    conversationRef: input.conversationRef,
    channelContext: input.channelContext,
    imContext: buildImContext(input),
    taskId: input.taskId,
    resumeFrom: input.resumeFrom,
    requestedCapabilities: input.requestedCapabilities
  };
}

async function resolveTurnRequest<TInbound>(
  normalized: NormalizedInboundMessage,
  deps: Pick<ImAdapterDeps<TInbound>, "app" | "lookupSessionBinding" | "lookupActorBinding">
) {
  const sessionResolutionInput = createSessionResolutionInput(normalized);
  const actorResolutionInput = createActorResolutionInput(normalized);
  const [sessionBinding, actorBinding] = await Promise.all([
    deps.lookupSessionBinding?.(sessionResolutionInput) ?? null,
    deps.lookupActorBinding?.(actorResolutionInput) ?? null
  ]);
  const [sessionId, actorId] = await Promise.all([
    deps.app.im.resolveSessionId({
      ...sessionResolutionInput,
      binding: sessionBinding ?? undefined
    }),
    deps.app.im.resolveActorId({
      ...actorResolutionInput,
      binding: actorBinding ?? undefined
    })
  ]);

  return createTurnRequestFromNormalized(normalized, {
    sessionId,
    actorId
  });
}

export function createImAdapter<TInbound>(deps: ImAdapterDeps<TInbound>) {
  const gates = deps.gates ?? [];

  return {
    async handleInbound(input: TInbound) {
      const normalized = await deps.normalizeInbound(input);
      const gateDecision = await evaluatePreAgentGates(normalized, gates);

      if (gateDecision.kind === "drop") {
        return {
          status: "dropped" as const,
          normalized,
          gateDecision
        };
      }

      const admission = await deps.app.im.evaluateInboundAdmission({
        source: normalized.source,
        workspaceId: normalized.workspaceId,
        accountId: normalized.accountId,
        senderId: normalized.senderId,
        conversationRef: normalized.conversationRef,
        conversationScope: normalized.conversationScope,
        activationHint: normalized.activationHint
      });

      if (admission.outcome === "drop") {
        return {
          status: "dropped" as const,
          normalized,
          gateDecision
        };
      }

      if (admission.outcome === "reply_direct" || admission.outcome === "reject_direct") {
        const outboundMessages = admission.directReply?.text?.trim()
          ? [createControlOutboundMessage({
              turnId: `im_control_${admission.outcome}`,
              normalized,
              text: admission.directReply.text,
              metadata: {
                outcome: admission.outcome
              }
            })]
          : [];
        const deliveryReceipts = outboundMessages.length > 0
          ? await deps.outbound.dispatch(outboundMessages)
          : [];

        return {
          status: "direct_replied" as const,
          normalized,
          gateDecision,
          admissionDecision: admission,
          outboundMessages,
          deliveryReceipts
        };
      }

      const turnRequest = await resolveTurnRequest(normalized, deps);

      if (admission.outcome === "passive_ingest") {
        if (!deps.app.im.recordPassiveIngress) {
          throw new Error("IM passive-ingest recorder not configured.");
        }

        await deps.app.im.recordPassiveIngress({ turnRequest });

        return {
          status: "passive_ingested" as const,
          normalized,
          gateDecision,
          admissionDecision: admission,
          turnRequest
        };
      }

      if (normalized.commandIntent) {
        if (!deps.app.im.executeCommand) {
          throw new Error("IM command service not configured.");
        }

        const commandResult = await deps.app.im.executeCommand({
          turnRequest,
          commandIntent: normalized.commandIntent,
          conversationScope: normalized.conversationScope
        });

        if (commandResult.kind === "reply_text" || commandResult.kind === "reply_model_picker") {
          const outboundMessages = commandResult.replyText.trim()
            ? [createControlOutboundMessage({
                turnId: turnRequest.turnId,
                sessionId: turnRequest.sessionId,
                normalized,
                text: commandResult.replyText,
                metadata: {
                  commandName: normalized.commandIntent.name,
                  commandReply: true,
                  ...(commandResult.kind === "reply_model_picker"
                    ? { commandReplyPayload: commandResult }
                    : {})
                }
              })]
            : [];
          const deliveryReceipts = outboundMessages.length > 0
            ? await deps.outbound.dispatch(outboundMessages)
            : [];
          if (commandResult.afterReplyDelivered) {
            await commandResult.afterReplyDelivered();
          }

          return {
            status: "command_replied" as const,
            normalized,
            gateDecision,
            admissionDecision: admission,
            turnRequest,
            outboundMessages,
            deliveryReceipts
          };
        }

        const turnResult = await deps.app.shell.executeTurn(commandResult.turnRequest);
        const outbound = await dispatchRenderedMessages({
          dispatcher: deps.outbound,
          turnResult,
          sessionId: commandResult.turnRequest.sessionId,
          conversationRef: normalized.conversationRef,
          replyToMessageId: createReplyToMessageId(normalized),
          recordOutboundSessionBinding: deps.recordOutboundSessionBinding
        });

        return {
          status: "dispatched" as const,
          normalized,
          gateDecision,
          turnRequest: commandResult.turnRequest,
          turnResult,
          outboundMessages: outbound.messages,
          deliveryReceipts: outbound.receipts
        };
      }

      const preflightDecision = await deps.app.im.preflightOwnerInit?.({
        turnRequest,
        conversationScope: normalized.conversationScope
      });
      if (preflightDecision?.outcome === "consumed") {
        const outboundMessages = preflightDecision.replyText.trim()
          ? [createControlOutboundMessage({
              turnId: turnRequest.turnId,
              sessionId: turnRequest.sessionId,
              normalized,
              text: preflightDecision.replyText,
              metadata: {
                controlKind: preflightDecision.controlKind,
                completionReason: preflightDecision.completionReason,
                preflightConsumed: true
              }
            })]
          : [];
        const deliveryReceipts = outboundMessages.length > 0
          ? await deps.outbound.dispatch(outboundMessages)
          : [];

        return {
          status: "preflight_consumed" as const,
          normalized,
          gateDecision,
          preflightDecision,
          turnRequest,
          outboundMessages,
          deliveryReceipts
        };
      }

      const turnResult = await deps.app.shell.executeTurn(turnRequest);
      const outbound = await dispatchRenderedMessages({
        dispatcher: deps.outbound,
        turnResult,
        sessionId: turnRequest.sessionId,
        conversationRef: normalized.conversationRef,
        replyToMessageId: createReplyToMessageId(normalized),
        recordOutboundSessionBinding: deps.recordOutboundSessionBinding
      });

      return {
        status: "dispatched" as const,
        normalized,
        gateDecision,
        turnRequest,
        turnResult,
        outboundMessages: outbound.messages,
        deliveryReceipts: outbound.receipts
      };
    },

    async dispatchTurnResult(input: {
      turnResult: TurnResult;
      sessionId: string;
      conversationRef: NormalizedInboundMessage["conversationRef"];
      replyToMessageId?: string;
    }) {
      return dispatchRenderedMessages({
        dispatcher: deps.outbound,
        turnResult: input.turnResult,
        sessionId: input.sessionId,
        conversationRef: input.conversationRef,
        replyToMessageId: input.replyToMessageId,
        recordOutboundSessionBinding: deps.recordOutboundSessionBinding
      });
    }
  };
}
