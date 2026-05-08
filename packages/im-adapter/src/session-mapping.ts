import { createHash } from "node:crypto";
import type { ActorResolutionInput, NormalizedInboundMessage, SessionResolutionInput } from "./types.ts";

function stableHash(parts: string[]) {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
}

export function createSessionResolutionInput(
  input: Pick<NormalizedInboundMessage, "source" | "workspaceId" | "accountId" | "conversationRef">
): SessionResolutionInput {
  return {
    source: input.source,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    conversationRef: input.conversationRef
  };
}

export function createActorResolutionInput(
  input: Pick<NormalizedInboundMessage, "source" | "workspaceId" | "accountId" | "senderId" | "conversationRef">
): ActorResolutionInput {
  return {
    source: input.source,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    senderId: input.senderId,
    conversationRef: input.conversationRef
  };
}

export function createInboundTurnId(
  input: Pick<NormalizedInboundMessage, "source" | "workspaceId" | "accountId" | "transportMessageId" | "conversationRef">
) {
  return `turn_im_${stableHash([
    input.source,
    input.workspaceId,
    input.accountId,
    input.conversationRef.conversationId,
    input.transportMessageId
  ])}`;
}
