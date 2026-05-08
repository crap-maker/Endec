import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  InflightTurnSchema,
  SessionStateSchema,
  type ArtifactRef,
  type InflightTurn,
  type Mode,
  type SessionEventKind,
  type SessionState,
  type TurnRequest,
  type TurnResult
} from "@endec/domain";
import { ensureSessionsSchema } from "./schema.ts";
import { openSessionsDatabase } from "./sqlite.ts";

type LoadOrCreateInput = Pick<TurnRequest, "sessionId" | "workspaceId" | "source"> & Partial<TurnRequest>;

type SessionRow = {
  sessionId: string;
  workspaceId: string;
  createdFrom: TurnRequest["source"];
  lastSource: TurnRequest["source"];
  mode: SessionState["mode"];
  status: SessionState["status"];
  currentGoal: string;
  workingSetRef: string;
  workingSetVersion: number;
  activeTaskIds: string;
  recentTurnRefs: string;
  lastEventSeq: number;
  lastTurnAt: string;
  createdAt: string;
  updatedAt: string;
  focusTaskId: string | null;
  focusRunId: string | null;
  focusUpdatedAt: string | null;
};

type InflightRow = {
  turnId: string;
  sessionId: string;
  workspaceId: string;
  state: InflightTurn["state"];
  waitingReason: InflightTurn["waitingReason"];
  resumePolicy: InflightTurn["resumePolicy"];
  loopCount: number;
  toolCallCount: number;
  pendingApprovalRef: string | null;
  checkpointRef: string;
  frameRef: string | null;
  contractVersion: string | null;
  pendingExecutionJson: string | null;
  createdAt: string;
  updatedAt: string;
};

type CommitTurnEventInput = {
  eventId: string;
  eventKind: SessionEventKind;
  createdAt: string;
  summary: string;
  text?: string;
  artifactRefs?: ArtifactRef[];
  sourceRefs?: string[];
};

type CommitTurnInput = {
  turnId: string;
  sessionId: string;
  workspaceId: string;
  source: TurnRequest["source"];
  mode: Mode;
  status: TurnResult["status"];
  sessionStatus?: SessionState["status"];
  currentGoal?: string;
  createdAt: string;
  usage?: TurnResult["usage"];
  events: CommitTurnEventInput[];
};

type CommittedTurnRow = {
  turnId: string;
  source: TurnRequest["source"];
  mode: Mode;
  status: TurnResult["status"];
  sessionStatus: SessionState["status"];
  currentGoal: string;
  eventCount: number;
  usageJson: string | null;
};

type SessionEventRow = {
  eventId: string;
  eventKind: SessionEventKind;
  eventText: string;
  summary: string;
  artifactRefs: string;
  sourceRefs: string;
  createdAt: string;
};

function parseSession(row: SessionRow): SessionState {
  return SessionStateSchema.parse({
    ...row,
    activeTaskIds: JSON.parse(row.activeTaskIds),
    recentTurnRefs: JSON.parse(row.recentTurnRefs),
    focusTaskId: row.focusTaskId ?? undefined,
    focusRunId: row.focusRunId ?? undefined,
    focusUpdatedAt: row.focusUpdatedAt ?? undefined
  });
}

function parseInflight(row: InflightRow): InflightTurn {
  return InflightTurnSchema.parse({
    ...row,
    pendingApprovalRef: row.pendingApprovalRef ?? undefined,
    frameRef: row.frameRef ?? undefined,
    contractVersion: row.contractVersion ?? undefined,
    pendingExecution: row.pendingExecutionJson ? JSON.parse(row.pendingExecutionJson) : undefined
  });
}

function serializeArtifactRefs(value: ArtifactRef[] | undefined) {
  return JSON.stringify(value ?? []);
}

function serializeSourceRefs(value: string[] | undefined) {
  return JSON.stringify(value ?? []);
}

function eventMatches(row: SessionEventRow, event: CommitTurnEventInput) {
  return row.eventKind === event.eventKind
    && row.eventText === (event.text ?? event.summary)
    && row.summary === event.summary
    && row.artifactRefs === serializeArtifactRefs(event.artifactRefs)
    && row.sourceRefs === serializeSourceRefs(event.sourceRefs)
    && row.createdAt === event.createdAt;
}

export function createSessionStore({ filename }: { filename: string }) {
  const db = openSessionsDatabase(filename);
  ensureSessionsSchema(db);

  const loadSessionStmt = db.prepare(`
    SELECT
      session_id as sessionId,
      workspace_id as workspaceId,
      created_from as createdFrom,
      last_source as lastSource,
      mode,
      status,
      current_goal as currentGoal,
      working_set_ref as workingSetRef,
      working_set_version as workingSetVersion,
      active_task_ids as activeTaskIds,
      recent_turn_refs as recentTurnRefs,
      last_event_seq as lastEventSeq,
      last_turn_at as lastTurnAt,
      created_at as createdAt,
      updated_at as updatedAt,
      focus_task_id as focusTaskId,
      focus_run_id as focusRunId,
      focus_updated_at as focusUpdatedAt
    FROM sessions
    WHERE session_id = ?
  `);
  const loadInflightStmt = db.prepare(`
    SELECT
      turn_id as turnId,
      session_id as sessionId,
      workspace_id as workspaceId,
      state,
      waiting_reason as waitingReason,
      resume_policy as resumePolicy,
      loop_count as loopCount,
      tool_call_count as toolCallCount,
      pending_approval_ref as pendingApprovalRef,
      checkpoint_ref as checkpointRef,
      frame_ref as frameRef,
      contract_version as contractVersion,
      pending_execution_json as pendingExecutionJson,
      created_at as createdAt,
      updated_at as updatedAt
    FROM inflight_turns
    WHERE session_id = ?
  `);
  const loadCommittedTurnStmt = db.prepare(`
    SELECT
      turn_id as turnId,
      source,
      mode,
      status,
      session_status as sessionStatus,
      current_goal as currentGoal,
      event_count as eventCount,
      usage_json as usageJson
    FROM committed_turns
    WHERE turn_id = ?
  `);
  const loadCommittedEventsStmt = db.prepare(`
    SELECT
      event_id as eventId,
      event_kind as eventKind,
      event_text as eventText,
      summary,
      artifact_refs as artifactRefs,
      source_refs as sourceRefs,
      created_at as createdAt
    FROM session_events
    WHERE turn_id = ?
    ORDER BY seq ASC
  `);

  function ensureSession(input: { sessionId: string; workspaceId: string; source: TurnRequest["source"] }) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO sessions (
        session_id,
        workspace_id,
        created_from,
        last_source,
        mode,
        status,
        current_goal,
        working_set_ref,
        working_set_version,
        active_task_ids,
        recent_turn_refs,
        last_event_seq,
        last_turn_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'chat', 'active', '', 'working_set:initial', 0, '[]', '[]', 0, ?, ?, ?)
    `).run(input.sessionId, input.workspaceId, input.source, input.source, now, now, now);

    const row = loadSessionStmt.get(input.sessionId) as SessionRow | undefined;
    if (!row) {
      throw new Error(`failed to load session ${input.sessionId}`);
    }
    return parseSession(row);
  }

  async function loadOrCreate(request: LoadOrCreateInput) {
    return ensureSession({
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      source: request.source
    });
  }

  async function loadById(sessionId: string) {
    const row = loadSessionStmt.get(sessionId) as SessionRow | undefined;
    return row ? parseSession(row) : undefined;
  }

  async function openOrCreateSession(input: {
    sessionId?: string;
    workspaceId: string;
    source: TurnRequest["source"];
  }) {
    const sessionId = input.sessionId ?? `session_${randomUUID()}`;
    ensureSession({
      sessionId,
      workspaceId: input.workspaceId,
      source: input.source
    });
    return sessionId;
  }

  async function markInflight(input: {
    turnId: string;
    sessionId: string;
    workspaceId: string;
    state: InflightTurn["state"];
    waitingReason: InflightTurn["waitingReason"];
    resumePolicy: InflightTurn["resumePolicy"];
    loopCount?: number;
    toolCallCount?: number;
    pendingApprovalRef?: string;
    checkpointRef?: string;
    frameRef?: string;
    contractVersion?: string;
    pendingExecution?: InflightTurn["pendingExecution"];
  }) {
    const existing = loadInflightStmt.get(input.sessionId) as InflightRow | undefined;
    if (existing) {
      throw new Error(`open recoverable inflight already exists for session ${input.sessionId}`);
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO inflight_turns (
        turn_id,
        session_id,
        workspace_id,
        state,
        waiting_reason,
        resume_policy,
        loop_count,
        tool_call_count,
        pending_approval_ref,
        checkpoint_ref,
        frame_ref,
        contract_version,
        pending_execution_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.turnId,
      input.sessionId,
      input.workspaceId,
      input.state,
      input.waitingReason,
      input.resumePolicy,
      input.loopCount ?? 0,
      input.toolCallCount ?? 0,
      input.pendingApprovalRef ?? null,
      input.checkpointRef ?? `checkpoint:${input.turnId}`,
      input.frameRef ?? null,
      input.contractVersion ?? null,
      input.pendingExecution ? JSON.stringify(input.pendingExecution) : null,
      now,
      now
    );

    const row = loadInflightStmt.get(input.sessionId) as InflightRow | undefined;
    if (!row) {
      throw new Error(`failed to load inflight turn for session ${input.sessionId}`);
    }
    parseInflight(row);
  }

  async function loadRecoveryContext(sessionId: string) {
    const sessionRow = loadSessionStmt.get(sessionId) as SessionRow | undefined;
    const inflightRow = loadInflightStmt.get(sessionId) as InflightRow | undefined;

    if (!sessionRow || !inflightRow) {
      return null;
    }

    const session = parseSession(sessionRow);
    const inflight = parseInflight(inflightRow);

    return {
      session,
      inflight,
      checkpointRef: inflight.checkpointRef,
      recentTurnRefs: session.recentTurnRefs
    };
  }

  async function commitTurn(input: CommitTurnInput) {
    const existingTurn = loadCommittedTurnStmt.get(input.turnId) as CommittedTurnRow | undefined;
    const session = ensureSession({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      source: input.source
    });
    const nextRecentTurnRefs = [
      ...session.recentTurnRefs.filter((turnId) => turnId !== input.turnId),
      input.turnId
    ].slice(-10);
    const existingEvents = existingTurn
      ? (loadCommittedEventsStmt.all(input.turnId) as SessionEventRow[])
      : [];
    const existingEventsById = new Map(existingEvents.map((event) => [event.eventId, event]));
    const normalizedEvents = input.events.flatMap((event, index) => {
      const existingEvent = existingEventsById.get(event.eventId);
      if (!existingEvent) {
        return [event];
      }

      if (eventMatches(existingEvent, event)) {
        return [];
      }

      return [{
        ...event,
        eventId: `${event.eventId}:continuation:${session.lastEventSeq + index + 1}`
      }];
    });
    const nextSessionStatus = input.sessionStatus ?? "active";
    const nextCurrentGoal = input.currentGoal ?? session.currentGoal;
    const nextUsageJson = input.usage ? JSON.stringify(input.usage) : null;

    if (
      existingTurn
      && normalizedEvents.length === 0
      && existingTurn.source === input.source
      && existingTurn.mode === input.mode
      && existingTurn.status === input.status
      && existingTurn.sessionStatus === nextSessionStatus
      && existingTurn.currentGoal === nextCurrentGoal
      && existingTurn.usageJson === nextUsageJson
    ) {
      return;
    }

    const commit = db.transaction(() => {
      if (existingTurn) {
        db.prepare(`
          UPDATE committed_turns
          SET
            source = ?,
            mode = ?,
            status = ?,
            session_status = ?,
            current_goal = ?,
            event_count = ?,
            usage_json = ?
          WHERE turn_id = ?
        `).run(
          input.source,
          input.mode,
          input.status,
          nextSessionStatus,
          nextCurrentGoal,
          existingTurn.eventCount + normalizedEvents.length,
          nextUsageJson,
          input.turnId
        );
      } else {
        db.prepare(`
          INSERT INTO committed_turns (
            turn_id,
            session_id,
            workspace_id,
            source,
            mode,
            status,
            session_status,
            current_goal,
            event_count,
            usage_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.turnId,
          input.sessionId,
          input.workspaceId,
          input.source,
          input.mode,
          input.status,
          nextSessionStatus,
          nextCurrentGoal,
          normalizedEvents.length,
          nextUsageJson,
          input.createdAt
        );
      }

      for (const [index, event] of normalizedEvents.entries()) {
        db.prepare(`
          INSERT INTO session_events (
            event_id,
            session_id,
            workspace_id,
            turn_id,
            seq,
            event_kind,
            event_text,
            summary,
            artifact_refs,
            source_refs,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          event.eventId,
          input.sessionId,
          input.workspaceId,
          input.turnId,
          session.lastEventSeq + index + 1,
          event.eventKind,
          event.text ?? event.summary,
          event.summary,
          serializeArtifactRefs(event.artifactRefs),
          serializeSourceRefs(event.sourceRefs),
          event.createdAt
        );
      }

      db.prepare(`
        UPDATE sessions
        SET
          last_source = ?,
          mode = ?,
          status = ?,
          current_goal = ?,
          recent_turn_refs = ?,
          last_event_seq = ?,
          last_turn_at = ?,
          updated_at = ?
        WHERE session_id = ?
      `).run(
        input.source,
        input.mode,
        nextSessionStatus,
        nextCurrentGoal,
        JSON.stringify(nextRecentTurnRefs),
        session.lastEventSeq + normalizedEvents.length,
        input.createdAt,
        input.createdAt,
        input.sessionId
      );
    });

    commit();
  }

  async function updateWorkingSetPointer(input: {
    sessionId: string;
    workingSetRef: string;
    workingSetVersion: number;
  }) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE sessions
      SET
        working_set_ref = ?,
        working_set_version = ?,
        updated_at = ?
      WHERE session_id = ?
    `).run(input.workingSetRef, input.workingSetVersion, now, input.sessionId);
  }

  async function setFocusRun(input: { sessionId: string; taskId: string; runId: string; now?: string }) {
    const now = input.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE sessions
      SET focus_task_id = ?, focus_run_id = ?, focus_updated_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(input.taskId, input.runId, now, now, input.sessionId);
    return result.changes === 1
      ? { taskId: input.taskId, runId: input.runId, updatedAt: now }
      : undefined;
  }

  async function clearFocusRun(input: { sessionId: string; now?: string }) {
    const now = input.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE sessions
      SET focus_task_id = NULL, focus_run_id = NULL, focus_updated_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(now, now, input.sessionId);
    return result.changes === 1 ? undefined : undefined;
  }

  async function loadFocusRun(sessionId: string) {
    const row = db.prepare(`
      SELECT focus_task_id as taskId, focus_run_id as runId, focus_updated_at as updatedAt
      FROM sessions
      WHERE session_id = ?
    `).get(sessionId) as { taskId: string | null; runId: string | null; updatedAt: string | null } | undefined;
    if (!row || !row.taskId || !row.runId) {
      return undefined;
    }
    return {
      taskId: row.taskId,
      runId: row.runId,
      updatedAt: row.updatedAt ?? undefined
    };
  }

  async function finalize(input: { turnId: string; sessionId: string; status: TurnResult["status"]; preserveInflight?: boolean }) {
    if (input.status !== "blocked" && !input.preserveInflight) {
      db.prepare(`DELETE FROM inflight_turns WHERE turn_id = ?`).run(input.turnId);
    }
    return `session_state_ref:${input.turnId}`;
  }

  return {
    loadOrCreate,
    loadById,
    openOrCreateSession,
    markInflight,
    loadRecoveryContext,
    commitTurn,
    updateWorkingSetPointer,
    setFocusRun,
    clearFocusRun,
    loadFocusRun,
    finalize
  };
}
