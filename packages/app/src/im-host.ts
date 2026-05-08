import { createHash } from "node:crypto";
import type { TurnRequest, TurnResult } from "@endec/domain";
import type { createSessionStore } from "@endec/sessions";
import type {
  EndecConversationDirectoryEntry,
  EndecImActorResolutionInput,
  EndecImCommandExecutionInput,
  EndecImCommandExecutionResult,
  EndecImConversationActivityInput,
  EndecImHostPort,
  EndecImPassiveIngressInput,
  EndecImSessionResolutionInput
} from "./types.ts";
import { commitTurnProjection } from "./commit-turn.ts";
import { planOwnerInitUpdate } from "./owner-init.ts";

function stableHash(parts: string[]) {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
}

function buildOwnerInitConfirmation(input: {
  updates?: {
    ownerDisplayName?: string;
    assistantDisplayName?: string;
    timezone?: string;
  };
  completionReason: "fields_captured" | "explicit_skip";
}) {
  if (input.completionReason === "explicit_skip") {
    return "Okay — keeping the current defaults. You can tell me your display name or timezone later anytime.";
  }

  const confirmations: string[] = [];
  if (input.updates?.ownerDisplayName) {
    confirmations.push(`your display name = ${input.updates.ownerDisplayName}`);
  }
  if (input.updates?.assistantDisplayName) {
    confirmations.push(`my display name = ${input.updates.assistantDisplayName}`);
  }
  if (input.updates?.timezone) {
    confirmations.push(`your timezone = ${input.updates.timezone}`);
  }

  return confirmations.length > 0
    ? `Saved ${confirmations.join("; ")}.`
    : "Saved your owner setup preferences.";
}

function buildOwnerInitSourceRefs(turnRequest: TurnRequest) {
  return [
    turnRequest.turnId,
    turnRequest.channelContext && typeof turnRequest.channelContext === "object"
      ? (turnRequest.channelContext as { messageId?: unknown }).messageId
      : undefined
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function readStringChannelContextValue(turnRequest: TurnRequest, key: string) {
  if (!turnRequest.channelContext || typeof turnRequest.channelContext !== "object") {
    return undefined;
  }

  const value = (turnRequest.channelContext as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readObservedAtFromTurnRequest(turnRequest: TurnRequest) {
  if (!turnRequest.channelContext || typeof turnRequest.channelContext !== "object") {
    return undefined;
  }

  const value = (turnRequest.channelContext as Record<string, unknown>).messageDate;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function summarizePassiveText(text: string, maxLength = 120) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(empty)";
  }

  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

async function commitOwnerInitConsumption(input: {
  sessionStore: Pick<ReturnType<typeof createSessionStore>, "commitTurn">;
  turnRequest: TurnRequest;
  summary: string;
  sourceRefs: string[];
  now: string;
}) {
  const result: Pick<TurnResult, "turnId" | "sessionId" | "resolvedMode" | "status" | "warnings"> & { messages: Array<{ role: "assistant"; content: string }>; toolEvents: []; approvals: []; artifacts: [] } = {
    turnId: input.turnRequest.turnId,
    sessionId: input.turnRequest.sessionId,
    resolvedMode: input.turnRequest.requestedMode ?? "chat",
    status: "completed",
    warnings: [],
    messages: [{ role: "assistant", content: input.summary }],
    toolEvents: [],
    approvals: [],
    artifacts: []
  };

  await commitTurnProjection({
    sessionStore: input.sessionStore,
    request: input.turnRequest,
    result,
    sourceRefs: input.sourceRefs,
    createdAt: input.now
  });
}

async function recordConversationActivityIfConfigured(input: {
  conversationDirectory?: {
    recordConversationActivity(input: EndecImConversationActivityInput): Promise<EndecConversationDirectoryEntry>;
  };
  turnRequest: TurnRequest;
}) {
  if (!input.conversationDirectory) {
    return undefined;
  }

  const accountId = input.turnRequest.conversationRef?.accountId;
  if (!accountId || (input.turnRequest.source !== "telegram" && input.turnRequest.source !== "feishu") || !input.turnRequest.conversationRef) {
    return undefined;
  }

  return input.conversationDirectory.recordConversationActivity({
    source: input.turnRequest.source,
    accountId,
    conversationRef: input.turnRequest.conversationRef,
    sessionId: input.turnRequest.sessionId,
    conversationLabel: readStringChannelContextValue(input.turnRequest, "chatTitle"),
    observedAt: readObservedAtFromTurnRequest(input.turnRequest)
  });
}

async function commitPassiveIngress(input: {
  sessionStore: Pick<ReturnType<typeof createSessionStore>, "commitTurn">;
  conversationDirectory?: {
    recordConversationActivity(input: EndecImConversationActivityInput): Promise<EndecConversationDirectoryEntry>;
  };
  ingress: EndecImPassiveIngressInput;
}) {
  const { turnRequest } = input.ingress;
  await recordConversationActivityIfConfigured({
    conversationDirectory: input.conversationDirectory,
    turnRequest
  });

  const createdAt = readObservedAtFromTurnRequest(turnRequest) ?? new Date().toISOString();
  const messageId = readStringChannelContextValue(turnRequest, "messageId");
  await input.sessionStore.commitTurn({
    turnId: turnRequest.turnId,
    sessionId: turnRequest.sessionId,
    workspaceId: turnRequest.workspaceId,
    source: turnRequest.source,
    mode: turnRequest.requestedMode ?? "chat",
    status: "completed",
    createdAt,
    events: [{
      eventId: `${turnRequest.turnId}:passive:user`,
      eventKind: "user_message",
      createdAt,
      summary: summarizePassiveText(turnRequest.input),
      text: turnRequest.input,
      sourceRefs: [turnRequest.turnId, messageId].filter((value): value is string => typeof value === "string" && value.length > 0)
    }]
  });
}

export function createEndecImHost(input: {
  sessionStore: Pick<ReturnType<typeof createSessionStore>, "loadById" | "openOrCreateSession" | "commitTurn">;
  authority: Pick<EndecImHostPort, "evaluateInboundAdmission" | "applyConversationLifecycleEvent" | "evaluateOutboundConversationLegality">;
  commandService?: {
    execute(input: EndecImCommandExecutionInput): Promise<EndecImCommandExecutionResult>;
  };
  conversationDirectory?: {
    recordConversationActivity(input: EndecImConversationActivityInput): Promise<EndecConversationDirectoryEntry>;
  };
  ownerInit?: {
    inspectOwnerBinding(input: { source: TurnRequest["source"]; accountId: string }): Promise<{
      ownerBinding?: {
        ownerBindingId: string;
        ownerActorId: string;
      };
      ownerInitState?: {
        status: "pending_prompt" | "prompted" | "completed";
        promptSentAt?: string;
        completionReason?: "fields_captured" | "explicit_skip" | "operator_closed";
        completedAt?: string;
        updatedAt: string;
      };
    }>;
    upsertOwnerPreferences(input: {
      source: TurnRequest["source"];
      accountId: string;
      ownerBindingId: string;
      ownerActorId: string;
      ownerDisplayName?: string;
      assistantDisplayName?: string;
      timezone?: string;
      now: string;
    }): Promise<void>;
    upsertOwnerInitState(input: {
      source: TurnRequest["source"];
      accountId: string;
      ownerBindingId: string;
      status: "prompted" | "completed";
      promptVersion?: 1;
      promptSentAt?: string;
      completionReason?: "fields_captured" | "explicit_skip" | "operator_closed";
      completedAt?: string;
      now: string;
    }): Promise<void>;
    resolveServerTimezone(): string;
  };
}): EndecImHostPort {
  return {
    async resolveSessionId(resolution: EndecImSessionResolutionInput) {
      const boundSessionId = resolution.binding?.sessionId;

      if (boundSessionId) {
        const existing = await input.sessionStore.loadById(boundSessionId);
        if (existing && existing.workspaceId !== resolution.workspaceId) {
          throw new Error(
            `IM session binding ${boundSessionId} belongs to workspace ${existing.workspaceId}, not ${resolution.workspaceId}.`
          );
        }

        return input.sessionStore.openOrCreateSession({
          sessionId: boundSessionId,
          workspaceId: resolution.workspaceId,
          source: resolution.source
        });
      }

      return input.sessionStore.openOrCreateSession({
        workspaceId: resolution.workspaceId,
        source: resolution.source
      });
    },

    async resolveActorId(resolution: EndecImActorResolutionInput) {
      if (resolution.binding?.actorId) {
        return resolution.binding.actorId;
      }

      return `actor_im_${stableHash([
        resolution.source,
        resolution.accountId,
        resolution.senderId
      ])}`;
    },

    async preflightOwnerInit(preflight) {
      if (!input.ownerInit) {
        return { outcome: "continue" };
      }

      if ((preflight.turnRequest.source !== "telegram" && preflight.turnRequest.source !== "feishu") || preflight.conversationScope !== "direct") {
        return { outcome: "continue" };
      }

      const accountId = preflight.turnRequest.conversationRef?.accountId;
      if (!accountId) {
        return { outcome: "continue" };
      }

      const inspection = await input.ownerInit.inspectOwnerBinding({
        source: preflight.turnRequest.source,
        accountId
      });
      if (!inspection.ownerBinding || !inspection.ownerInitState || inspection.ownerInitState.status !== "prompted") {
        return { outcome: "continue" };
      }

      const planned = planOwnerInitUpdate({
        text: preflight.turnRequest.input,
        serverTimezone: input.ownerInit.resolveServerTimezone()
      });
      if (planned.outcome === "no_signal" || planned.outcome === "ambiguous") {
        return { outcome: "continue" };
      }

      const now = new Date().toISOString();
      const sourceRefs = buildOwnerInitSourceRefs(preflight.turnRequest);
      const { ownerBinding } = inspection;

      if (planned.outcome === "apply") {
        await input.ownerInit.upsertOwnerPreferences({
          source: preflight.turnRequest.source,
          accountId,
          ownerBindingId: ownerBinding.ownerBindingId,
          ownerActorId: ownerBinding.ownerActorId,
          ownerDisplayName: planned.updates.ownerDisplayName,
          assistantDisplayName: planned.updates.assistantDisplayName,
          timezone: planned.updates.timezone,
          now
        });
        await input.ownerInit.upsertOwnerInitState({
          source: preflight.turnRequest.source,
          accountId,
          ownerBindingId: ownerBinding.ownerBindingId,
          status: "completed",
          completionReason: "fields_captured",
          completedAt: now,
          now
        });

        const summary = buildOwnerInitConfirmation({
          updates: planned.updates,
          completionReason: "fields_captured"
        });
        await commitOwnerInitConsumption({
          sessionStore: input.sessionStore,
          turnRequest: preflight.turnRequest,
          summary,
          sourceRefs,
          now
        });

        return {
          outcome: "consumed",
          controlKind: "owner_init",
          completionReason: "fields_captured",
          replyText: summary
        };
      }

      await input.ownerInit.upsertOwnerInitState({
        source: preflight.turnRequest.source,
        accountId,
        ownerBindingId: ownerBinding.ownerBindingId,
        status: "completed",
        promptVersion: 1,
        promptSentAt: inspection.ownerInitState.promptSentAt ?? now,
        completionReason: planned.completionReason,
        completedAt: now,
        now
      });

      const summary = buildOwnerInitConfirmation({
        completionReason: planned.completionReason
      });
      await commitOwnerInitConsumption({
        sessionStore: input.sessionStore,
        turnRequest: preflight.turnRequest,
        summary,
        sourceRefs,
        now
      });

      return {
        outcome: "consumed",
        controlKind: "owner_init",
        completionReason: planned.completionReason,
        replyText: summary
      };
    },

    async executeCommand(inputValue) {
      if (!input.commandService) {
        throw new Error("IM command service not configured.");
      }

      await recordConversationActivityIfConfigured({
        conversationDirectory: input.conversationDirectory,
        turnRequest: inputValue.turnRequest
      });

      return input.commandService.execute(inputValue);
    },

    recordPassiveIngress(inputValue) {
      return commitPassiveIngress({
        sessionStore: input.sessionStore,
        conversationDirectory: input.conversationDirectory,
        ingress: inputValue
      });
    },

    recordConversationActivity(inputValue) {
      if (!input.conversationDirectory) {
        throw new Error("Conversation directory not configured.");
      }

      return input.conversationDirectory.recordConversationActivity(inputValue);
    },

    evaluateInboundAdmission(inputValue) {
      return input.authority.evaluateInboundAdmission(inputValue);
    },

    applyConversationLifecycleEvent(inputValue) {
      return input.authority.applyConversationLifecycleEvent(inputValue);
    },

    evaluateOutboundConversationLegality(inputValue) {
      return input.authority.evaluateOutboundConversationLegality(inputValue);
    }
  };
}
