import Database from "better-sqlite3";
import type {
  ConversationRef,
  RunAttentionMode,
  RunBudgetLedger,
  RunContinuationKind,
  TaskRunClaimResult,
  TaskRunKind,
  TaskRunSnapshot,
  TaskRunStatus
} from "@endec/domain";
import { ConversationRefSchema, TaskRunSnapshotSchema, normalizeLegacyTaskRunStatus } from "@endec/domain";
import { ensureTasksSchema } from "./schema.ts";
import { openSqliteDatabase } from "./sqlite.ts";

export type RecoveryTruthState = "consumed" | "closed";

export type TaskRunStoreRun = TaskRunSnapshot & {
  idempotencyKey: string;
  turnRequest: unknown;
  workerId?: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  wallClockDeadlineAt?: string;
  priority: number;
  recoveryTruthState?: RecoveryTruthState;
  recoveryTruthUpdatedAt?: string;
};

export type BackgroundTaskSnapshot = {
  taskId: string;
  workspaceId: string;
  sessionId: string;
  actorId?: string;
  conversationRef?: ConversationRef;
  title: string;
  description: string;
  agentStatus: "open" | "queued" | "running" | "blocked" | "done" | "failed" | "canceled";
  blockingReason?: string;
  sourceTurnId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateBackgroundTaskInput = {
  taskId: string;
  workspaceId: string;
  sessionId: string;
  actorId?: string;
  conversationRef?: ConversationRef;
  title: string;
  description: string;
  sourceTurnId: string;
  now?: string;
};

export type CreateRunInput = {
  runId: string;
  taskId: string;
  workspaceId: string;
  sessionId: string;
  actorId?: string;
  conversationRef?: ConversationRef;
  attentionMode: RunAttentionMode;
  runKind?: TaskRunKind;
  sourceTurnId?: string;
  maxAttempts?: number;
  retryOfRunId?: string;
  parentRunId?: string;
  runDeadlineAt?: string;
  wallClockDeadlineAt?: string;
  idempotencyKey?: string;
  turnRequest?: unknown;
  attemptNo?: number;
  priority?: number;
  seedInitialSlice?: boolean;
  now?: string;
};

export type EnqueueRunInput = {
  runId: string;
  taskId: string;
  workspaceId: string;
  sessionId: string;
  actorId?: string;
  conversationRef?: ConversationRef;
  idempotencyKey: string;
  turnRequest: unknown;
  sourceTurnId?: string;
  maxAttempts?: number;
  runKind?: TaskRunKind;
  parentRunId?: string;
  retryOfRunId?: string;
  wallClockDeadlineAt?: string;
  attemptNo?: number;
  priority?: number;
  seedInitialSlice?: boolean;
  now?: string;
};

export type ClaimNextRunInput = { workerId: string; leaseDurationMs: number; now?: string };
export type RenewRunLeaseInput = { runId: string; leaseOwner: string; leaseDurationMs: number; now?: string };
export type CompleteRunInput = { runId: string; resultSummary?: string; now?: string };
export type FailRunInput = { runId: string; resultSummary?: string; error?: unknown; retryRunId?: string; retryIdempotencyKey?: string; now?: string };
export type InterruptRunInput = { runId: string; resultSummary?: string; error?: unknown; now?: string };
export type SuspendRunInput = { runId: string; pendingApprovalRef?: string; pendingControlRef?: string; blockedBy?: string; resultSummary?: string; now?: string };
export type RequestRunCancellationInput = { runId: string; actorId?: string; reason?: string; now?: string };
export type CancelQueuedOrSuspendedRunInput = { runId: string; reason?: string; now?: string };
export type MarkRunCanceledInput = { runId: string; resultSummary?: string; reason?: string; now?: string };
export type MarkLeaseExpiredInput = { runId: string; retryRunId?: string; retryIdempotencyKey?: string; now?: string };
export type UpdateRunStatusAndLedgerInput = { runId: string; status: TaskRunStatus; ledger: RunBudgetLedger; now?: string };
export type UpdateRunAttentionModeInput = { runId: string; attentionMode: RunAttentionMode; now?: string };
export type AttachContinuationInput = { runId: string; kind: RunContinuationKind; payload?: unknown; now?: string };
export type ClearContinuationInput = { runId: string; now?: string };
export type LatchRunCancelInput = {
  runId: string;
  cancelRequestedAt?: string;
  cancelRequestedBy?: string;
  cancelReason?: string;
  cancelObservedSliceId?: string;
};

export type TaskRunStore = {
  createBackgroundTask(input: CreateBackgroundTaskInput): Promise<BackgroundTaskSnapshot | undefined>;
  loadBackgroundTask(taskId: string): Promise<BackgroundTaskSnapshot | undefined>;
  listBackgroundTasks(input?: {
    workspaceId?: string;
    sessionId?: string;
    agentStatus?: BackgroundTaskSnapshot["agentStatus"];
    limit?: number;
  }): Promise<BackgroundTaskSnapshot[]>;
  createRun(input: CreateRunInput): Promise<TaskRunStoreRun>;
  enqueueRun(input: EnqueueRunInput): Promise<TaskRunStoreRun>;
  loadRunById(runId: string): Promise<TaskRunStoreRun | undefined>;
  listRunsByTask(taskId: string): Promise<TaskRunStoreRun[]>;
  updateRunStatusAndLedger(input: UpdateRunStatusAndLedgerInput): Promise<TaskRunStoreRun | undefined>;
  updateRunAttentionMode(input: UpdateRunAttentionModeInput): Promise<TaskRunStoreRun | undefined>;
  attachContinuation(input: AttachContinuationInput): Promise<TaskRunStoreRun | undefined>;
  clearContinuation(input: ClearContinuationInput): Promise<TaskRunStoreRun | undefined>;
  latchRunCancel(input: LatchRunCancelInput): Promise<TaskRunStoreRun | undefined>;
  claimNextRun(input: ClaimNextRunInput): Promise<TaskRunClaimResult>;
  renewRunLease(input: RenewRunLeaseInput): Promise<TaskRunStoreRun | undefined>;
  completeRun(input: CompleteRunInput): Promise<TaskRunStoreRun | undefined>;
  failRun(input: FailRunInput): Promise<{ failed: TaskRunStoreRun | undefined; retry: TaskRunStoreRun | undefined }>;
  interruptRun(input: InterruptRunInput): Promise<TaskRunStoreRun | undefined>;
  suspendRun(input: SuspendRunInput): Promise<TaskRunStoreRun | undefined>;
  requestRunCancellation(input: RequestRunCancellationInput): Promise<TaskRunStoreRun | undefined>;
  cancelQueuedOrSuspendedRun(input: CancelQueuedOrSuspendedRunInput): Promise<TaskRunStoreRun | undefined>;
  markRunCanceled(input: MarkRunCanceledInput): Promise<TaskRunStoreRun | undefined>;
  markLeaseExpired(input: MarkLeaseExpiredInput): Promise<{ expired: TaskRunStoreRun | undefined; retry: TaskRunStoreRun | undefined }>;
};

type TaskRunRow = {
  runId: string;
  taskId: string;
  workspaceId: string;
  sessionId: string;
  actorId: string | null;
  conversationRefJson: string | null;
  status: string;
  attentionMode: RunAttentionMode | null;
  runKind: TaskRunKind;
  attemptNo: number;
  idempotencyKey: string;
  turnRequestJson: string;
  sourceTurnId: string | null;
  workerId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  maxAttempts: number;
  wallClockDeadlineAt: string | null;
  runDeadlineAt: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
  cancelReason: string | null;
  cancelObservedSliceId: string | null;
  continuationKind: RunContinuationKind | null;
  continuationPayloadJson: string | null;
  continuationUpdatedAt: string | null;
  recoveryTruthState: RecoveryTruthState | null;
  recoveryTruthUpdatedAt: string | null;
  pendingApprovalRef: string | null;
  pendingControlRef: string | null;
  parentRunId: string | null;
  retryOfRunId: string | null;
  resultSummary: string | null;
  errorJson: string | null;
  priority: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeTotalTokens: number;
  cumulativeEstimatedCost: number;
  autonomyWindowSliceCount: number;
  autonomyWindowToolCallCount: number;
  foregroundBurstSliceCount: number;
  foregroundBurstStartedAt: string | null;
  lastHumanInputAt: string | null;
  runStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type TaskRow = {
  taskId: string;
  workspaceId: string;
  sessionId: string;
  actorId: string | null;
  conversationRefJson: string | null;
  title: string;
  description: string;
  agentStatus: BackgroundTaskSnapshot["agentStatus"] | null;
  status: string;
  lastTurnId: string;
  blockingReason: string | null;
  createdAt: string;
  updatedAt: string;
};

const runSelect = `
  SELECT
    run_id as runId,
    task_id as taskId,
    workspace_id as workspaceId,
    session_id as sessionId,
    actor_id as actorId,
    conversation_ref_json as conversationRefJson,
    status,
    attention_mode as attentionMode,
    run_kind as runKind,
    attempt_no as attemptNo,
    idempotency_key as idempotencyKey,
    turn_request_json as turnRequestJson,
    source_turn_id as sourceTurnId,
    worker_id as workerId,
    lease_owner as leaseOwner,
    lease_expires_at as leaseExpiresAt,
    claimed_at as claimedAt,
    started_at as startedAt,
    finished_at as finishedAt,
    max_attempts as maxAttempts,
    wall_clock_deadline_at as wallClockDeadlineAt,
    run_deadline_at as runDeadlineAt,
    cancel_requested_at as cancelRequestedAt,
    cancel_requested_by as cancelRequestedBy,
    cancel_reason as cancelReason,
    cancel_observed_slice_id as cancelObservedSliceId,
    continuation_kind as continuationKind,
    continuation_payload_json as continuationPayloadJson,
    continuation_updated_at as continuationUpdatedAt,
    recovery_truth_state as recoveryTruthState,
    recovery_truth_updated_at as recoveryTruthUpdatedAt,
    pending_approval_ref as pendingApprovalRef,
    pending_control_ref as pendingControlRef,
    parent_run_id as parentRunId,
    retry_of_run_id as retryOfRunId,
    result_summary as resultSummary,
    error_json as errorJson,
    priority,
    cumulative_input_tokens as cumulativeInputTokens,
    cumulative_output_tokens as cumulativeOutputTokens,
    cumulative_total_tokens as cumulativeTotalTokens,
    cumulative_estimated_cost as cumulativeEstimatedCost,
    autonomy_window_slice_count as autonomyWindowSliceCount,
    autonomy_window_tool_call_count as autonomyWindowToolCallCount,
    foreground_burst_slice_count as foregroundBurstSliceCount,
    foreground_burst_started_at as foregroundBurstStartedAt,
    last_human_input_at as lastHumanInputAt,
    run_started_at as runStartedAt,
    created_at as createdAt,
    updated_at as updatedAt
  FROM task_runs
`;

function addMs(iso: string, ms: number) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function maybeJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function maybeParseJson(value: string | null) {
  return value ? JSON.parse(value) : undefined;
}

function parseConversationRef(value: string | null) {
  return value ? ConversationRefSchema.parse(JSON.parse(value)) : undefined;
}

function parseRun(row: TaskRunRow): TaskRunStoreRun {
  const snapshot = TaskRunSnapshotSchema.parse({
    runId: row.runId,
    taskId: row.taskId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    actorId: row.actorId ?? undefined,
    conversationRef: parseConversationRef(row.conversationRefJson),
    status: normalizeLegacyTaskRunStatus(row.status as never),
    attentionMode: row.attentionMode ?? "foreground_attached",
    runKind: row.runKind,
    attemptNo: row.attemptNo,
    maxAttempts: row.maxAttempts,
    retryOfRunId: row.retryOfRunId ?? undefined,
    parentRunId: row.parentRunId ?? undefined,
    sourceTurnId: row.sourceTurnId ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    cancelRequestedAt: row.cancelRequestedAt ?? undefined,
    cancelRequestedBy: row.cancelRequestedBy ?? undefined,
    cancelReason: row.cancelReason ?? undefined,
    cancelObservedSliceId: row.cancelObservedSliceId ?? undefined,
    continuationKind: row.continuationKind ?? undefined,
    continuationPayload: maybeParseJson(row.continuationPayloadJson),
    continuationUpdatedAt: row.continuationUpdatedAt ?? undefined,
    pendingApprovalRef: row.pendingApprovalRef ?? undefined,
    pendingControlRef: row.pendingControlRef ?? undefined,
    resultSummary: row.resultSummary ?? undefined,
    error: maybeParseJson(row.errorJson),
    cumulativeInputTokens: row.cumulativeInputTokens,
    cumulativeOutputTokens: row.cumulativeOutputTokens,
    cumulativeTotalTokens: row.cumulativeTotalTokens,
    cumulativeEstimatedCost: row.cumulativeEstimatedCost,
    autonomyWindowSliceCount: row.autonomyWindowSliceCount,
    autonomyWindowToolCallCount: row.autonomyWindowToolCallCount,
    foregroundBurstSliceCount: row.foregroundBurstSliceCount,
    foregroundBurstStartedAt: row.foregroundBurstStartedAt ?? undefined,
    lastHumanInputAt: row.lastHumanInputAt ?? undefined,
    runStartedAt: row.runStartedAt ?? undefined,
    runDeadlineAt: row.runDeadlineAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });

  return {
    ...snapshot,
    idempotencyKey: row.idempotencyKey,
    turnRequest: JSON.parse(row.turnRequestJson),
    workerId: row.workerId ?? undefined,
    claimedAt: row.claimedAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    wallClockDeadlineAt: row.wallClockDeadlineAt ?? undefined,
    priority: row.priority,
    recoveryTruthState: row.recoveryTruthState ?? undefined,
    recoveryTruthUpdatedAt: row.recoveryTruthUpdatedAt ?? undefined
  };
}

function parseTask(row: TaskRow): BackgroundTaskSnapshot {
  return {
    taskId: row.taskId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    actorId: row.actorId ?? undefined,
    conversationRef: parseConversationRef(row.conversationRefJson),
    title: row.title,
    description: row.description,
    agentStatus: row.agentStatus ?? legacyToAgentStatus(row.status),
    blockingReason: row.blockingReason ?? undefined,
    sourceTurnId: row.lastTurnId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function legacyToAgentStatus(status: string): BackgroundTaskSnapshot["agentStatus"] {
  switch (status) {
    case "blocked": return "blocked";
    case "done": return "done";
    case "failed": return "failed";
    case "cancelled": return "canceled";
    default: return "open";
  }
}

function agentToLegacyStatus(status: BackgroundTaskSnapshot["agentStatus"]) {
  switch (status) {
    case "blocked": return "blocked";
    case "done": return "done";
    case "failed": return "failed";
    case "canceled": return "cancelled";
    default: return "active";
  }
}

function loadRun(db: Database.Database, runId: string) {
  const row = db.prepare(`${runSelect} WHERE run_id = ?`).get(runId) as TaskRunRow | undefined;
  return row ? parseRun(row) : undefined;
}

function updateTaskStatus(
  db: Database.Database,
  taskId: string,
  agentStatus: BackgroundTaskSnapshot["agentStatus"],
  now: string,
  options?: { blockingReason?: string }
) {
  const legacyStatus = agentToLegacyStatus(agentStatus);
  db.prepare(`
    UPDATE tasks
    SET agent_status = ?,
        status = ?,
        blocking_reason = CASE
          WHEN ? = 'blocked' THEN ?
          WHEN ? IN ('done', 'failed', 'cancelled', 'active') THEN NULL
          ELSE blocking_reason
        END,
        updated_at = ?
    WHERE task_id = ?
  `).run(agentStatus, legacyStatus, legacyStatus, options?.blockingReason ?? null, legacyStatus, now, taskId);
}

function nextAttemptNo(db: Database.Database, taskId: string) {
  const row = db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 as attemptNo FROM task_runs WHERE task_id = ?").get(taskId) as { attemptNo: number };
  return row.attemptNo;
}

function appendPendingCancelControl(db: Database.Database, input: {
  runId: string;
  taskId: string;
  reason?: string;
  createdAt: string;
}) {
  const existing = db.prepare(`
    SELECT control_id as controlId
    FROM run_control_inputs
    WHERE run_id = ? AND kind = 'cancel' AND applied_slice_id IS NULL
    ORDER BY control_seq ASC
    LIMIT 1
  `).get(input.runId) as { controlId: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE run_control_inputs
      SET payload_json = ?
      WHERE control_id = ?
    `).run(maybeJson(input.reason ? { reason: input.reason } : undefined), existing.controlId);
    return existing.controlId;
  }

  const controlId = `run:${input.runId}:cancel:${input.createdAt}`;
  db.prepare(`
    INSERT INTO run_control_inputs (
      control_id,
      task_id,
      run_id,
      kind,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, 'cancel', ?, ?)
  `).run(controlId, input.taskId, input.runId, maybeJson(input.reason ? { reason: input.reason } : undefined), input.createdAt);
  return controlId;
}

function markPendingCancelControlsApplied(db: Database.Database, input: {
  runId: string;
  appliedSliceId: string;
  appliedAt: string;
}) {
  db.prepare(`
    UPDATE run_control_inputs
    SET applied_slice_id = COALESCE(applied_slice_id, ?),
        applied_at = COALESCE(applied_at, ?)
    WHERE run_id = ? AND kind = 'cancel' AND applied_slice_id IS NULL
  `).run(input.appliedSliceId, input.appliedAt, input.runId);
}

export function createTaskRunStore({ filename }: { filename: string }): TaskRunStore {
  const db = openSqliteDatabase(filename);
  ensureTasksSchema(db);

  function loadBackgroundTask(taskId: string) {
    const row = db.prepare(`
      SELECT
        task_id as taskId,
        workspace_id as workspaceId,
        session_id as sessionId,
        actor_id as actorId,
        conversation_ref_json as conversationRefJson,
        title,
        description,
        agent_status as agentStatus,
        status,
        last_turn_id as lastTurnId,
        blocking_reason as blockingReason,
        created_at as createdAt,
        updated_at as updatedAt
      FROM tasks
      WHERE task_id = ?
    `).get(taskId) as TaskRow | undefined;
    return Promise.resolve(row ? parseTask(row) : undefined);
  }

  function createBackgroundTask(input: CreateBackgroundTaskInput) {
    const now = input.now ?? new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (
        task_id,
        workspace_id,
        session_id,
        title,
        description,
        kind,
        status,
        last_turn_id,
        checkpoint_ref,
        plan_json,
        artifacts_json,
        actor_id,
        conversation_ref_json,
        agent_status,
        background_created_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'background', 'active', ?, '', '[]', '[]', ?, ?, 'open', ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        session_id = excluded.session_id,
        title = excluded.title,
        description = excluded.description,
        last_turn_id = excluded.last_turn_id,
        actor_id = excluded.actor_id,
        conversation_ref_json = excluded.conversation_ref_json,
        updated_at = excluded.updated_at
    `).run(
      input.taskId,
      input.workspaceId,
      input.sessionId,
      input.title,
      input.description,
      input.sourceTurnId,
      input.actorId ?? null,
      maybeJson(input.conversationRef),
      now,
      now,
      now
    );
    return loadBackgroundTask(input.taskId);
  }

  function listBackgroundTasks(input: {
    workspaceId?: string;
    sessionId?: string;
    agentStatus?: BackgroundTaskSnapshot["agentStatus"];
    limit?: number;
  } = {}) {
    const conditions = ["kind = 'background'"];
    const params: Array<string | number> = [];

    if (input.workspaceId) {
      conditions.push("workspace_id = ?");
      params.push(input.workspaceId);
    }

    if (input.sessionId) {
      conditions.push("session_id = ?");
      params.push(input.sessionId);
    }

    if (input.agentStatus) {
      conditions.push("agent_status = ?");
      params.push(input.agentStatus);
    }

    const limit = input.limit ?? 50;
    params.push(limit);

    const rows = db.prepare(`
      SELECT
        task_id as taskId,
        workspace_id as workspaceId,
        session_id as sessionId,
        actor_id as actorId,
        conversation_ref_json as conversationRefJson,
        title,
        description,
        agent_status as agentStatus,
        status,
        last_turn_id as lastTurnId,
        blocking_reason as blockingReason,
        created_at as createdAt,
        updated_at as updatedAt
      FROM tasks
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, task_id DESC
      LIMIT ?
    `).all(...params) as TaskRow[];

    return Promise.resolve(rows.map(parseTask));
  }

  const createRunTransaction = db.transaction((input: CreateRunInput) => {
    const now = input.now ?? new Date().toISOString();
    const idempotencyKey = input.idempotencyKey ?? `run:${input.runId}`;
    const existing = db.prepare(`${runSelect} WHERE task_id = ? AND idempotency_key = ?`).get(input.taskId, idempotencyKey) as TaskRunRow | undefined;
    if (existing) return parseRun(existing);

    const attemptNo = input.attemptNo ?? nextAttemptNo(db, input.taskId);
    db.prepare(`
      INSERT INTO task_runs (
        run_id,
        task_id,
        workspace_id,
        session_id,
        actor_id,
        conversation_ref_json,
        status,
        attention_mode,
        run_kind,
        attempt_no,
        idempotency_key,
        turn_request_json,
        source_turn_id,
        max_attempts,
        wall_clock_deadline_at,
        run_deadline_at,
        parent_run_id,
        retry_of_run_id,
        priority,
        run_started_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      input.runId,
      input.taskId,
      input.workspaceId,
      input.sessionId,
      input.actorId ?? null,
      maybeJson(input.conversationRef),
      input.attentionMode,
      input.runKind ?? "normal",
      attemptNo,
      idempotencyKey,
      JSON.stringify(input.turnRequest ?? {}),
      input.sourceTurnId ?? null,
      input.maxAttempts ?? 1,
      input.wallClockDeadlineAt ?? null,
      input.runDeadlineAt ?? null,
      input.parentRunId ?? null,
      input.retryOfRunId ?? null,
      input.priority ?? 0,
      now,
      now
    );

    if (input.seedInitialSlice) {
      db.prepare(`
        INSERT INTO runtime_slices (
          slice_id,
          run_id,
          task_id,
          slice_no,
          trigger_kind,
          lane,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 1, 'initial', 'background', 'queued', ?, ?)
      `).run(
        `slice_${input.runId}_001`,
        input.runId,
        input.taskId,
        now,
        now
      );
    }

    updateTaskStatus(db, input.taskId, "queued", now);
    return loadRun(db, input.runId)!;
  });

  function createRun(input: CreateRunInput) {
    return Promise.resolve(createRunTransaction(input));
  }

  function enqueueRun(input: EnqueueRunInput) {
    return Promise.resolve(createRunTransaction({
      ...input,
      attentionMode: "background_detached",
      turnRequest: input.turnRequest,
      idempotencyKey: input.idempotencyKey
    }));
  }

  function loadRunById(runId: string) {
    return Promise.resolve(loadRun(db, runId));
  }

  function listRunsByTask(taskId: string) {
    const rows = db.prepare(`${runSelect} WHERE task_id = ? ORDER BY attempt_no ASC, created_at ASC, run_id ASC`).all(taskId) as TaskRunRow[];
    return Promise.resolve(rows.map(parseRun));
  }

  function updateRunStatusAndLedger(input: UpdateRunStatusAndLedgerInput) {
    const now = input.now ?? new Date().toISOString();
    const terminal = input.status === "completed" || input.status === "failed" || input.status === "canceled";
    const result = db.prepare(`
      UPDATE task_runs
      SET status = ?,
          cumulative_input_tokens = ?,
          cumulative_output_tokens = ?,
          cumulative_total_tokens = ?,
          cumulative_estimated_cost = ?,
          autonomy_window_slice_count = ?,
          autonomy_window_tool_call_count = ?,
          foreground_burst_slice_count = ?,
          foreground_burst_started_at = ?,
          last_human_input_at = ?,
          run_started_at = COALESCE(run_started_at, ?),
          run_deadline_at = ?,
          finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      input.status,
      input.ledger.cumulativeInputTokens,
      input.ledger.cumulativeOutputTokens,
      input.ledger.cumulativeTotalTokens,
      input.ledger.cumulativeEstimatedCost,
      input.ledger.autonomyWindowSliceCount,
      input.ledger.autonomyWindowToolCallCount,
      input.ledger.foregroundBurstSliceCount,
      input.ledger.foregroundBurstStartedAt ?? null,
      input.ledger.lastHumanInputAt ?? null,
      input.ledger.runStartedAt ?? null,
      input.ledger.runDeadlineAt ?? null,
      terminal ? 1 : 0,
      now,
      now,
      input.runId
    );
    if (result.changes !== 1) return Promise.resolve(undefined);
    return Promise.resolve(loadRun(db, input.runId));
  }

  function updateRunAttentionMode(input: UpdateRunAttentionModeInput) {
    const now = input.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE task_runs
      SET attention_mode = ?, updated_at = ?
      WHERE run_id = ?
    `).run(input.attentionMode, now, input.runId);
    return Promise.resolve(result.changes === 1 ? loadRun(db, input.runId) : undefined);
  }

  function attachContinuation(input: AttachContinuationInput) {
    const now = input.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE task_runs
      SET continuation_kind = ?,
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(input.kind, maybeJson(input.payload), now, now, input.runId);
    return Promise.resolve(result.changes === 1 ? loadRun(db, input.runId) : undefined);
  }

  function clearContinuation(input: ClearContinuationInput) {
    const now = input.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE task_runs
      SET continuation_kind = NULL,
          continuation_payload_json = NULL,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(now, now, input.runId);
    return Promise.resolve(result.changes === 1 ? loadRun(db, input.runId) : undefined);
  }

  function latchRunCancel(input: LatchRunCancelInput) {
    const cancelRequestedAt = input.cancelRequestedAt ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE task_runs
      SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
          cancel_requested_by = COALESCE(?, cancel_requested_by),
          cancel_reason = COALESCE(?, cancel_reason),
          cancel_observed_slice_id = COALESCE(?, cancel_observed_slice_id),
          updated_at = ?
      WHERE run_id = ?
    `).run(
      cancelRequestedAt,
      input.cancelRequestedBy ?? null,
      input.cancelReason ?? null,
      input.cancelObservedSliceId ?? null,
      cancelRequestedAt,
      input.runId
    );
    return Promise.resolve(result.changes === 1 ? loadRun(db, input.runId) : undefined);
  }

  const claimTransaction = db.transaction((input: ClaimNextRunInput): TaskRunClaimResult => {
    const now = input.now ?? new Date().toISOString();
    const candidate = db.prepare(`
      ${runSelect}
      WHERE status = 'queued'
      ORDER BY priority DESC, created_at ASC, run_id ASC
      LIMIT 1
    `).get() as TaskRunRow | undefined;
    if (!candidate) return { status: "none" };

    const result = db.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = COALESCE(started_at, ?),
          run_started_at = COALESCE(run_started_at, ?),
          updated_at = ?
      WHERE run_id = ? AND status = 'queued'
    `).run(input.workerId, input.workerId, addMs(now, input.leaseDurationMs), now, now, now, now, candidate.runId);

    if (result.changes !== 1) return { status: "lost_race" };
    updateTaskStatus(db, candidate.taskId, "running", now);
    return { status: "claimed", run: loadRun(db, candidate.runId)! };
  });

  function claimNextRun(input: ClaimNextRunInput) {
    return Promise.resolve(claimTransaction(input));
  }

  function renewRunLease(input: RenewRunLeaseInput) {
    const now = input.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE task_runs
      SET lease_expires_at = ?, updated_at = ?
      WHERE run_id = ?
        AND lease_owner = ?
        AND status IN ('running', 'cancel_requested')
        AND lease_expires_at > ?
    `).run(addMs(now, input.leaseDurationMs), now, input.runId, input.leaseOwner, now);
    return Promise.resolve(result.changes === 1 ? loadRun(db, input.runId) : undefined);
  }

  function transitionRun(input: {
    runId: string;
    from: string[];
    to: string;
    taskStatus?: BackgroundTaskSnapshot["agentStatus"];
    resultSummary?: string;
    error?: unknown;
    cancelReason?: string;
    pendingApprovalRef?: string;
    pendingControlRef?: string;
    blockedBy?: string;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const terminal = ["completed", "failed", "canceled", "lease_expired"].includes(input.to);
    const current = db.prepare(`${runSelect} WHERE run_id = ?`).get(input.runId) as TaskRunRow | undefined;
    if (!current) return undefined;
    const recoveryTruthState = current.attentionMode === "background_detached"
      ? terminal
        ? "closed"
        : input.to === "blocked"
          ? null
          : current.recoveryTruthState
      : current.recoveryTruthState;
    const recoveryTruthUpdatedAt = current.attentionMode === "background_detached" && (terminal || input.to === "blocked")
      ? now
      : current.recoveryTruthUpdatedAt;
    const result = db.prepare(`
      UPDATE task_runs
      SET status = ?,
          finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
          lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
          lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
          result_summary = COALESCE(?, result_summary),
          error_json = COALESCE(?, error_json),
          cancel_reason = COALESCE(?, cancel_reason),
          recovery_truth_state = ?,
          recovery_truth_updated_at = ?,
          pending_approval_ref = COALESCE(?, pending_approval_ref),
          pending_control_ref = COALESCE(?, pending_control_ref),
          updated_at = ?
      WHERE run_id = ? AND status IN (${input.from.map(() => "?").join(", ")})
    `).run(
      input.to,
      terminal ? 1 : 0,
      now,
      terminal || input.to === "blocked" ? 1 : 0,
      terminal || input.to === "blocked" ? 1 : 0,
      input.resultSummary ?? null,
      maybeJson(input.error),
      input.cancelReason ?? null,
      recoveryTruthState,
      recoveryTruthUpdatedAt,
      input.pendingApprovalRef ?? null,
      input.pendingControlRef ?? null,
      now,
      input.runId,
      ...input.from
    );
    if (result.changes !== 1) return undefined;
    if (terminal) {
      markPendingCancelControlsApplied(db, {
        runId: input.runId,
        appliedSliceId: `terminal:${input.runId}:${input.to}`,
        appliedAt: now
      });
    }
    const run = loadRun(db, input.runId)!;
    if (input.taskStatus) updateTaskStatus(db, run.taskId, input.taskStatus, now, { blockingReason: input.to === "blocked" ? input.blockedBy : undefined });
    return loadRun(db, input.runId);
  }

  function completeRun(input: CompleteRunInput) {
    return Promise.resolve(transitionRun({
      runId: input.runId,
      from: ["running", "cancel_requested"],
      to: "completed",
      taskStatus: "done",
      resultSummary: input.resultSummary,
      now: input.now
    }));
  }

  function failRun(input: FailRunInput) {
    const tx = db.transaction(() => {
      const failed = transitionRun({
        runId: input.runId,
        from: ["running", "cancel_requested"],
        to: "failed",
        taskStatus: "failed",
        resultSummary: input.resultSummary,
        error: input.error,
        now: input.now
      });
      if (!failed) return { failed: undefined, retry: undefined };
      if (!input.retryRunId || !input.retryIdempotencyKey || failed.attemptNo >= failed.maxAttempts || failed.cancelRequestedAt) {
        return { failed, retry: undefined };
      }
      const retry = createRunTransaction({
        runId: input.retryRunId,
        taskId: failed.taskId,
        workspaceId: failed.workspaceId,
        sessionId: failed.sessionId,
        actorId: failed.actorId,
        conversationRef: failed.conversationRef,
        attentionMode: failed.attentionMode,
        idempotencyKey: input.retryIdempotencyKey,
        turnRequest: failed.turnRequest,
        sourceTurnId: failed.sourceTurnId,
        maxAttempts: failed.maxAttempts,
        runKind: failed.runKind,
        parentRunId: failed.parentRunId,
        retryOfRunId: failed.runId,
        runDeadlineAt: failed.runDeadlineAt,
        wallClockDeadlineAt: failed.wallClockDeadlineAt,
        attemptNo: failed.attemptNo + 1,
        priority: failed.priority,
        seedInitialSlice: failed.attentionMode === "background_detached",
        now: input.now
      });
      return { failed, retry };
    });
    return Promise.resolve(tx());
  }

  function interruptRun(input: InterruptRunInput) {
    return Promise.resolve(transitionRun({
      runId: input.runId,
      from: ["running", "cancel_requested"],
      to: "failed",
      taskStatus: "failed",
      resultSummary: input.resultSummary,
      error: input.error,
      now: input.now
    }));
  }

  function suspendRun(input: SuspendRunInput) {
    return Promise.resolve(transitionRun({
      runId: input.runId,
      from: ["running", "cancel_requested"],
      to: "blocked",
      taskStatus: "blocked",
      pendingApprovalRef: input.pendingApprovalRef,
      pendingControlRef: input.pendingControlRef,
      blockedBy: input.blockedBy,
      resultSummary: input.resultSummary,
      now: input.now
    }));
  }

  function requestRunCancellation(input: RequestRunCancellationInput) {
    const tx = db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const row = db.prepare(`${runSelect} WHERE run_id = ?`).get(input.runId) as TaskRunRow | undefined;
      if (!row) return undefined;

      const currentStatus = normalizeLegacyTaskRunStatus(row.status as never);
      if (currentStatus === "completed" || currentStatus === "failed" || currentStatus === "canceled") {
        return undefined;
      }

      db.prepare(`
        UPDATE task_runs
        SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
            cancel_requested_by = COALESCE(cancel_requested_by, ?),
            cancel_reason = COALESCE(cancel_reason, ?),
            recovery_truth_state = ?,
            recovery_truth_updated_at = ?,
            updated_at = ?
        WHERE run_id = ?
      `).run(
        now,
        input.actorId ?? null,
        input.reason ?? null,
        row.attentionMode === "background_detached" ? "closed" : row.recoveryTruthState,
        row.attentionMode === "background_detached" ? now : row.recoveryTruthUpdatedAt,
        now,
        input.runId
      );

      appendPendingCancelControl(db, {
        runId: input.runId,
        taskId: row.taskId,
        reason: input.reason,
        createdAt: now
      });

      return loadRun(db, input.runId);
    });

    return Promise.resolve(tx());
  }

  function cancelQueuedOrSuspendedRun(input: CancelQueuedOrSuspendedRunInput) {
    const canceled = transitionRun({
      runId: input.runId,
      from: ["queued", "blocked", "suspended"],
      to: "canceled",
      taskStatus: "canceled",
      cancelReason: input.reason,
      now: input.now
    });
    return Promise.resolve(canceled);
  }

  function markRunCanceled(input: MarkRunCanceledInput) {
    return Promise.resolve(transitionRun({
      runId: input.runId,
      from: ["running", "cancel_requested", "blocked"],
      to: "canceled",
      taskStatus: "canceled",
      resultSummary: input.resultSummary,
      cancelReason: input.reason,
      now: input.now
    }));
  }

  function markLeaseExpired(input: MarkLeaseExpiredInput) {
    const tx = db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const updated = db.prepare(`
        UPDATE task_runs
        SET status = 'failed',
            finished_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE run_id = ?
          AND status IN ('running', 'cancel_requested')
          AND lease_expires_at < ?
      `).run(now, now, input.runId, now);
      if (updated.changes !== 1) return { expired: undefined, retry: undefined };

      const expired = loadRun(db, input.runId)!;
      markPendingCancelControlsApplied(db, {
        runId: input.runId,
        appliedSliceId: `terminal:${input.runId}:failed`,
        appliedAt: now
      });
      updateTaskStatus(db, expired.taskId, "failed", now);

      if (!input.retryRunId || !input.retryIdempotencyKey || expired.attemptNo >= expired.maxAttempts || expired.cancelRequestedAt) {
        return { expired, retry: undefined };
      }
      const retry = createRunTransaction({
        runId: input.retryRunId,
        taskId: expired.taskId,
        workspaceId: expired.workspaceId,
        sessionId: expired.sessionId,
        actorId: expired.actorId,
        conversationRef: expired.conversationRef,
        attentionMode: expired.attentionMode,
        idempotencyKey: input.retryIdempotencyKey,
        turnRequest: expired.turnRequest,
        sourceTurnId: expired.sourceTurnId,
        maxAttempts: expired.maxAttempts,
        runKind: expired.runKind,
        parentRunId: expired.parentRunId,
        retryOfRunId: expired.runId,
        runDeadlineAt: expired.runDeadlineAt,
        wallClockDeadlineAt: expired.wallClockDeadlineAt,
        attemptNo: expired.attemptNo + 1,
        seedInitialSlice: expired.attentionMode === "background_detached",
        priority: expired.priority,
        now
      });
      return { expired, retry };
    });
    return Promise.resolve(tx());
  }

  return {
    createBackgroundTask,
    loadBackgroundTask,
    listBackgroundTasks,
    createRun,
    enqueueRun,
    loadRunById,
    listRunsByTask,
    updateRunStatusAndLedger,
    updateRunAttentionMode,
    attachContinuation,
    clearContinuation,
    latchRunCancel,
    claimNextRun,
    renewRunLease,
    completeRun,
    failRun,
    interruptRun,
    suspendRun,
    requestRunCancellation,
    cancelQueuedOrSuspendedRun,
    markRunCanceled,
    markLeaseExpired
  };
}
