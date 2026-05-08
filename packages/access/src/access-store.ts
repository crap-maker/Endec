import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  ApprovePairClaimRequestSchema,
  type ConversationLifecycleEvent,
  ConversationDirectoryEntrySchema,
  ConversationLifecycleEventSchema,
  ModelOverrideRecordSchema,
  PersonaScopeKindSchema,
  type ConversationDirectoryEntry,
  type ConversationRef,
  type ModelOverrideRecord,
  type PersonaScopeKind,
  DEFAULT_PAIR_CLAIM_TTL_MS,
  type InstanceAuthorityState,
  type InstanceOwnerBinding,
  type OwnerInitState,
  OwnerInitStateSchema,
  type OwnerPreferences,
  OwnerPreferencesSchema,
  type PairClaim,
  PairClaimSchema,
  type Source,
  type TrustedConversationBinding,
  TrustedConversationBindingSchema,
  TrustedConversationGrantKindSchema,
  type TrustedConversationCoverage,
  deriveTrustedConversationKey,
  isPairClaimExpired,
  isTrustedConversationCurrentGeneration,
  matchesTrustedConversationBinding
} from "@endec/domain";
import { InstanceAuthorityStateSchema, InstanceOwnerBindingSchema } from "@endec/domain";
import { ensureAccessSchema } from "./schema.ts";

type AuthorityStateRow = {
  source: Source;
  accountId: string;
  ownerGeneration: number;
  ownerBindingId: string | null;
  status: InstanceAuthorityState["status"];
  createdAt: string;
  updatedAt: string;
};

type OwnerBindingRow = {
  ownerBindingId: string;
  source: Source;
  accountId: string;
  ownerGeneration: number;
  ownerSubjectRef: string;
  ownerActorId: string;
  pairedConversationRefJson: string;
  consumedClaimId: string;
  status: InstanceOwnerBinding["status"];
  boundAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  approvedByOperatorId: string | null;
  revokedByOperatorId: string | null;
};

type PairClaimRow = {
  claimId: string;
  source: Source;
  accountId: string;
  ownerGeneration: number;
  requesterSubjectRef: string;
  requesterActorId: string;
  requestWorkspaceId: string | null;
  requestSessionId: string | null;
  requestConversationRefJson: string;
  pairCode: string;
  status: PairClaim["status"];
  expiresAt: string;
  createdAt: string;
  consumedAt: string | null;
  supersededAt: string | null;
  approvedByOperatorId: string | null;
};

type TrustedConversationRow = {
  trustId: string;
  source: Source;
  accountId: string;
  ownerGeneration: number;
  conversationRefJson: string;
  conversationKey: string;
  coverage: TrustedConversationBinding["coverage"];
  grantKind: TrustedConversationBinding["grantKind"];
  grantedByOwnerBindingId: string;
  status: TrustedConversationBinding["status"];
  grantedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  revokedByOperatorId: string | null;
};

type TrustedConversationReacquireBoundaryRow = {
  source: Source;
  accountId: string;
  ownerGeneration: number;
  conversationKey: string;
  coverage: TrustedConversationBinding["coverage"];
  grantKind: TrustedConversationBinding["grantKind"];
  botAbsentObservedAt: string;
};

type OwnerPreferencesRow = {
  source: Source;
  accountId: string;
  ownerGeneration: number;
  ownerBindingId: string;
  ownerActorId: string;
  ownerDisplayName: string | null;
  assistantDisplayName: string | null;
  timezone: string | null;
  createdAt: string;
  updatedAt: string;
};

type OwnerInitStateRow = {
  source: Source;
  accountId: string;
  ownerGeneration: number;
  ownerBindingId: string;
  status: OwnerInitState["status"];
  promptVersion: number;
  promptSentAt: string | null;
  completionReason: NonNullable<OwnerInitState["completionReason"]> | null;
  completedAt: string | null;
  updatedAt: string;
};

type ConversationDirectoryRow = {
  source: Source;
  accountId: string;
  conversationKey: string;
  baseConversationKey: string | null;
  conversationLabel: string | null;
  latestSessionId: string | null;
  observedAt: string;
};

type PersonaProfileRow = {
  source: Source;
  accountId: string;
  ownerBindingId: string;
  ownerGeneration: number;
  scopeKind: PersonaScopeKind;
  conversationKey: string;
  styleInstructions: string;
  behaviorInstructions: string;
  updatedByActorId: string;
  createdAt: string;
  updatedAt: string;
};

type ModelOverrideRow = {
  source: Source;
  accountId: string;
  modelTier: ModelOverrideRecord["modelTier"];
  providerId: string;
  modelId: string;
  updatedByActorId: string;
  updatedAt: string;
};

type ProviderControlRow = {
  source: Source;
  accountId: string;
  providerId: string | null;
  modelId: string | null;
  baseUrlOverride: string | null;
  updatedByActorId: string;
  updatedAt: string;
};

type ProviderSecretRow = {
  source: Source;
  accountId: string;
  apiKey: string;
  updatedByActorId: string;
  updatedAt: string;
};

type PersonaProfileRecord = {
  source: Source;
  accountId: string;
  ownerBindingId: string;
  ownerGeneration: number;
  scopeKind: PersonaScopeKind;
  conversationKey?: string;
  styleInstructions: string;
  behaviorInstructions: string;
  updatedByActorId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateOrReusePairClaimInput = {
  source: Source;
  accountId: string;
  requesterSubjectRef: string;
  requesterActorId: string;
  requestWorkspaceId: string;
  requestSessionId?: string;
  requestConversationRef: ConversationRef;
  now?: string;
};

export type CreateOrReusePairClaimResult = {
  outcome: "created" | "reused" | "authority_bound";
  state: InstanceAuthorityState;
  claim?: PairClaim;
};

export type ApprovePairClaimInput = {
  source: Source;
  accountId: string;
  claimId?: string;
  pairCode?: string;
  operatorActorId: string;
  now?: string;
};

export type ApprovePairClaimResult = {
  outcome: "approved" | "claim_not_found" | "claim_not_pending" | "claim_expired" | "authority_already_bound" | "generation_mismatch";
  state: InstanceAuthorityState;
  ownerBinding?: InstanceOwnerBinding;
  consumedClaim?: PairClaim;
  supersededClaimCount: number;
};

export type ResetOwnerBindingInput = {
  source: Source;
  accountId: string;
  operatorActorId: string;
  reason?: string;
  now?: string;
};

export type ResetOwnerBindingResult = {
  outcome: "reset" | "already_unbound";
  state: InstanceAuthorityState;
  revokedOwnerBinding?: InstanceOwnerBinding;
  revokedTrustCount: number;
  supersededClaimCount: number;
  newOwnerGeneration: number;
};

export type EnsureTrustedConversationInput = {
  source: Source;
  accountId: string;
  conversationRef: ConversationRef;
  coverage: TrustedConversationCoverage;
  grantKind: TrustedConversationBinding["grantKind"];
  now?: string;
};

export type EnsureTrustedConversationResult = {
  outcome: "created" | "existing_active" | "revoked" | "authority_unbound";
  state: InstanceAuthorityState;
  binding?: TrustedConversationBinding;
};

export type RevokeTrustedConversationInput = {
  source: Source;
  accountId: string;
  trustId?: string;
  conversationKey?: string;
  operatorActorId: string;
  reason?: string;
  now?: string;
};

export type RevokeTrustedConversationResult = {
  outcome: "revoked" | "not_found" | "already_revoked";
  state: InstanceAuthorityState;
  revokedBinding?: TrustedConversationBinding;
  affectedOutboundLegality: boolean;
};

export type MatchTrustedConversationInput = {
  source: Source;
  accountId: string;
  conversationRef: ConversationRef;
};

export type ListScopeInput = {
  source: Source;
  accountId: string;
  includeInactive?: boolean;
  now?: string;
};

export type UpsertOwnerPreferencesInput = {
  source: Source;
  accountId: string;
  ownerBindingId: string;
  ownerActorId: string;
  ownerDisplayName?: string | null;
  assistantDisplayName?: string | null;
  timezone?: string | null;
  now?: string;
};

export type UpsertOwnerInitStateInput = {
  source: Source;
  accountId: string;
  ownerBindingId: string;
  status: OwnerInitState["status"];
  promptVersion?: 1;
  promptSentAt?: string;
  completionReason?: NonNullable<OwnerInitState["completionReason"]>;
  completedAt?: string;
  now?: string;
};

export type GetOwnerScopedStateInput = {
  source: Source;
  accountId: string;
  now?: string;
};

export type MarkOwnerInitPromptedInput = {
  source: Source;
  accountId: string;
  ownerBindingId: string;
  now?: string;
};

export type UpsertConversationDirectoryEntryInput = ConversationDirectoryEntry;
export type ResolveConversationTargetInput = {
  source: Source;
  accountId: string;
  target: string;
};
export type UpsertPersonaProfileInput = {
  source: Source;
  accountId: string;
  ownerBindingId: string;
  ownerGeneration: number;
  scopeKind: PersonaScopeKind;
  conversationKey?: string;
  styleInstructions: string;
  behaviorInstructions: string;
  updatedByActorId: string;
  now?: string;
};
export type PersonaProfileLookupInput = {
  source: Source;
  accountId: string;
  ownerGeneration: number;
  scopeKind: PersonaScopeKind;
  conversationKey?: string;
};
export type ClearPersonaProfileInput = PersonaProfileLookupInput;
export type ListPersonaProfilesInput = {
  source: Source;
  accountId: string;
  ownerGeneration?: number;
  scopeKind?: PersonaScopeKind;
  conversationKey?: string;
};
export type SetModelOverrideInput = {
  source: Source;
  accountId: string;
  modelTier: ModelOverrideRecord["modelTier"];
  providerId: string;
  modelId: string;
  updatedByActorId: string;
  now?: string;
};
export type GetModelOverridesInput = {
  source: Source;
  accountId: string;
  modelTier?: ModelOverrideRecord["modelTier"];
};

export type UpsertProviderControlInput = {
  source: Source;
  accountId: string;
  providerId?: string | null;
  modelId?: string | null;
  baseUrlOverride?: string | null;
  updatedByActorId: string;
  now?: string;
};

export type ProviderControlRecord = {
  source: Source;
  accountId: string;
  providerId?: string;
  modelId?: string;
  baseUrlOverride?: string;
  updatedByActorId: string;
  updatedAt: string;
};

export type ProviderSecretRecord = {
  source: Source;
  accountId: string;
  apiKey: string;
  updatedByActorId: string;
  updatedAt: string;
};

export type SetProviderSecretInput = {
  source: Source;
  accountId: string;
  apiKey: string;
  updatedByActorId: string;
  now?: string;
};

export type ProviderControlFieldSource = "persisted" | "env" | "builtin" | "derived_legacy" | "missing";

export type InspectProviderControlInput = {
  source: Source;
  accountId: string;
  fallbackProviderId?: string;
  fallbackProviderSource?: Exclude<ProviderControlFieldSource, "persisted">;
  fallbackModelId?: string;
  fallbackModelSource?: Exclude<ProviderControlFieldSource, "persisted">;
  fallbackBaseUrl?: string;
  fallbackBaseUrlSource?: Exclude<ProviderControlFieldSource, "persisted">;
  fallbackApiKey?: string;
  fallbackApiKeySource?: Exclude<ProviderControlFieldSource, "persisted">;
};

export type InspectedProviderControl = {
  providerId?: string;
  providerSource: ProviderControlFieldSource;
  modelId?: string;
  modelSource: ProviderControlFieldSource;
  baseUrl?: string;
  baseUrlSource: ProviderControlFieldSource;
  apiKeyMasked?: string;
  apiKeySource: ProviderControlFieldSource;
  apiKeyPresent: boolean;
};

export type RevealedProviderApiKey = {
  apiKey?: string;
  apiKeySource: ProviderControlFieldSource;
  apiKeyPresent: boolean;
};

export function createAccessStore({ filename }: { filename: string }) {
  const db = new Database(filename);
  ensureAccessSchema(db);

  const loadAuthorityStateStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      owner_binding_id as ownerBindingId,
      status,
      created_at as createdAt,
      updated_at as updatedAt
    FROM instance_authority_state
    WHERE source = ? AND account_id = ?
  `);

  const loadOwnerBindingByIdStmt = db.prepare(`
    SELECT
      owner_binding_id as ownerBindingId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      owner_subject_ref as ownerSubjectRef,
      owner_actor_id as ownerActorId,
      paired_conversation_ref_json as pairedConversationRefJson,
      consumed_claim_id as consumedClaimId,
      status,
      bound_at as boundAt,
      revoked_at as revokedAt,
      revoked_reason as revokedReason,
      approved_by_operator_id as approvedByOperatorId,
      revoked_by_operator_id as revokedByOperatorId
    FROM instance_owner_bindings
    WHERE owner_binding_id = ?
  `);

  const loadLatestOwnerBindingStmt = db.prepare(`
    SELECT
      owner_binding_id as ownerBindingId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      owner_subject_ref as ownerSubjectRef,
      owner_actor_id as ownerActorId,
      paired_conversation_ref_json as pairedConversationRefJson,
      consumed_claim_id as consumedClaimId,
      status,
      bound_at as boundAt,
      revoked_at as revokedAt,
      revoked_reason as revokedReason,
      approved_by_operator_id as approvedByOperatorId,
      revoked_by_operator_id as revokedByOperatorId
    FROM instance_owner_bindings
    WHERE source = ? AND account_id = ?
    ORDER BY owner_generation DESC, bound_at DESC, owner_binding_id DESC
    LIMIT 1
  `);

  const loadPendingClaimByRequesterStmt = db.prepare(`
    SELECT
      claim_id as claimId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      requester_subject_ref as requesterSubjectRef,
      requester_actor_id as requesterActorId,
      request_workspace_id as requestWorkspaceId,
      request_session_id as requestSessionId,
      request_conversation_ref_json as requestConversationRefJson,
      pair_code as pairCode,
      status,
      expires_at as expiresAt,
      created_at as createdAt,
      consumed_at as consumedAt,
      superseded_at as supersededAt,
      approved_by_operator_id as approvedByOperatorId
    FROM pair_claims
    WHERE source = ? AND account_id = ? AND requester_subject_ref = ? AND status = 'pending'
    LIMIT 1
  `);

  const loadClaimByIdStmt = db.prepare(`
    SELECT
      claim_id as claimId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      requester_subject_ref as requesterSubjectRef,
      requester_actor_id as requesterActorId,
      request_workspace_id as requestWorkspaceId,
      request_session_id as requestSessionId,
      request_conversation_ref_json as requestConversationRefJson,
      pair_code as pairCode,
      status,
      expires_at as expiresAt,
      created_at as createdAt,
      consumed_at as consumedAt,
      superseded_at as supersededAt,
      approved_by_operator_id as approvedByOperatorId
    FROM pair_claims
    WHERE source = ? AND account_id = ? AND claim_id = ?
  `);

  const loadClaimByPairCodeStmt = db.prepare(`
    SELECT
      claim_id as claimId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      requester_subject_ref as requesterSubjectRef,
      requester_actor_id as requesterActorId,
      request_workspace_id as requestWorkspaceId,
      request_session_id as requestSessionId,
      request_conversation_ref_json as requestConversationRefJson,
      pair_code as pairCode,
      status,
      expires_at as expiresAt,
      created_at as createdAt,
      consumed_at as consumedAt,
      superseded_at as supersededAt,
      approved_by_operator_id as approvedByOperatorId
    FROM pair_claims
    WHERE source = ? AND account_id = ? AND pair_code = ?
    ORDER BY created_at DESC, claim_id DESC
    LIMIT 1
  `);

  const listClaimsStmt = db.prepare(`
    SELECT
      claim_id as claimId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      requester_subject_ref as requesterSubjectRef,
      requester_actor_id as requesterActorId,
      request_workspace_id as requestWorkspaceId,
      request_session_id as requestSessionId,
      request_conversation_ref_json as requestConversationRefJson,
      pair_code as pairCode,
      status,
      expires_at as expiresAt,
      created_at as createdAt,
      consumed_at as consumedAt,
      superseded_at as supersededAt,
      approved_by_operator_id as approvedByOperatorId
    FROM pair_claims
    WHERE source = ? AND account_id = ?
    ORDER BY created_at DESC, claim_id DESC
  `);

  const listTrustedStmt = db.prepare(`
    SELECT
      trust_id as trustId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      conversation_ref_json as conversationRefJson,
      conversation_key as conversationKey,
      coverage,
      grant_kind as grantKind,
      granted_by_owner_binding_id as grantedByOwnerBindingId,
      status,
      granted_at as grantedAt,
      revoked_at as revokedAt,
      revoked_reason as revokedReason,
      revoked_by_operator_id as revokedByOperatorId
    FROM trusted_conversations
    WHERE source = ? AND account_id = ?
    ORDER BY owner_generation DESC, granted_at DESC, trust_id DESC
  `);

  const loadTrustByIdStmt = db.prepare(`
    SELECT
      trust_id as trustId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      conversation_ref_json as conversationRefJson,
      conversation_key as conversationKey,
      coverage,
      grant_kind as grantKind,
      granted_by_owner_binding_id as grantedByOwnerBindingId,
      status,
      granted_at as grantedAt,
      revoked_at as revokedAt,
      revoked_reason as revokedReason,
      revoked_by_operator_id as revokedByOperatorId
    FROM trusted_conversations
    WHERE source = ? AND account_id = ? AND trust_id = ?
  `);

  const loadTrustByUniqueKeyStmt = db.prepare(`
    SELECT
      trust_id as trustId,
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      conversation_ref_json as conversationRefJson,
      conversation_key as conversationKey,
      coverage,
      grant_kind as grantKind,
      granted_by_owner_binding_id as grantedByOwnerBindingId,
      status,
      granted_at as grantedAt,
      revoked_at as revokedAt,
      revoked_reason as revokedReason,
      revoked_by_operator_id as revokedByOperatorId
    FROM trusted_conversations
    WHERE source = ?
      AND account_id = ?
      AND owner_generation = ?
      AND grant_kind = ?
      AND coverage = ?
      AND conversation_key = ?
    ORDER BY granted_at DESC, trust_id DESC
  `);

  const loadReacquireBoundaryStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      conversation_key as conversationKey,
      coverage,
      grant_kind as grantKind,
      bot_absent_observed_at as botAbsentObservedAt
    FROM trusted_conversation_reacquire_boundaries
    WHERE source = ?
      AND account_id = ?
      AND owner_generation = ?
      AND grant_kind = ?
      AND coverage = ?
      AND conversation_key = ?
  `);

  const loadOwnerPreferencesStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      owner_binding_id as ownerBindingId,
      owner_actor_id as ownerActorId,
      owner_display_name as ownerDisplayName,
      assistant_display_name as assistantDisplayName,
      timezone,
      created_at as createdAt,
      updated_at as updatedAt
    FROM owner_preferences
    WHERE source = ? AND account_id = ? AND owner_generation = ? AND owner_binding_id = ?
  `);

  const loadOwnerInitStateStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      owner_generation as ownerGeneration,
      owner_binding_id as ownerBindingId,
      status,
      prompt_version as promptVersion,
      prompt_sent_at as promptSentAt,
      completion_reason as completionReason,
      completed_at as completedAt,
      updated_at as updatedAt
    FROM owner_init_state
    WHERE source = ? AND account_id = ? AND owner_generation = ? AND owner_binding_id = ?
  `);

  const listConversationDirectoryStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      conversation_key as conversationKey,
      base_conversation_key as baseConversationKey,
      conversation_label as conversationLabel,
      latest_session_id as latestSessionId,
      observed_at as observedAt
    FROM conversation_directory
    WHERE source = ? AND account_id = ?
    ORDER BY observed_at DESC, conversation_key DESC
  `);

  const loadPersonaProfileStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      owner_binding_id as ownerBindingId,
      owner_generation as ownerGeneration,
      scope_kind as scopeKind,
      conversation_key as conversationKey,
      style_instructions as styleInstructions,
      behavior_instructions as behaviorInstructions,
      updated_by_actor_id as updatedByActorId,
      created_at as createdAt,
      updated_at as updatedAt
    FROM persona_profiles
    WHERE source = ? AND account_id = ? AND owner_generation = ? AND scope_kind = ? AND conversation_key = ?
  `);

  const listPersonaProfilesStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      owner_binding_id as ownerBindingId,
      owner_generation as ownerGeneration,
      scope_kind as scopeKind,
      conversation_key as conversationKey,
      style_instructions as styleInstructions,
      behavior_instructions as behaviorInstructions,
      updated_by_actor_id as updatedByActorId,
      created_at as createdAt,
      updated_at as updatedAt
    FROM persona_profiles
    WHERE source = ? AND account_id = ?
    ORDER BY owner_generation DESC, scope_kind, conversation_key, updated_at DESC
  `);

  const loadModelOverrideStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      model_tier as modelTier,
      provider_id as providerId,
      model_id as modelId,
      updated_by_actor_id as updatedByActorId,
      updated_at as updatedAt
    FROM instance_model_overrides
    WHERE source = ? AND account_id = ? AND model_tier = ?
  `);

  const listModelOverridesStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      model_tier as modelTier,
      provider_id as providerId,
      model_id as modelId,
      updated_by_actor_id as updatedByActorId,
      updated_at as updatedAt
    FROM instance_model_overrides
    WHERE source = ? AND account_id = ?
    ORDER BY model_tier
  `);

  const loadProviderControlStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      provider_id as providerId,
      model_id as modelId,
      base_url_override as baseUrlOverride,
      updated_by_actor_id as updatedByActorId,
      updated_at as updatedAt
    FROM instance_provider_control
    WHERE source = ? AND account_id = ?
  `);

  const loadProviderSecretStmt = db.prepare(`
    SELECT
      source,
      account_id as accountId,
      api_key as apiKey,
      updated_by_actor_id as updatedByActorId,
      updated_at as updatedAt
    FROM instance_provider_secret
    WHERE source = ? AND account_id = ?
  `);

  function nowIso(input?: string) {
    return input ?? new Date().toISOString();
  }

  function hasOwnField<T extends object>(value: T, key: keyof T) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function mergeOwnerPreferenceValue(
    input: UpsertOwnerPreferencesInput,
    key: "ownerDisplayName" | "assistantDisplayName" | "timezone",
    existingValue: string | null | undefined
  ) {
    if (!hasOwnField(input, key) || input[key] === undefined) {
      return existingValue ?? null;
    }
    return input[key] ?? null;
  }

  const ownerInitStatusRank: Record<OwnerInitState["status"], number> = {
    pending_prompt: 0,
    prompted: 1,
    completed: 2
  };

  function assertOwnerInitStateDoesNotRegress(existing: OwnerInitStateRow | undefined, nextStatus: OwnerInitState["status"]) {
    if (!existing) {
      return;
    }
    if (ownerInitStatusRank[nextStatus] < ownerInitStatusRank[existing.status]) {
      throw new Error(`owner init state cannot regress from ${existing.status} to ${nextStatus}`);
    }
  }

  function parseAuthorityState(row: AuthorityStateRow): InstanceAuthorityState {
    return InstanceAuthorityStateSchema.parse({
      ...row,
      ownerBindingId: row.ownerBindingId ?? undefined
    });
  }

  function parseOwnerBinding(row: OwnerBindingRow): InstanceOwnerBinding {
    return InstanceOwnerBindingSchema.parse({
      ...row,
      pairedConversationRef: JSON.parse(row.pairedConversationRefJson),
      revokedAt: row.revokedAt ?? undefined,
      revokedReason: row.revokedReason ?? undefined,
      approvedByOperatorId: row.approvedByOperatorId ?? undefined,
      revokedByOperatorId: row.revokedByOperatorId ?? undefined
    });
  }

  function parsePairClaim(row: PairClaimRow): PairClaim {
    return PairClaimSchema.parse({
      ...row,
      requestWorkspaceId: row.requestWorkspaceId ?? undefined,
      requestSessionId: row.requestSessionId ?? undefined,
      requestConversationRef: JSON.parse(row.requestConversationRefJson),
      consumedAt: row.consumedAt ?? undefined,
      supersededAt: row.supersededAt ?? undefined,
      approvedByOperatorId: row.approvedByOperatorId ?? undefined
    });
  }

  function recordTrustedConversationReacquireBoundary(input: {
    source: Source;
    accountId: string;
    ownerGeneration: number;
    conversationRef: ConversationRef;
    coverage: TrustedConversationCoverage;
    grantKind: TrustedConversationBinding["grantKind"];
    observedAt: string;
  }) {
    const conversationKey = deriveTrustedConversationKey(input.conversationRef, input.coverage);

    db.prepare(`
      INSERT INTO trusted_conversation_reacquire_boundaries (
        source,
        account_id,
        owner_generation,
        conversation_key,
        coverage,
        grant_kind,
        bot_absent_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, account_id, owner_generation, grant_kind, coverage, conversation_key)
      DO UPDATE SET bot_absent_observed_at = excluded.bot_absent_observed_at
    `).run(
      input.source,
      input.accountId,
      input.ownerGeneration,
      conversationKey,
      input.coverage,
      input.grantKind,
      input.observedAt
    );
  }

  function parseTrustedConversation(row: TrustedConversationRow): TrustedConversationBinding {
    return TrustedConversationBindingSchema.parse({
      ...row,
      conversationRef: JSON.parse(row.conversationRefJson),
      revokedAt: row.revokedAt ?? undefined,
      revokedReason: row.revokedReason ?? undefined,
      revokedByOperatorId: row.revokedByOperatorId ?? undefined
    });
  }

  function parseOwnerPreferences(row: OwnerPreferencesRow): OwnerPreferences {
    return OwnerPreferencesSchema.parse({
      ...row,
      ownerDisplayName: row.ownerDisplayName ?? undefined,
      assistantDisplayName: row.assistantDisplayName ?? undefined,
      timezone: row.timezone ?? undefined
    });
  }

  function parseOwnerInitState(row: OwnerInitStateRow): OwnerInitState {
    return OwnerInitStateSchema.parse({
      ...row,
      promptSentAt: row.promptSentAt ?? undefined,
      completionReason: row.completionReason ?? undefined,
      completedAt: row.completedAt ?? undefined
    });
  }

  function parseConversationDirectoryEntry(row: ConversationDirectoryRow): ConversationDirectoryEntry {
    return ConversationDirectoryEntrySchema.parse({
      ...row,
      baseConversationKey: row.baseConversationKey ?? undefined,
      conversationLabel: row.conversationLabel ?? undefined,
      latestSessionId: row.latestSessionId ?? undefined
    });
  }

  function parsePersonaProfile(row: PersonaProfileRow): PersonaProfileRecord {
    return {
      source: row.source,
      accountId: row.accountId,
      ownerBindingId: row.ownerBindingId,
      ownerGeneration: row.ownerGeneration,
      scopeKind: row.scopeKind,
      conversationKey: row.conversationKey || undefined,
      styleInstructions: row.styleInstructions,
      behaviorInstructions: row.behaviorInstructions,
      updatedByActorId: row.updatedByActorId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  function parseModelOverride(row: ModelOverrideRow): ModelOverrideRecord {
    return ModelOverrideRecordSchema.parse(row);
  }

  function parseProviderControl(row: ProviderControlRow): ProviderControlRecord {
    return {
      source: row.source,
      accountId: row.accountId,
      providerId: row.providerId ?? undefined,
      modelId: row.modelId ?? undefined,
      baseUrlOverride: row.baseUrlOverride ?? undefined,
      updatedByActorId: row.updatedByActorId,
      updatedAt: row.updatedAt
    };
  }

  function parseProviderSecret(row: ProviderSecretRow): ProviderSecretRecord {
    return {
      source: row.source,
      accountId: row.accountId,
      apiKey: row.apiKey,
      updatedByActorId: row.updatedByActorId,
      updatedAt: row.updatedAt
    };
  }

  function normalizeOptionalString(value: string | null | undefined) {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  function maskSecret(value: string | undefined) {
    const normalized = normalizeOptionalString(value);
    if (!normalized) {
      return undefined;
    }

    const prefix = normalized.slice(0, 3);
    const suffix = normalized.slice(-4);
    return `${prefix}****${suffix}`;
  }

  function resolveInspectedValue<T>(persistedValue: T | undefined, fallbackValue: T | undefined, fallbackSource: ProviderControlFieldSource) {
    if (persistedValue !== undefined) {
      return {
        value: persistedValue,
        source: "persisted" as const
      };
    }

    if (fallbackValue !== undefined) {
      return {
        value: fallbackValue,
        source: fallbackSource
      };
    }

    return {
      value: undefined,
      source: "missing" as const
    };
  }

  function ensureAuthorityState(source: Source, accountId: string, now = new Date().toISOString()) {
    db.prepare(`
      INSERT OR IGNORE INTO instance_authority_state (
        source,
        account_id,
        owner_generation,
        owner_binding_id,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, 0, NULL, 'unbound', ?, ?)
    `).run(source, accountId, now, now);

    const row = loadAuthorityStateStmt.get(source, accountId) as AuthorityStateRow | undefined;
    if (!row) {
      throw new Error(`failed to load authority state for ${source}/${accountId}`);
    }
    return parseAuthorityState(row);
  }

  function generatePairCode() {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = randomBytes(8);
    let code = "";
    for (const value of bytes) {
      code += alphabet[value % alphabet.length];
    }
    return code;
  }

  function loadOwnerBindingById(ownerBindingId: string | undefined) {
    if (!ownerBindingId) {
      return undefined;
    }

    const row = loadOwnerBindingByIdStmt.get(ownerBindingId) as OwnerBindingRow | undefined;
    return row ? parseOwnerBinding(row) : undefined;
  }

  function expirePendingClaims(source: Source, accountId: string, now: string) {
    const result = db.prepare(`
      UPDATE pair_claims
      SET status = 'expired'
      WHERE source = ?
        AND account_id = ?
        AND status = 'pending'
        AND expires_at <= ?
    `).run(source, accountId, now);

    return result.changes;
  }

  function loadCurrentState(input: { source: Source; accountId: string; now?: string }) {
    return ensureAuthorityState(input.source, input.accountId, nowIso(input.now));
  }

  async function getAuthorityState(input: { source: Source; accountId: string; now?: string }) {
    return loadCurrentState(input);
  }

  function loadActiveOwnerBindingForState(state: InstanceAuthorityState, source: Source, accountId: string) {
    const binding = loadOwnerBindingById(state.ownerBindingId) ?? (() => {
      const row = loadLatestOwnerBindingStmt.get(source, accountId) as OwnerBindingRow | undefined;
      return row ? parseOwnerBinding(row) : undefined;
    })();
    return binding?.status === "active" ? binding : undefined;
  }

  async function inspectOwnerBinding(input: { source: Source; accountId: string; now?: string }) {
    const state = loadCurrentState(input);
    return loadActiveOwnerBindingForState(state, input.source, input.accountId);
  }

  async function getOwnerPreferences(input: GetOwnerScopedStateInput) {
    const state = loadCurrentState(input);
    const binding = loadActiveOwnerBindingForState(state, input.source, input.accountId);
    if (!binding) {
      return undefined;
    }

    const row = loadOwnerPreferencesStmt.get(
      input.source,
      input.accountId,
      state.ownerGeneration,
      binding.ownerBindingId
    ) as OwnerPreferencesRow | undefined;
    return row ? parseOwnerPreferences(row) : undefined;
  }

  async function getOwnerInitState(input: GetOwnerScopedStateInput) {
    const state = loadCurrentState(input);
    const binding = loadActiveOwnerBindingForState(state, input.source, input.accountId);
    if (!binding) {
      return undefined;
    }

    const row = loadOwnerInitStateStmt.get(
      input.source,
      input.accountId,
      state.ownerGeneration,
      binding.ownerBindingId
    ) as OwnerInitStateRow | undefined;
    return row ? parseOwnerInitState(row) : undefined;
  }

  async function upsertOwnerPreferences(input: UpsertOwnerPreferencesInput) {
    const now = nowIso(input.now);
    const state = loadCurrentState(input);
    const binding = loadActiveOwnerBindingForState(state, input.source, input.accountId);
    if (!binding || binding.ownerBindingId !== input.ownerBindingId || binding.ownerActorId !== input.ownerActorId) {
      throw new Error(`cannot upsert owner preferences for inactive binding ${input.ownerBindingId}`);
    }

    const existing = loadOwnerPreferencesStmt.get(
      input.source,
      input.accountId,
      state.ownerGeneration,
      input.ownerBindingId
    ) as OwnerPreferencesRow | undefined;
    const createdAt = existing?.createdAt ?? now;
    const ownerDisplayName = mergeOwnerPreferenceValue(input, "ownerDisplayName", existing?.ownerDisplayName);
    const assistantDisplayName = mergeOwnerPreferenceValue(input, "assistantDisplayName", existing?.assistantDisplayName);
    const timezone = mergeOwnerPreferenceValue(input, "timezone", existing?.timezone);

    db.prepare(`
      INSERT INTO owner_preferences (
        source,
        account_id,
        owner_generation,
        owner_binding_id,
        owner_actor_id,
        owner_display_name,
        assistant_display_name,
        timezone,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, account_id, owner_generation, owner_binding_id)
      DO UPDATE SET
        owner_actor_id = excluded.owner_actor_id,
        owner_display_name = excluded.owner_display_name,
        assistant_display_name = excluded.assistant_display_name,
        timezone = excluded.timezone,
        updated_at = excluded.updated_at
    `).run(
      input.source,
      input.accountId,
      state.ownerGeneration,
      input.ownerBindingId,
      input.ownerActorId,
      ownerDisplayName,
      assistantDisplayName,
      timezone,
      createdAt,
      now
    );

    return parseOwnerPreferences(loadOwnerPreferencesStmt.get(
      input.source,
      input.accountId,
      state.ownerGeneration,
      input.ownerBindingId
    ) as OwnerPreferencesRow);
  }

  function writeOwnerInitState(input: UpsertOwnerInitStateInput) {
    const now = nowIso(input.now);
    const state = loadCurrentState(input);
    const binding = loadActiveOwnerBindingForState(state, input.source, input.accountId);
    if (!binding || binding.ownerBindingId !== input.ownerBindingId) {
      throw new Error(`cannot upsert owner init state for inactive binding ${input.ownerBindingId}`);
    }

    const existing = loadOwnerInitStateStmt.get(
      input.source,
      input.accountId,
      state.ownerGeneration,
      input.ownerBindingId
    ) as OwnerInitStateRow | undefined;

    assertOwnerInitStateDoesNotRegress(existing, input.status);

    const candidate = OwnerInitStateSchema.parse({
      source: input.source,
      accountId: input.accountId,
      ownerGeneration: state.ownerGeneration,
      ownerBindingId: input.ownerBindingId,
      status: input.status,
      promptVersion: input.promptVersion ?? existing?.promptVersion ?? 1,
      promptSentAt: input.status === "pending_prompt"
        ? undefined
        : input.promptSentAt ?? existing?.promptSentAt ?? undefined,
      completionReason: input.status === "completed"
        ? input.completionReason ?? existing?.completionReason ?? undefined
        : undefined,
      completedAt: input.status === "completed"
        ? input.completedAt ?? existing?.completedAt ?? undefined
        : undefined,
      updatedAt: now
    });

    db.prepare(`
      INSERT INTO owner_init_state (
        source,
        account_id,
        owner_generation,
        owner_binding_id,
        status,
        prompt_version,
        prompt_sent_at,
        completion_reason,
        completed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, account_id, owner_generation, owner_binding_id)
      DO UPDATE SET
        status = excluded.status,
        prompt_version = excluded.prompt_version,
        prompt_sent_at = excluded.prompt_sent_at,
        completion_reason = excluded.completion_reason,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      candidate.source,
      candidate.accountId,
      candidate.ownerGeneration,
      candidate.ownerBindingId,
      candidate.status,
      candidate.promptVersion,
      candidate.promptSentAt ?? null,
      candidate.completionReason ?? null,
      candidate.completedAt ?? null,
      candidate.updatedAt
    );

    return parseOwnerInitState(loadOwnerInitStateStmt.get(
      input.source,
      input.accountId,
      state.ownerGeneration,
      input.ownerBindingId
    ) as OwnerInitStateRow);
  }

  async function upsertOwnerInitState(input: UpsertOwnerInitStateInput) {
    return writeOwnerInitState(input);
  }

  async function markOwnerInitPrompted(input: MarkOwnerInitPromptedInput): Promise<"transitioned" | "unchanged"> {
    const now = nowIso(input.now);
    const state = loadCurrentState(input);
    const binding = loadActiveOwnerBindingForState(state, input.source, input.accountId);
    if (!binding || binding.ownerBindingId !== input.ownerBindingId) {
      return "unchanged";
    }

    const result = db.prepare(`
      UPDATE owner_init_state
      SET status = 'prompted',
          prompt_sent_at = ?,
          completion_reason = NULL,
          completed_at = NULL,
          updated_at = ?
      WHERE source = ?
        AND account_id = ?
        AND owner_generation = ?
        AND owner_binding_id = ?
        AND status = 'pending_prompt'
    `).run(
      now,
      now,
      input.source,
      input.accountId,
      state.ownerGeneration,
      input.ownerBindingId
    );

    return result.changes === 1 ? "transitioned" : "unchanged";
  }

  async function upsertConversationDirectoryEntry(
    input: UpsertConversationDirectoryEntryInput
  ): Promise<ConversationDirectoryEntry> {
    const parsed = ConversationDirectoryEntrySchema.parse(input);
    const row = db.transaction(() => {
      db.prepare(`
        INSERT INTO conversation_directory (
          source,
          account_id,
          conversation_key,
          base_conversation_key,
          conversation_label,
          latest_session_id,
          observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, account_id, conversation_key)
        DO UPDATE SET
          base_conversation_key = excluded.base_conversation_key,
          conversation_label = excluded.conversation_label,
          latest_session_id = excluded.latest_session_id,
          observed_at = excluded.observed_at
      `).run(
        parsed.source,
        parsed.accountId,
        parsed.conversationKey,
        parsed.baseConversationKey ?? null,
        parsed.conversationLabel ?? null,
        parsed.latestSessionId ?? null,
        parsed.observedAt
      );

      return listConversationDirectoryStmt.all(parsed.source, parsed.accountId) as ConversationDirectoryRow[];
    })().find((entry) => entry.conversationKey === parsed.conversationKey);

    if (!row) {
      throw new Error(`failed to upsert conversation directory entry for ${parsed.source}/${parsed.accountId}/${parsed.conversationKey}`);
    }

    return parseConversationDirectoryEntry(row);
  }

  async function resolveConversationTarget(input: ResolveConversationTargetInput) {
    const rows = (listConversationDirectoryStmt.all(input.source, input.accountId) as ConversationDirectoryRow[])
      .map(parseConversationDirectoryEntry);

    const exactConversationMatch = rows.find((entry) => entry.conversationKey === input.target);
    if (exactConversationMatch) {
      return exactConversationMatch;
    }

    const labelMatch = rows.find((entry) => entry.conversationLabel === input.target);
    if (labelMatch) {
      return labelMatch;
    }

    return undefined;
  }

  async function listConversationDirectory(input: { source: Source; accountId: string }) {
    return (listConversationDirectoryStmt.all(input.source, input.accountId) as ConversationDirectoryRow[]).map(
      parseConversationDirectoryEntry
    );
  }

  async function upsertPersonaProfile(input: UpsertPersonaProfileInput): Promise<PersonaProfileRecord> {
    const now = nowIso(input.now);
    const conversationKey = input.conversationKey ?? "";
    const scopeKind = PersonaScopeKindSchema.parse(input.scopeKind);

    db.transaction(() => {
      db.prepare(`
        INSERT INTO persona_profiles (
          source,
          account_id,
          owner_binding_id,
          owner_generation,
          scope_kind,
          conversation_key,
          style_instructions,
          behavior_instructions,
          updated_by_actor_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, account_id, owner_generation, scope_kind, conversation_key)
        DO UPDATE SET
          owner_binding_id = excluded.owner_binding_id,
          style_instructions = excluded.style_instructions,
          behavior_instructions = excluded.behavior_instructions,
          updated_by_actor_id = excluded.updated_by_actor_id,
          updated_at = excluded.updated_at
      `).run(
        input.source,
        input.accountId,
        input.ownerBindingId,
        input.ownerGeneration,
        scopeKind,
        conversationKey,
        input.styleInstructions,
        input.behaviorInstructions,
        input.updatedByActorId,
        now,
        now
      );
    })();

    const row = (listPersonaProfilesStmt.all(input.source, input.accountId) as PersonaProfileRow[])
      .find((entry) => entry.ownerGeneration === input.ownerGeneration && entry.scopeKind === scopeKind && entry.conversationKey === conversationKey);

    if (!row) {
      throw new Error(`failed to upsert persona profile for ${input.source}/${input.accountId}/${input.ownerGeneration}/${scopeKind}/${conversationKey}`);
    }

    return parsePersonaProfile(row);
  }

  async function getPersonaProfile(input: PersonaProfileLookupInput) {
    const scopeKind = PersonaScopeKindSchema.parse(input.scopeKind);
    const row = (listPersonaProfilesStmt.all(input.source, input.accountId) as PersonaProfileRow[])
      .find((entry) => entry.ownerGeneration === input.ownerGeneration && entry.scopeKind === scopeKind && entry.conversationKey === (input.conversationKey ?? ""));

    return row ? parsePersonaProfile(row) : undefined;
  }

  async function clearPersonaProfile(input: ClearPersonaProfileInput) {
    return db.prepare(`
      DELETE FROM persona_profiles
      WHERE source = ?
        AND account_id = ?
        AND owner_generation = ?
        AND scope_kind = ?
        AND conversation_key = ?
    `).run(
      input.source,
      input.accountId,
      input.ownerGeneration,
      PersonaScopeKindSchema.parse(input.scopeKind),
      input.conversationKey ?? ""
    ).changes;
  }

  async function listPersonaProfiles(input: ListPersonaProfilesInput) {
    const rows = (listPersonaProfilesStmt.all(input.source, input.accountId) as PersonaProfileRow[])
      .filter((row) => input.ownerGeneration === undefined || row.ownerGeneration === input.ownerGeneration)
      .filter((row) => input.scopeKind === undefined || row.scopeKind === input.scopeKind)
      .filter((row) => input.conversationKey === undefined || row.conversationKey === (input.conversationKey ?? ""));
    return rows.map(parsePersonaProfile);
  }

  async function setModelOverride(input: SetModelOverrideInput): Promise<ModelOverrideRecord> {
    const now = nowIso(input.now);
    const row = db.transaction(() => {
      db.prepare(`
        INSERT INTO instance_model_overrides (
          source,
          account_id,
          model_tier,
          provider_id,
          model_id,
          updated_by_actor_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, account_id, model_tier)
        DO UPDATE SET
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          updated_by_actor_id = excluded.updated_by_actor_id,
          updated_at = excluded.updated_at
      `).run(
        input.source,
        input.accountId,
        input.modelTier,
        input.providerId,
        input.modelId,
        input.updatedByActorId,
        now
      );

      return loadModelOverrideStmt.get(input.source, input.accountId, input.modelTier) as ModelOverrideRow | undefined;
    })();

    if (!row) {
      throw new Error(`failed to set model override for ${input.source}/${input.accountId}/${input.modelTier}`);
    }

    return parseModelOverride(row);
  }

  async function getModelOverrides(input: GetModelOverridesInput) {
    if (input.modelTier) {
      const row = loadModelOverrideStmt.get(input.source, input.accountId, input.modelTier) as ModelOverrideRow | undefined;
      return row ? [parseModelOverride(row)] : [];
    }

    return (listModelOverridesStmt.all(input.source, input.accountId) as ModelOverrideRow[]).map(parseModelOverride);
  }

  async function upsertProviderControl(input: UpsertProviderControlInput): Promise<ProviderControlRecord> {
    const now = nowIso(input.now);
    const row = db.transaction(() => {
      db.prepare(`
        INSERT INTO instance_provider_control (
          source,
          account_id,
          provider_id,
          model_id,
          base_url_override,
          updated_by_actor_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, account_id)
        DO UPDATE SET
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          base_url_override = excluded.base_url_override,
          updated_by_actor_id = excluded.updated_by_actor_id,
          updated_at = excluded.updated_at
      `).run(
        input.source,
        input.accountId,
        normalizeOptionalString(input.providerId) ?? null,
        normalizeOptionalString(input.modelId) ?? null,
        normalizeOptionalString(input.baseUrlOverride) ?? null,
        input.updatedByActorId,
        now
      );

      return loadProviderControlStmt.get(input.source, input.accountId) as ProviderControlRow | undefined;
    })();

    if (!row) {
      throw new Error(`failed to upsert provider control for ${input.source}/${input.accountId}`);
    }

    return parseProviderControl(row);
  }

  async function getProviderControl(input: { source: Source; accountId: string }) {
    const row = loadProviderControlStmt.get(input.source, input.accountId) as ProviderControlRow | undefined;
    return row ? parseProviderControl(row) : undefined;
  }

  async function setProviderSecret(input: SetProviderSecretInput): Promise<ProviderSecretRecord> {
    const now = nowIso(input.now);
    const apiKey = normalizeOptionalString(input.apiKey);
    if (!apiKey) {
      throw new Error("provider secret apiKey must not be empty");
    }

    const row = db.transaction(() => {
      db.prepare(`
        INSERT INTO instance_provider_secret (
          source,
          account_id,
          api_key,
          updated_by_actor_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source, account_id)
        DO UPDATE SET
          api_key = excluded.api_key,
          updated_by_actor_id = excluded.updated_by_actor_id,
          updated_at = excluded.updated_at
      `).run(
        input.source,
        input.accountId,
        apiKey,
        input.updatedByActorId,
        now
      );

      return loadProviderSecretStmt.get(input.source, input.accountId) as ProviderSecretRow | undefined;
    })();

    if (!row) {
      throw new Error(`failed to set provider secret for ${input.source}/${input.accountId}`);
    }

    return parseProviderSecret(row);
  }

  async function getProviderSecret(input: { source: Source; accountId: string }) {
    const row = loadProviderSecretStmt.get(input.source, input.accountId) as ProviderSecretRow | undefined;
    return row ? parseProviderSecret(row) : undefined;
  }

  async function clearProviderSecret(input: { source: Source; accountId: string }) {
    const changes = db.prepare(`
      DELETE FROM instance_provider_secret
      WHERE source = ? AND account_id = ?
    `).run(input.source, input.accountId).changes;

    return changes === 1 ? "cleared" as const : "already_missing" as const;
  }

  async function inspectProviderControl(input: InspectProviderControlInput): Promise<InspectedProviderControl> {
    const [persistedControl, persistedSecret] = await Promise.all([
      getProviderControl({ source: input.source, accountId: input.accountId }),
      getProviderSecret({ source: input.source, accountId: input.accountId })
    ]);

    const provider = resolveInspectedValue(
      persistedControl?.providerId,
      normalizeOptionalString(input.fallbackProviderId),
      input.fallbackProviderSource ?? "missing"
    );
    const model = resolveInspectedValue(
      persistedControl?.modelId,
      normalizeOptionalString(input.fallbackModelId),
      input.fallbackModelSource ?? "missing"
    );
    const baseUrl = resolveInspectedValue(
      persistedControl?.baseUrlOverride,
      normalizeOptionalString(input.fallbackBaseUrl),
      input.fallbackBaseUrlSource ?? "missing"
    );
    const apiKey = resolveInspectedValue(
      persistedSecret?.apiKey,
      normalizeOptionalString(input.fallbackApiKey),
      input.fallbackApiKeySource ?? "missing"
    );

    return {
      providerId: provider.value,
      providerSource: provider.source,
      modelId: model.value,
      modelSource: model.source,
      baseUrl: baseUrl.value,
      baseUrlSource: baseUrl.source,
      apiKeyMasked: maskSecret(apiKey.value),
      apiKeySource: apiKey.source,
      apiKeyPresent: apiKey.value !== undefined
    };
  }

  async function revealProviderApiKey(input: InspectProviderControlInput): Promise<RevealedProviderApiKey> {
    const persistedSecret = await getProviderSecret({ source: input.source, accountId: input.accountId });
    const resolved = resolveInspectedValue(
      persistedSecret?.apiKey,
      normalizeOptionalString(input.fallbackApiKey),
      input.fallbackApiKeySource ?? "missing"
    );

    return {
      apiKey: resolved.value,
      apiKeySource: resolved.source,
      apiKeyPresent: resolved.value !== undefined
    };
  }

  async function evaluateClaimExpiry(input: { source: Source; accountId: string; now?: string }) {
    return {
      expiredClaimCount: expirePendingClaims(input.source, input.accountId, nowIso(input.now))
    };
  }

  async function createOrReusePairClaim(input: CreateOrReusePairClaimInput): Promise<CreateOrReusePairClaimResult> {
    const now = nowIso(input.now);

    const run = db.transaction((): CreateOrReusePairClaimResult => {
      expirePendingClaims(input.source, input.accountId, now);
      const state = ensureAuthorityState(input.source, input.accountId, now);

      if (state.status === "bound") {
        return { outcome: "authority_bound", state };
      }

      if (input.requestConversationRef.peerKind !== "dm") {
        throw new Error("pair claims may only be created for direct conversations");
      }

      const existingRow = loadPendingClaimByRequesterStmt.get(
        input.source,
        input.accountId,
        input.requesterSubjectRef
      ) as PairClaimRow | undefined;
      if (existingRow) {
        return {
          outcome: "reused",
          state,
          claim: parsePairClaim(existingRow)
        };
      }

      const claimId = `claim_${randomUUID()}`;
      const expiresAt = new Date(new Date(now).getTime() + DEFAULT_PAIR_CLAIM_TTL_MS).toISOString();
      let pairCode = generatePairCode();
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const collision = loadClaimByPairCodeStmt.get(input.source, input.accountId, pairCode) as PairClaimRow | undefined;
        if (!collision || collision.status !== "pending") {
          const insertResult = db.prepare(`
            INSERT OR IGNORE INTO pair_claims (
              claim_id,
              source,
              account_id,
              owner_generation,
              requester_subject_ref,
              requester_actor_id,
              request_workspace_id,
              request_session_id,
              request_conversation_ref_json,
              pair_code,
              status,
              expires_at,
              created_at,
              consumed_at,
              superseded_at,
              approved_by_operator_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL)
          `).run(
            claimId,
            input.source,
            input.accountId,
            state.ownerGeneration,
            input.requesterSubjectRef,
            input.requesterActorId,
            input.requestWorkspaceId,
            input.requestSessionId,
            JSON.stringify(input.requestConversationRef),
            pairCode,
            expiresAt,
            now
          );

          if (insertResult.changes === 1) {
            const claim = loadClaimByIdStmt.get(input.source, input.accountId, claimId) as PairClaimRow;
            return {
              outcome: "created",
              state,
              claim: parsePairClaim(claim)
            };
          }

          const racedRow = loadPendingClaimByRequesterStmt.get(
            input.source,
            input.accountId,
            input.requesterSubjectRef
          ) as PairClaimRow | undefined;
          if (racedRow) {
            return {
              outcome: "reused",
              state,
              claim: parsePairClaim(racedRow)
            };
          }
        }

        pairCode = generatePairCode();
      }

      throw new Error(`failed to allocate pair claim for ${input.source}/${input.accountId}/${input.requesterSubjectRef}`);
    });

    return run();
  }

  async function listPairClaims(input: ListScopeInput) {
    const now = nowIso(input.now);
    expirePendingClaims(input.source, input.accountId, now);
    const rows = (listClaimsStmt.all(input.source, input.accountId) as PairClaimRow[])
      .map(parsePairClaim)
      .filter((claim) => input.includeInactive ? true : claim.status === "pending");
    return rows;
  }

  async function approvePairClaim(input: ApprovePairClaimInput): Promise<ApprovePairClaimResult> {
    const validated = ApprovePairClaimRequestSchema.parse(input);
    const now = nowIso(input.now);
    expirePendingClaims(validated.source, validated.accountId, now);

    const run = db.transaction((): ApprovePairClaimResult => {
      const state = ensureAuthorityState(validated.source, validated.accountId, now);
      const claimRow = validated.claimId
        ? loadClaimByIdStmt.get(validated.source, validated.accountId, validated.claimId) as PairClaimRow | undefined
        : loadClaimByPairCodeStmt.get(validated.source, validated.accountId, validated.pairCode) as PairClaimRow | undefined;

      if (!claimRow) {
        return {
          outcome: "claim_not_found",
          state,
          supersededClaimCount: 0
        };
      }

      const claim = parsePairClaim(claimRow);
      if (claim.status !== "pending") {
        return {
          outcome: "claim_not_pending",
          state,
          consumedClaim: claim,
          supersededClaimCount: 0
        };
      }

      if (isPairClaimExpired(claim, now)) {
        db.prepare(`UPDATE pair_claims SET status = 'expired' WHERE claim_id = ?`).run(claim.claimId);
        return {
          outcome: "claim_expired",
          state,
          consumedClaim: { ...claim, status: "expired" },
          supersededClaimCount: 0
        };
      }

      if (state.status === "bound") {
        return {
          outcome: "authority_already_bound",
          state,
          consumedClaim: claim,
          supersededClaimCount: 0
        };
      }

      if (claim.ownerGeneration !== state.ownerGeneration) {
        return {
          outcome: "generation_mismatch",
          state,
          consumedClaim: claim,
          supersededClaimCount: 0
        };
      }

      const ownerBindingId = `owner_${randomUUID()}`;
      db.prepare(`
        INSERT INTO instance_owner_bindings (
          owner_binding_id,
          source,
          account_id,
          owner_generation,
          owner_subject_ref,
          owner_actor_id,
          paired_conversation_ref_json,
          consumed_claim_id,
          status,
          bound_at,
          revoked_at,
          revoked_reason,
          approved_by_operator_id,
          revoked_by_operator_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?, NULL)
      `).run(
        ownerBindingId,
        validated.source,
        validated.accountId,
        state.ownerGeneration,
        claim.requesterSubjectRef,
        claim.requesterActorId,
        JSON.stringify(claim.requestConversationRef),
        claim.claimId,
        now,
        validated.operatorActorId
      );

      db.prepare(`
        UPDATE instance_authority_state
        SET owner_binding_id = ?, status = 'bound', updated_at = ?
        WHERE source = ? AND account_id = ?
      `).run(ownerBindingId, now, validated.source, validated.accountId);

      db.prepare(`
        UPDATE pair_claims
        SET status = 'consumed', consumed_at = ?, approved_by_operator_id = ?
        WHERE claim_id = ?
      `).run(now, validated.operatorActorId, claim.claimId);

      const superseded = db.prepare(`
        UPDATE pair_claims
        SET status = 'superseded', superseded_at = ?
        WHERE source = ?
          AND account_id = ?
          AND claim_id <> ?
          AND status = 'pending'
      `).run(now, validated.source, validated.accountId, claim.claimId);

      const nextState = ensureAuthorityState(validated.source, validated.accountId, now);
      const ownerBinding = loadOwnerBindingById(ownerBindingId);
      if (ownerBinding) {
        writeOwnerInitState({
          source: ownerBinding.source,
          accountId: ownerBinding.accountId,
          ownerBindingId: ownerBinding.ownerBindingId,
          status: "pending_prompt",
          promptVersion: 1,
          now
        });
      }
      const consumedClaim = parsePairClaim(loadClaimByIdStmt.get(validated.source, validated.accountId, claim.claimId) as PairClaimRow);

      return {
        outcome: "approved",
        state: nextState,
        ownerBinding,
        consumedClaim,
        supersededClaimCount: superseded.changes
      };
    });

    return run();
  }

  async function resetOwnerBinding(input: ResetOwnerBindingInput): Promise<ResetOwnerBindingResult> {
    const now = nowIso(input.now);

    const run = db.transaction((): ResetOwnerBindingResult => {
      expirePendingClaims(input.source, input.accountId, now);
      const state = ensureAuthorityState(input.source, input.accountId, now);
      const activeBinding = loadOwnerBindingById(state.ownerBindingId);
      const outcome: ResetOwnerBindingResult["outcome"] = activeBinding ? "reset" : "already_unbound";

      let revokedOwnerBinding: InstanceOwnerBinding | undefined;
      if (activeBinding) {
        db.prepare(`
          UPDATE instance_owner_bindings
          SET status = 'revoked', revoked_at = ?, revoked_reason = ?, revoked_by_operator_id = ?
          WHERE owner_binding_id = ?
        `).run(now, input.reason ?? "owner reset", input.operatorActorId, activeBinding.ownerBindingId);
        revokedOwnerBinding = loadOwnerBindingById(activeBinding.ownerBindingId);
      }

      const revokedTrusts = db.prepare(`
        UPDATE trusted_conversations
        SET status = 'revoked', revoked_at = ?, revoked_reason = COALESCE(revoked_reason, ?)
        WHERE source = ?
          AND account_id = ?
          AND owner_generation = ?
          AND status = 'active'
      `).run(now, input.reason ?? "owner reset", input.source, input.accountId, state.ownerGeneration);

      const supersededClaims = db.prepare(`
        UPDATE pair_claims
        SET status = 'superseded', superseded_at = ?
        WHERE source = ?
          AND account_id = ?
          AND status = 'pending'
      `).run(now, input.source, input.accountId);

      db.prepare(`
        UPDATE instance_authority_state
        SET owner_binding_id = NULL,
            status = 'unbound',
            owner_generation = owner_generation + 1,
            updated_at = ?
        WHERE source = ? AND account_id = ?
      `).run(now, input.source, input.accountId);

      const nextState = ensureAuthorityState(input.source, input.accountId, now);
      return {
        outcome,
        state: nextState,
        revokedOwnerBinding,
        revokedTrustCount: revokedTrusts.changes,
        supersededClaimCount: supersededClaims.changes,
        newOwnerGeneration: nextState.ownerGeneration
      };
    });

    return run();
  }

  async function ensureTrustedConversation(input: EnsureTrustedConversationInput): Promise<EnsureTrustedConversationResult> {
    TrustedConversationGrantKindSchema.parse(input.grantKind);
    const now = nowIso(input.now);

    const run = db.transaction((): EnsureTrustedConversationResult => {
      const state = ensureAuthorityState(input.source, input.accountId, now);
      if (state.status !== "bound" || !state.ownerBindingId) {
        return { outcome: "authority_unbound", state };
      }

      const conversationKey = deriveTrustedConversationKey(input.conversationRef, input.coverage);
      const rows = loadTrustByUniqueKeyStmt.all(
        input.source,
        input.accountId,
        state.ownerGeneration,
        input.grantKind,
        input.coverage,
        conversationKey
      ) as TrustedConversationRow[];

      const active = rows.find((row) => row.status === "active");
      if (active) {
        return {
          outcome: "existing_active",
          state,
          binding: parseTrustedConversation(active)
        };
      }

      const revoked = rows.find((row) => row.status === "revoked");
      if (revoked) {
        const boundary = loadReacquireBoundaryStmt.get(
          input.source,
          input.accountId,
          state.ownerGeneration,
          input.grantKind,
          input.coverage,
          conversationKey
        ) as TrustedConversationReacquireBoundaryRow | undefined;
        const revokedAt = revoked.revokedAt ?? revoked.grantedAt;

        if (!boundary || boundary.botAbsentObservedAt < revokedAt || boundary.botAbsentObservedAt > now) {
          return {
            outcome: "revoked",
            state,
            binding: parseTrustedConversation(revoked)
          };
        }
      }

      const trustId = `trust_${randomUUID()}`;
      db.prepare(`
        INSERT INTO trusted_conversations (
          trust_id,
          source,
          account_id,
          owner_generation,
          conversation_ref_json,
          conversation_key,
          coverage,
          grant_kind,
          granted_by_owner_binding_id,
          status,
          granted_at,
          revoked_at,
          revoked_reason,
          revoked_by_operator_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL)
      `).run(
        trustId,
        input.source,
        input.accountId,
        state.ownerGeneration,
        JSON.stringify(input.conversationRef),
        conversationKey,
        input.coverage,
        input.grantKind,
        state.ownerBindingId,
        now
      );

      db.prepare(`
        DELETE FROM trusted_conversation_reacquire_boundaries
        WHERE source = ?
          AND account_id = ?
          AND owner_generation = ?
          AND grant_kind = ?
          AND coverage = ?
          AND conversation_key = ?
      `).run(
        input.source,
        input.accountId,
        state.ownerGeneration,
        input.grantKind,
        input.coverage,
        conversationKey
      );

      return {
        outcome: "created",
        state,
        binding: parseTrustedConversation(loadTrustByIdStmt.get(input.source, input.accountId, trustId) as TrustedConversationRow)
      };
    });

    return run();
  }

  async function applyConversationLifecycleEvent(event: ConversationLifecycleEvent) {
    const observedAt = nowIso(event.observedAt);

    const run = db.transaction(() => {
      const validatedEvent = ConversationLifecycleEventSchema.parse(event);
      const state = ensureAuthorityState(validatedEvent.source, validatedEvent.accountId, observedAt);
      if (state.status !== "bound") {
        return;
      }

      if (validatedEvent.eventKind !== "bot_removed") {
        return;
      }

      recordTrustedConversationReacquireBoundary({
        source: validatedEvent.source,
        accountId: validatedEvent.accountId,
        ownerGeneration: state.ownerGeneration,
        conversationRef: validatedEvent.conversationRef,
        coverage: "descendants",
        grantKind: "owner_auto",
        observedAt
      });
    });

    run();
  }

  async function revokeTrustedConversation(input: RevokeTrustedConversationInput): Promise<RevokeTrustedConversationResult> {
    const now = nowIso(input.now);

    const run = db.transaction((): RevokeTrustedConversationResult => {
      const state = ensureAuthorityState(input.source, input.accountId, now);
      const row = input.trustId
        ? loadTrustByIdStmt.get(input.source, input.accountId, input.trustId) as TrustedConversationRow | undefined
        : (listTrustedStmt.all(input.source, input.accountId) as TrustedConversationRow[])
          .find((candidate) => candidate.conversationKey === input.conversationKey && candidate.ownerGeneration === state.ownerGeneration);

      if (!row) {
        return { outcome: "not_found", state, affectedOutboundLegality: false };
      }

      const binding = parseTrustedConversation(row);
      if (binding.status === "revoked") {
        return { outcome: "already_revoked", state, revokedBinding: binding, affectedOutboundLegality: false };
      }

      db.prepare(`
        UPDATE trusted_conversations
        SET status = 'revoked', revoked_at = ?, revoked_reason = ?, revoked_by_operator_id = ?
        WHERE trust_id = ?
      `).run(now, input.reason ?? "manual revoke", input.operatorActorId, binding.trustId);

      return {
        outcome: "revoked",
        state,
        revokedBinding: parseTrustedConversation(loadTrustByIdStmt.get(input.source, input.accountId, binding.trustId) as TrustedConversationRow),
        affectedOutboundLegality: true
      };
    });

    return run();
  }

  async function matchTrustedConversation(input: MatchTrustedConversationInput) {
    const state = ensureAuthorityState(input.source, input.accountId);
    if (state.status !== "bound") {
      return undefined;
    }

    const rows = (listTrustedStmt.all(input.source, input.accountId) as TrustedConversationRow[])
      .map(parseTrustedConversation)
      .filter((binding) => binding.status === "active" && isTrustedConversationCurrentGeneration(binding, state.ownerGeneration))
      .sort((left, right) => {
        if (left.coverage === right.coverage) {
          return right.grantedAt.localeCompare(left.grantedAt);
        }
        return left.coverage === "exact" ? -1 : 1;
      });

    return rows.find((binding) => matchesTrustedConversationBinding(binding, input.conversationRef));
  }

  async function listTrustedConversations(input: ListScopeInput) {
    const state = ensureAuthorityState(input.source, input.accountId, nowIso(input.now));
    const bindings = (listTrustedStmt.all(input.source, input.accountId) as TrustedConversationRow[])
      .map(parseTrustedConversation)
      .filter((binding) => {
        if (input.includeInactive) {
          return true;
        }
        return binding.status === "active" && binding.ownerGeneration === state.ownerGeneration;
      });
    return bindings;
  }

  return {
    getAuthorityState,
    inspectOwnerBinding,
    getOwnerPreferences,
    upsertOwnerPreferences,
    getOwnerInitState,
    upsertOwnerInitState,
    markOwnerInitPrompted,
    upsertConversationDirectoryEntry,
    resolveConversationTarget,
    listConversationDirectory,
    upsertPersonaProfile,
    getPersonaProfile,
    clearPersonaProfile,
    listPersonaProfiles,
    setModelOverride,
    getModelOverrides,
    upsertProviderControl,
    getProviderControl,
    setProviderSecret,
    getProviderSecret,
    clearProviderSecret,
    inspectProviderControl,
    revealProviderApiKey,
    createOrReusePairClaim,
    approvePairClaim,
    resetOwnerBinding,
    ensureTrustedConversation,
    applyConversationLifecycleEvent,
    revokeTrustedConversation,
    matchTrustedConversation,
    listPairClaims,
    listTrustedConversations,
    evaluateClaimExpiry
  };
}
