import type Database from "better-sqlite3";

const bootstrapTablesSql = `
CREATE TABLE IF NOT EXISTS instance_authority_state (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  owner_binding_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id)
);

CREATE TABLE IF NOT EXISTS instance_owner_bindings (
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
  approved_by_operator_id TEXT,
  revoked_by_operator_id TEXT
);

CREATE TABLE IF NOT EXISTS pair_claims (
  claim_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  requester_subject_ref TEXT NOT NULL,
  requester_actor_id TEXT NOT NULL,
  request_workspace_id TEXT NOT NULL,
  request_session_id TEXT,
  request_conversation_ref_json TEXT NOT NULL,
  pair_code TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  superseded_at TEXT,
  approved_by_operator_id TEXT
);

CREATE TABLE IF NOT EXISTS trusted_conversations (
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
  revoked_reason TEXT,
  revoked_by_operator_id TEXT
);

CREATE TABLE IF NOT EXISTS trusted_conversation_reacquire_boundaries (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  conversation_key TEXT NOT NULL,
  coverage TEXT NOT NULL,
  grant_kind TEXT NOT NULL,
  bot_absent_observed_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id, owner_generation, grant_kind, coverage, conversation_key)
);

CREATE TABLE IF NOT EXISTS owner_preferences (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  owner_binding_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  owner_display_name TEXT,
  assistant_display_name TEXT,
  timezone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id, owner_generation, owner_binding_id)
);

CREATE TABLE IF NOT EXISTS owner_init_state (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  owner_binding_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  prompt_sent_at TEXT,
  completion_reason TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id, owner_generation, owner_binding_id)
);

CREATE TABLE IF NOT EXISTS persona_profiles (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_binding_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  scope_kind TEXT NOT NULL,
  conversation_key TEXT NOT NULL DEFAULT '',
  style_instructions TEXT NOT NULL,
  behavior_instructions TEXT NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id, owner_generation, scope_kind, conversation_key)
);

CREATE TABLE IF NOT EXISTS instance_model_overrides (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id, model_tier)
);

CREATE TABLE IF NOT EXISTS instance_provider_control (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  base_url_override TEXT,
  updated_by_actor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id)
);

CREATE TABLE IF NOT EXISTS instance_provider_secret (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id)
);

CREATE TABLE IF NOT EXISTS conversation_directory (
  source TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  base_conversation_key TEXT,
  conversation_label TEXT,
  latest_session_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (source, account_id, conversation_key)
);
`;

const bootstrapIndexesSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_instance_owner_bindings_active
ON instance_owner_bindings (source, account_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_instance_owner_bindings_scope_generation
ON instance_owner_bindings (source, account_id, owner_generation DESC, bound_at DESC, owner_binding_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_claims_pending_pair_code
ON pair_claims (source, account_id, pair_code)
WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_claims_pending_requester
ON pair_claims (source, account_id, requester_subject_ref)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pair_claims_scope_created_at
ON pair_claims (source, account_id, created_at DESC, claim_id DESC);

CREATE INDEX IF NOT EXISTS idx_pair_claims_scope_generation_status
ON pair_claims (source, account_id, owner_generation, status, expires_at, claim_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_conversations_active_unique
ON trusted_conversations (source, account_id, owner_generation, grant_kind, coverage, conversation_key)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_trusted_conversations_scope_generation
ON trusted_conversations (source, account_id, owner_generation, status, conversation_key, granted_at DESC, trust_id DESC);

CREATE INDEX IF NOT EXISTS idx_trusted_conversation_reacquire_boundaries_scope_generation
ON trusted_conversation_reacquire_boundaries (source, account_id, owner_generation, conversation_key, bot_absent_observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_owner_preferences_scope_generation_binding
ON owner_preferences (source, account_id, owner_generation, owner_binding_id);

CREATE INDEX IF NOT EXISTS idx_owner_init_state_scope_generation_binding
ON owner_init_state (source, account_id, owner_generation, owner_binding_id);

CREATE INDEX IF NOT EXISTS idx_persona_profiles_scope
ON persona_profiles (source, account_id, owner_generation DESC, scope_kind, conversation_key);

CREATE INDEX IF NOT EXISTS idx_instance_model_overrides_scope
ON instance_model_overrides (source, account_id, model_tier);

CREATE INDEX IF NOT EXISTS idx_instance_provider_control_scope
ON instance_provider_control (source, account_id);

CREATE INDEX IF NOT EXISTS idx_instance_provider_secret_scope
ON instance_provider_secret (source, account_id);

CREATE INDEX IF NOT EXISTS idx_conversation_directory_label
ON conversation_directory (source, account_id, conversation_label, observed_at DESC, conversation_key);
`;

export const bootstrapSql = `${bootstrapTablesSql}\n${bootstrapIndexesSql}`;

function columnInfo(db: Database.Database, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: 0 | 1;
  }>;
}

function columnNames(db: Database.Database, tableName: string) {
  return new Set(columnInfo(db, tableName).map((column) => column.name));
}

function isRequiredColumn(db: Database.Database, tableName: string, columnName: string) {
  return columnInfo(db, tableName).some((column) => column.name === columnName && column.notnull === 1);
}

function addNullableColumnIfMissing(db: Database.Database, tableName: string, columnName: string, definition: string) {
  const columns = columnNames(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function recreatePairClaimsTableWithNullableRequestSessionId(db: Database.Database) {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec("ALTER TABLE pair_claims RENAME TO pair_claims__legacy_notnull_request_session_id");
    db.exec(`
      CREATE TABLE pair_claims (
        claim_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        account_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL,
        requester_subject_ref TEXT NOT NULL,
        requester_actor_id TEXT NOT NULL,
        request_workspace_id TEXT NOT NULL,
        request_session_id TEXT,
        request_conversation_ref_json TEXT NOT NULL,
        pair_code TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        superseded_at TEXT,
        approved_by_operator_id TEXT
      )
    `);
    db.exec(`
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
      )
      SELECT
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
      FROM pair_claims__legacy_notnull_request_session_id
    `);
    db.exec("DROP TABLE pair_claims__legacy_notnull_request_session_id");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function ensureAccessSchema(db: Database.Database) {
  db.exec(bootstrapTablesSql);

  if (isRequiredColumn(db, "pair_claims", "request_session_id")) {
    recreatePairClaimsTableWithNullableRequestSessionId(db);
  }

  addNullableColumnIfMissing(db, "instance_owner_bindings", "approved_by_operator_id", "TEXT");
  addNullableColumnIfMissing(db, "instance_owner_bindings", "revoked_by_operator_id", "TEXT");

  addNullableColumnIfMissing(db, "pair_claims", "request_workspace_id", "TEXT");
  addNullableColumnIfMissing(db, "pair_claims", "request_session_id", "TEXT");
  addNullableColumnIfMissing(db, "pair_claims", "approved_by_operator_id", "TEXT");

  addNullableColumnIfMissing(db, "trusted_conversations", "revoked_by_operator_id", "TEXT");

  db.exec(bootstrapIndexesSql);
}
