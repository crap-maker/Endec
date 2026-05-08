import type Database from "better-sqlite3";

const bootstrapTablesSql = `
CREATE TABLE IF NOT EXISTS session_working_sets (
  working_set_ref TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  summary TEXT NOT NULL,
  objective TEXT,
  recent_progress TEXT NOT NULL DEFAULT '[]',
  recent_decisions TEXT NOT NULL DEFAULT '[]',
  blockers TEXT NOT NULL DEFAULT '[]',
  open_loops TEXT NOT NULL DEFAULT '[]',
  active_memory_refs TEXT NOT NULL DEFAULT '[]',
  active_task_refs TEXT NOT NULL DEFAULT '[]',
  recent_event_refs TEXT NOT NULL DEFAULT '[]',
  highlights TEXT NOT NULL,
  blocker_snapshot TEXT,
  source_refs TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_outbox (
  write_id TEXT PRIMARY KEY,
  source_turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  write_kind TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS evidence_store (
  evidence_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  conversation_boundary_key TEXT,
  visibility TEXT,
  borrowed_conversation_keys_json TEXT NOT NULL DEFAULT '[]',
  transient_borrowed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS typed_memory_store (
  memory_id TEXT PRIMARY KEY,
  write_id TEXT NOT NULL UNIQUE,
  source_turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT,
  task_id TEXT,
  scope TEXT,
  importance REAL NOT NULL DEFAULT 0,
  memory_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  selection_state TEXT NOT NULL DEFAULT 'active',
  memory_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  conversation_boundary_key TEXT,
  visibility TEXT,
  borrowed_conversation_keys_json TEXT NOT NULL DEFAULT '[]',
  transient_borrowed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  corrected_at TEXT,
  superseded_by_memory_id TEXT,
  correction_id TEXT,
  correction_reason TEXT,
  correction_actor_id TEXT
);

CREATE TABLE IF NOT EXISTS projection_derived_refs (
  ref TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  section TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  turn_refs TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const bootstrapIndexesSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_working_sets_session_version
ON session_working_sets(session_id, version);

CREATE INDEX IF NOT EXISTS idx_typed_memory_session_updated
ON typed_memory_store(session_id, updated_at DESC, memory_id DESC);

CREATE INDEX IF NOT EXISTS idx_typed_memory_workspace_updated
ON typed_memory_store(workspace_id, updated_at DESC, memory_id DESC);

CREATE INDEX IF NOT EXISTS idx_typed_memory_actor_updated
ON typed_memory_store(actor_id, updated_at DESC, memory_id DESC);

CREATE INDEX IF NOT EXISTS idx_projection_derived_refs_workspace_day
ON projection_derived_refs(workspace_id, day DESC, section ASC, ref ASC);
`;

export const bootstrapSql = `${bootstrapTablesSql}\n${bootstrapIndexesSql}`;

function listColumns(db: Database.Database, tableName: string) {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name);
}

export function ensureMemorySchema(db: Database.Database) {
  db.exec(bootstrapTablesSql);

  const workingSetColumns = new Set(listColumns(db, "session_working_sets"));
  if (!workingSetColumns.has("objective")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN objective TEXT`);
  }
  if (!workingSetColumns.has("recent_progress")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN recent_progress TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!workingSetColumns.has("recent_decisions")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN recent_decisions TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!workingSetColumns.has("blockers")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN blockers TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!workingSetColumns.has("open_loops")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN open_loops TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!workingSetColumns.has("active_memory_refs")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN active_memory_refs TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!workingSetColumns.has("active_task_refs")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN active_task_refs TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!workingSetColumns.has("recent_event_refs")) {
    db.exec(`ALTER TABLE session_working_sets ADD COLUMN recent_event_refs TEXT NOT NULL DEFAULT '[]'`);
  }

  const outboxColumns = new Set(listColumns(db, "memory_outbox"));
  if (!outboxColumns.has("status")) {
    db.exec(`ALTER TABLE memory_outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
  }
  if (!outboxColumns.has("attempt_count")) {
    db.exec(`ALTER TABLE memory_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!outboxColumns.has("last_error")) {
    db.exec(`ALTER TABLE memory_outbox ADD COLUMN last_error TEXT`);
  }
  if (!outboxColumns.has("failed_at")) {
    db.exec(`ALTER TABLE memory_outbox ADD COLUMN failed_at TEXT`);
  }

  const evidenceColumns = new Set(listColumns(db, "evidence_store"));
  if (!evidenceColumns.has("conversation_boundary_key")) {
    db.exec(`ALTER TABLE evidence_store ADD COLUMN conversation_boundary_key TEXT`);
  }
  if (!evidenceColumns.has("visibility")) {
    db.exec(`ALTER TABLE evidence_store ADD COLUMN visibility TEXT`);
  }
  if (!evidenceColumns.has("borrowed_conversation_keys_json")) {
    db.exec(`ALTER TABLE evidence_store ADD COLUMN borrowed_conversation_keys_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!evidenceColumns.has("transient_borrowed")) {
    db.exec(`ALTER TABLE evidence_store ADD COLUMN transient_borrowed INTEGER NOT NULL DEFAULT 0`);
  }

  const typedMemoryColumns = new Set(listColumns(db, "typed_memory_store"));
  if (!typedMemoryColumns.has("actor_id")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN actor_id TEXT`);
  }
  if (!typedMemoryColumns.has("task_id")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN task_id TEXT`);
  }
  if (!typedMemoryColumns.has("scope")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN scope TEXT`);
  }
  if (!typedMemoryColumns.has("importance")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN importance REAL NOT NULL DEFAULT 0`);
  }
  if (!typedMemoryColumns.has("selection_state")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN selection_state TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!typedMemoryColumns.has("conversation_boundary_key")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN conversation_boundary_key TEXT`);
  }
  if (!typedMemoryColumns.has("visibility")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN visibility TEXT`);
  }
  if (!typedMemoryColumns.has("borrowed_conversation_keys_json")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN borrowed_conversation_keys_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!typedMemoryColumns.has("transient_borrowed")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN transient_borrowed INTEGER NOT NULL DEFAULT 0`);
  }
  if (!typedMemoryColumns.has("corrected_at")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN corrected_at TEXT`);
  }
  if (!typedMemoryColumns.has("superseded_by_memory_id")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN superseded_by_memory_id TEXT`);
  }
  if (!typedMemoryColumns.has("correction_id")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN correction_id TEXT`);
  }
  if (!typedMemoryColumns.has("correction_reason")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN correction_reason TEXT`);
  }
  if (!typedMemoryColumns.has("correction_actor_id")) {
    db.exec(`ALTER TABLE typed_memory_store ADD COLUMN correction_actor_id TEXT`);
  }

  db.exec(bootstrapIndexesSql);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_typed_memory_selection_state ON typed_memory_store(selection_state, updated_at DESC, memory_id DESC)`);
}
