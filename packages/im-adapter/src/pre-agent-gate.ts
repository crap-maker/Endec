import { deriveConversationScopeFromPeerKind } from "@endec/domain";
import type { NormalizedInboundMessage, PreAgentGate, PreAgentGateDecision } from "./types.ts";

const ALLOW_DECISION = { kind: "allow" } as const satisfies PreAgentGateDecision;

export async function evaluatePreAgentGates(input: NormalizedInboundMessage, gates: PreAgentGate[] = []) {
  for (const gate of gates) {
    const decision = await gate(input);
    if (decision.kind === "drop") {
      return decision;
    }
  }

  return ALLOW_DECISION;
}

export function createMentionGate(): PreAgentGate {
  return (input) => {
    if (deriveConversationScopeFromPeerKind(input.conversationRef.peerKind) === "direct" || input.activationHint.mentionMatched) {
      return ALLOW_DECISION;
    }

    return {
      kind: "drop",
      reasonCode: "mention_required",
      reasonText: "group traffic must explicitly mention the bot before entering the agent"
    } as const;
  };
}
