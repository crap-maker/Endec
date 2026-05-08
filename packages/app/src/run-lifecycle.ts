import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { RuntimeSliceSnapshot, SliceLane, SliceTriggerKind, TaskRunSnapshot, TurnRequest, TurnResult } from "@endec/domain";
import { normalizeLegacyTaskRunStatus } from "@endec/domain";

type RunStore = {
  loadRunById(runId: string): Promise<(TaskRunSnapshot & {
    turnRequest?: unknown;
    workerId?: string;
    claimedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    wallClockDeadlineAt?: string;
    priority?: number;
    recoveryTruthState?: "consumed" | "closed";
    recoveryTruthUpdatedAt?: string;
  }) | undefined>;
};

type SliceStore = {
  listSlicesByRun(runId: string): Promise<RuntimeSliceSnapshot[]>;
};

type ControlStore = {
  appendControlInput(input: {
    controlId: string;
    taskId: string;
    runId: string;
    kind: "steer" | "follow_up" | "continue" | "cancel";
    payload?: unknown;
    createdAt?: string;
  }): Promise<unknown>;
  listPendingControls(runId: string): Promise<Array<{
    controlSeq: number;
    controlId: string;
    taskId: string;
    runId: string;
    kind: "steer" | "follow_up" | "continue" | "cancel";
    payload?: unknown;
    createdAt: string;
    appliedSliceId?: string;
    appliedAt?: string;
  }>>;
};

type SessionStore = {
  setFocusRun?(input: { sessionId: string; taskId: string; runId: string; now?: string }): Promise<unknown>;
  clearFocusRun?(input: { sessionId: string; now?: string }): Promise<unknown>;
  loadFocusRun?(sessionId: string): Promise<{ taskId: string; runId: string; updatedAt?: string } | undefined>;
  loadRecoveryContext?(sessionId: string): Promise<{
    inflight: {
      turnId: string;
      pendingExecution?: unknown;
    };
  } | null>;
  finalize?(input: { turnId: string; sessionId: string; status: "completed" | "failed" | "interrupted" | "blocked"; preserveInflight?: boolean }): Promise<string>;
};

type ClaimedRun = NonNullable<Awaited<ReturnType<RunStore["loadRunById"]>>>;

type LifecycleContinuation = {
  kind: "auto_continue" | "user_resume" | "approval_resume" | "operator_resume" | "recovery_retry";
  payload?: unknown;
  pendingApprovalRef?: string;
  pendingControlRef?: string;
  blockedBy?: string;
};

type LifecycleUsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
  toolCallCount?: number;
};

type FinalizeSliceInput = {
  sliceId: string;
  runId: string;
  taskId: string;
  lane: SliceLane;
  result: {
    terminalStatus: "yielded" | "blocked" | "completed" | "failed" | "canceled";
    resultSummary?: string;
    error?: unknown;
    continuation?: LifecycleContinuation;
    usageSummary?: LifecycleUsageSummary;
    toolLoopSummary?: unknown;
  };
  now?: string;
};

type ClaimedSlice = {
  run: ClaimedRun;
  slice: RuntimeSliceSnapshot;
};

type RunBoundaryDecision = "continue" | "detach" | "block" | "stop";

type BoundaryDecisionResult = {
  decision: RunBoundaryDecision;
  runStatus?: "queued" | "blocked" | "completed" | "failed" | "canceled";
};

type RunLifecycleOptions = {
  tasksDbPath: string;
  runStore: RunStore;
  sliceStore: SliceStore;
  controlStore: ControlStore;
  sessionStore?: SessionStore;
  executeTurnSlice: (request: TurnRequest, context: ClaimedSlice) => Promise<TurnResult>;
  continueSlice?: (context: ClaimedSlice) => Promise<TurnResult>;
  resolveApprovalSlice?: (context: ClaimedSlice) => Promise<TurnResult>;
  decideNextAction?: (input: {
    run: ClaimedRun;
    lane: SliceLane;
    terminalStatus: FinalizeSliceInput["result"]["terminalStatus"];
    continuation?: LifecycleContinuation;
    pendingControls: Awaited<ReturnType<ControlStore["listPendingControls"]>>;
    usageSummary?: LifecycleUsageSummary;
  }) => BoundaryDecisionResult;
};

type RawRunRow = {
  runId: string;
  taskId: string;
  sessionId: string;
  workspaceId: string;
  status: string;
  attentionMode: "foreground_attached" | "background_detached" | null;
  continuationKind: LifecycleContinuation["kind"] | null;
  continuationPayloadJson: string | null;
  continuationUpdatedAt: string | null;
  recoveryTruthState: "consumed" | "closed" | null;
  recoveryTruthUpdatedAt: string | null;
  pendingApprovalRef: string | null;
  pendingControlRef: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
  cancelReason: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  turnRequestJson: string;
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
  runDeadlineAt: string | null;
};

type RawSliceRow = {
  sliceId: string;
  runId: string;
  taskId: string;
  sliceNo: number;
  triggerKind: SliceTriggerKind;
  lane: SliceLane;
  status: string;
  continuationPayloadJson: string | null;
  leaseExpiresAt: string | null;
};

const runSelect = `
  SELECT
    run_id as runId,
    task_id as taskId,
    session_id as sessionId,
    workspace_id as workspaceId,
    status,
    attention_mode as attentionMode,
    continuation_kind as continuationKind,
    continuation_payload_json as continuationPayloadJson,
    continuation_updated_at as continuationUpdatedAt,
    recovery_truth_state as recoveryTruthState,
    recovery_truth_updated_at as recoveryTruthUpdatedAt,
    pending_approval_ref as pendingApprovalRef,
    pending_control_ref as pendingControlRef,
    cancel_requested_at as cancelRequestedAt,
    cancel_requested_by as cancelRequestedBy,
    cancel_reason as cancelReason,
    lease_owner as leaseOwner,
    lease_expires_at as leaseExpiresAt,
    turn_request_json as turnRequestJson,
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
    run_deadline_at as runDeadlineAt
  FROM task_runs
`;

function openDb(filename: string) {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  return db;
}

function maybeJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | undefined {
  return value ? JSON.parse(value) as T : undefined;
}

function detachedRecoveryFinalizeStatus(status: "completed" | "failed" | "canceled") {
  return status === "completed"
    ? "completed" as const
    : status === "failed"
      ? "failed" as const
      : "interrupted" as const;
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function hasRecoverableRecoveryContinuation(input: ClaimedSlice, sessionStore?: SessionStore) {
  const slicePayload = asObjectRecord(input.slice.continuationPayload);
  const runPayload = asObjectRecord(input.run.continuationPayload);
  if (asObjectRecord(slicePayload?.recovery) || asObjectRecord(runPayload?.recovery)) {
    return true;
  }

  const recoveryContext = await sessionStore?.loadRecoveryContext?.(input.run.sessionId);
  return Boolean(
    recoveryContext
      && recoveryContext.inflight.turnId === input.run.runId
      && recoveryContext.inflight.pendingExecution
  );
}

function readCancelControlMetadata(payload: unknown) {
  const record = asObjectRecord(payload);
  return {
    requestedBy: typeof record?.actorId === "string"
      ? record.actorId
      : typeof record?.requestedBy === "string"
        ? record.requestedBy
        : undefined,
    reason: typeof record?.reason === "string" ? record.reason : undefined
  };
}

function addMs(iso: string, ms: number) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function laneFromAttentionMode(attentionMode: RawRunRow["attentionMode"]): SliceLane {
  return attentionMode === "background_detached" ? "background" : "foreground";
}

function taskStatusForRunStatus(status: "queued" | "running" | "blocked" | "completed" | "failed" | "canceled") {
  switch (status) {
    case "queued":
      return { agentStatus: "queued", legacyStatus: "active" } as const;
    case "running":
      return { agentStatus: "running", legacyStatus: "active" } as const;
    case "blocked":
      return { agentStatus: "blocked", legacyStatus: "blocked" } as const;
    case "completed":
      return { agentStatus: "done", legacyStatus: "done" } as const;
    case "failed":
      return { agentStatus: "failed", legacyStatus: "failed" } as const;
    case "canceled":
      return { agentStatus: "canceled", legacyStatus: "cancelled" } as const;
  }
}

function reconstructTurnRequest(run: ClaimedRun): TurnRequest {
  const stored = (run.turnRequest ?? {}) as Record<string, unknown>;
  const originTurnId = typeof stored.originTurnId === "string"
    ? stored.originTurnId
    : typeof stored.turnId === "string"
      ? stored.turnId
      : run.runId;

  return {
    turnId: run.runId,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    source: stored.source === "telegram"
      || stored.source === "feishu"
      || stored.source === "cli"
      || stored.source === "tui"
      || stored.source === "web"
      || stored.source === "sdk"
      ? stored.source
      : "sdk",
    actorId: typeof stored.actorId === "string" ? stored.actorId : run.actorId ?? "system:run-slice-worker",
    input: typeof stored.input === "string" ? stored.input : "",
    attachments: Array.isArray(stored.attachments) ? stored.attachments : [],
    requestedMode: stored.requestedMode === "chat"
      || stored.requestedMode === "plan"
      || stored.requestedMode === "act"
      || stored.requestedMode === "review"
      || stored.requestedMode === "task"
      ? stored.requestedMode
      : undefined,
    conversationRef: run.conversationRef,
    taskId: run.taskId,
    channelContext: {
      ...(stored.channelContext && typeof stored.channelContext === "object" && !Array.isArray(stored.channelContext)
        ? stored.channelContext as Record<string, unknown>
        : {}),
      backgroundTask: {
        schemaVersion: 1,
        contractVersion: "im.background-turn.v1",
        taskId: run.taskId,
        runId: run.runId,
        attemptNo: run.attemptNo,
        originTurnId,
        executionRole: "background_worker"
      }
    }
  };
}

function createMissingContinuationHandlerResult(input: {
  request: TurnRequest;
  run: ClaimedRun;
  continuationKind: Extract<LifecycleContinuation["kind"], "auto_continue" | "approval_resume" | "user_resume" | "operator_resume" | "recovery_retry">;
  requiredHandler: "continueSlice" | "resolveApprovalSlice";
}): TurnResult {
  const continuationPayload = input.run.continuationPayload && typeof input.run.continuationPayload === "object" && !Array.isArray(input.run.continuationPayload)
    ? input.run.continuationPayload as Record<string, unknown>
    : undefined;
  const checkpointRef = typeof continuationPayload?.checkpointRef === "string" && continuationPayload.checkpointRef.length > 0
    ? continuationPayload.checkpointRef
    : input.run.sourceTurnId ?? input.run.runId;
  const message = `background worker cannot continue ${input.continuationKind} without ${input.requiredHandler}; refusing fresh executeTurn fallback`;

  return {
    turnId: input.request.turnId,
    sessionId: input.request.sessionId,
    resolvedMode: input.request.requestedMode ?? "chat",
    status: "failed",
    messages: [],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0
    },
    warnings: [message],
    checkpointRef
  };
}

export function createRunLifecycle(options: RunLifecycleOptions) {
  const db = openDb(options.tasksDbPath);

  function updateTaskStatus(taskId: string, runStatus: ReturnType<typeof taskStatusForRunStatus>, now: string, blockedBy?: string) {
    db.prepare(`
      UPDATE tasks
      SET agent_status = ?,
          status = ?,
          blocking_reason = CASE
            WHEN ? = 'blocked' THEN ?
            WHEN ? IN ('active', 'done', 'failed', 'cancelled') THEN NULL
            ELSE blocking_reason
          END,
          updated_at = ?
      WHERE task_id = ?
    `).run(runStatus.agentStatus, runStatus.legacyStatus, runStatus.legacyStatus, blockedBy ?? null, runStatus.legacyStatus, now, taskId);
  }

  function nextSliceNo(runId: string) {
    const row = db.prepare(`SELECT COALESCE(MAX(slice_no), 0) + 1 as nextSliceNo FROM runtime_slices WHERE run_id = ?`).get(runId) as { nextSliceNo: number };
    return row.nextSliceNo;
  }

  function insertQueuedSlice(input: {
    sliceId?: string;
    runId: string;
    taskId: string;
    triggerKind: SliceTriggerKind;
    lane: SliceLane;
    continuationPayload?: unknown;
    createdAt: string;
  }) {
    const sliceId = input.sliceId ?? `slice_${randomUUID()}`;
    db.prepare(`
      INSERT INTO runtime_slices (
        slice_id,
        run_id,
        task_id,
        slice_no,
        trigger_kind,
        lane,
        status,
        continuation_payload_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      sliceId,
      input.runId,
      input.taskId,
      nextSliceNo(input.runId),
      input.triggerKind,
      input.lane,
      maybeJson(input.continuationPayload),
      input.createdAt,
      input.createdAt
    );
    return sliceId;
  }

  function loadRunRow(runId: string) {
    return db.prepare(`${runSelect} WHERE run_id = ?`).get(runId) as RawRunRow | undefined;
  }

  function loadPendingControlsRow(runId: string) {
    const rows = db.prepare(`
      SELECT
        control_seq as controlSeq,
        control_id as controlId,
        task_id as taskId,
        run_id as runId,
        kind,
        payload_json as payloadJson,
        created_at as createdAt,
        applied_slice_id as appliedSliceId,
        applied_at as appliedAt
      FROM run_control_inputs
      WHERE run_id = ? AND applied_slice_id IS NULL
      ORDER BY control_seq ASC
    `).all(runId) as Array<{
      controlSeq: number;
      controlId: string;
      taskId: string;
      runId: string;
      kind: "steer" | "follow_up" | "continue" | "cancel";
      payloadJson: string | null;
      createdAt: string;
      appliedSliceId: string | null;
      appliedAt: string | null;
    }>;

    return rows.map((row) => ({
      controlSeq: row.controlSeq,
      controlId: row.controlId,
      taskId: row.taskId,
      runId: row.runId,
      kind: row.kind,
      payload: parseJson(row.payloadJson),
      createdAt: row.createdAt,
      appliedSliceId: row.appliedSliceId ?? undefined,
      appliedAt: row.appliedAt ?? undefined
    }));
  }

  const migrateLegacyRunsToSlicesTx = db.transaction((rawNow?: string) => {
    const now = rawNow ?? new Date().toISOString();
    const runs = db.prepare(`${runSelect} ORDER BY run_id ASC`).all() as RawRunRow[];

    for (const run of runs) {
      const hasSlice = db.prepare(`SELECT 1 FROM runtime_slices WHERE run_id = ? LIMIT 1`).get(run.runId);
      if (hasSlice) {
        continue;
      }

      const normalizedStatus = normalizeLegacyTaskRunStatus(run.status as never);
      if (normalizedStatus === "completed" || normalizedStatus === "failed" || normalizedStatus === "canceled") {
        continue;
      }

      if (run.cancelRequestedAt) {
        db.prepare(`
          UPDATE task_runs
          SET status = 'canceled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              worker_id = NULL,
              finished_at = COALESCE(finished_at, ?),
              updated_at = ?
          WHERE run_id = ?
        `).run(now, now, run.runId);
        updateTaskStatus(run.taskId, taskStatusForRunStatus("canceled"), now);
        continue;
      }

      const lane = laneFromAttentionMode(run.attentionMode);
      if (normalizedStatus === "queued") {
        insertQueuedSlice({
          runId: run.runId,
          taskId: run.taskId,
          triggerKind: "legacy_cutover",
          lane,
          createdAt: now
        });
        continue;
      }

      if (normalizedStatus === "running") {
        db.prepare(`
          UPDATE task_runs
          SET status = 'queued',
              worker_id = NULL,
              claimed_at = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              continuation_kind = COALESCE(continuation_kind, 'recovery_retry'),
              continuation_updated_at = COALESCE(continuation_updated_at, ?),
              updated_at = ?
          WHERE run_id = ?
        `).run(now, now, run.runId);
        updateTaskStatus(run.taskId, taskStatusForRunStatus("queued"), now);
        insertQueuedSlice({
          runId: run.runId,
          taskId: run.taskId,
          triggerKind: "recovery_retry",
          lane,
          continuationPayload: parseJson(run.continuationPayloadJson),
          createdAt: now
        });
        continue;
      }

      if (normalizedStatus === "blocked") {
        const continuationKind = run.continuationKind
          ?? (run.pendingApprovalRef ? "approval_resume" : run.pendingControlRef ? "operator_resume" : null);
        if (continuationKind) {
          const existingPayload = parseJson<Record<string, unknown>>(run.continuationPayloadJson) ?? {};
          db.prepare(`
            UPDATE task_runs
            SET continuation_kind = ?,
                continuation_payload_json = ?,
                continuation_updated_at = COALESCE(continuation_updated_at, ?),
                updated_at = ?
            WHERE run_id = ?
          `).run(
            continuationKind,
            JSON.stringify({
              ...existingPayload,
              pendingApprovalRef: run.pendingApprovalRef ?? existingPayload.pendingApprovalRef,
              pendingControlRef: run.pendingControlRef ?? existingPayload.pendingControlRef
            }),
            now,
            now,
            run.runId
          );
        }
        updateTaskStatus(run.taskId, taskStatusForRunStatus("blocked"), now, run.pendingApprovalRef ? "permission" : undefined);
      }
    }

  });

  async function migrateLegacyRunsToSlices(input?: { now?: string }) {
    migrateLegacyRunsToSlicesTx(input?.now);
  }

  function recoverExpiredSlice(now: string, expired: RawSliceRow | undefined) {
    if (!expired) {
      return false;
    }

    const run = loadRunRow(expired.runId);
    if (!run) {
      return false;
    }

    db.prepare(`
      UPDATE runtime_slices
      SET status = 'lease_expired',
          finished_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE slice_id = ? AND status = 'running'
    `).run(now, now, expired.sliceId);

    if (run.cancelRequestedAt) {
      db.prepare(`
        UPDATE task_runs
        SET status = 'canceled',
            worker_id = NULL,
            claimed_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            finished_at = COALESCE(finished_at, ?),
            updated_at = ?
        WHERE run_id = ?
      `).run(now, now, run.runId);
      updateTaskStatus(run.taskId, taskStatusForRunStatus("canceled"), now);
      return true;
    }

    db.prepare(`
      UPDATE task_runs
      SET status = 'queued',
          worker_id = NULL,
          claimed_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          continuation_kind = 'recovery_retry',
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(now, now, run.runId);
    updateTaskStatus(run.taskId, taskStatusForRunStatus("queued"), now);
    insertQueuedSlice({
      runId: run.runId,
      taskId: run.taskId,
      triggerKind: "recovery_retry",
      lane: expired.lane,
      continuationPayload: parseJson(expired.continuationPayloadJson),
      createdAt: now
    });
    return true;
  }

  function recoverExpiredSliceInLane(now: string, lane: SliceLane) {
    const expired = db.prepare(`
      SELECT
        s.slice_id as sliceId,
        s.run_id as runId,
        s.task_id as taskId,
        s.slice_no as sliceNo,
        s.trigger_kind as triggerKind,
        s.lane as lane,
        s.status as status,
        s.continuation_payload_json as continuationPayloadJson,
        s.lease_expires_at as leaseExpiresAt
      FROM runtime_slices s
      WHERE s.lane = ? AND s.status = 'running' AND s.lease_expires_at < ?
      ORDER BY s.lease_expires_at ASC, s.slice_no ASC, s.slice_id ASC
      LIMIT 1
    `).get(lane, now) as RawSliceRow | undefined;

    return recoverExpiredSlice(now, expired);
  }

  function recoverExpiredSliceForRun(now: string, runId: string) {
    const expired = db.prepare(`
      SELECT
        s.slice_id as sliceId,
        s.run_id as runId,
        s.task_id as taskId,
        s.slice_no as sliceNo,
        s.trigger_kind as triggerKind,
        s.lane as lane,
        s.status as status,
        s.continuation_payload_json as continuationPayloadJson,
        s.lease_expires_at as leaseExpiresAt
      FROM runtime_slices s
      WHERE s.run_id = ? AND s.status = 'running' AND s.lease_expires_at < ?
      ORDER BY s.lease_expires_at ASC, s.slice_no ASC, s.slice_id ASC
      LIMIT 1
    `).get(runId, now) as RawSliceRow | undefined;

    return recoverExpiredSlice(now, expired);
  }

  const claimNextRunnableSliceTx = db.transaction((input: { workerId: string; lane: SliceLane; leaseDurationMs: number; now?: string }) => {
    const now = input.now ?? new Date().toISOString();
    migrateLegacyRunsToSlicesTx(now);

    while (recoverExpiredSliceInLane(now, input.lane)) {
      // keep draining expired leases before claiming a fresh head
    }

    const candidate = db.prepare(`
      SELECT s.slice_id as sliceId, s.run_id as runId
      FROM runtime_slices s
      JOIN task_runs r ON r.run_id = s.run_id
      WHERE s.lane = ?
        AND r.status = 'queued'
        AND s.status = 'queued'
        AND NOT EXISTS (
          SELECT 1
          FROM runtime_slices active
          WHERE active.run_id = s.run_id
            AND active.status = 'running'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM runtime_slices prior
          WHERE prior.run_id = s.run_id
            AND prior.status = 'queued'
            AND prior.slice_no < s.slice_no
        )
      ORDER BY r.priority DESC, r.created_at ASC, r.run_id ASC, s.slice_no ASC, s.created_at ASC, s.slice_id ASC
      LIMIT 1
    `).get(input.lane) as { sliceId: string; runId: string } | undefined;

    if (!candidate) {
      return { status: "none" as const };
    }

    const leaseExpiresAt = addMs(now, input.leaseDurationMs);
    const runChanges = db.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = ?,
          claimed_at = ?,
          started_at = COALESCE(started_at, ?),
          lease_owner = ?,
          lease_expires_at = ?,
          run_started_at = COALESCE(run_started_at, ?),
          updated_at = ?
      WHERE run_id = ? AND status = 'queued'
    `).run(input.workerId, now, now, input.workerId, leaseExpiresAt, now, now, candidate.runId).changes;

    if (runChanges !== 1) {
      return { status: "lost_race" as const };
    }

    const sliceChanges = db.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = COALESCE(started_at, ?),
          updated_at = ?
      WHERE slice_id = ? AND status = 'queued'
    `).run(input.workerId, input.workerId, leaseExpiresAt, now, now, now, candidate.sliceId).changes;

    if (sliceChanges !== 1) {
      db.prepare(`
        UPDATE task_runs
        SET status = 'queued',
            worker_id = NULL,
            claimed_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE run_id = ? AND status = 'running'
      `).run(now, candidate.runId);
      return { status: "lost_race" as const };
    }

    const run = loadRunRow(candidate.runId);
    if (run) {
      updateTaskStatus(run.taskId, taskStatusForRunStatus("running"), now);
    }

    return { status: "claimed" as const, sliceId: candidate.sliceId, runId: candidate.runId };
  });

  async function claimNextRunnableSlice(input: { workerId: string; lane: SliceLane; leaseDurationMs: number; now?: string }) {
    const claimed = claimNextRunnableSliceTx(input);
    if (claimed.status !== "claimed") {
      return claimed;
    }

    const [run, slices] = await Promise.all([
      options.runStore.loadRunById(claimed.runId),
      options.sliceStore.listSlicesByRun(claimed.runId)
    ]);
    const slice = slices.find((item) => item.sliceId === claimed.sliceId);
    if (!run || !slice) {
      throw new Error(`claimed slice ${claimed.sliceId} for run ${claimed.runId} disappeared`);
    }

    return {
      status: "claimed" as const,
      run,
      slice
    };
  }

  async function claimRunnableSliceForRun(input: { runId: string; workerId: string; leaseDurationMs: number; now?: string }) {
    const claimed = db.transaction((claimInput: { runId: string; workerId: string; leaseDurationMs: number; now?: string }) => {
      const now = claimInput.now ?? new Date().toISOString();
      migrateLegacyRunsToSlicesTx(now);

      while (recoverExpiredSliceForRun(now, claimInput.runId)) {
        // keep recovering expired targeted slices until a fresh runnable head exists
      }

      const candidate = db.prepare(`
        SELECT s.slice_id as sliceId, s.run_id as runId
        FROM runtime_slices s
        JOIN task_runs r ON r.run_id = s.run_id
        WHERE s.run_id = ?
          AND r.status = 'queued'
          AND s.status = 'queued'
          AND NOT EXISTS (
            SELECT 1
            FROM runtime_slices active
            WHERE active.run_id = s.run_id
              AND active.status = 'running'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM runtime_slices prior
            WHERE prior.run_id = s.run_id
              AND prior.status = 'queued'
              AND prior.slice_no < s.slice_no
          )
        ORDER BY s.slice_no ASC, s.created_at ASC, s.slice_id ASC
        LIMIT 1
      `).get(claimInput.runId) as { sliceId: string; runId: string } | undefined;

      if (!candidate) {
        return { status: "none" as const };
      }

      const leaseExpiresAt = addMs(now, claimInput.leaseDurationMs);
      const runChanges = db.prepare(`
        UPDATE task_runs
        SET status = 'running',
            worker_id = ?,
            claimed_at = ?,
            started_at = COALESCE(started_at, ?),
            lease_owner = ?,
            lease_expires_at = ?,
            run_started_at = COALESCE(run_started_at, ?),
            updated_at = ?
        WHERE run_id = ? AND status = 'queued'
      `).run(claimInput.workerId, now, now, claimInput.workerId, leaseExpiresAt, now, now, candidate.runId).changes;
      if (runChanges !== 1) {
        return { status: "lost_race" as const };
      }

      const sliceChanges = db.prepare(`
        UPDATE runtime_slices
        SET status = 'running',
            worker_id = ?,
            lease_owner = ?,
            lease_expires_at = ?,
            claimed_at = ?,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE slice_id = ? AND status = 'queued'
      `).run(claimInput.workerId, claimInput.workerId, leaseExpiresAt, now, now, now, candidate.sliceId).changes;
      if (sliceChanges !== 1) {
        db.prepare(`
          UPDATE task_runs
          SET status = 'queued',
              worker_id = NULL,
              claimed_at = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE run_id = ? AND status = 'running'
        `).run(now, candidate.runId);
        return { status: "lost_race" as const };
      }

      const run = loadRunRow(candidate.runId);
      if (run) {
        updateTaskStatus(run.taskId, taskStatusForRunStatus("running"), now);
      }

      return { status: "claimed" as const, sliceId: candidate.sliceId, runId: candidate.runId };
    })(input);

    if (claimed.status !== "claimed") {
      return claimed;
    }

    const [run, slices] = await Promise.all([
      options.runStore.loadRunById(claimed.runId),
      options.sliceStore.listSlicesByRun(claimed.runId)
    ]);
    const slice = slices.find((item) => item.sliceId === claimed.sliceId);
    if (!run || !slice) {
      throw new Error(`claimed slice ${claimed.sliceId} for run ${claimed.runId} disappeared`);
    }

    return {
      status: "claimed" as const,
      run,
      slice
    };
  }

  async function executeClaimedSlice(input: ClaimedSlice) {
    const request = reconstructTurnRequest(input.run);
    const triggerKind = input.slice.triggerKind;

    if (triggerKind === "approval_resume") {
      if (options.resolveApprovalSlice) {
        return {
          request,
          turnResult: await options.resolveApprovalSlice(input)
        };
      }

      return {
        request,
        turnResult: createMissingContinuationHandlerResult({
          request,
          run: input.run,
          continuationKind: "approval_resume",
          requiredHandler: "resolveApprovalSlice"
        })
      };
    }

    if (triggerKind === "auto_continue" || triggerKind === "user_resume" || triggerKind === "operator_resume") {
      if (options.continueSlice) {
        return {
          request,
          turnResult: await options.continueSlice(input)
        };
      }

      return {
        request,
        turnResult: createMissingContinuationHandlerResult({
          request,
          run: input.run,
          continuationKind: triggerKind,
          requiredHandler: "continueSlice"
        })
      };
    }

    if (triggerKind === "recovery_retry") {
      if (await hasRecoverableRecoveryContinuation(input, options.sessionStore)) {
        if (options.continueSlice) {
          return {
            request,
            turnResult: await options.continueSlice(input)
          };
        }

        return {
          request,
          turnResult: createMissingContinuationHandlerResult({
            request,
            run: input.run,
            continuationKind: "recovery_retry",
            requiredHandler: "continueSlice"
          })
        };
      }

      return {
        request,
        turnResult: await options.executeTurnSlice(request, input)
      };
    }

    return {
      request,
      turnResult: await options.executeTurnSlice(request, input)
    };
  }

  async function persistRunningSliceContinuationPayload(input: {
    runId: string;
    sliceId: string;
    continuationPayload: unknown;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    db.transaction(() => {
      const sliceChanges = db.prepare(`
        UPDATE runtime_slices
        SET continuation_payload_json = ?,
            updated_at = ?
        WHERE slice_id = ? AND run_id = ? AND status = 'running'
      `).run(
        maybeJson(input.continuationPayload),
        now,
        input.sliceId,
        input.runId
      ).changes;

      if (sliceChanges !== 1) {
        throw new Error(`slice ${input.sliceId} is not running`);
      }

      const runChanges = db.prepare(`
        UPDATE task_runs
        SET continuation_payload_json = ?,
            continuation_updated_at = ?,
            updated_at = ?
        WHERE run_id = ?
      `).run(
        maybeJson(input.continuationPayload),
        now,
        now,
        input.runId
      ).changes;

      if (runChanges !== 1) {
        throw new Error(`run ${input.runId} not found while persisting continuation payload`);
      }
    })();

    const [run, slices] = await Promise.all([
      options.runStore.loadRunById(input.runId),
      options.sliceStore.listSlicesByRun(input.runId)
    ]);
    if (!run) {
      throw new Error(`run ${input.runId} disappeared after persisting continuation payload`);
    }
    return {
      run,
      slice: slices.find((slice) => slice.sliceId === input.sliceId)
    };
  }

  function defaultDecision(input: {
    run: ClaimedRun;
    terminalStatus: FinalizeSliceInput["result"]["terminalStatus"];
    continuation?: LifecycleContinuation;
    pendingControls: Awaited<ReturnType<ControlStore["listPendingControls"]>>;
  }): BoundaryDecisionResult {
    if (input.terminalStatus === "completed") {
      return { decision: "stop", runStatus: "completed" };
    }
    if (input.terminalStatus === "failed") {
      return { decision: "stop", runStatus: "failed" };
    }
    if (input.terminalStatus === "canceled" || input.run.cancelRequestedAt || input.pendingControls.some((control) => control.kind === "cancel")) {
      return { decision: "stop", runStatus: "canceled" };
    }
    if (input.terminalStatus === "blocked") {
      return { decision: "block", runStatus: "blocked" };
    }
    if (input.terminalStatus === "yielded" && input.continuation) {
      return { decision: "continue", runStatus: "queued" };
    }
    return { decision: "stop", runStatus: "failed" };
  }

  async function finalizeSliceResult(input: FinalizeSliceInput) {
    const now = input.now ?? new Date().toISOString();
    const runBefore = await options.runStore.loadRunById(input.runId);
    if (!runBefore) {
      throw new Error(`run ${input.runId} not found`);
    }

    const continuationPayload = input.result.continuation?.payload;
    let clearTransientInflight = false;
    let clearDetachedTerminalInflight = false;
    let detachedTerminalRunStatus: "completed" | "failed" | "canceled" | null = null;

    const tx = db.transaction(() => {
      const runRow = loadRunRow(input.runId);
      if (!runRow) {
        throw new Error(`run ${input.runId} not found during finalization`);
      }

      const sliceChanges = db.prepare(`
        UPDATE runtime_slices
        SET status = ?,
            tool_loop_summary_json = ?,
            usage_summary_json = ?,
            continuation_payload_json = ?,
            result_summary = ?,
            error_json = ?,
            finished_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE slice_id = ? AND status = 'running'
      `).run(
        input.result.terminalStatus,
        maybeJson(input.result.toolLoopSummary),
        maybeJson(input.result.usageSummary),
        maybeJson(continuationPayload),
        input.result.resultSummary ?? null,
        maybeJson(input.result.error),
        now,
        now,
        input.sliceId
      ).changes;
      if (sliceChanges !== 1) {
        throw new Error(`slice ${input.sliceId} is not running`);
      }

      const pendingControls = loadPendingControlsRow(input.runId);
      const lastControlSeq = pendingControls.at(-1)?.controlSeq;
      const newestHumanControl = [...pendingControls]
        .filter((control) => control.kind === "steer" || control.kind === "follow_up" || control.kind === "continue")
        .sort((left, right) => left.controlSeq - right.controlSeq)
        .at(-1);
      const newestSteerControl = [...pendingControls]
        .filter((control) => control.kind === "steer")
        .sort((left, right) => left.controlSeq - right.controlSeq)
        .at(-1);
      const cancelControl = pendingControls.find((control) => control.kind === "cancel");
      const refreshedByHuman = newestHumanControl?.createdAt;
      const cumulativeInputTokens = runRow.cumulativeInputTokens + (input.result.usageSummary?.inputTokens ?? 0);
      const cumulativeOutputTokens = runRow.cumulativeOutputTokens + (input.result.usageSummary?.outputTokens ?? 0);
      const cumulativeTotalTokens = runRow.cumulativeTotalTokens + (input.result.usageSummary?.totalTokens ?? 0);
      const cumulativeEstimatedCost = runRow.cumulativeEstimatedCost + (input.result.usageSummary?.estimatedCost ?? 0);
      const autonomyWindowSliceCount = (refreshedByHuman ? 0 : runRow.autonomyWindowSliceCount) + 1;
      const autonomyWindowToolCallCount = (refreshedByHuman ? 0 : runRow.autonomyWindowToolCallCount) + (input.result.usageSummary?.toolCallCount ?? 0);
      const foregroundBurstSliceCount = input.lane === "foreground"
        ? (refreshedByHuman ? 0 : runRow.foregroundBurstSliceCount) + 1
        : runRow.foregroundBurstSliceCount;
      const foregroundBurstStartedAt = input.lane === "foreground"
        ? (runRow.foregroundBurstStartedAt ?? now)
        : runRow.foregroundBurstStartedAt;
      const cancelRequestedAt = cancelControl?.createdAt ?? runRow.cancelRequestedAt;
      const cancelReason = cancelControl?.payload && typeof cancelControl.payload === "object" && !Array.isArray(cancelControl.payload)
        ? (cancelControl.payload as { reason?: string }).reason ?? runRow.cancelReason
        : runRow.cancelReason;

      const runForDecision = {
        ...runBefore,
        cancelRequestedAt: cancelRequestedAt ?? undefined,
        cancelRequestedBy: runRow.cancelRequestedBy ?? undefined,
        cancelReason: cancelReason ?? undefined,
        continuationKind: input.result.continuation?.kind ?? runBefore.continuationKind,
        continuationPayload: continuationPayload ?? runBefore.continuationPayload,
        continuationUpdatedAt: now,
        pendingApprovalRef: input.result.continuation?.pendingApprovalRef ?? runRow.pendingApprovalRef ?? undefined,
        pendingControlRef: input.result.continuation?.pendingControlRef ?? runRow.pendingControlRef ?? undefined,
        resultSummary: input.result.resultSummary ?? runBefore.resultSummary,
        error: input.result.error ?? runBefore.error,
        cumulativeInputTokens,
        cumulativeOutputTokens,
        cumulativeTotalTokens,
        cumulativeEstimatedCost,
        autonomyWindowSliceCount,
        autonomyWindowToolCallCount,
        foregroundBurstSliceCount,
        foregroundBurstStartedAt: foregroundBurstStartedAt ?? undefined,
        lastHumanInputAt: newestHumanControl?.createdAt ?? runRow.lastHumanInputAt ?? undefined,
        runStartedAt: runRow.runStartedAt ?? runBefore.runStartedAt,
        updatedAt: now
      } satisfies ClaimedRun;

      const decision = options.decideNextAction?.({
        run: runForDecision,
        lane: input.lane,
        terminalStatus: input.result.terminalStatus,
        continuation: input.result.continuation,
        pendingControls,
        usageSummary: input.result.usageSummary
      }) ?? defaultDecision({
        run: runForDecision,
        terminalStatus: input.result.terminalStatus,
        continuation: input.result.continuation,
        pendingControls
      });
      const stopAsCanceled = decision.decision === "stop" && decision.runStatus === "canceled";

      const shouldPromoteToForeground = runRow.attentionMode === "background_detached"
        && newestSteerControl !== undefined
        && decision.decision === "continue";

      let nextSliceId: string | undefined;
      if (decision.decision === "continue" || decision.decision === "detach") {
        const triggerKind = input.result.continuation?.kind ?? "auto_continue";
        nextSliceId = insertQueuedSlice({
          runId: input.runId,
          taskId: input.taskId,
          triggerKind,
          lane: decision.decision === "detach"
            ? "background"
            : shouldPromoteToForeground
              ? "foreground"
              : input.lane,
          continuationPayload,
          createdAt: now
        });
      }

      const nextRunStatus = decision.runStatus
        ?? (decision.decision === "block" ? "blocked" : decision.decision === "stop" ? "failed" : "queued");
      const nextAttentionMode = nextRunStatus === "queued"
        ? decision.decision === "detach"
          ? "background_detached"
          : shouldPromoteToForeground
            ? "foreground_attached"
            : runRow.attentionMode
        : runRow.attentionMode;
      const taskStatus = taskStatusForRunStatus(nextRunStatus);
      clearTransientInflight = runRow.attentionMode === "background_detached"
        && input.result.terminalStatus === "yielded"
        && (decision.decision === "continue" || decision.decision === "detach");
      clearDetachedTerminalInflight = runRow.attentionMode === "background_detached"
        && (nextRunStatus === "completed" || nextRunStatus === "failed" || nextRunStatus === "canceled");
      detachedTerminalRunStatus = nextRunStatus === "completed" || nextRunStatus === "failed" || nextRunStatus === "canceled"
        ? nextRunStatus
        : null;
      const consumeRecoveryTruth = clearTransientInflight && continuationPayload !== undefined;
      const recoveryTruthState = runRow.attentionMode === "background_detached"
        ? nextRunStatus === "blocked"
          ? null
          : clearDetachedTerminalInflight
            ? "closed"
            : consumeRecoveryTruth
              ? "consumed"
              : runRow.recoveryTruthState
        : runRow.recoveryTruthState;
      const recoveryTruthUpdatedAt = runRow.attentionMode === "background_detached"
        && (nextRunStatus === "blocked" || clearDetachedTerminalInflight || consumeRecoveryTruth)
        ? now
        : runRow.recoveryTruthUpdatedAt;

      db.prepare(`
        UPDATE task_runs
        SET status = ?,
            worker_id = NULL,
            claimed_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            cancel_requested_at = COALESCE(cancel_requested_at, ?),
            cancel_requested_by = COALESCE(cancel_requested_by, ?),
            cancel_reason = COALESCE(cancel_reason, ?),
            cancel_observed_slice_id = CASE WHEN ? THEN ? ELSE cancel_observed_slice_id END,
            continuation_kind = ?,
            continuation_payload_json = ?,
            continuation_updated_at = ?,
            attention_mode = ?,
            recovery_truth_state = ?,
            recovery_truth_updated_at = ?,
            pending_approval_ref = ?,
            pending_control_ref = ?,
            result_summary = COALESCE(?, result_summary),
            error_json = COALESCE(?, error_json),
            cumulative_input_tokens = ?,
            cumulative_output_tokens = ?,
            cumulative_total_tokens = ?,
            cumulative_estimated_cost = ?,
            autonomy_window_slice_count = ?,
            autonomy_window_tool_call_count = ?,
            foreground_burst_slice_count = ?,
            foreground_burst_started_at = ?,
            last_human_input_at = ?,
            finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE run_id = ?
      `).run(
        nextRunStatus,
        cancelRequestedAt ?? null,
        runRow.cancelRequestedBy,
        cancelReason ?? null,
        stopAsCanceled ? 1 : 0,
        stopAsCanceled ? input.sliceId : null,
        decision.decision === "stop" ? null : input.result.continuation?.kind ?? null,
        decision.decision === "stop" ? null : maybeJson(continuationPayload),
        decision.decision === "stop" ? null : now,
        nextAttentionMode,
        recoveryTruthState,
        recoveryTruthUpdatedAt,
        decision.decision === "block" ? input.result.continuation?.pendingApprovalRef ?? runRow.pendingApprovalRef : null,
        decision.decision === "block" || decision.decision === "continue" || decision.decision === "detach"
          ? input.result.continuation?.pendingControlRef ?? null
          : null,
        input.result.resultSummary ?? null,
        maybeJson(input.result.error),
        cumulativeInputTokens,
        cumulativeOutputTokens,
        cumulativeTotalTokens,
        cumulativeEstimatedCost,
        autonomyWindowSliceCount,
        autonomyWindowToolCallCount,
        foregroundBurstSliceCount,
        foregroundBurstStartedAt ?? null,
        newestHumanControl?.createdAt ?? runRow.lastHumanInputAt,
        nextRunStatus === "completed" || nextRunStatus === "failed" || nextRunStatus === "canceled" ? 1 : 0,
        now,
        runRow.runStartedAt ?? now,
        now,
        input.runId
      );

      updateTaskStatus(input.taskId, taskStatus, now, input.result.continuation?.blockedBy);

      if (lastControlSeq !== undefined) {
        db.prepare(`
          UPDATE run_control_inputs
          SET applied_slice_id = ?, applied_at = ?
          WHERE run_id = ? AND applied_slice_id IS NULL AND control_seq <= ?
        `).run(
          nextSliceId
            ?? (decision.decision === "block"
              ? `boundary:${input.sliceId}:blocked`
              : `terminal:${input.runId}:${nextRunStatus}`),
          now,
          input.runId,
          lastControlSeq
        );
      }

      return nextSliceId;
    });

    const nextSliceId = tx();
    if (clearTransientInflight) {
      await options.sessionStore?.finalize?.({
        turnId: input.runId,
        sessionId: runBefore.sessionId,
        status: "interrupted"
      });
    }
    if (clearDetachedTerminalInflight && detachedTerminalRunStatus) {
      await options.sessionStore?.finalize?.({
        turnId: input.runId,
        sessionId: runBefore.sessionId,
        status: detachedRecoveryFinalizeStatus(detachedTerminalRunStatus)
      });
    }
    const [run, slices] = await Promise.all([
      options.runStore.loadRunById(input.runId),
      options.sliceStore.listSlicesByRun(input.runId)
    ]);
    if (!run) {
      throw new Error(`run ${input.runId} disappeared after finalization`);
    }
    return {
      run,
      slice: slices.find((slice) => slice.sliceId === input.sliceId),
      nextSlice: nextSliceId ? slices.find((slice) => slice.sliceId === nextSliceId) : undefined
    };
  }

  async function scheduleNextSliceIfNeeded(input: {
    runId: string;
    taskId: string;
    triggerKind: Exclude<SliceTriggerKind, "initial" | "legacy_cutover">;
    lane: SliceLane;
    continuationPayload?: unknown;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const tx = db.transaction(() => {
      const run = loadRunRow(input.runId);
      if (!run) {
        throw new Error(`run ${input.runId} not found while scheduling next slice`);
      }
      const normalizedStatus = normalizeLegacyTaskRunStatus(run.status as never);
      if (normalizedStatus === "completed" || normalizedStatus === "failed" || normalizedStatus === "canceled") {
        return undefined;
      }

      const openSlice = db.prepare(`
        SELECT slice_id as sliceId
        FROM runtime_slices
        WHERE run_id = ? AND status IN ('queued', 'running')
        LIMIT 1
      `).get(input.runId) as { sliceId: string } | undefined;
      if (openSlice) {
        throw new Error(`run ${input.runId} already has an open slice`);
      }

      const nextSliceId = insertQueuedSlice({
        runId: input.runId,
        taskId: input.taskId,
        triggerKind: input.triggerKind,
        lane: input.lane,
        continuationPayload: input.continuationPayload,
        createdAt: now
      });

      const nextRunStatus = "queued" as const;
      const consumeRecoveryTruth = run.attentionMode === "background_detached" && input.continuationPayload !== undefined;
      db.prepare(`
        UPDATE task_runs
        SET status = ?,
            worker_id = NULL,
            claimed_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            continuation_kind = ?,
            continuation_payload_json = ?,
            continuation_updated_at = ?,
            recovery_truth_state = ?,
            recovery_truth_updated_at = ?,
            pending_approval_ref = NULL,
            pending_control_ref = NULL,
            updated_at = ?
        WHERE run_id = ? AND status IN ('blocked', 'queued')
      `).run(
        nextRunStatus,
        input.triggerKind,
        maybeJson(input.continuationPayload),
        now,
        consumeRecoveryTruth ? "consumed" : run.recoveryTruthState,
        consumeRecoveryTruth ? now : run.recoveryTruthUpdatedAt,
        now,
        input.runId
      );

      updateTaskStatus(input.taskId, taskStatusForRunStatus(nextRunStatus), now);
      return nextSliceId;
    });
    const nextSliceId = tx();
    if (!nextSliceId) {
      return undefined;
    }
    const slices = await options.sliceStore.listSlicesByRun(input.runId);
    return slices.find((slice) => slice.sliceId === nextSliceId);
  }

  async function transitionBlockedRunToQueuedSlice(input: {
    sessionId: string;
    taskId: string;
    runId: string;
    attentionMode?: "foreground_attached" | "background_detached";
    triggerKind: Extract<SliceTriggerKind, "approval_resume" | "operator_resume" | "user_resume" | "recovery_retry">;
    lane: SliceLane;
    control?: {
      controlId?: string;
      kind: "steer" | "follow_up" | "continue" | "cancel";
      payload?: unknown;
    };
    continuationPayload?: unknown;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const tx = db.transaction(() => {
      const run = loadRunRow(input.runId);
      if (!run) {
        throw new Error(`run ${input.runId} not found while transitioning blocked run`);
      }

      const openSliceRow = db.prepare(`
        SELECT slice_id as sliceId, status
        FROM runtime_slices
        WHERE run_id = ? AND status IN ('queued', 'running')
        ORDER BY slice_no ASC, created_at ASC, slice_id ASC
        LIMIT 1
      `).get(input.runId) as { sliceId: string; status: "queued" | "running" } | undefined;

      const normalizedStatus = normalizeLegacyTaskRunStatus(run.status as never);
      if (normalizedStatus === "completed" || normalizedStatus === "failed" || normalizedStatus === "canceled") {
        return { status: "not_runnable" as const, sliceId: undefined };
      }

      if (normalizedStatus === "queued" || normalizedStatus === "running") {
        if (!openSliceRow) {
          throw new Error(`run ${input.runId} is ${normalizedStatus} without an open slice`);
        }
        return {
          status: openSliceRow.status === "running" ? "already_running" as const : "already_queued" as const,
          sliceId: openSliceRow.sliceId
        };
      }

      if (normalizedStatus !== "blocked") {
        throw new Error(`run ${input.runId} must be blocked before transitioning to ${input.triggerKind}`);
      }
      if (openSliceRow) {
        throw new Error(`blocked run ${input.runId} already has an open slice`);
      }

      const consumeRecoveryTruth = run.attentionMode === "background_detached" && input.continuationPayload !== undefined;
      const queuedRunChanges = db.prepare(`
        UPDATE task_runs
        SET status = 'queued',
            worker_id = NULL,
            claimed_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            continuation_kind = ?,
            continuation_payload_json = ?,
            continuation_updated_at = ?,
            recovery_truth_state = ?,
            recovery_truth_updated_at = ?,
            pending_approval_ref = NULL,
            pending_control_ref = NULL,
            updated_at = ?
        WHERE run_id = ? AND status = 'blocked'
      `).run(
        input.triggerKind,
        maybeJson(input.continuationPayload),
        now,
        consumeRecoveryTruth ? "consumed" : run.recoveryTruthState,
        consumeRecoveryTruth ? now : run.recoveryTruthUpdatedAt,
        now,
        input.runId
      ).changes;

      if (queuedRunChanges === 0) {
        const refreshedRun = loadRunRow(input.runId);
        if (!refreshedRun) {
          throw new Error(`run ${input.runId} disappeared while transitioning blocked run`);
        }
        const refreshedOpenSliceRow = db.prepare(`
          SELECT slice_id as sliceId, status
          FROM runtime_slices
          WHERE run_id = ? AND status IN ('queued', 'running')
          ORDER BY slice_no ASC, created_at ASC, slice_id ASC
          LIMIT 1
        `).get(input.runId) as { sliceId: string; status: "queued" | "running" } | undefined;
        const refreshedStatus = normalizeLegacyTaskRunStatus(refreshedRun.status as never);
        if (refreshedStatus === "queued" || refreshedStatus === "running") {
          return {
            status: refreshedOpenSliceRow?.status === "running" ? "already_running" as const : refreshedOpenSliceRow ? "already_queued" as const : "not_runnable" as const,
            sliceId: refreshedOpenSliceRow?.sliceId
          };
        }
        return { status: "not_runnable" as const, sliceId: undefined };
      }

      if (input.control) {
        const controlId = input.control.controlId ?? `control_${randomUUID()}`;
        db.prepare(`
          INSERT INTO run_control_inputs (
            control_id,
            task_id,
            run_id,
            kind,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(control_id) DO NOTHING
        `).run(
          controlId,
          input.taskId,
          input.runId,
          input.control.kind,
          maybeJson(input.control.payload),
          now
        );

        if (input.control.kind === "cancel") {
          const cancelMetadata = readCancelControlMetadata(input.control.payload);
          db.prepare(`
            UPDATE task_runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
                cancel_requested_by = COALESCE(cancel_requested_by, ?),
                cancel_reason = COALESCE(cancel_reason, ?),
                updated_at = ?
            WHERE run_id = ?
          `).run(
            now,
            cancelMetadata.requestedBy ?? null,
            cancelMetadata.reason ?? null,
            now,
            input.runId
          );
        }
      }

      const nextSliceId = insertQueuedSlice({
        runId: input.runId,
        taskId: input.taskId,
        triggerKind: input.triggerKind,
        lane: input.lane,
        continuationPayload: input.continuationPayload,
        createdAt: now
      });

      updateTaskStatus(input.taskId, taskStatusForRunStatus("queued"), now);
      return { status: "queued" as const, sliceId: nextSliceId };
    });

    const transitioned = tx();

    if (input.attentionMode === "background_detached" && transitioned.status === "queued") {
      await options.sessionStore?.finalize?.({
        turnId: input.runId,
        sessionId: input.sessionId,
        status: "interrupted"
      });
    }

    if (input.attentionMode === "foreground_attached") {
      await options.sessionStore?.setFocusRun?.({
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        now
      });
    } else if (input.attentionMode === "background_detached") {
      const focus = await options.sessionStore?.loadFocusRun?.(input.sessionId);
      if (focus?.runId === input.runId) {
        await options.sessionStore?.clearFocusRun?.({
          sessionId: input.sessionId,
          now
        });
      }
    }

    if (!transitioned.sliceId) {
      return {
        status: transitioned.status,
        slice: undefined
      };
    }

    const slices = await options.sliceStore.listSlicesByRun(input.runId);
    return {
      status: transitioned.status,
      slice: slices.find((slice) => slice.sliceId === transitioned.sliceId)
    };
  }

  async function cancelDetachedRun(input: {
    sessionId: string;
    taskId: string;
    runId: string;
    attentionMode?: "foreground_attached" | "background_detached";
    reason?: string;
    requestedBy?: string;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const outcome = db.transaction(() => {
      const run = loadRunRow(input.runId);
      if (!run) {
        throw new Error(`run ${input.runId} not found while canceling detached run`);
      }

      const normalizedStatus = normalizeLegacyTaskRunStatus(run.status as never);
      if (normalizedStatus === "completed" || normalizedStatus === "failed" || normalizedStatus === "canceled") {
        return { status: "not_runnable" as const };
      }

      const openSliceRow = db.prepare(`
        SELECT slice_id as sliceId, status
        FROM runtime_slices
        WHERE run_id = ? AND status IN ('queued', 'running')
        ORDER BY slice_no ASC, created_at ASC, slice_id ASC
        LIMIT 1
      `).get(input.runId) as { sliceId: string; status: "queued" | "running" } | undefined;

      if (!openSliceRow) {
        throw new Error(`run ${input.runId} is ${normalizedStatus} without an open slice.`);
      }

      const cancelPayload = {
        reason: input.reason,
        requestedBy: input.requestedBy
      };

      if (normalizedStatus === "queued") {
        const controlId = run.cancelRequestedAt ? undefined : `control_${randomUUID()}`;
        if (controlId) {
          db.prepare(`
            INSERT INTO run_control_inputs (
              control_id,
              task_id,
              run_id,
              kind,
              payload_json,
              created_at
            ) VALUES (?, ?, ?, 'cancel', ?, ?)
          `).run(
            controlId,
            input.taskId,
            input.runId,
            maybeJson(cancelPayload),
            now
          );
        }

        const canceledSliceChanges = db.prepare(`
          UPDATE runtime_slices
          SET status = 'canceled',
              result_summary = COALESCE(?, result_summary),
              finished_at = COALESCE(finished_at, ?),
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE slice_id = ? AND status = 'queued'
        `).run(
          input.reason ?? "cancelled",
          now,
          now,
          openSliceRow.sliceId
        ).changes;

        const canceledRunChanges = canceledSliceChanges > 0
          ? db.prepare(`
            UPDATE task_runs
            SET status = 'canceled',
                worker_id = NULL,
                claimed_at = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                cancel_requested_at = COALESCE(cancel_requested_at, ?),
                cancel_requested_by = COALESCE(cancel_requested_by, ?),
                cancel_reason = COALESCE(cancel_reason, ?),
                cancel_observed_slice_id = COALESCE(cancel_observed_slice_id, ?),
                continuation_kind = NULL,
                continuation_payload_json = NULL,
                continuation_updated_at = NULL,
                recovery_truth_state = ?,
                recovery_truth_updated_at = ?,
                pending_approval_ref = NULL,
                pending_control_ref = NULL,
                result_summary = COALESCE(?, result_summary),
                finished_at = COALESCE(finished_at, ?),
                updated_at = ?
            WHERE run_id = ? AND status = 'queued'
          `).run(
            now,
            input.requestedBy ?? null,
            input.reason ?? null,
            openSliceRow.sliceId,
            run.attentionMode === "background_detached" ? "closed" : run.recoveryTruthState,
            run.attentionMode === "background_detached" ? now : run.recoveryTruthUpdatedAt,
            input.reason ?? null,
            now,
            now,
            input.runId
          ).changes
          : 0;

        if (canceledSliceChanges > 0 && canceledRunChanges > 0) {
          db.prepare(`
            UPDATE run_control_inputs
            SET applied_slice_id = ?, applied_at = ?
            WHERE run_id = ? AND applied_slice_id IS NULL
          `).run(`terminal:${input.runId}:canceled`, now, input.runId);

          updateTaskStatus(input.taskId, taskStatusForRunStatus("canceled"), now);
          return { status: "canceled" as const };
        }

        const refreshedRun = loadRunRow(input.runId);
        if (!refreshedRun) {
          throw new Error(`run ${input.runId} disappeared while canceling detached run`);
        }
        const refreshedStatus = normalizeLegacyTaskRunStatus(refreshedRun.status as never);
        if (refreshedStatus === "completed" || refreshedStatus === "failed" || refreshedStatus === "canceled") {
          if (controlId) {
            db.prepare(`
              DELETE FROM run_control_inputs
              WHERE control_id = ? AND applied_slice_id IS NULL
            `).run(controlId);
          }
          return { status: "not_runnable" as const };
        }

        const refreshedOpenSliceRow = db.prepare(`
          SELECT slice_id as sliceId, status
          FROM runtime_slices
          WHERE run_id = ? AND status IN ('queued', 'running')
          ORDER BY slice_no ASC, created_at ASC, slice_id ASC
          LIMIT 1
        `).get(input.runId) as { sliceId: string; status: "queued" | "running" } | undefined;
        if (!refreshedOpenSliceRow) {
          throw new Error(`run ${input.runId} is ${refreshedStatus} without an open slice.`);
        }

        db.prepare(`
          UPDATE task_runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
              cancel_requested_by = COALESCE(cancel_requested_by, ?),
              cancel_reason = COALESCE(cancel_reason, ?),
              recovery_truth_state = ?,
              recovery_truth_updated_at = ?,
              updated_at = ?
          WHERE run_id = ? AND status IN ('queued', 'running')
        `).run(
          now,
          input.requestedBy ?? null,
          input.reason ?? null,
          refreshedRun.attentionMode === "background_detached" ? "closed" : refreshedRun.recoveryTruthState,
          refreshedRun.attentionMode === "background_detached" ? now : refreshedRun.recoveryTruthUpdatedAt,
          now,
          input.runId
        );

        return { status: "cancel_requested" as const };
      }

      if (normalizedStatus !== "running") {
        throw new Error(`run ${input.runId} must be queued or running before detached cancellation`);
      }

      if (!run.cancelRequestedAt) {
        db.prepare(`
          INSERT INTO run_control_inputs (
            control_id,
            task_id,
            run_id,
            kind,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, 'cancel', ?, ?)
        `).run(
          `control_${randomUUID()}`,
          input.taskId,
          input.runId,
          maybeJson(cancelPayload),
          now
        );

        db.prepare(`
          UPDATE task_runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
              cancel_requested_by = COALESCE(cancel_requested_by, ?),
              cancel_reason = COALESCE(cancel_reason, ?),
              recovery_truth_state = ?,
              recovery_truth_updated_at = ?,
              updated_at = ?
          WHERE run_id = ? AND status = 'running'
        `).run(
          now,
          input.requestedBy ?? null,
          input.reason ?? null,
          run.attentionMode === "background_detached" ? "closed" : run.recoveryTruthState,
          run.attentionMode === "background_detached" ? now : run.recoveryTruthUpdatedAt,
          now,
          input.runId
        );
      }

      return { status: "cancel_requested" as const };
    })();

    if (input.attentionMode === "foreground_attached") {
      if (outcome.status === "canceled") {
        await options.sessionStore?.finalize?.({
          turnId: input.runId,
          sessionId: input.sessionId,
          status: "interrupted"
        });
      }
      await options.sessionStore?.clearFocusRun?.({
        sessionId: input.sessionId,
        now
      });
    } else if (input.attentionMode === "background_detached") {
      if (outcome.status === "canceled") {
        await options.sessionStore?.finalize?.({
          turnId: input.runId,
          sessionId: input.sessionId,
          status: "interrupted"
        });
      }
      const focus = await options.sessionStore?.loadFocusRun?.(input.sessionId);
      if (focus?.runId === input.runId) {
        await options.sessionStore?.clearFocusRun?.({
          sessionId: input.sessionId,
          now
        });
      }
    }

    return outcome;
  }

  async function closeBlockedRunTerminally(input: {
    sessionId: string;
    taskId: string;
    runId: string;
    attentionMode?: "foreground_attached" | "background_detached";
    terminalStatus: "failed" | "canceled";
    resultSummary?: string;
    error?: unknown;
    cancel?: {
      requestedAt?: string;
      requestedBy?: string;
      reason?: string;
    };
    control?: {
      controlId?: string;
      kind: "cancel";
      payload?: unknown;
    };
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();
    const tx = db.transaction(() => {
      const run = loadRunRow(input.runId);
      if (!run) {
        throw new Error(`run ${input.runId} not found while closing blocked run`);
      }

      const normalizedStatus = normalizeLegacyTaskRunStatus(run.status as never);
      if (normalizedStatus === "completed" || normalizedStatus === "failed" || normalizedStatus === "canceled") {
        return { status: "not_runnable" as const };
      }
      if (normalizedStatus !== "blocked") {
        throw new Error(`run ${input.runId} must be blocked before closing terminally`);
      }

      const openSlice = db.prepare(`
        SELECT slice_id as sliceId
        FROM runtime_slices
        WHERE run_id = ? AND status IN ('queued', 'running')
        LIMIT 1
      `).get(input.runId) as { sliceId: string } | undefined;
      if (openSlice) {
        throw new Error(`blocked run ${input.runId} already has an open slice`);
      }

      const controlId = input.control
        ? input.control.controlId ?? `control_${randomUUID()}`
        : undefined;

      const closedRunChanges = db.prepare(`
        UPDATE task_runs
        SET status = ?,
            worker_id = NULL,
            claimed_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            cancel_requested_at = CASE WHEN ? THEN COALESCE(cancel_requested_at, ?) ELSE cancel_requested_at END,
            cancel_requested_by = CASE WHEN ? THEN COALESCE(cancel_requested_by, ?) ELSE cancel_requested_by END,
            cancel_reason = CASE WHEN ? THEN COALESCE(cancel_reason, ?) ELSE cancel_reason END,
            cancel_observed_slice_id = CASE WHEN ? THEN COALESCE(cancel_observed_slice_id, ?) ELSE cancel_observed_slice_id END,
            continuation_kind = NULL,
            continuation_payload_json = NULL,
            continuation_updated_at = NULL,
            recovery_truth_state = ?,
            recovery_truth_updated_at = ?,
            pending_approval_ref = NULL,
            pending_control_ref = NULL,
            result_summary = COALESCE(?, result_summary),
            error_json = COALESCE(?, error_json),
            finished_at = COALESCE(finished_at, ?),
            updated_at = ?
        WHERE run_id = ? AND status = 'blocked'
      `).run(
        input.terminalStatus,
        input.terminalStatus === "canceled" ? 1 : 0,
        input.cancel?.requestedAt ?? now,
        input.terminalStatus === "canceled" ? 1 : 0,
        input.cancel?.requestedBy ?? null,
        input.terminalStatus === "canceled" ? 1 : 0,
        input.cancel?.reason ?? null,
        input.terminalStatus === "canceled" ? 1 : 0,
        `terminal:${input.runId}:canceled`,
        run.attentionMode === "background_detached" ? "closed" : run.recoveryTruthState,
        run.attentionMode === "background_detached" ? now : run.recoveryTruthUpdatedAt,
        input.resultSummary ?? null,
        maybeJson(input.error),
        now,
        now,
        input.runId
      ).changes;

      if (closedRunChanges === 0) {
        const refreshedRun = loadRunRow(input.runId);
        if (!refreshedRun) {
          throw new Error(`run ${input.runId} disappeared while closing blocked run`);
        }
        const refreshedStatus = normalizeLegacyTaskRunStatus(refreshedRun.status as never);
        if (input.terminalStatus === "canceled" && (refreshedStatus === "queued" || refreshedStatus === "running")) {
          const refreshedOpenSlice = db.prepare(`
            SELECT slice_id as sliceId, status
            FROM runtime_slices
            WHERE run_id = ? AND status IN ('queued', 'running')
            ORDER BY slice_no ASC, created_at ASC, slice_id ASC
            LIMIT 1
          `).get(input.runId) as { sliceId: string; status: "queued" | "running" } | undefined;
          if (!refreshedOpenSlice) {
            throw new Error(`run ${input.runId} is ${refreshedStatus} without an open slice`);
          }

          if (input.control && controlId) {
            db.prepare(`
              INSERT INTO run_control_inputs (
                control_id,
                task_id,
                run_id,
                kind,
                payload_json,
                created_at
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(control_id) DO NOTHING
            `).run(
              controlId,
              input.taskId,
              input.runId,
              input.control.kind,
              maybeJson(input.control.payload),
              now
            );
          }

          db.prepare(`
            UPDATE task_runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
                cancel_requested_by = COALESCE(cancel_requested_by, ?),
                cancel_reason = COALESCE(cancel_reason, ?),
                recovery_truth_state = ?,
                recovery_truth_updated_at = ?,
                updated_at = ?
            WHERE run_id = ? AND status IN ('queued', 'running')
          `).run(
            input.cancel?.requestedAt ?? now,
            input.cancel?.requestedBy ?? null,
            input.cancel?.reason ?? null,
            refreshedRun.attentionMode === "background_detached" ? "closed" : refreshedRun.recoveryTruthState,
            refreshedRun.attentionMode === "background_detached" ? now : refreshedRun.recoveryTruthUpdatedAt,
            now,
            input.runId
          );
        }

        return { status: "not_runnable" as const };
      }

      if (input.control && controlId) {
        db.prepare(`
          INSERT INTO run_control_inputs (
            control_id,
            task_id,
            run_id,
            kind,
            payload_json,
            created_at,
            applied_slice_id,
            applied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          controlId,
          input.taskId,
          input.runId,
          input.control.kind,
          maybeJson(input.control.payload),
          now,
          `terminal:${input.runId}:${input.terminalStatus}`,
          now
        );
      }

      db.prepare(`
        UPDATE run_control_inputs
        SET applied_slice_id = ?, applied_at = ?
        WHERE run_id = ? AND applied_slice_id IS NULL
      `).run(`terminal:${input.runId}:${input.terminalStatus}`, now, input.runId);

      updateTaskStatus(input.taskId, taskStatusForRunStatus(input.terminalStatus), now);
      return { status: "closed" as const };
    });

    const closed = tx();

    if (input.attentionMode === "foreground_attached") {
      await options.sessionStore?.clearFocusRun?.({
        sessionId: input.sessionId,
        now
      });
    } else if (input.attentionMode === "background_detached") {
      if (closed.status === "closed") {
        await options.sessionStore?.finalize?.({
          turnId: input.runId,
          sessionId: input.sessionId,
          status: detachedRecoveryFinalizeStatus(input.terminalStatus)
        });
      }
      const focus = await options.sessionStore?.loadFocusRun?.(input.sessionId);
      if (focus?.runId === input.runId) {
        await options.sessionStore?.clearFocusRun?.({
          sessionId: input.sessionId,
          now
        });
      }
    }

    if (closed.status !== "closed") {
      return undefined;
    }

    return options.runStore.loadRunById(input.runId);
  }

  async function acceptMessageOrControl(input: {
    sessionId: string;
    taskId: string;
    runId: string;
    attentionMode?: "foreground_attached" | "background_detached";
    control?: {
      controlId?: string;
      kind: "steer" | "follow_up" | "continue" | "cancel";
      payload?: unknown;
    };
    reengageToForeground?: boolean;
    now?: string;
  }) {
    const now = input.now ?? new Date().toISOString();

    const control = input.control;
    if (control) {
      db.transaction(() => {
        const controlId = control.controlId ?? `control_${randomUUID()}`;
        db.prepare(`
          INSERT INTO run_control_inputs (
            control_id,
            task_id,
            run_id,
            kind,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(control_id) DO NOTHING
        `).run(
          controlId,
          input.taskId,
          input.runId,
          control.kind,
          maybeJson(control.payload),
          now
        );

        if (control.kind === "cancel") {
          const cancelMetadata = readCancelControlMetadata(control.payload);
          db.prepare(`
            UPDATE task_runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
                cancel_requested_by = COALESCE(cancel_requested_by, ?),
                cancel_reason = COALESCE(cancel_reason, ?),
                updated_at = ?
            WHERE run_id = ?
          `).run(
            now,
            cancelMetadata.requestedBy ?? null,
            cancelMetadata.reason ?? null,
            now,
            input.runId
          );
        }

        if (input.reengageToForeground) {
          const run = loadRunRow(input.runId);
          const normalizedStatus = run ? normalizeLegacyTaskRunStatus(run.status as never) : undefined;
          if (run?.attentionMode === "background_detached" && normalizedStatus === "queued") {
            db.prepare(`
              UPDATE runtime_slices
              SET lane = 'foreground', updated_at = ?
              WHERE run_id = ? AND status = 'queued' AND lane = 'background'
            `).run(now, input.runId);
            db.prepare(`
              UPDATE task_runs
              SET attention_mode = 'foreground_attached', updated_at = ?
              WHERE run_id = ?
            `).run(now, input.runId);
          }
        }
      })();
    }

    if (input.reengageToForeground || input.attentionMode === "foreground_attached") {
      await options.sessionStore?.setFocusRun?.({
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        now
      });
    } else if (input.attentionMode === "background_detached") {
      const focus = await options.sessionStore?.loadFocusRun?.(input.sessionId);
      if (focus?.runId === input.runId) {
        await options.sessionStore?.clearFocusRun?.({
          sessionId: input.sessionId,
          now
        });
      }
    }
  }

  migrateLegacyRunsToSlicesTx();

  return {
    migrateLegacyRunsToSlices,
    transitionBlockedRunToQueuedSlice,
    cancelDetachedRun,
    closeBlockedRunTerminally,
    acceptMessageOrControl,
    claimNextRunnableSlice,
    claimRunnableSliceForRun,
    executeClaimedSlice,
    persistRunningSliceContinuationPayload,
    finalizeSliceResult,
    scheduleNextSliceIfNeeded
  };
}
