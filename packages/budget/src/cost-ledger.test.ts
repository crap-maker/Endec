import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCostLedger } from "./cost-ledger";

const tempDirs: string[] = [];

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "endec-cost-ledger-"));
  tempDirs.push(dir);
  return join(dir, "cost-ledger.sqlite");
}

function createLegacyCostLedgerTable(filename: string) {
  const db = new Database(filename);
  try {
    db.exec(`
      CREATE TABLE cost_ledger (
        ledger_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
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
      ) VALUES (
        'legacy_001',
        'turn_legacy_001',
        'session_legacy_001',
        'workspace_local',
        'act',
        'strong-default',
        'local-default',
        7,
        2,
        4,
        1,
        9,
        0.002,
        0,
        0,
        0,
        1,
        'stop',
        '2026-05-03T00:00:00.000Z',
        '2026-05-03T00:00:01.000Z'
      )
    `);
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("CostLedger", () => {
  it("writes a canonical ledger row", async () => {
    const ledger = createCostLedger({ filename: ":memory:" });

    await ledger.record({
      ledgerId: "ledger_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      mode: "act",
      modelId: "strong-default",
      providerId: "local-default",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      estimatedCost: 0.01,
      memoryInjectedTokens: 20,
      toolResultInjectedTokens: 5,
      toolCallCount: 1,
      loopCount: 1,
      stopReason: "stop",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString()
    });

    const rows = await ledger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: "workspace_local",
      providerId: "local-default",
      modelId: "strong-default",
      toolCallCount: 1,
      loopCount: 1
    });
  });

  it("preserves unreported cache metrics instead of forcing zeroes", async () => {
    const ledger = createCostLedger({ filename: ":memory:" });

    await ledger.record({
      ledgerId: "ledger_002",
      turnId: "turn_002",
      sessionId: "session_002",
      workspaceId: "workspace_local",
      mode: "act",
      modelId: "strong-default",
      providerId: "local-default",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      estimatedCost: 0.001,
      memoryInjectedTokens: 0,
      toolResultInjectedTokens: 0,
      toolCallCount: 0,
      loopCount: 1,
      stopReason: "stop",
      startedAt: new Date(2).toISOString(),
      endedAt: new Date(3).toISOString()
    });

    const rows = await ledger.list();
    expect(rows[0]).toMatchObject({
      ledgerId: "ledger_002",
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined
    });
  });

  it("migrates legacy NOT NULL cache columns to nullable and preserves rows", async () => {
    const filename = createTempDbPath();
    createLegacyCostLedgerTable(filename);

    const ledger = createCostLedger({ filename });
    await ledger.record({
      ledgerId: "ledger_002",
      turnId: "turn_002",
      sessionId: "session_002",
      workspaceId: "workspace_local",
      mode: "act",
      modelId: "strong-default",
      providerId: "local-default",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      estimatedCost: 0.001,
      memoryInjectedTokens: 0,
      toolResultInjectedTokens: 0,
      toolCallCount: 0,
      loopCount: 1,
      stopReason: "stop",
      startedAt: new Date(2).toISOString(),
      endedAt: new Date(3).toISOString()
    });

    const verifyDb = new Database(filename, { readonly: true });
    try {
      expect((verifyDb.prepare("PRAGMA table_info(cost_ledger)").all() as Array<{ name: string; notnull: 0 | 1 }>).find((column) => column.name === "cache_read_tokens")?.notnull).toBe(0);
      expect((verifyDb.prepare("PRAGMA table_info(cost_ledger)").all() as Array<{ name: string; notnull: 0 | 1 }>).find((column) => column.name === "cache_write_tokens")?.notnull).toBe(0);

      const rows = await ledger.list();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        ledgerId: "legacy_001",
        cacheReadTokens: 4,
        cacheWriteTokens: 1
      });
      expect(rows[1]).toMatchObject({
        ledgerId: "ledger_002",
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined
      });
    } finally {
      verifyDb.close();
    }
  });
});
