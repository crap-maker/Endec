import type Database from "better-sqlite3";

export const bootstrapSql = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_from TEXT NOT NULL,
  last_source TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  current_goal TEXT NOT NULL,
  working_set_ref TEXT NOT NULL,
  working_set_version INTEGER NOT NULL,
  active_task_ids TEXT NOT NULL,
  recent_turn_refs TEXT NOT NULL,
  last_event_seq INTEGER NOT NULL,
  last_turn_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inflight_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  waiting_reason TEXT NOT NULL,
  resume_policy TEXT NOT NULL,
  loop_count INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL,
  pending_approval_ref TEXT,
  checkpoint_ref TEXT NOT NULL,
  frame_ref TEXT,
  contract_version TEXT,
  pending_execution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS committed_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  session_status TEXT NOT NULL,
  current_goal TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS session_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  event_text TEXT NOT NULL,
  summary TEXT NOT NULL,
  artifact_refs TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES committed_turns(turn_id)
);

CREATE INDEX IF NOT EXISTS idx_inflight_turns_session_id ON inflight_turns (session_id);
CREATE INDEX IF NOT EXISTS idx_committed_turns_session_created_at ON committed_turns (session_id, created_at DESC, turn_id DESC);
CREATE INDEX IF NOT EXISTS idx_session_events_session_seq ON session_events (session_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_session_events_workspace_created_at ON session_events (workspace_id, created_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_session_events_turn_id ON session_events (turn_id, seq DESC);
`;

const inflightTurnColumnMigrations = [
  {
    columnName: "frame_ref",
    alterSql: "ALTER TABLE inflight_turns ADD COLUMN frame_ref TEXT"
  },
  {
    columnName: "contract_version",
    alterSql: "ALTER TABLE inflight_turns ADD COLUMN contract_version TEXT"
  },
  {
    columnName: "pending_execution_json",
    alterSql: "ALTER TABLE inflight_turns ADD COLUMN pending_execution_json TEXT"
  }
] as const;

function listTableColumns(db: Database.Database, tableName: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function migrateInflightTurnsTable(db: Database.Database) {
  const existingColumns = listTableColumns(db, "inflight_turns");

  for (const migration of inflightTurnColumnMigrations) {
    if (!existingColumns.has(migration.columnName)) {
      db.exec(migration.alterSql);
    }
  }
}

function migrateSessionsTable(db: Database.Database) {
  const columns = listTableColumns(db, "sessions");
  if (!columns.has("focus_task_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN focus_task_id TEXT");
  }
  if (!columns.has("focus_run_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN focus_run_id TEXT");
  }
  if (!columns.has("focus_updated_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN focus_updated_at TEXT");
  }
}

function migrateCommittedTurnsTable(db: Database.Database) {
  const columns = listTableColumns(db, "committed_turns");
  if (!columns.has("usage_json")) {
    db.exec("ALTER TABLE committed_turns ADD COLUMN usage_json TEXT");
  }
}

export function ensureSessionsSchema(db: Database.Database) {
  db.exec(bootstrapSql);
  migrateInflightTurnsTable(db);
  migrateSessionsTable(db);
  migrateCommittedTurnsTable(db);
}
