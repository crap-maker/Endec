import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAccessStore } from "./access-store.ts";
import { ensureAccessSchema } from "./schema.ts";

const tempFiles = new Set<string>();

function directConversationRef() {
  return {
    accountId: "telegram:bot:endec",
    conversationId: "dm:chat_42",
    peerId: "chat_42",
    peerKind: "dm" as const
  };
}

function trustedConversationRef() {
  return {
    accountId: "telegram:bot:endec",
    conversationId: "group:chat_100:topic:77",
    peerId: "chat_100",
    peerKind: "group" as const,
    parentConversationId: "group:chat_100",
    baseConversationId: "group:chat_100",
    topicId: "77"
  };
}

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "endec-access-store-"));
  const filename = join(dir, "access.sqlite");
  tempFiles.add(filename);
  return filename;
}

afterEach(async () => {
  await Promise.all([...tempFiles].map(async (filename) => {
    await rm(filename, { force: true });
    tempFiles.delete(filename);
  }));
});

describe("access store", () => {
  it("stores persona profiles, conversation directory rows, and model overrides", async () => {
    const store = createAccessStore({ filename: ":memory:" });

    await store.upsertConversationDirectoryEntry({
      source: "telegram",
      accountId: "acct_bot",
      conversationKey: "supergroup:-100123:topic:77",
      baseConversationKey: "supergroup:-100123",
      conversationLabel: "release-room",
      latestSessionId: "session_group_a",
      observedAt: "2026-05-01T09:00:00.000Z"
    });

    await store.upsertPersonaProfile({
      source: "telegram",
      accountId: "acct_bot",
      ownerBindingId: "owner_001",
      ownerGeneration: 1,
      scopeKind: "shared_default",
      styleInstructions: "friendly but terse",
      behaviorInstructions: "prefer bullets",
      updatedByActorId: "actor_owner",
      now: "2026-05-01T09:01:00.000Z"
    });

    await store.setModelOverride({
      source: "telegram",
      accountId: "acct_bot",
      modelTier: "cheap",
      providerId: "openai",
      modelId: "gpt5.5",
      updatedByActorId: "actor_owner",
      now: "2026-05-01T09:02:00.000Z"
    });

    expect(
      await store.resolveConversationTarget({
        source: "telegram",
        accountId: "acct_bot",
        target: "release-room"
      })
    ).toMatchObject({
      conversationKey: "supergroup:-100123:topic:77",
      baseConversationKey: "supergroup:-100123"
    });

    expect(
      await store.getPersonaProfile({
        source: "telegram",
        accountId: "acct_bot",
        ownerGeneration: 1,
        scopeKind: "shared_default"
      })
    ).toMatchObject({ ownerBindingId: "owner_001", scopeKind: "shared_default" });

    expect(await store.getModelOverrides({ source: "telegram", accountId: "acct_bot" })).toMatchObject([
      { modelTier: "cheap", providerId: "openai", modelId: "gpt5.5" }
    ]);
  });

  it("stores provider control separately, masks secrets by default, reveals only on the dedicated path, and falls back to env-or-missing after clear", async () => {
    const filename = await tempDb();
    const store = createAccessStore({ filename });

    await store.upsertProviderControl({
      source: "telegram",
      accountId: "acct_bot",
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrlOverride: "https://api.persisted.example/v1",
      updatedByActorId: "actor_owner",
      now: "2026-05-02T09:00:00.000Z"
    });
    await store.setProviderSecret({
      source: "telegram",
      accountId: "acct_bot",
      apiKey: "sk-persisted-secret-1234",
      updatedByActorId: "actor_owner",
      now: "2026-05-02T09:01:00.000Z"
    });

    const db = new Database(filename, { readonly: true });
    expect(db.prepare(`
      SELECT source, account_id, provider_id, model_id, base_url_override
      FROM instance_provider_control
    `).all()).toEqual([
      {
        source: "telegram",
        account_id: "acct_bot",
        provider_id: "openai",
        model_id: "gpt-5.4",
        base_url_override: "https://api.persisted.example/v1"
      }
    ]);
    expect(db.prepare(`
      SELECT source, account_id, api_key
      FROM instance_provider_secret
    `).all()).toEqual([
      {
        source: "telegram",
        account_id: "acct_bot",
        api_key: "sk-persisted-secret-1234"
      }
    ]);
    db.close();

    await expect(store.inspectProviderControl({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toMatchObject({
      providerId: "openai",
      providerSource: "persisted",
      modelId: "gpt-5.4",
      modelSource: "persisted",
      baseUrl: "https://api.persisted.example/v1",
      baseUrlSource: "persisted",
      apiKeyMasked: "sk-****1234",
      apiKeySource: "persisted",
      apiKeyPresent: true
    });
    await expect(store.revealProviderApiKey({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toEqual({
      apiKey: "sk-persisted-secret-1234",
      apiKeyPresent: true,
      apiKeySource: "persisted"
    });

    await expect(store.clearProviderSecret({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toBe("cleared");
    await expect(store.inspectProviderControl({
      source: "telegram",
      accountId: "acct_bot",
      fallbackApiKey: "sk-env-secret-9876",
      fallbackApiKeySource: "env"
    })).resolves.toMatchObject({
      apiKeyMasked: "sk-****9876",
      apiKeySource: "env",
      apiKeyPresent: true
    });
    await expect(store.inspectProviderControl({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toMatchObject({
      apiKeyMasked: undefined,
      apiKeySource: "missing",
      apiKeyPresent: false
    });
  });

  it("reuses one live claim per requester and preserves DM routing metadata without session truth", async () => {
    const store = createAccessStore({ filename: ":memory:" });

    const created = await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    });
    const reused = await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:01:00.000Z"
    });

    expect(created.outcome).toBe("created");
    expect(reused.outcome).toBe("reused");
    expect(reused.claim?.claimId).toBe(created.claim?.claimId);
    expect(reused.claim?.pairCode).toBe(created.claim?.pairCode);
    expect(created.claim).toMatchObject({
      requestWorkspaceId: "workspace_local",
      requestConversationRef: directConversationRef()
    });
    expect(created.claim?.requestSessionId).toBeUndefined();

    const claims = await store.listPairClaims({
      source: "telegram",
      accountId: "telegram:bot:endec",
      includeInactive: true
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]?.requestWorkspaceId).toBe("workspace_local");
  });

  it("preserves legacy missing pair-claim routing metadata as undefined", async () => {
    const filename = await tempDb();
    const db = new Database(filename);

    db.exec(`
      CREATE TABLE pair_claims (
        claim_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        account_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        requester_subject_ref TEXT NOT NULL,
        requester_actor_id TEXT NOT NULL,
        request_conversation_ref_json TEXT NOT NULL,
        pair_code TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        superseded_at TEXT
      );
    `);

    db.prepare(`
      INSERT INTO pair_claims (
        claim_id,
        source,
        account_id,
        owner_generation,
        requester_subject_ref,
        requester_actor_id,
        request_conversation_ref_json,
        pair_code,
        status,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      "claim_legacy_null_routing",
      "telegram",
      "telegram:bot:endec",
      0,
      "telegram-user:legacy",
      "actor_legacy",
      JSON.stringify(directConversationRef()),
      "LEGC0001",
      "2026-04-29T00:10:00.000Z",
      "2026-04-29T00:00:00.000Z"
    );
    db.close();

    const store = createAccessStore({ filename });
    const claims = await store.listPairClaims({
      source: "telegram",
      accountId: "telegram:bot:endec",
      includeInactive: true
    });
    const claim = claims.find((entry) => entry.claimId === "claim_legacy_null_routing");

    expect(claim).toBeDefined();
    expect(claim?.requestWorkspaceId).toBeUndefined();
    expect(claim?.requestSessionId).toBeUndefined();
  });

  it("reuses duplicate requester claims atomically when a requester-unique race wins first", async () => {
    const filename = await tempDb();
    const request = {
      source: "telegram" as const,
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    };

    const originalPrepare = Database.prototype.prepare;
    let injected = false;

    (Database.prototype as unknown as { prepare: typeof Database.prototype.prepare }).prepare = function patchedPrepare(
      sql: string,
      ...args: any[]
    ) {
      const statement = (originalPrepare as any).call(this, sql, ...args);
      if (sql.includes("INSERT OR IGNORE INTO pair_claims")) {
        const originalRun = statement.run.bind(statement) as (...params: any[]) => unknown;
        statement.run = ((...params: any[]) => {
          if (!injected) {
            injected = true;
            const [claimId, source, accountId, ownerGeneration, requesterSubjectRef, requesterActorId, requestWorkspaceId, requestSessionId, requestConversationRefJson, , expiresAt, createdAt] = params;
            (originalPrepare as any).call(this, `
              INSERT INTO pair_claims (
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
              `${String(claimId)}_winning_race`,
              source,
              accountId,
              ownerGeneration,
              requesterSubjectRef,
              requesterActorId,
              requestWorkspaceId,
              requestSessionId,
              requestConversationRefJson,
              "RACE1234",
              expiresAt,
              createdAt
            );
          }
          return originalRun(...params);
        }) as typeof statement.run;
      }
      return statement;
    };

    try {
      const store = createAccessStore({ filename });
      const result = await store.createOrReusePairClaim(request);

      expect(result.outcome).toBe("reused");
      expect(result.claim).toMatchObject({
        requesterSubjectRef: request.requesterSubjectRef,
        pairCode: "RACE1234",
        requestWorkspaceId: request.requestWorkspaceId,
        requestSessionId: request.requestSessionId,
        requestConversationRef: request.requestConversationRef
      });

      const claims = await store.listPairClaims({
        source: "telegram",
        accountId: "telegram:bot:endec",
        includeInactive: true
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]?.claimId).toContain("winning_race");
    } finally {
      (Database.prototype as unknown as { prepare: typeof Database.prototype.prepare }).prepare = originalPrepare;
    }
  });

  it("allows only one approval winner across competing store handles and stamps the operator", async () => {
    const filename = await tempDb();
    const storeA = createAccessStore({ filename });
    const storeB = createAccessStore({ filename });

    const claim = (await storeA.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;

    const first = await storeA.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:02:00.000Z"
    });
    const second = await storeB.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_beta",
      now: "2026-04-29T00:02:01.000Z"
    });

    expect(first.outcome).toBe("approved");
    expect(first.ownerBinding).toMatchObject({
      ownerSubjectRef: "telegram-user:42",
      ownerActorId: "actor_42",
      approvedByOperatorId: "operator_alpha"
    });
    expect(["authority_already_bound", "claim_not_pending", "claim_not_found"]).toContain(second.outcome);

    const owner = await storeA.inspectOwnerBinding({
      source: "telegram",
      accountId: "telegram:bot:endec"
    });
    expect(owner?.approvedByOperatorId).toBe("operator_alpha");
  });

  it("reset increments generation, revokes the owner binding, and supersedes stale pending claims", async () => {
    const filename = await tempDb();
    const store = createAccessStore({ filename });

    const winningClaim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;

    await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: winningClaim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    const db = new Database(filename);
    db.prepare(`
      INSERT INTO pair_claims (
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
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      "claim_stale_manual",
      "telegram",
      "telegram:bot:endec",
      0,
      "telegram-user:77",
      "actor_77",
      "workspace_local",
      "session_077",
      JSON.stringify(directConversationRef()),
      "ZXCV1234",
      "2026-04-29T00:09:00.000Z",
      "2026-04-29T00:02:00.000Z"
    );
    db.close();

    const reset = await store.resetOwnerBinding({
      source: "telegram",
      accountId: "telegram:bot:endec",
      operatorActorId: "operator_reset",
      reason: "rotate owner",
      now: "2026-04-29T00:03:00.000Z"
    });

    expect(reset.outcome).toBe("reset");
    expect(reset.newOwnerGeneration).toBe(1);
    expect(reset.supersededClaimCount).toBe(1);
    expect(reset.revokedOwnerBinding).toMatchObject({
      status: "revoked",
      revokedByOperatorId: "operator_reset",
      revokedReason: "rotate owner"
    });

    const state = await store.getAuthorityState({
      source: "telegram",
      accountId: "telegram:bot:endec"
    });
    expect(state).toMatchObject({
      status: "unbound",
      ownerGeneration: 1,
      ownerBindingId: undefined
    });

    const claims = await store.listPairClaims({
      source: "telegram",
      accountId: "telegram:bot:endec",
      includeInactive: true
    });
    expect(claims.find((claim) => claim.claimId === "claim_stale_manual")?.status).toBe("superseded");
  });

  it("keeps repeated trust acquire idempotent and refuses replay after manual revoke", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    const first = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:02:00.000Z"
    });
    const second = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:02:05.000Z"
    });

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("existing_active");
    expect(second.binding?.trustId).toBe(first.binding?.trustId);

    const revoked = await store.revokeTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      trustId: first.binding!.trustId,
      operatorActorId: "operator_alpha",
      reason: "manual revoke",
      now: "2026-04-29T00:03:00.000Z"
    });
    expect(revoked.outcome).toBe("revoked");

    const replay = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:03:05.000Z"
    });
    expect(replay.outcome).toBe("revoked");

    const matched = await store.matchTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef()
    });
    expect(matched).toBeUndefined();
  });

  it("allows same-timestamp bot-removed boundary and revoke to reacquire trust on re-add", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    const initial = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:02:00.000Z"
    });
    expect(initial.outcome).toBe("created");

    await store.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      conversationScope: "shared",
      eventKind: "bot_removed",
      observedAt: "2026-04-29T00:03:00.000Z"
    });
    await store.revokeTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      trustId: initial.binding!.trustId,
      operatorActorId: "system:authority-lifecycle",
      reason: "bot_removed",
      now: "2026-04-29T00:03:00.000Z"
    });

    const reacquired = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:04:00.000Z"
    });

    expect(reacquired.outcome).toBe("created");
    expect(reacquired.binding?.trustId).not.toBe(initial.binding?.trustId);
  });

  it("allows trust reacquire only after explicit same-generation boundary or a later generation", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    const initial = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:02:00.000Z"
    });
    await store.revokeTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      trustId: initial.binding!.trustId,
      operatorActorId: "operator_alpha",
      reason: "manual revoke",
      now: "2026-04-29T00:03:00.000Z"
    });

    const sameGenerationWithoutBoundary = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:04:00.000Z"
    });
    expect(sameGenerationWithoutBoundary.outcome).toBe("revoked");

    await store.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      conversationScope: "shared",
      eventKind: "bot_removed",
      observedAt: "2026-04-29T00:04:30.000Z"
    });

    const sameGeneration = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:05:00.000Z"
    });
    expect(sameGeneration.outcome).toBe("created");
    expect(sameGeneration.binding?.trustId).not.toBe(initial.binding?.trustId);

    await store.resetOwnerBinding({
      source: "telegram",
      accountId: "telegram:bot:endec",
      operatorActorId: "operator_reset",
      reason: "re-pair",
      now: "2026-04-29T00:06:00.000Z"
    });

    const claimTwo = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:99",
      requesterActorId: "actor_99",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_099",
      requestConversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_99",
        peerId: "chat_99",
        peerKind: "dm"
      },
      now: "2026-04-29T00:07:00.000Z"
    })).claim!;
    await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claimTwo.pairCode,
      operatorActorId: "operator_beta",
      now: "2026-04-29T00:08:00.000Z"
    });

    const nextGeneration = await store.ensureTrustedConversation({
      source: "telegram",
      accountId: "telegram:bot:endec",
      conversationRef: trustedConversationRef(),
      coverage: "descendants",
      grantKind: "owner_auto",
      now: "2026-04-29T00:09:00.000Z"
    });
    expect(nextGeneration.outcome).toBe("created");
    expect(nextGeneration.binding?.ownerGeneration).toBe(1);
  });

  it("seeds pending init state after approval and transitions prompt state idempotently", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;

    const approved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    const seeded = await store.getOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec"
    });
    expect(approved.outcome).toBe("approved");
    expect(seeded).toMatchObject({
      status: "pending_prompt",
      promptVersion: 1,
      ownerBindingId: approved.ownerBinding?.ownerBindingId
    });
    expect(seeded?.promptSentAt).toBeUndefined();

    const first = await store.markOwnerInitPrompted({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      now: "2026-04-29T00:02:00.000Z"
    });
    const second = await store.markOwnerInitPrompted({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      now: "2026-04-29T00:03:00.000Z"
    });
    const prompted = await store.getOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec"
    });

    expect(first).toBe("transitioned");
    expect(second).toBe("unchanged");
    expect(prompted).toMatchObject({
      status: "prompted",
      promptSentAt: "2026-04-29T00:02:00.000Z",
      updatedAt: "2026-04-29T00:02:00.000Z"
    });
  });

  it("supports owner-init lifecycle upserts through completion without dropping preserved fields", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    const approved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    const prompted = await store.upsertOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      status: "prompted",
      promptVersion: 1,
      promptSentAt: "2026-04-29T00:02:00.000Z",
      now: "2026-04-29T00:02:00.000Z"
    });
    expect(prompted).toMatchObject({
      status: "prompted",
      promptSentAt: "2026-04-29T00:02:00.000Z",
      updatedAt: "2026-04-29T00:02:00.000Z"
    });

    const completed = await store.upsertOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      status: "completed",
      promptVersion: 1,
      completionReason: "fields_captured",
      completedAt: "2026-04-29T00:05:00.000Z",
      now: "2026-04-29T00:05:00.000Z"
    });
    expect(completed).toMatchObject({
      status: "completed",
      promptSentAt: "2026-04-29T00:02:00.000Z",
      completionReason: "fields_captured",
      completedAt: "2026-04-29T00:05:00.000Z",
      updatedAt: "2026-04-29T00:05:00.000Z"
    });

    const refreshed = await store.upsertOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      status: "completed",
      promptVersion: 1,
      now: "2026-04-29T00:06:00.000Z"
    });
    expect(refreshed).toMatchObject({
      status: "completed",
      promptSentAt: "2026-04-29T00:02:00.000Z",
      completionReason: "fields_captured",
      completedAt: "2026-04-29T00:05:00.000Z",
      updatedAt: "2026-04-29T00:06:00.000Z"
    });
  });

  it("rejects owner-init status regressions after prompting or completion", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    const approved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    await store.upsertOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      status: "prompted",
      promptVersion: 1,
      promptSentAt: "2026-04-29T00:02:00.000Z",
      now: "2026-04-29T00:02:00.000Z"
    });

    await expect(store.upsertOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      status: "pending_prompt",
      promptVersion: 1,
      now: "2026-04-29T00:03:00.000Z"
    })).rejects.toThrow(/regress/i);

    await store.upsertOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      status: "completed",
      promptVersion: 1,
      completionReason: "fields_captured",
      completedAt: "2026-04-29T00:05:00.000Z",
      now: "2026-04-29T00:05:00.000Z"
    });

    await expect(store.upsertOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      status: "prompted",
      promptVersion: 1,
      now: "2026-04-29T00:06:00.000Z"
    })).rejects.toThrow(/regress/i);
  });

  it("preserves stored owner preferences when incremental updates omit fields", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    const approved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    await store.upsertOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      ownerActorId: approved.ownerBinding!.ownerActorId,
      ownerDisplayName: "Alice",
      assistantDisplayName: "Endec",
      timezone: "Asia/Shanghai",
      now: "2026-04-29T00:02:00.000Z"
    });

    const updated = await store.upsertOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      ownerActorId: approved.ownerBinding!.ownerActorId,
      timezone: "America/Los_Angeles",
      now: "2026-04-29T00:03:00.000Z"
    });

    expect(updated).toMatchObject({
      ownerDisplayName: "Alice",
      assistantDisplayName: "Endec",
      timezone: "America/Los_Angeles"
    });
  });

  it("clears stored owner preferences only when fields are explicitly nulled", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    const approved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    await store.upsertOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      ownerActorId: approved.ownerBinding!.ownerActorId,
      ownerDisplayName: "Alice",
      assistantDisplayName: "Endec",
      timezone: "Asia/Shanghai",
      now: "2026-04-29T00:02:00.000Z"
    });

    const cleared = await store.upsertOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      ownerActorId: approved.ownerBinding!.ownerActorId,
      assistantDisplayName: null,
      now: "2026-04-29T00:03:00.000Z"
    });

    expect(cleared).toMatchObject({
      ownerDisplayName: "Alice",
      timezone: "Asia/Shanghai"
    });
    expect(cleared.assistantDisplayName).toBeUndefined();
  });

  it("keeps stored preferences sparse while exposing only current-generation owner data", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const claim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    const approved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: claim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });

    const upserted = await store.upsertOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      ownerActorId: approved.ownerBinding!.ownerActorId,
      assistantDisplayName: undefined,
      timezone: "Asia/Shanghai",
      now: "2026-04-29T00:02:00.000Z"
    });
    expect(upserted).toMatchObject({
      timezone: "Asia/Shanghai"
    });
    expect(upserted.assistantDisplayName).toBeUndefined();

    const current = await store.getOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec"
    });
    expect(current).toMatchObject({
      ownerBindingId: approved.ownerBinding!.ownerBindingId,
      timezone: "Asia/Shanghai"
    });
    expect(current?.assistantDisplayName).toBeUndefined();
  });

  it("does not revive old owner preferences or init state after reset and re-pair", async () => {
    const store = createAccessStore({ filename: ":memory:" });
    const firstClaim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:42",
      requesterActorId: "actor_42",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_001",
      requestConversationRef: directConversationRef(),
      now: "2026-04-29T00:00:00.000Z"
    })).claim!;
    const firstApproved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: firstClaim.pairCode,
      operatorActorId: "operator_alpha",
      now: "2026-04-29T00:01:00.000Z"
    });
    await store.upsertOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: firstApproved.ownerBinding!.ownerBindingId,
      ownerActorId: firstApproved.ownerBinding!.ownerActorId,
      ownerDisplayName: "Alice",
      timezone: "Asia/Shanghai",
      now: "2026-04-29T00:02:00.000Z"
    });
    await store.markOwnerInitPrompted({
      source: "telegram",
      accountId: "telegram:bot:endec",
      ownerBindingId: firstApproved.ownerBinding!.ownerBindingId,
      now: "2026-04-29T00:03:00.000Z"
    });

    await store.resetOwnerBinding({
      source: "telegram",
      accountId: "telegram:bot:endec",
      operatorActorId: "operator_reset",
      reason: "rotate owner",
      now: "2026-04-29T00:04:00.000Z"
    });

    expect(await store.getOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec"
    })).toBeUndefined();
    expect(await store.getOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec"
    })).toBeUndefined();

    const secondClaim = (await store.createOrReusePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      requesterSubjectRef: "telegram-user:99",
      requesterActorId: "actor_99",
      requestWorkspaceId: "workspace_local",
      requestSessionId: "session_099",
      requestConversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_99",
        peerId: "chat_99",
        peerKind: "dm"
      },
      now: "2026-04-29T00:05:00.000Z"
    })).claim!;
    const secondApproved = await store.approvePairClaim({
      source: "telegram",
      accountId: "telegram:bot:endec",
      pairCode: secondClaim.pairCode,
      operatorActorId: "operator_beta",
      now: "2026-04-29T00:06:00.000Z"
    });

    expect(await store.getOwnerPreferences({
      source: "telegram",
      accountId: "telegram:bot:endec"
    })).toBeUndefined();
    expect(await store.getOwnerInitState({
      source: "telegram",
      accountId: "telegram:bot:endec"
    })).toMatchObject({
      ownerBindingId: secondApproved.ownerBinding!.ownerBindingId,
      status: "pending_prompt"
    });
  });

  it("adds owner preference/init tables idempotently for pre-profile databases", async () => {
    const filename = await tempDb();
    const db = new Database(filename);
    db.exec(`
      CREATE TABLE instance_authority_state (
        source TEXT NOT NULL,
        account_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        owner_binding_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, account_id)
      );
    `);
    ensureAccessSchema(db);
    ensureAccessSchema(db);

    const listColumns = (tableName: string) => db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    expect(listColumns("owner_preferences").map((column) => column.name)).toEqual(expect.arrayContaining([
      "source",
      "account_id",
      "owner_generation",
      "owner_binding_id",
      "owner_actor_id",
      "owner_display_name",
      "assistant_display_name",
      "timezone",
      "created_at",
      "updated_at"
    ]));
    expect(listColumns("owner_init_state").map((column) => column.name)).toEqual(expect.arrayContaining([
      "source",
      "account_id",
      "owner_generation",
      "owner_binding_id",
      "status",
      "prompt_version",
      "prompt_sent_at",
      "completion_reason",
      "completed_at",
      "updated_at"
    ]));
    db.close();
  });
});
