import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";

const tempDirs: string[] = [];

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "endec-memory-schema-"));
  tempDirs.push(dir);
  return join(dir, "memory.sqlite");
}

function createLegacyTypedMemoryTable(filename: string) {
  const db = new Database(filename);
  try {
    db.exec(`
      CREATE TABLE typed_memory_store (
        memory_id TEXT PRIMARY KEY,
        write_id TEXT NOT NULL UNIQUE,
        source_turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        memory_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        evidence_refs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        task_id TEXT,
        scope TEXT,
        importance REAL NOT NULL DEFAULT 0
      );

      INSERT INTO typed_memory_store (
        memory_id,
        write_id,
        source_turn_id,
        session_id,
        workspace_id,
        memory_kind,
        status,
        memory_type,
        summary,
        content,
        payload_json,
        evidence_refs,
        created_at,
        updated_at,
        task_id,
        scope,
        importance
      ) VALUES (
        'memory_legacy_001',
        'write_legacy_001',
        'turn_legacy_001',
        'session_legacy_001',
        'workspace_local',
        'typed_upsert',
        'materialized',
        'semantic',
        'legacy summary',
        'legacy content',
        '{"summary":"legacy summary"}',
        '["turn_legacy_001"]',
        '2026-04-20T09:00:00.000Z',
        '2026-04-20T09:00:00.000Z',
        'task_legacy_001',
        'workspace',
        0.7
      );
    `);
  } finally {
    db.close();
  }
}

function listColumnNames(filename: string) {
  const db = new Database(filename, { readonly: true });
  try {
    return (db.prepare("PRAGMA table_info(typed_memory_store)").all() as Array<{ name: string }>).map((column) => column.name);
  } finally {
    db.close();
  }
}

function listIndexNames(filename: string) {
  const db = new Database(filename, { readonly: true });
  try {
    return (db.prepare("PRAGMA index_list(typed_memory_store)").all() as Array<{ name: string }>).map((index) => index.name);
  } finally {
    db.close();
  }
}

describe("memory schema migrations", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("migrates legacy typed memory table before creating actor-aware indexes", async () => {
    const filename = createTempDbPath();
    createLegacyTypedMemoryTable(filename);

    expect(() => createMemoryStore({ filename })).not.toThrow();

    const columns = listColumnNames(filename);
    expect(columns).toEqual(expect.arrayContaining([
      "actor_id",
      "selection_state",
      "corrected_at",
      "superseded_by_memory_id",
      "correction_id",
      "correction_reason",
      "correction_actor_id"
    ]));
    expect(listIndexNames(filename)).toEqual(expect.arrayContaining([
      "idx_typed_memory_actor_updated",
      "idx_typed_memory_selection_state"
    ]));

    expect(() => createMemoryStore({ filename })).not.toThrow();

    const store = createMemoryStore({ filename });
    const rows = await store.listTypedMemory({
      sessionId: "session_legacy_001",
      workspaceId: "workspace_local"
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memoryId: "memory_legacy_001",
      writeId: "write_legacy_001",
      summary: "legacy summary",
      selectionState: "active",
      scope: "workspace",
      taskId: "task_legacy_001",
      importance: 0.7
    });
  });
});
