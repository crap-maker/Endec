import type Database from "better-sqlite3";

export const bootstrapSql = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  last_turn_id TEXT NOT NULL,
  checkpoint_ref TEXT NOT NULL,
  plan_json TEXT,
  current_step TEXT,
  next_action TEXT,
  artifacts_json TEXT,
  blocking_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_session_status_updated_at ON tasks (session_id, status, updated_at DESC, task_id DESC);
`;

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

function addColumnIfMissing(db: Database.Database, tableName: string, columnName: string, definition: string) {
  const columns = columnNames(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function tableExists(db: Database.Database, tableName: string) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
}

function foreignKeyInfo(db: Database.Database, tableName: string) {
  return db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    from: string;
    table: string;
  }>;
}

function recreateRunControlInputsTableWithoutAppliedSliceForeignKey(db: Database.Database) {
  if (!tableExists(db, "run_control_inputs")) {
    return;
  }

  const foreignKeys = foreignKeyInfo(db, "run_control_inputs");
  const hasAppliedSliceForeignKey = foreignKeys.some((foreignKey) => foreignKey.from === "applied_slice_id" && foreignKey.table === "runtime_slices");
  if (!hasAppliedSliceForeignKey) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec("ALTER TABLE run_control_inputs RENAME TO run_control_inputs__legacy_with_applied_slice_fk");
    db.exec(`
      CREATE TABLE run_control_inputs (
        control_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        control_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        applied_slice_id TEXT,
        applied_at TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id),
        FOREIGN KEY(run_id) REFERENCES task_runs(run_id)
      )
    `);
    db.exec(`
      INSERT INTO run_control_inputs (
        control_seq,
        control_id,
        task_id,
        run_id,
        kind,
        payload_json,
        created_at,
        applied_slice_id,
        applied_at
      )
      SELECT
        control_seq,
        control_id,
        task_id,
        run_id,
        kind,
        payload_json,
        created_at,
        applied_slice_id,
        applied_at
      FROM run_control_inputs__legacy_with_applied_slice_fk
    `);
    db.exec("DROP TABLE run_control_inputs__legacy_with_applied_slice_fk");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureUniqueIndex(
  db: Database.Database,
  tableName: string,
  indexName: string,
  createIndexSql: string
) {
  const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string; unique: 0 | 1 }>;
  const existing = indexes.find((index) => index.name === indexName);
  if (existing && existing.unique === 0) {
    db.exec(`DROP INDEX IF EXISTS ${indexName}`);
  }
  db.exec(createIndexSql);
}

function ensureRunOwnershipTriggers(db: Database.Database) {
  if (tableExists(db, "runtime_slices")) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_runtime_slices_task_run_ownership_insert
      BEFORE INSERT ON runtime_slices
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
        FROM task_runs
        WHERE run_id = NEW.run_id
          AND task_id <> NEW.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'runtime_slices.task_id must match task_runs.task_id');
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_runtime_slices_task_run_ownership_update
      BEFORE UPDATE OF run_id, task_id ON runtime_slices
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
        FROM task_runs
        WHERE run_id = NEW.run_id
          AND task_id <> NEW.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'runtime_slices.task_id must match task_runs.task_id');
      END
    `);
  }

  if (tableExists(db, "run_control_inputs")) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_run_control_inputs_task_run_ownership_insert
      BEFORE INSERT ON run_control_inputs
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
        FROM task_runs
        WHERE run_id = NEW.run_id
          AND task_id <> NEW.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'run_control_inputs.task_id must match task_runs.task_id');
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_run_control_inputs_task_run_ownership_update
      BEFORE UPDATE OF run_id, task_id ON run_control_inputs
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
        FROM task_runs
        WHERE run_id = NEW.run_id
          AND task_id <> NEW.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'run_control_inputs.task_id must match task_runs.task_id');
      END
    `);
  }
}

function recreateOutboundEventsTableWithNullableSessionId(db: Database.Database) {
  const legacyColumns = columnNames(db, "outbound_events");

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec("ALTER TABLE outbound_events RENAME TO outbound_events__legacy_notnull_session_id");
    db.exec(`
      CREATE TABLE outbound_events (
        outbound_event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT,
        actor_id TEXT,
        task_id TEXT,
        run_id TEXT,
        conversation_ref_json TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        render_payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        claim_owner TEXT,
        claim_token TEXT,
        claim_expires_at TEXT,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id),
        FOREIGN KEY(run_id) REFERENCES task_runs(run_id)
      )
    `);
    db.exec(`
      INSERT INTO outbound_events (
        outbound_event_id,
        workspace_id,
        session_id,
        actor_id,
        task_id,
        run_id,
        conversation_ref_json,
        channel,
        event_kind,
        render_payload_json,
        idempotency_key,
        status,
        claim_owner,
        claim_token,
        claim_expires_at,
        available_at,
        created_at,
        updated_at
      )
      SELECT
        outbound_event_id,
        workspace_id,
        session_id,
        actor_id,
        task_id,
        run_id,
        conversation_ref_json,
        channel,
        event_kind,
        render_payload_json,
        idempotency_key,
        status,
        ${legacyColumns.has("claim_owner") ? "claim_owner" : "NULL"},
        ${legacyColumns.has("claim_token") ? "claim_token" : "NULL"},
        ${legacyColumns.has("claim_expires_at") ? "claim_expires_at" : "NULL"},
        available_at,
        created_at,
        updated_at
      FROM outbound_events__legacy_notnull_session_id
    `);
    db.exec("DROP TABLE outbound_events__legacy_notnull_session_id");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function recreateOutboundDeliveriesTableWithCanonicalOutboundEventForeignKey(db: Database.Database) {
  if (!tableExists(db, "outbound_deliveries")) {
    return;
  }

  const foreignKeys = foreignKeyInfo(db, "outbound_deliveries");
  const hasCanonicalOutboundEventForeignKey = foreignKeys.some((foreignKey) => foreignKey.from === "outbound_event_id" && foreignKey.table === "outbound_events");
  if (hasCanonicalOutboundEventForeignKey) {
    return;
  }

  const legacyColumns = columnNames(db, "outbound_deliveries");

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec("ALTER TABLE outbound_deliveries RENAME TO outbound_deliveries__legacy_outbound_event_fk");
    db.exec(`
      CREATE TABLE outbound_deliveries (
        delivery_id TEXT PRIMARY KEY,
        outbound_event_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        transport_target_json TEXT NOT NULL,
        status TEXT NOT NULL,
        claim_owner TEXT,
        claim_expires_at TEXT,
        send_started_at TEXT,
        delivered_at TEXT,
        failed_at TEXT,
        delivery_unknown_at TEXT,
        transport_message_id TEXT,
        transport_receipt_json TEXT,
        error_json TEXT,
        attempt_no INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(outbound_event_id) REFERENCES outbound_events(outbound_event_id)
      )
    `);
    db.exec(`
      INSERT INTO outbound_deliveries (
        delivery_id,
        outbound_event_id,
        transport,
        transport_target_json,
        status,
        claim_owner,
        claim_expires_at,
        send_started_at,
        delivered_at,
        failed_at,
        delivery_unknown_at,
        transport_message_id,
        transport_receipt_json,
        error_json,
        attempt_no,
        idempotency_key,
        created_at,
        updated_at
      )
      SELECT
        delivery_id,
        outbound_event_id,
        transport,
        transport_target_json,
        status,
        claim_owner,
        claim_expires_at,
        send_started_at,
        delivered_at,
        ${legacyColumns.has("failed_at") ? "failed_at" : "NULL"},
        delivery_unknown_at,
        transport_message_id,
        ${legacyColumns.has("transport_receipt_json") ? "transport_receipt_json" : "NULL"},
        error_json,
        attempt_no,
        idempotency_key,
        created_at,
        updated_at
      FROM outbound_deliveries__legacy_outbound_event_fk
    `);
    db.exec("DROP TABLE outbound_deliveries__legacy_outbound_event_fk");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function ensureTaskRunsTable(db: Database.Database) {
  const columnsBeforeMigration = tableExists(db, "task_runs") ? columnNames(db, "task_runs") : new Set<string>();
  const hadRunDeadlineColumn = columnsBeforeMigration.has("run_deadline_at");

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      actor_id TEXT,
      conversation_ref_json TEXT,
      status TEXT NOT NULL,
      attention_mode TEXT NOT NULL DEFAULT 'foreground_attached',
      run_kind TEXT NOT NULL DEFAULT 'normal',
      attempt_no INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      turn_request_json TEXT NOT NULL,
      source_turn_id TEXT,
      worker_id TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      claimed_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      wall_clock_deadline_at TEXT,
      run_deadline_at TEXT,
      cancel_requested_at TEXT,
      cancel_requested_by TEXT,
      cancel_reason TEXT,
      cancel_observed_slice_id TEXT,
      continuation_kind TEXT,
      continuation_payload_json TEXT,
      continuation_updated_at TEXT,
      recovery_truth_state TEXT,
      recovery_truth_updated_at TEXT,
      pending_approval_ref TEXT,
      pending_control_ref TEXT,
      parent_run_id TEXT,
      retry_of_run_id TEXT,
      result_summary TEXT,
      error_json TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      cumulative_input_tokens INTEGER NOT NULL DEFAULT 0,
      cumulative_output_tokens INTEGER NOT NULL DEFAULT 0,
      cumulative_total_tokens INTEGER NOT NULL DEFAULT 0,
      cumulative_estimated_cost REAL NOT NULL DEFAULT 0,
      autonomy_window_slice_count INTEGER NOT NULL DEFAULT 0,
      autonomy_window_tool_call_count INTEGER NOT NULL DEFAULT 0,
      foreground_burst_slice_count INTEGER NOT NULL DEFAULT 0,
      foreground_burst_started_at TEXT,
      last_human_input_at TEXT,
      run_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id)
    )
  `);

  const taskRunColumns = [
    ["actor_id", "TEXT"],
    ["conversation_ref_json", "TEXT"],
    ["attention_mode", "TEXT NOT NULL DEFAULT 'foreground_attached'"],
    ["run_kind", "TEXT NOT NULL DEFAULT 'normal'"],
    ["source_turn_id", "TEXT"],
    ["worker_id", "TEXT"],
    ["lease_owner", "TEXT"],
    ["lease_expires_at", "TEXT"],
    ["claimed_at", "TEXT"],
    ["started_at", "TEXT"],
    ["finished_at", "TEXT"],
    ["max_attempts", "INTEGER NOT NULL DEFAULT 1"],
    ["wall_clock_deadline_at", "TEXT"],
    ["run_deadline_at", "TEXT"],
    ["cancel_requested_at", "TEXT"],
    ["cancel_requested_by", "TEXT"],
    ["cancel_reason", "TEXT"],
    ["cancel_observed_slice_id", "TEXT"],
    ["continuation_kind", "TEXT"],
    ["continuation_payload_json", "TEXT"],
    ["continuation_updated_at", "TEXT"],
    ["recovery_truth_state", "TEXT"],
    ["recovery_truth_updated_at", "TEXT"],
    ["pending_approval_ref", "TEXT"],
    ["pending_control_ref", "TEXT"],
    ["parent_run_id", "TEXT"],
    ["retry_of_run_id", "TEXT"],
    ["result_summary", "TEXT"],
    ["error_json", "TEXT"],
    ["priority", "INTEGER NOT NULL DEFAULT 0"],
    ["cumulative_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cumulative_output_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cumulative_total_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cumulative_estimated_cost", "REAL NOT NULL DEFAULT 0"],
    ["autonomy_window_slice_count", "INTEGER NOT NULL DEFAULT 0"],
    ["autonomy_window_tool_call_count", "INTEGER NOT NULL DEFAULT 0"],
    ["foreground_burst_slice_count", "INTEGER NOT NULL DEFAULT 0"],
    ["foreground_burst_started_at", "TEXT"],
    ["last_human_input_at", "TEXT"],
    ["run_started_at", "TEXT"]
  ] as const;

  for (const [columnName, definition] of taskRunColumns) {
    addColumnIfMissing(db, "task_runs", columnName, definition);
  }

  ensureUniqueIndex(
    db,
    "task_runs",
    "idx_task_runs_task_id_idempotency_key",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_task_id_idempotency_key ON task_runs (task_id, idempotency_key)"
  );
  db.exec("DROP INDEX IF EXISTS idx_task_runs_claim");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_runs_claim ON task_runs (status, priority DESC, created_at ASC, run_id ASC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_runs_lease_recovery ON task_runs (status, lease_expires_at, created_at, run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_runs_task_attempt ON task_runs (task_id, attempt_no, run_id)");

  if (!hadRunDeadlineColumn && columnsBeforeMigration.has("wall_clock_deadline_at")) {
    db.exec(`
      UPDATE task_runs
      SET run_deadline_at = wall_clock_deadline_at
      WHERE run_deadline_at IS NULL
        AND wall_clock_deadline_at IS NOT NULL
    `);
  }
}

function ensureRuntimeSlicesTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_slices (
      slice_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      slice_no INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL,
      lane TEXT NOT NULL,
      status TEXT NOT NULL,
      worker_id TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      claimed_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      budget_snapshot_json TEXT,
      tool_loop_summary_json TEXT,
      usage_summary_json TEXT,
      continuation_payload_json TEXT,
      result_summary TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES task_runs(run_id),
      FOREIGN KEY(task_id) REFERENCES tasks(task_id)
    )
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_slices_run_slice_no ON runtime_slices (run_id, slice_no)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runtime_slices_claim ON runtime_slices (lane, status, created_at, slice_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_runtime_slices_run_status ON runtime_slices (run_id, status, slice_no)");
}

function ensureRunControlInputsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_control_inputs (
      control_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      control_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      applied_slice_id TEXT,
      applied_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id),
      FOREIGN KEY(run_id) REFERENCES task_runs(run_id)
    )
  `);
  recreateRunControlInputsTableWithoutAppliedSliceForeignKey(db);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_control_inputs_control_id ON run_control_inputs (control_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_run_control_inputs_run_pending ON run_control_inputs (run_id, applied_slice_id, control_seq)");
}

export function ensureTasksSchema(db: Database.Database) {
  db.exec(bootstrapSql);

  addColumnIfMissing(db, "tasks", "actor_id", "TEXT");
  addColumnIfMissing(db, "tasks", "conversation_ref_json", "TEXT");
  addColumnIfMissing(db, "tasks", "agent_status", "TEXT");
  addColumnIfMissing(db, "tasks", "background_created_at", "TEXT");

  ensureTaskRunsTable(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_id TEXT,
      workspace_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id),
      FOREIGN KEY(run_id) REFERENCES task_runs(run_id)
    )
  `);

  ensureUniqueIndex(
    db,
    "task_events",
    "idx_task_events_task_seq",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events (task_id, seq)"
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_events_run_created_at ON task_events (run_id, created_at, event_id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_task_id_idempotency_key ON task_events (task_id, idempotency_key) WHERE idempotency_key IS NOT NULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_events (
      outbound_event_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT,
      actor_id TEXT,
      task_id TEXT,
      run_id TEXT,
      conversation_ref_json TEXT NOT NULL,
      channel TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      render_payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_owner TEXT,
      claim_token TEXT,
      claim_expires_at TEXT,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id),
      FOREIGN KEY(run_id) REFERENCES task_runs(run_id)
    )
  `);

  if (tableExists(db, "outbound_events") && isRequiredColumn(db, "outbound_events", "session_id")) {
    recreateOutboundEventsTableWithNullableSessionId(db);
  }

  addColumnIfMissing(db, "outbound_events", "claim_owner", "TEXT");
  addColumnIfMissing(db, "outbound_events", "claim_token", "TEXT");
  addColumnIfMissing(db, "outbound_events", "claim_expires_at", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_events_workspace_id_idempotency_key ON outbound_events (workspace_id, idempotency_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_events_pending ON outbound_events (status, available_at, created_at, outbound_event_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_events_task_run ON outbound_events (task_id, run_id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_deliveries (
      delivery_id TEXT PRIMARY KEY,
      outbound_event_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      transport_target_json TEXT NOT NULL,
      status TEXT NOT NULL,
      claim_owner TEXT,
      claim_expires_at TEXT,
      send_started_at TEXT,
      delivered_at TEXT,
      failed_at TEXT,
      delivery_unknown_at TEXT,
      transport_message_id TEXT,
      transport_receipt_json TEXT,
      error_json TEXT,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(outbound_event_id) REFERENCES outbound_events(outbound_event_id)
    )
  `);
  recreateOutboundDeliveriesTableWithCanonicalOutboundEventForeignKey(db);

  addColumnIfMissing(db, "outbound_deliveries", "failed_at", "TEXT");
  addColumnIfMissing(db, "outbound_deliveries", "transport_receipt_json", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_deliveries_event_transport_idempotency_key ON outbound_deliveries (outbound_event_id, transport, idempotency_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_claim ON outbound_deliveries (transport, status, claim_expires_at, created_at, delivery_id)");

  ensureRuntimeSlicesTable(db);
  ensureRunControlInputsTable(db);
  ensureRunOwnershipTriggers(db);
}
