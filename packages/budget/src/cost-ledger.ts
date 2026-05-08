import Database from "better-sqlite3";
import { CostLedgerSchema, type CostLedger } from "@endec/domain";

const bootstrapSql = `
CREATE TABLE IF NOT EXISTS cost_ledger (
  ledger_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER NOT NULL,
  estimated_cost REAL NOT NULL,
  memory_injected_tokens INTEGER NOT NULL,
  tool_result_injected_tokens INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL,
  loop_count INTEGER NOT NULL,
  stop_reason TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL
);
`;

interface CostLedgerRow {
  ledgerId: string;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  mode: CostLedger["mode"];
  modelId: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number;
  estimatedCost: number;
  memoryInjectedTokens: number;
  toolResultInjectedTokens: number;
  toolCallCount: number;
  loopCount: number;
  stopReason: string;
  startedAt: string;
  endedAt: string;
}

function columnInfo(db: Database.Database, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: 0 | 1;
  }>;
}

function tableExists(db: Database.Database, tableName: string) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row);
}

function hasLegacyNotNullCacheColumns(db: Database.Database) {
  return columnInfo(db, "cost_ledger").some((column) =>
    (column.name === "cache_read_tokens" || column.name === "cache_write_tokens") && column.notnull === 1
  );
}

function migrateLegacyCostLedgerSchema(db: Database.Database) {
  if (!tableExists(db, "cost_ledger") || !hasLegacyNotNullCacheColumns(db)) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec("ALTER TABLE cost_ledger RENAME TO cost_ledger__legacy_notnull_cache_metrics");
    db.exec(bootstrapSql);
    db.exec(`
      INSERT INTO cost_ledger (
        ledger_id,
        turn_id,
        session_id,
        workspace_id,
        mode,
        model_id,
        provider_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        estimated_cost,
        memory_injected_tokens,
        tool_result_injected_tokens,
        tool_call_count,
        loop_count,
        stop_reason,
        started_at,
        ended_at
      )
      SELECT
        ledger_id,
        turn_id,
        session_id,
        workspace_id,
        mode,
        model_id,
        provider_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        estimated_cost,
        memory_injected_tokens,
        tool_result_injected_tokens,
        tool_call_count,
        loop_count,
        stop_reason,
        started_at,
        ended_at
      FROM cost_ledger__legacy_notnull_cache_metrics
      ORDER BY rowid ASC
    `);
    db.exec("DROP TABLE cost_ledger__legacy_notnull_cache_metrics");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function createCostLedger({ filename }: { filename: string }) {
  const db = new Database(filename);

  db.exec(bootstrapSql);
  migrateLegacyCostLedgerSchema(db);

  const insertRow = db.prepare(`
    INSERT OR REPLACE INTO cost_ledger (
      ledger_id,
      turn_id,
      session_id,
      workspace_id,
      mode,
      model_id,
      provider_id,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      total_tokens,
      estimated_cost,
      memory_injected_tokens,
      tool_result_injected_tokens,
      tool_call_count,
      loop_count,
      stop_reason,
      started_at,
      ended_at
    ) VALUES (
      @ledgerId,
      @turnId,
      @sessionId,
      @workspaceId,
      @mode,
      @modelId,
      @providerId,
      @inputTokens,
      @outputTokens,
      @cacheReadTokens,
      @cacheWriteTokens,
      @totalTokens,
      @estimatedCost,
      @memoryInjectedTokens,
      @toolResultInjectedTokens,
      @toolCallCount,
      @loopCount,
      @stopReason,
      @startedAt,
      @endedAt
    )
  `);

  const listRows = db.prepare<unknown[], CostLedgerRow>(`
    SELECT
      ledger_id AS ledgerId,
      turn_id AS turnId,
      session_id AS sessionId,
      workspace_id AS workspaceId,
      mode AS mode,
      model_id AS modelId,
      provider_id AS providerId,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens,
      cache_write_tokens AS cacheWriteTokens,
      total_tokens AS totalTokens,
      estimated_cost AS estimatedCost,
      memory_injected_tokens AS memoryInjectedTokens,
      tool_result_injected_tokens AS toolResultInjectedTokens,
      tool_call_count AS toolCallCount,
      loop_count AS loopCount,
      stop_reason AS stopReason,
      started_at AS startedAt,
      ended_at AS endedAt
    FROM cost_ledger
    ORDER BY rowid ASC
  `);
  const loadByTurnIdRow = db.prepare<unknown[], CostLedgerRow>(`
    SELECT
      ledger_id AS ledgerId,
      turn_id AS turnId,
      session_id AS sessionId,
      workspace_id AS workspaceId,
      mode AS mode,
      model_id AS modelId,
      provider_id AS providerId,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens,
      cache_write_tokens AS cacheWriteTokens,
      total_tokens AS totalTokens,
      estimated_cost AS estimatedCost,
      memory_injected_tokens AS memoryInjectedTokens,
      tool_result_injected_tokens AS toolResultInjectedTokens,
      tool_call_count AS toolCallCount,
      loop_count AS loopCount,
      stop_reason AS stopReason,
      started_at AS startedAt,
      ended_at AS endedAt
    FROM cost_ledger
    WHERE turn_id = ?
    ORDER BY rowid DESC
    LIMIT 1
  `);

  function parseRow(row: CostLedgerRow) {
    return CostLedgerSchema.parse({
      ...row,
      cacheReadTokens: row.cacheReadTokens ?? undefined,
      cacheWriteTokens: row.cacheWriteTokens ?? undefined
    });
  }

  return {
    async record(input: CostLedger) {
      const record = CostLedgerSchema.parse(input);
      insertRow.run({
        ...record,
        cacheReadTokens: record.cacheReadTokens ?? null,
        cacheWriteTokens: record.cacheWriteTokens ?? null
      });
    },
    async list(): Promise<CostLedger[]> {
      const rows = listRows.all();
      return rows.map(parseRow);
    },
    async loadByTurnId(turnId: string): Promise<CostLedger | undefined> {
      const row = loadByTurnIdRow.get(turnId);
      return row ? parseRow(row) : undefined;
    }
  };
}
