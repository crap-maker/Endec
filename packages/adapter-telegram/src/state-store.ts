import Database from "better-sqlite3";
import { ConversationRefSchema } from "@endec/domain";
import type { TelegramAdapterStateStore, TelegramSessionBinding } from "./telegram-types.ts";

type SessionBindingRow = {
  sessionId: string;
  conversationRef: string;
  updatedAt: string;
};

function parseSessionBinding(row: SessionBindingRow): TelegramSessionBinding {
  return {
    sessionId: row.sessionId,
    conversationRef: ConversationRefSchema.parse(JSON.parse(row.conversationRef)),
    updatedAt: row.updatedAt
  };
}

function conversationBindingKey(input: {
  source: string;
  workspaceId: string;
  accountId: string;
  conversationId: string;
}) {
  return [input.source, input.workspaceId, input.accountId, input.conversationId].join("\u001f");
}

function actorBindingKey(input: {
  source: string;
  workspaceId: string;
  accountId: string;
  senderId: string;
}) {
  return [input.source, input.workspaceId, input.accountId, input.senderId].join("\u001f");
}

export function createInMemoryTelegramAdapterStateStore(): TelegramAdapterStateStore {
  const sessionBindingsByConversation = new Map<string, TelegramSessionBinding>();
  const sessionBindingsBySessionId = new Map<string, TelegramSessionBinding>();
  const actorBindings = new Map<string, string>();
  const inboundDedup = new Map<string, number>();
  const pollingOffsets = new Map<string, number>();

  function purgeExpiredDedup(nowMs: number) {
    for (const [key, expiresAtMs] of inboundDedup.entries()) {
      if (expiresAtMs <= nowMs) {
        inboundDedup.delete(key);
      }
    }
  }

  return {
    async loadSessionBindingByConversation(input) {
      return sessionBindingsByConversation.get(
        conversationBindingKey({
          source: input.source,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          conversationId: input.conversationRef.conversationId
        })
      );
    },

    async loadSessionBindingBySessionId(sessionId) {
      return sessionBindingsBySessionId.get(sessionId);
    },

    async saveSessionBinding(input) {
      const binding: TelegramSessionBinding = {
        sessionId: input.sessionId,
        conversationRef: input.conversationRef,
        updatedAt: new Date().toISOString()
      };
      sessionBindingsByConversation.set(
        conversationBindingKey({
          source: input.source,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          conversationId: input.conversationRef.conversationId
        }),
        binding
      );
      sessionBindingsBySessionId.set(input.sessionId, binding);
    },

    async loadActorBinding(input) {
      return actorBindings.get(actorBindingKey(input));
    },

    async saveActorBinding(input) {
      actorBindings.set(actorBindingKey(input), input.actorId);
    },

    async claimInboundDedup(input) {
      const nowMs = Date.now();
      purgeExpiredDedup(nowMs);
      if (inboundDedup.has(input.dedupKey)) {
        return false;
      }
      inboundDedup.set(input.dedupKey, input.expiresAtMs);
      return true;
    },

    async readPollingOffset(input) {
      return pollingOffsets.get(input.accountId) ?? null;
    },

    async writePollingOffset(input) {
      pollingOffsets.set(input.accountId, input.nextUpdateId);
    },

    close() {
      sessionBindingsByConversation.clear();
      sessionBindingsBySessionId.clear();
      actorBindings.clear();
      inboundDedup.clear();
      pollingOffsets.clear();
    }
  };
}

const bootstrapSql = `
CREATE TABLE IF NOT EXISTS telegram_session_bindings (
  source TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  conversation_ref_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, workspace_id, account_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_session_bindings_session_id
  ON telegram_session_bindings (session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS telegram_actor_bindings (
  source TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, workspace_id, account_id, sender_id)
);

CREATE TABLE IF NOT EXISTS telegram_inbound_dedup (
  dedup_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_inbound_dedup_expires_at
  ON telegram_inbound_dedup (expires_at);

CREATE TABLE IF NOT EXISTS telegram_polling_offsets (
  account_id TEXT PRIMARY KEY,
  next_update_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function createSqliteTelegramAdapterStateStore({ filename }: { filename: string }): TelegramAdapterStateStore {
  const db = new Database(filename);
  db.exec(bootstrapSql);

  const loadSessionByConversationStmt = db.prepare(`
    SELECT
      session_id as sessionId,
      conversation_ref_json as conversationRef,
      updated_at as updatedAt
    FROM telegram_session_bindings
    WHERE source = ?
      AND workspace_id = ?
      AND account_id = ?
      AND conversation_id = ?
  `);
  const loadSessionBySessionIdStmt = db.prepare(`
    SELECT
      session_id as sessionId,
      conversation_ref_json as conversationRef,
      updated_at as updatedAt
    FROM telegram_session_bindings
    WHERE session_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const saveSessionBindingStmt = db.prepare(`
    INSERT INTO telegram_session_bindings (
      source,
      workspace_id,
      account_id,
      conversation_id,
      session_id,
      conversation_ref_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, workspace_id, account_id, conversation_id) DO UPDATE SET
      session_id = excluded.session_id,
      conversation_ref_json = excluded.conversation_ref_json,
      updated_at = excluded.updated_at
  `);
  const loadActorBindingStmt = db.prepare(`
    SELECT actor_id as actorId
    FROM telegram_actor_bindings
    WHERE source = ?
      AND workspace_id = ?
      AND account_id = ?
      AND sender_id = ?
  `);
  const saveActorBindingStmt = db.prepare(`
    INSERT INTO telegram_actor_bindings (
      source,
      workspace_id,
      account_id,
      sender_id,
      actor_id,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, workspace_id, account_id, sender_id) DO UPDATE SET
      actor_id = excluded.actor_id,
      updated_at = excluded.updated_at
  `);
  const deleteExpiredDedupStmt = db.prepare(`DELETE FROM telegram_inbound_dedup WHERE expires_at <= ?`);
  const claimDedupStmt = db.prepare(`
    INSERT OR IGNORE INTO telegram_inbound_dedup (
      dedup_key,
      expires_at,
      seen_at
    ) VALUES (?, ?, ?)
  `);
  const readOffsetStmt = db.prepare(`
    SELECT next_update_id as nextUpdateId
    FROM telegram_polling_offsets
    WHERE account_id = ?
  `);
  const writeOffsetStmt = db.prepare(`
    INSERT INTO telegram_polling_offsets (
      account_id,
      next_update_id,
      updated_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      next_update_id = excluded.next_update_id,
      updated_at = excluded.updated_at
  `);

  return {
    async loadSessionBindingByConversation(input) {
      const row = loadSessionByConversationStmt.get(
        input.source,
        input.workspaceId,
        input.accountId,
        input.conversationRef.conversationId
      ) as SessionBindingRow | undefined;
      return row ? parseSessionBinding(row) : undefined;
    },

    async loadSessionBindingBySessionId(sessionId) {
      const row = loadSessionBySessionIdStmt.get(sessionId) as SessionBindingRow | undefined;
      return row ? parseSessionBinding(row) : undefined;
    },

    async saveSessionBinding(input) {
      saveSessionBindingStmt.run(
        input.source,
        input.workspaceId,
        input.accountId,
        input.conversationRef.conversationId,
        input.sessionId,
        JSON.stringify(input.conversationRef),
        new Date().toISOString()
      );
    },

    async loadActorBinding(input) {
      const row = loadActorBindingStmt.get(
        input.source,
        input.workspaceId,
        input.accountId,
        input.senderId
      ) as { actorId: string } | undefined;
      return row?.actorId;
    },

    async saveActorBinding(input) {
      saveActorBindingStmt.run(
        input.source,
        input.workspaceId,
        input.accountId,
        input.senderId,
        input.actorId,
        new Date().toISOString()
      );
    },

    async claimInboundDedup(input) {
      deleteExpiredDedupStmt.run(Date.now());
      const result = claimDedupStmt.run(input.dedupKey, input.expiresAtMs, new Date().toISOString());
      return result.changes > 0;
    },

    async readPollingOffset(input) {
      const row = readOffsetStmt.get(input.accountId) as { nextUpdateId: number } | undefined;
      return row?.nextUpdateId ?? null;
    },

    async writePollingOffset(input) {
      writeOffsetStmt.run(input.accountId, input.nextUpdateId, new Date().toISOString());
    },

    close() {
      db.close();
    }
  };
}
