import { z } from "zod";
import { ConversationPeerKindSchema, ConversationRefSchema, SourceSchema, type ConversationPeerKind, type ConversationRef } from "./turn.ts";

const BaseOwnerInitStateSchema = z.object({
  source: SourceSchema,
  accountId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  ownerBindingId: z.string(),
  promptVersion: z.literal(1).default(1),
  updatedAt: z.string()
});

export const PAIRING_NOTICE_CONTRACT_VERSION = "im.authority-control.v1" as const;
export const DEFAULT_PAIR_CLAIM_TTL_MS = 10 * 60 * 1000;

export const InstanceAuthorityStatusSchema = z.enum(["unbound", "bound"]);
export const InstanceAuthorityStateSchema = z.object({
  source: SourceSchema,
  accountId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  ownerBindingId: z.string().optional(),
  status: InstanceAuthorityStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

export const InstanceOwnerBindingStatusSchema = z.enum(["active", "revoked"]);
export const InstanceOwnerBindingSchema = z.object({
  ownerBindingId: z.string(),
  source: SourceSchema,
  accountId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  ownerSubjectRef: z.string(),
  ownerActorId: z.string(),
  pairedConversationRef: ConversationRefSchema,
  consumedClaimId: z.string(),
  status: InstanceOwnerBindingStatusSchema,
  boundAt: z.string(),
  revokedAt: z.string().optional(),
  revokedReason: z.string().optional(),
  approvedByOperatorId: z.string().optional(),
  revokedByOperatorId: z.string().optional()
});

export const OwnerPreferencesSchema = z.object({
  source: SourceSchema,
  accountId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  ownerBindingId: z.string(),
  ownerActorId: z.string(),
  ownerDisplayName: z.string().optional(),
  assistantDisplayName: z.string().optional(),
  timezone: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const OwnerTimezoneSourceSchema = z.enum(["owner_preference", "server_default"]);
export const ResolvedOwnerPreferencesSchema = z.object({
  ownerDisplayName: z.string().optional(),
  assistantDisplayName: z.string(),
  timezone: z.string(),
  timezoneSource: OwnerTimezoneSourceSchema
});

export const OwnerInitStatusSchema = z.enum(["pending_prompt", "prompted", "completed"]);
export const OwnerInitCompletionReasonSchema = z.enum(["fields_captured", "explicit_skip", "operator_closed"]);
export const OwnerInitStateSchema = z.discriminatedUnion("status", [
  BaseOwnerInitStateSchema.extend({
    status: z.literal("pending_prompt"),
    promptSentAt: z.undefined().optional(),
    completionReason: z.undefined().optional(),
    completedAt: z.undefined().optional()
  }),
  BaseOwnerInitStateSchema.extend({
    status: z.literal("prompted"),
    promptSentAt: z.string(),
    completionReason: z.undefined().optional(),
    completedAt: z.undefined().optional()
  }),
  BaseOwnerInitStateSchema.extend({
    status: z.literal("completed"),
    promptSentAt: z.string().optional(),
    completionReason: OwnerInitCompletionReasonSchema,
    completedAt: z.string()
  })
]);

export const PairClaimStatusSchema = z.enum(["pending", "consumed", "expired", "superseded"]);
export const PairClaimSchema = z.object({
  claimId: z.string(),
  source: SourceSchema,
  accountId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  requesterSubjectRef: z.string(),
  requesterActorId: z.string(),
  requestWorkspaceId: z.string().optional(),
  requestSessionId: z.string().optional(),
  requestConversationRef: ConversationRefSchema,
  pairCode: z.string().regex(/^[A-Z0-9]{8}$/),
  status: PairClaimStatusSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  consumedAt: z.string().optional(),
  supersededAt: z.string().optional(),
  approvedByOperatorId: z.string().optional()
});

export const TrustedConversationCoverageSchema = z.enum(["exact", "descendants"]);
export const TrustedConversationGrantKindSchema = z.enum(["owner_auto"]);
export const TrustedConversationBindingStatusSchema = z.enum(["active", "revoked"]);
export const TrustedConversationBindingSchema = z.object({
  trustId: z.string(),
  source: SourceSchema,
  accountId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  conversationRef: ConversationRefSchema,
  conversationKey: z.string(),
  coverage: TrustedConversationCoverageSchema,
  grantKind: TrustedConversationGrantKindSchema,
  grantedByOwnerBindingId: z.string(),
  status: TrustedConversationBindingStatusSchema,
  grantedAt: z.string(),
  revokedAt: z.string().optional(),
  revokedReason: z.string().optional(),
  revokedByOperatorId: z.string().optional()
});

export const ConversationScopeSchema = z.enum(["direct", "shared", "broadcast", "unknown"]);
export const ActivationHintSchema = z.object({
  pairRequested: z.boolean().default(false),
  explicitActivation: z.boolean().default(false),
  mentionMatched: z.boolean().default(false),
  replyToBot: z.boolean().optional()
});

export const AuthorityDirectReplySchema = z.object({
  text: z.string()
});

export const AdmissionDecisionOutcomeSchema = z.enum(["dispatch_turn", "reply_direct", "reject_direct", "drop", "passive_ingest"]);
export const AdmissionDecisionSchema = z.object({
  outcome: AdmissionDecisionOutcomeSchema,
  expectsUserVisibleReply: z.boolean(),
  directReply: AuthorityDirectReplySchema.optional()
});

export const ConversationLifecycleEventKindSchema = z.enum(["bot_added", "bot_removed", "owner_left"]);
export const ConversationLifecycleEventSchema = z.object({
  source: SourceSchema,
  accountId: z.string(),
  conversationRef: ConversationRefSchema,
  conversationScope: ConversationScopeSchema,
  eventKind: ConversationLifecycleEventKindSchema,
  subjectRef: z.string().optional(),
  actorId: z.string().optional(),
  observedAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const OutboundConversationLegalityStatusSchema = z.enum(["allowed", "blocked"]);
export const OutboundConversationLegalityReasonSchema = z.enum([
  "owner_direct",
  "trusted_conversation",
  "authority_unbound",
  "owner_mismatch",
  "conversation_not_trusted",
  "unsupported_conversation_scope"
]);
export const OutboundConversationLegalitySchema = z.object({
  status: OutboundConversationLegalityStatusSchema,
  reason: OutboundConversationLegalityReasonSchema,
  ownerGeneration: z.number().int().nonnegative().optional(),
  ownerBindingId: z.string().optional(),
  trustId: z.string().optional()
});

export const AuthorityControlNoticeKindSchema = z.enum(["pairing_success", "trusted_conversation_granted"]);
export const AuthorityControlPayloadSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  contractVersion: z.literal(PAIRING_NOTICE_CONTRACT_VERSION).default(PAIRING_NOTICE_CONTRACT_VERSION),
  noticeKind: AuthorityControlNoticeKindSchema,
  message: z.string(),
  ownerBindingId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  conversationRef: ConversationRefSchema
});

const AuthorityInstanceTargetSchema = z.object({
  source: SourceSchema,
  accountId: z.string()
});

export const InspectOwnerBindingRequestSchema = AuthorityInstanceTargetSchema;
export const InspectOwnerBindingResultSchema = z.object({
  state: InstanceAuthorityStateSchema,
  ownerBinding: InstanceOwnerBindingSchema.optional(),
  ownerPreferences: OwnerPreferencesSchema.optional(),
  resolvedOwnerPreferences: ResolvedOwnerPreferencesSchema.optional(),
  ownerInitState: OwnerInitStateSchema.optional()
});

export const ListPairClaimsRequestSchema = AuthorityInstanceTargetSchema.extend({
  includeInactive: z.boolean().optional()
});
export const ListPairClaimsResultSchema = z.object({
  state: InstanceAuthorityStateSchema,
  claims: z.array(PairClaimSchema)
});

export const ApprovePairClaimRequestSchema = AuthorityInstanceTargetSchema.extend({
  claimId: z.string().optional(),
  pairCode: z.string().regex(/^[A-Z0-9]{8}$/).optional(),
  operatorActorId: z.string()
}).refine((value) => Boolean(value.claimId || value.pairCode), {
  message: "approve pair claim requires claimId or pairCode",
  path: ["claimId"]
});
export const ApprovePairClaimOutcomeSchema = z.enum([
  "approved",
  "claim_not_found",
  "claim_not_pending",
  "claim_expired",
  "authority_already_bound",
  "generation_mismatch"
]);
export const PairingSuccessNoticeStatusSchema = z.enum([
  "not_approved",
  "enqueued",
  "skipped_missing_request_routing",
  "impossible_missing_approved_claim_context"
]);
export const ApprovePairClaimResultSchema = z.object({
  outcome: ApprovePairClaimOutcomeSchema,
  state: InstanceAuthorityStateSchema,
  ownerBinding: InstanceOwnerBindingSchema.optional(),
  consumedClaim: PairClaimSchema.optional(),
  supersededClaimCount: z.number().int().nonnegative().default(0),
  pairingSuccessNoticeStatus: PairingSuccessNoticeStatusSchema
});

export const ResetOwnerBindingRequestSchema = AuthorityInstanceTargetSchema.extend({
  operatorActorId: z.string(),
  reason: z.string().optional()
});
export const ResetOwnerBindingResultSchema = z.object({
  outcome: z.enum(["reset", "already_unbound"]),
  state: InstanceAuthorityStateSchema,
  revokedOwnerBinding: InstanceOwnerBindingSchema.optional(),
  revokedTrustCount: z.number().int().nonnegative(),
  supersededClaimCount: z.number().int().nonnegative(),
  newOwnerGeneration: z.number().int().nonnegative()
});

export const ListTrustedConversationsRequestSchema = AuthorityInstanceTargetSchema.extend({
  includeInactive: z.boolean().optional()
});
export const ListTrustedConversationsResultSchema = z.object({
  state: InstanceAuthorityStateSchema,
  bindings: z.array(TrustedConversationBindingSchema)
});

export const RevokeTrustedConversationRequestSchema = AuthorityInstanceTargetSchema.extend({
  trustId: z.string().optional(),
  conversationKey: z.string().optional(),
  operatorActorId: z.string(),
  reason: z.string().optional()
}).refine((value) => Boolean(value.trustId || value.conversationKey), {
  message: "revoke trusted conversation requires trustId or conversationKey",
  path: ["trustId"]
});
export const RevokeTrustedConversationResultSchema = z.object({
  outcome: z.enum(["revoked", "not_found", "already_revoked"]),
  state: InstanceAuthorityStateSchema,
  revokedBinding: TrustedConversationBindingSchema.optional(),
  affectedOutboundLegality: z.boolean().default(false)
});

export function deriveConversationScopeFromPeerKind(peerKind: ConversationPeerKind) {
  switch (peerKind) {
    case "dm":
      return "direct" satisfies ConversationScope;
    case "group":
      return "shared" satisfies ConversationScope;
    case "channel":
      return "broadcast" satisfies ConversationScope;
    case "unknown":
    default:
      return "unknown" satisfies ConversationScope;
  }
}

export function deriveTrustedConversationKey(
  conversationRef: Pick<ConversationRef, "conversationId" | "baseConversationId">,
  coverage: TrustedConversationCoverage
) {
  return coverage === "descendants"
    ? conversationRef.baseConversationId ?? conversationRef.conversationId
    : conversationRef.conversationId;
}

export function matchesTrustedConversationBinding(
  binding: Pick<TrustedConversationBinding, "coverage" | "conversationKey">,
  conversationRef: Pick<ConversationRef, "conversationId" | "baseConversationId" | "parentConversationId">
) {
  if (binding.coverage === "exact") {
    return conversationRef.conversationId === binding.conversationKey;
  }

  const baseOrCurrent = conversationRef.baseConversationId ?? conversationRef.conversationId;
  if (baseOrCurrent === binding.conversationKey) {
    return true;
  }

  if (conversationRef.parentConversationId === binding.conversationKey) {
    return true;
  }

  return conversationRef.conversationId === binding.conversationKey
    || conversationRef.conversationId.startsWith(`${binding.conversationKey}:`)
    || Boolean(conversationRef.parentConversationId?.startsWith(`${binding.conversationKey}:`));
}

export function isPairClaimCurrentGeneration(claim: Pick<PairClaim, "ownerGeneration">, ownerGeneration: number) {
  return claim.ownerGeneration === ownerGeneration;
}

export function isTrustedConversationCurrentGeneration(
  binding: Pick<TrustedConversationBinding, "ownerGeneration">,
  ownerGeneration: number
) {
  return binding.ownerGeneration === ownerGeneration;
}

export function isPairClaimExpired(claim: Pick<PairClaim, "expiresAt">, now = new Date().toISOString()) {
  return claim.expiresAt <= now;
}

export type InstanceAuthorityStatus = z.infer<typeof InstanceAuthorityStatusSchema>;
export type InstanceAuthorityState = z.infer<typeof InstanceAuthorityStateSchema>;
export type InstanceOwnerBindingStatus = z.infer<typeof InstanceOwnerBindingStatusSchema>;
export type InstanceOwnerBinding = z.infer<typeof InstanceOwnerBindingSchema>;
export type OwnerPreferences = z.infer<typeof OwnerPreferencesSchema>;
export type OwnerTimezoneSource = z.infer<typeof OwnerTimezoneSourceSchema>;
export type ResolvedOwnerPreferences = z.infer<typeof ResolvedOwnerPreferencesSchema>;
export type OwnerInitStatus = z.infer<typeof OwnerInitStatusSchema>;
export type OwnerInitCompletionReason = z.infer<typeof OwnerInitCompletionReasonSchema>;
export type OwnerInitState = z.infer<typeof OwnerInitStateSchema>;
export type PairClaimStatus = z.infer<typeof PairClaimStatusSchema>;
export type PairClaim = z.infer<typeof PairClaimSchema>;
export type TrustedConversationCoverage = z.infer<typeof TrustedConversationCoverageSchema>;
export type TrustedConversationGrantKind = z.infer<typeof TrustedConversationGrantKindSchema>;
export type TrustedConversationBindingStatus = z.infer<typeof TrustedConversationBindingStatusSchema>;
export type TrustedConversationBinding = z.infer<typeof TrustedConversationBindingSchema>;
export type ConversationScope = z.infer<typeof ConversationScopeSchema>;
export type ActivationHint = z.infer<typeof ActivationHintSchema>;
export type AuthorityDirectReply = z.infer<typeof AuthorityDirectReplySchema>;
export type AdmissionDecisionOutcome = z.infer<typeof AdmissionDecisionOutcomeSchema>;
export type AdmissionDecision = z.infer<typeof AdmissionDecisionSchema>;
export type ConversationLifecycleEventKind = z.infer<typeof ConversationLifecycleEventKindSchema>;
export type ConversationLifecycleEvent = z.infer<typeof ConversationLifecycleEventSchema>;
export type OutboundConversationLegalityStatus = z.infer<typeof OutboundConversationLegalityStatusSchema>;
export type OutboundConversationLegalityReason = z.infer<typeof OutboundConversationLegalityReasonSchema>;
export type OutboundConversationLegality = z.infer<typeof OutboundConversationLegalitySchema>;
export type AuthorityControlNoticeKind = z.infer<typeof AuthorityControlNoticeKindSchema>;
export type AuthorityControlPayload = z.infer<typeof AuthorityControlPayloadSchema>;
export type InspectOwnerBindingRequest = z.infer<typeof InspectOwnerBindingRequestSchema>;
export type InspectOwnerBindingResult = z.infer<typeof InspectOwnerBindingResultSchema>;
export type ListPairClaimsRequest = z.infer<typeof ListPairClaimsRequestSchema>;
export type ListPairClaimsResult = z.infer<typeof ListPairClaimsResultSchema>;
export type ApprovePairClaimRequest = z.infer<typeof ApprovePairClaimRequestSchema>;
export type ApprovePairClaimRequestInput = z.input<typeof ApprovePairClaimRequestSchema>;
export type ApprovePairClaimOutcome = z.infer<typeof ApprovePairClaimOutcomeSchema>;
export type PairingSuccessNoticeStatus = z.infer<typeof PairingSuccessNoticeStatusSchema>;
export type ApprovePairClaimResult = z.infer<typeof ApprovePairClaimResultSchema>;
export type ResetOwnerBindingRequest = z.infer<typeof ResetOwnerBindingRequestSchema>;
export type ResetOwnerBindingRequestInput = z.input<typeof ResetOwnerBindingRequestSchema>;
export type ResetOwnerBindingResult = z.infer<typeof ResetOwnerBindingResultSchema>;
export type ListTrustedConversationsRequest = z.infer<typeof ListTrustedConversationsRequestSchema>;
export type ListTrustedConversationsResult = z.infer<typeof ListTrustedConversationsResultSchema>;
export type RevokeTrustedConversationRequest = z.infer<typeof RevokeTrustedConversationRequestSchema>;
export type RevokeTrustedConversationRequestInput = z.input<typeof RevokeTrustedConversationRequestSchema>;
export type RevokeTrustedConversationResult = z.infer<typeof RevokeTrustedConversationResultSchema>;
