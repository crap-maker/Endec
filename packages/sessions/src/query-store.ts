import Database from "better-sqlite3";
import {
  InflightTurnSchema,
  OperatorRecoverySnapshotSchema,
  RUNTIME_SELF_AWARENESS_CONTRACT_VERSION,
  RuntimeSelfAwarenessSurfaceSchema,
  resolvePendingPermissionDecision,
  SessionEventLookupQuerySchema,
  SessionEventSearchQuerySchema,
  SessionHistoryQuerySchema,
  SessionListQuerySchema,
  SessionStateSchema,
  type InflightTurn,
  type OperatorRecoverySnapshot,
  type RuntimeConstraintSurface,
  type RuntimeSelfAwarenessSurface,
  type SessionEventLookupQuery,
  type SessionEventLookupResult,
  type SessionEventSearchQuery,
  type SessionEventSearchResult,
  type SessionHistoryQuery,
  type SessionListQuery,
  type SessionListResult,
  type SessionState,
  type TurnResult
} from "@endec/domain";
import { browseSessionHistory, listSessions, lookupSessionEvent } from "./history-browse.ts";
import { searchSessionEvents } from "./history-search.ts";
import { ensureSessionsSchema } from "./schema.ts";
import { openSessionsDatabase } from "./sqlite.ts";

type SessionRow = {
  sessionId: string;
  workspaceId: string;
  createdFrom: SessionState["createdFrom"];
  lastSource: SessionState["lastSource"];
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
};

type StatusSessionRow = {
  sessionId: string;
  workspaceId: string;
  lastTurnAt: string;
  focusTaskId: string | null;
  focusRunId: string | null;
  focusUpdatedAt: string | null;
};

type CommittedTurnRow = {
  turnId: string;
  status: TurnResult["status"];
  createdAt: string;
  usageJson: string | null;
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

function parseSession(row: SessionRow): SessionState {
  return SessionStateSchema.parse({
    ...row,
    activeTaskIds: JSON.parse(row.activeTaskIds),
    recentTurnRefs: JSON.parse(row.recentTurnRefs)
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

function deriveRecoveryState(inflight: InflightTurn): OperatorRecoverySnapshot["state"] {
  if (inflight.pendingExecution?.status === "ready") {
    return "ready";
  }

  return inflight.state;
}

function deriveRecoveryBlockedBy(inflight: InflightTurn) {
  switch (inflight.waitingReason) {
    case "permission":
      return "permission";
    case "user_decision":
      return "user_decision";
    case "retry_backoff":
      return "retry_backoff";
    case "recovery":
      return "recovery";
  }
}

function buildPendingDecisionConstraint(inflight: InflightTurn): RuntimeConstraintSurface | undefined {
  const pendingExecution = inflight.pendingExecution;
  const pendingDecision = resolvePendingPermissionDecision({
    permissionDecisions: pendingExecution?.frame.pendingPermissionDecisions ?? [],
    pendingApprovalRef: inflight.pendingApprovalRef
  });

  if (!pendingDecision) {
    return undefined;
  }

  return {
    code: pendingDecision.reasonCode,
    summary: pendingDecision.reasonText,
    blocking: true,
    metadata: {
      decisionId: pendingDecision.decisionId,
      scope: pendingDecision.scope,
      requestedBy: pendingDecision.requestedBy
    }
  };
}

function mergeRuntimeConstraints(
  baseConstraints: RuntimeConstraintSurface[],
  pendingConstraint: RuntimeConstraintSurface | undefined
): RuntimeConstraintSurface[] {
  if (!pendingConstraint) {
    return baseConstraints;
  }

  const pendingSignature = JSON.stringify([pendingConstraint.code, pendingConstraint.summary, pendingConstraint.metadata ?? null]);
  const hasPendingConstraint = baseConstraints.some((constraint) =>
    JSON.stringify([constraint.code, constraint.summary, constraint.metadata ?? null]) === pendingSignature
  );

  return hasPendingConstraint ? baseConstraints : [...baseConstraints, pendingConstraint];
}

function buildRuntimeConstraints(inflight: InflightTurn): RuntimeConstraintSurface[] {
  const pendingConstraint = buildPendingDecisionConstraint(inflight);

  if (pendingConstraint) {
    return [pendingConstraint];
  }

  if (inflight.pendingApprovalRef) {
    return [{
      code: inflight.waitingReason,
      summary: `Pending operator decision ${inflight.pendingApprovalRef} must be resolved before continuation.`,
      blocking: true,
      metadata: {
        pendingApprovalRef: inflight.pendingApprovalRef
      }
    }];
  }

  return [];
}

function projectRuntimeSelfAwareness(session: SessionState, inflight: InflightTurn): RuntimeSelfAwarenessSurface {
  const pendingExecution = inflight.pendingExecution;
  const pendingConstraint = buildPendingDecisionConstraint(inflight);

  if (pendingExecution?.runtimeSelfAwareness) {
    const replyPath = pendingExecution.status === "ready"
      && pendingExecution.frame.continuation.continuationKind === "resume"
      ? "continuation"
      : "blocked";

    return RuntimeSelfAwarenessSurfaceSchema.parse({
      ...pendingExecution.runtimeSelfAwareness,
      replyPath,
      constraints: mergeRuntimeConstraints(pendingExecution.runtimeSelfAwareness.constraints, pendingConstraint)
    });
  }

  return RuntimeSelfAwarenessSurfaceSchema.parse({
    schemaVersion: 1,
    contractVersion: RUNTIME_SELF_AWARENESS_CONTRACT_VERSION,
    source: session.lastSource,
    channel: session.lastSource,
    mode: session.mode,
    exposedToolNames: [],
    replyPath: pendingExecution?.status === "ready" && pendingExecution.frame.continuation.continuationKind === "resume"
      ? "continuation"
      : pendingExecution ? "blocked" : "normal",
    constraints: buildRuntimeConstraints(inflight)
  });
}

function resolveRecoverySnapshotTarget(input: {
  sessionId: string;
  turnId?: string;
  frameRef?: string;
  inflight: InflightTurn;
}) {
  if (input.turnId && input.inflight.turnId !== input.turnId) {
    throw new Error(
      `Session ${input.sessionId} is waiting on turn ${input.inflight.turnId}, not ${input.turnId}. Retry with --turn ${input.inflight.turnId}, or omit --turn to target the current recoverable turn.`
    );
  }

  const currentFrameRef = input.inflight.frameRef;
  if (input.frameRef) {
    if (!currentFrameRef) {
      throw new Error(`Session ${input.sessionId} does not expose a recoverable execution frame.`);
    }

    if (currentFrameRef !== input.frameRef) {
      throw new Error(`Session ${input.sessionId} is waiting on frame ${currentFrameRef}, not ${input.frameRef}.`);
    }
  }
}

function projectRecoverySnapshot(input: {
  session: SessionState;
  inflight: InflightTurn;
}): OperatorRecoverySnapshot {
  const runtimeSelfAwareness = projectRuntimeSelfAwareness(input.session, input.inflight);
  const pendingExecution = input.inflight.pendingExecution;
  const pendingDecision = resolvePendingPermissionDecision({
    permissionDecisions: pendingExecution?.frame.pendingPermissionDecisions ?? [],
    pendingApprovalRef: input.inflight.pendingApprovalRef
  });

  return OperatorRecoverySnapshotSchema.parse({
    schemaVersion: 1,
    contractVersion: "ws5.operator-recovery-snapshot.v1",
    runtimeAwarenessContractVersion: runtimeSelfAwareness.contractVersion,
    sessionId: input.session.sessionId,
    workspaceId: input.session.workspaceId,
    recoverable: true,
    hasPendingExecution: Boolean(pendingExecution),
    turnId: input.inflight.turnId,
    frameRef: pendingExecution?.frameRef ?? input.inflight.frameRef,
    pendingExecutionId: pendingExecution?.pendingExecutionId,
    blockedBy: deriveRecoveryBlockedBy(input.inflight),
    waitingReason: input.inflight.waitingReason,
    state: deriveRecoveryState(input.inflight),
    allowedActions: pendingExecution?.frame.continuation.allowedActions ?? [],
    pendingApprovalRef: input.inflight.pendingApprovalRef,
    pendingDecision,
    checkpointRef: pendingExecution?.checkpointRef ?? input.inflight.checkpointRef,
    contextSummary: {
      sessionId: input.session.sessionId,
      workspaceId: input.session.workspaceId,
      source: input.session.lastSource,
      mode: input.session.mode,
      currentGoal: input.session.currentGoal,
      activeTaskIds: input.session.activeTaskIds,
      recentTurnRefs: input.session.recentTurnRefs
    },
    authoritativeTruth: pendingExecution?.authoritativeTruth,
    observability: pendingExecution?.observability,
    runtimeSelfAwareness
  });
}

export function createSessionQueryStore({ filename }: { filename: string }) {
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
      updated_at as updatedAt
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
  const loadStatusSessionStmt = db.prepare(`
    SELECT
      session_id as sessionId,
      workspace_id as workspaceId,
      last_turn_at as lastTurnAt,
      focus_task_id as focusTaskId,
      focus_run_id as focusRunId,
      focus_updated_at as focusUpdatedAt
    FROM sessions
    WHERE session_id = ?
  `);
  const loadLatestStatusSessionStmt = db.prepare(`
    SELECT
      session_id as sessionId,
      workspace_id as workspaceId,
      last_turn_at as lastTurnAt,
      focus_task_id as focusTaskId,
      focus_run_id as focusRunId,
      focus_updated_at as focusUpdatedAt
    FROM sessions
    ORDER BY last_turn_at DESC, updated_at DESC, session_id DESC
    LIMIT 1
  `);
  const loadLatestCommittedTurnStmt = db.prepare(`
    SELECT
      turn_id as turnId,
      status,
      created_at as createdAt,
      usage_json as usageJson
    FROM committed_turns
    WHERE session_id = ?
    ORDER BY created_at DESC, turn_id DESC
    LIMIT 1
  `);

  async function listSessionSummaries(input: SessionListQuery): Promise<SessionListResult> {
    return listSessions(db, SessionListQuerySchema.parse(input));
  }

  async function browseHistory(input: SessionHistoryQuery) {
    return browseSessionHistory(db, SessionHistoryQuerySchema.parse(input));
  }

  async function searchEvents(input: SessionEventSearchQuery): Promise<SessionEventSearchResult> {
    return searchSessionEvents(db, SessionEventSearchQuerySchema.parse(input));
  }

  async function lookupEvent(input: SessionEventLookupQuery): Promise<SessionEventLookupResult> {
    return lookupSessionEvent(db, SessionEventLookupQuerySchema.parse(input));
  }

  async function getRecoverySnapshot(input: { sessionId: string; turnId?: string; frameRef?: string }) {
    const sessionRow = loadSessionStmt.get(input.sessionId) as SessionRow | undefined;
    const inflightRow = loadInflightStmt.get(input.sessionId) as InflightRow | undefined;

    if (!sessionRow || !inflightRow) {
      return null;
    }

    const session = parseSession(sessionRow);
    const inflight = parseInflight(inflightRow);
    resolveRecoverySnapshotTarget({
      sessionId: input.sessionId,
      turnId: input.turnId,
      frameRef: input.frameRef,
      inflight
    });

    return projectRecoverySnapshot({ session, inflight });
  }

  async function loadStatusSessionTruth(input?: { sessionId?: string }) {
    const sessionRow = (input?.sessionId
      ? loadStatusSessionStmt.get(input.sessionId)
      : loadLatestStatusSessionStmt.get()) as StatusSessionRow | undefined;
    if (!sessionRow) {
      return null;
    }

    const lastTurnRow = loadLatestCommittedTurnStmt.get(sessionRow.sessionId) as CommittedTurnRow | undefined;
    return {
      sessionId: sessionRow.sessionId,
      workspaceId: sessionRow.workspaceId,
      lastTurnAt: sessionRow.lastTurnAt,
      focusTaskId: sessionRow.focusTaskId ?? undefined,
      focusRunId: sessionRow.focusRunId ?? undefined,
      focusUpdatedAt: sessionRow.focusUpdatedAt ?? undefined,
      lastTurn: lastTurnRow
        ? {
            turnId: lastTurnRow.turnId,
            status: lastTurnRow.status,
            createdAt: lastTurnRow.createdAt,
            usage: lastTurnRow.usageJson ? JSON.parse(lastTurnRow.usageJson) : undefined
          }
        : undefined
    };
  }

  async function loadRecentHistory(input: { sessionId: string; limit: number; beforeTurnId?: string }) {
    const beforeSeq = input.beforeTurnId
      ? (db.prepare(`SELECT MIN(seq) AS seq FROM session_events WHERE session_id = ? AND turn_id = ?`).get(
          input.sessionId,
          input.beforeTurnId
        ) as { seq: number | null } | undefined)?.seq
      : null;

    return db.prepare(`
      SELECT
        event_id AS eventId,
        turn_id AS turnId,
        event_kind AS eventKind,
        summary,
        event_text AS text,
        created_at AS createdAt,
        source_refs AS sourceRefs,
        seq
      FROM session_events
      WHERE session_id = ?
        AND (? IS NULL OR seq < ?)
      ORDER BY seq DESC
      LIMIT ?
    `).all(input.sessionId, beforeSeq, beforeSeq, input.limit).map((row) => ({
      eventId: (row as { eventId: string }).eventId,
      turnId: (row as { turnId: string }).turnId,
      eventKind: (row as { eventKind: string }).eventKind,
      summary: (row as { summary: string }).summary,
      text: (row as { text: string }).text,
      createdAt: (row as { createdAt: string }).createdAt,
      sourceRefs: JSON.parse((row as { sourceRefs: string }).sourceRefs) as string[]
    }));
  }

  return {
    listSessions: listSessionSummaries,
    browseSessionHistory: browseHistory,
    searchSessionEvents: searchEvents,
    lookupSessionEvent: lookupEvent,
    getRecoverySnapshot,
    loadStatusSessionTruth,
    loadRecentHistory
  };
}
