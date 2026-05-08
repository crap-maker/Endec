import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createAccessStore } from "./access-store.ts";

const tempFiles = new Set<string>();

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "endec-access-schema-"));
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

function createLegacyAccessDatabase(filename: string) {
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

    CREATE TABLE instance_owner_bindings (
      owner_binding_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      account_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL,
      owner_subject_ref TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      paired_conversation_ref_json TEXT NOT NULL,
      consumed_claim_id TEXT NOT NULL,
      status TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      approved_by_operator_id TEXT
    );

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

    CREATE TABLE trusted_conversations (
      trust_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      account_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL,
      conversation_ref_json TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      coverage TEXT NOT NULL,
      grant_kind TEXT NOT NULL,
      granted_by_owner_binding_id TEXT NOT NULL,
      status TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT
    );

    INSERT INTO instance_authority_state (
      source,
      account_id,
      owner_generation,
      owner_binding_id,
      status,
      created_at,
      updated_at
    ) VALUES (
      'telegram',
      'telegram:bot:endec',
      0,
      'binding_legacy_001',
      'bound',
      '2026-04-29T00:00:00.000Z',
      '2026-04-29T00:00:00.000Z'
    );

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
      approved_by_operator_id
    ) VALUES (
      'binding_legacy_001',
      'telegram',
      'telegram:bot:endec',
      0,
      'telegram-user:42',
      'actor_42',
      '{"accountId":"telegram:bot:endec","conversationId":"dm:chat_42","peerId":"chat_42","peerKind":"dm"}',
      'claim_legacy_001',
      'active',
      '2026-04-29T00:00:00.000Z',
      NULL,
      NULL,
      'operator_alpha'
    );

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
      created_at,
      consumed_at,
      superseded_at
    ) VALUES (
      'claim_legacy_001',
      'telegram',
      'telegram:bot:endec',
      0,
      'telegram-user:42',
      'actor_42',
      '{"accountId":"telegram:bot:endec","conversationId":"dm:chat_42","peerId":"chat_42","peerKind":"dm"}',
      'ABCD1234',
      'consumed',
      '2026-04-29T00:10:00.000Z',
      '2026-04-29T00:00:00.000Z',
      '2026-04-29T00:01:00.000Z',
      NULL
    );

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
      revoked_reason
    ) VALUES (
      'trust_legacy_001',
      'telegram',
      'telegram:bot:endec',
      0,
      '{"accountId":"telegram:bot:endec","conversationId":"group:chat_100","peerId":"chat_100","peerKind":"group","baseConversationId":"group:chat_100"}',
      'group:chat_100',
      'descendants',
      'owner_auto',
      'binding_legacy_001',
      'active',
      '2026-04-29T00:02:00.000Z',
      NULL,
      NULL
    );
  `);
  db.close();
}

function listColumns(db: Database.Database, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: 0 | 1;
  }>;
}

describe("access schema migration", () => {
  it("migrates a legacy authority database idempotently and preserves rows", async () => {
    const filename = await tempDb();
    createLegacyAccessDatabase(filename);

    const firstStore = createAccessStore({ filename });
    const secondStore = createAccessStore({ filename });

    await expect(firstStore.inspectOwnerBinding({
      source: "telegram",
      accountId: "telegram:bot:endec"
    })).resolves.toMatchObject({
      ownerBindingId: "binding_legacy_001",
      ownerActorId: "actor_42",
      approvedByOperatorId: "operator_alpha"
    });

    await expect(secondStore.listTrustedConversations({
      source: "telegram",
      accountId: "telegram:bot:endec",
      includeInactive: true
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        trustId: "trust_legacy_001",
        conversationKey: "group:chat_100"
      })
    ]));

    const db = new Database(filename);
    expect(listColumns(db, "instance_owner_bindings").map((column) => column.name)).toEqual(expect.arrayContaining([
      "revoked_by_operator_id"
    ]));
    const pairClaimColumns = listColumns(db, "pair_claims");
    expect(pairClaimColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "request_workspace_id",
      "request_session_id",
      "approved_by_operator_id"
    ]));
    expect(pairClaimColumns.find((column) => column.name === "request_session_id")?.notnull).toBe(0);
    expect(listColumns(db, "trusted_conversations").map((column) => column.name)).toEqual(expect.arrayContaining([
      "revoked_by_operator_id"
    ]));
    expect(listColumns(db, "trusted_conversation_reacquire_boundaries").map((column) => column.name)).toEqual(expect.arrayContaining([
      "source",
      "account_id",
      "owner_generation",
      "conversation_key",
      "coverage",
      "grant_kind",
      "bot_absent_observed_at"
    ]));
    expect(listColumns(db, "owner_preferences").map((column) => column.name)).toEqual(expect.arrayContaining([
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
    expect(listColumns(db, "owner_init_state").map((column) => column.name)).toEqual(expect.arrayContaining([
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

    const legacyClaim = db.prepare(`
      SELECT request_workspace_id, request_session_id, approved_by_operator_id
      FROM pair_claims
      WHERE claim_id = 'claim_legacy_001'
    `).get() as Record<string, unknown>;
    expect(legacyClaim).toEqual({
      request_workspace_id: null,
      request_session_id: null,
      approved_by_operator_id: null
    });
    db.close();
  });

  it("migrates legacy pair_claims to nullable request_session_id without rewriting rows", async () => {
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

      CREATE TABLE pair_claims (
        claim_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        account_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        requester_subject_ref TEXT NOT NULL,
        requester_actor_id TEXT NOT NULL,
        request_workspace_id TEXT NOT NULL,
        request_session_id TEXT NOT NULL,
        request_conversation_ref_json TEXT NOT NULL,
        pair_code TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        superseded_at TEXT,
        approved_by_operator_id TEXT
      );

      INSERT INTO instance_authority_state (
        source,
        account_id,
        owner_generation,
        owner_binding_id,
        status,
        created_at,
        updated_at
      ) VALUES (
        'telegram',
        'telegram:bot:endec',
        0,
        NULL,
        'unbound',
        '2026-04-29T00:00:00.000Z',
        '2026-04-29T00:00:00.000Z'
      );

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
      ) VALUES (
        'claim_nullable_migration_001',
        'telegram',
        'telegram:bot:endec',
        0,
        'telegram-user:42',
        'actor_42',
        'workspace_local',
        'session_001',
        '{"accountId":"telegram:bot:endec","conversationId":"dm:chat_42","peerId":"chat_42","peerKind":"dm"}',
        'ABCD1234',
        'pending',
        '2026-04-29T00:10:00.000Z',
        '2026-04-29T00:00:00.000Z',
        NULL,
        NULL,
        NULL
      );
    `);
    db.close();

    const store = createAccessStore({ filename });
    await expect(store.listPairClaims({
      source: 'telegram',
      accountId: 'telegram:bot:endec',
      includeInactive: true
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        claimId: 'claim_nullable_migration_001',
        requestSessionId: 'session_001'
      })
    ]));

    const migratedDb = new Database(filename);
    const pairClaimColumns = listColumns(migratedDb, "pair_claims");
    expect(pairClaimColumns.find((column) => column.name === "request_session_id")?.notnull).toBe(0);
    const migratedRow = migratedDb.prepare(`
      SELECT request_session_id
      FROM pair_claims
      WHERE claim_id = 'claim_nullable_migration_001'
    `).get() as Record<string, unknown>;
    expect(migratedRow).toEqual({ request_session_id: 'session_001' });
    migratedDb.close();
  });

  it("creates owner preference/init tables when migrating a pre-profile database", async () => {
    const filename = await tempDb();
    createLegacyAccessDatabase(filename);

    createAccessStore({ filename });

    const db = new Database(filename);
    expect(listColumns(db, "owner_preferences").map((column) => column.name)).toEqual(expect.arrayContaining([
      "owner_actor_id",
      "timezone"
    ]));
    expect(listColumns(db, "owner_init_state").map((column) => column.name)).toEqual(expect.arrayContaining([
      "status",
      "prompt_version",
      "prompt_sent_at"
    ]));
    db.close();
  });
});
