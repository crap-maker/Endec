import Database from "better-sqlite3";
import type {
  RuntimeSliceClaimResult,
  RuntimeSliceSnapshot,
  RuntimeSliceStatus,
  SliceLane,
  SliceTerminalStatus,
  SliceTriggerKind
} from "@endec/domain";
import { RuntimeSliceSnapshotSchema } from "@endec/domain";
import { ensureTasksSchema } from "./schema.ts";
import { openSqliteDatabase } from "./sqlite.ts";

type RuntimeSliceRow = {
  sliceId: string;
  runId: string;
  taskId: string;
  sliceNo: number;
  triggerKind: SliceTriggerKind;
  lane: SliceLane;
  status: RuntimeSliceStatus;
  workerId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  budgetSnapshotJson: string | null;
  toolLoopSummaryJson: string | null;
  usageSummaryJson: string | null;
  continuationPayloadJson: string | null;
  resultSummary: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
};

const sliceSelect = `
  SELECT
    slice_id as sliceId,
    run_id as runId,
    task_id as taskId,
    slice_no as sliceNo,
    trigger_kind as triggerKind,
    lane,
    status,
    worker_id as workerId,
    lease_owner as leaseOwner,
    lease_expires_at as leaseExpiresAt,
    claimed_at as claimedAt,
    started_at as startedAt,
    finished_at as finishedAt,
    budget_snapshot_json as budgetSnapshotJson,
    tool_loop_summary_json as toolLoopSummaryJson,
    usage_summary_json as usageSummaryJson,
    continuation_payload_json as continuationPayloadJson,
    result_summary as resultSummary,
    error_json as errorJson,
    created_at as createdAt,
    updated_at as updatedAt
  FROM runtime_slices
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

function parseSlice(row: RuntimeSliceRow): RuntimeSliceSnapshot {
  return RuntimeSliceSnapshotSchema.parse({
    sliceId: row.sliceId,
    runId: row.runId,
    taskId: row.taskId,
    sliceNo: row.sliceNo,
    triggerKind: row.triggerKind,
    lane: row.lane,
    status: row.status,
    workerId: row.workerId ?? undefined,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    claimedAt: row.claimedAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    budgetSnapshot: maybeParseJson(row.budgetSnapshotJson),
    toolLoopSummary: maybeParseJson(row.toolLoopSummaryJson),
    usageSummary: maybeParseJson(row.usageSummaryJson),
    continuationPayload: maybeParseJson(row.continuationPayloadJson),
    resultSummary: row.resultSummary ?? undefined,
    error: maybeParseJson(row.errorJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

function loadSlice(db: Database.Database, sliceId: string) {
  const row = db.prepare(`${sliceSelect} WHERE slice_id = ?`).get(sliceId) as RuntimeSliceRow | undefined;
  return row ? parseSlice(row) : undefined;
}

function nextSliceNo(db: Database.Database, runId: string) {
  const row = db.prepare("SELECT COALESCE(MAX(slice_no), 0) + 1 as sliceNo FROM runtime_slices WHERE run_id = ?").get(runId) as { sliceNo: number };
  return row.sliceNo;
}

function hasOpenSlice(db: Database.Database, runId: string) {
  const row = db.prepare(`
    SELECT slice_id as sliceId
    FROM runtime_slices
    WHERE run_id = ? AND status IN ('queued', 'running')
    LIMIT 1
  `).get(runId) as { sliceId: string } | undefined;
  return Boolean(row);
}

function loadRunOwnership(db: Database.Database, runId: string) {
  return db.prepare(`
    SELECT task_id as taskId
    FROM task_runs
    WHERE run_id = ?
  `).get(runId) as { taskId: string } | undefined;
}

export function createRuntimeSliceStore({ filename }: { filename: string }) {
  const db = openSqliteDatabase(filename);
  ensureTasksSchema(db);

  const enqueueSlice = db.transaction((input: {
    sliceId: string;
    runId: string;
    taskId: string;
    triggerKind: SliceTriggerKind;
    lane: SliceLane;
    budgetSnapshot?: unknown;
    now?: string;
    requireFirst: boolean;
  }) => {
    const owner = loadRunOwnership(db, input.runId);
    if (owner && owner.taskId !== input.taskId) {
      throw new Error(`run ${input.runId} belongs to task ${owner.taskId}, not ${input.taskId}`);
    }

    const now = input.now ?? new Date().toISOString();
    const sliceNo = nextSliceNo(db, input.runId);
    if (input.requireFirst && sliceNo !== 1) {
      throw new Error(`run ${input.runId} already has slices`);
    }
    if (!input.requireFirst && hasOpenSlice(db, input.runId)) {
      throw new Error(`run ${input.runId} already has an open slice`);
    }

    db.prepare(`
      INSERT INTO runtime_slices (
        slice_id,
        run_id,
        task_id,
        slice_no,
        trigger_kind,
        lane,
        status,
        budget_snapshot_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      input.sliceId,
      input.runId,
      input.taskId,
      sliceNo,
      input.triggerKind,
      input.lane,
      maybeJson(input.budgetSnapshot),
      now,
      now
    );
    return loadSlice(db, input.sliceId)!;
  });

  async function enqueueInitialSlice(input: {
    sliceId: string;
    runId: string;
    taskId: string;
    lane: SliceLane;
    budgetSnapshot?: unknown;
    now?: string;
  }) {
    return enqueueSlice({ ...input, triggerKind: "initial", requireFirst: true });
  }

  async function enqueueNextSlice(input: {
    sliceId: string;
    runId: string;
    taskId: string;
    triggerKind: Exclude<SliceTriggerKind, "initial">;
    lane: SliceLane;
    budgetSnapshot?: unknown;
    now?: string;
  }) {
    return enqueueSlice({ ...input, requireFirst: false });
  }

  const claimSlice = db.transaction((input: {
    workerId: string;
    lane: SliceLane;
    leaseDurationMs: number;
    now?: string;
  }): RuntimeSliceClaimResult => {
    const now = input.now ?? new Date().toISOString();
    const row = db.prepare(`
      ${sliceSelect}
      WHERE lane = ?
        AND status = 'queued'
        AND NOT EXISTS (
          SELECT 1
          FROM runtime_slices siblings
          WHERE siblings.run_id = runtime_slices.run_id
            AND siblings.status = 'running'
        )
      ORDER BY created_at ASC, slice_id ASC
      LIMIT 1
    `).get(input.lane) as RuntimeSliceRow | undefined;
    if (!row) return { status: "none" };

    const result = db.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = COALESCE(started_at, ?),
          updated_at = ?
      WHERE slice_id = ? AND status = 'queued'
    `).run(input.workerId, input.workerId, addMs(now, input.leaseDurationMs), now, now, now, row.sliceId);

    if (result.changes !== 1) return { status: "lost_race" };
    return { status: "claimed", slice: loadSlice(db, row.sliceId)! };
  });

  async function claimNextRunnableSlice(input: {
    workerId: string;
    lane: SliceLane;
    leaseDurationMs: number;
    now?: string;
  }) {
    return claimSlice(input);
  }

  async function finalizeSlice(input: {
    sliceId: string;
    status: SliceTerminalStatus;
    toolLoopSummary?: unknown;
    usageSummary?: unknown;
    continuationPayload?: unknown;
    resultSummary?: string;
    error?: unknown;
    finishedAt?: string;
  }) {
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    const result = db.prepare(`
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
      input.status,
      maybeJson(input.toolLoopSummary),
      maybeJson(input.usageSummary),
      maybeJson(input.continuationPayload),
      input.resultSummary ?? null,
      maybeJson(input.error),
      finishedAt,
      finishedAt,
      input.sliceId
    );
    return result.changes === 1 ? loadSlice(db, input.sliceId) : undefined;
  }

  async function recoverExpiredSlice(input: { sliceId: string; now?: string }) {
    const now = input.now ?? new Date().toISOString();
    const result = db.prepare(`
      UPDATE runtime_slices
      SET status = 'lease_expired',
          finished_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE slice_id = ? AND status = 'running' AND lease_expires_at < ?
    `).run(now, now, input.sliceId, now);
    return result.changes === 1 ? loadSlice(db, input.sliceId) : undefined;
  }

  async function listSlicesByRun(runId: string) {
    const rows = db.prepare(`${sliceSelect} WHERE run_id = ? ORDER BY slice_no ASC, created_at ASC, slice_id ASC`).all(runId) as RuntimeSliceRow[];
    return rows.map(parseSlice);
  }

  async function loadLatestSliceByRun(runId: string) {
    const row = db.prepare(`
      ${sliceSelect}
      WHERE run_id = ?
      ORDER BY slice_no DESC, created_at DESC, slice_id DESC
      LIMIT 1
    `).get(runId) as RuntimeSliceRow | undefined;
    return row ? parseSlice(row) : undefined;
  }

  return {
    enqueueInitialSlice,
    enqueueNextSlice,
    claimNextRunnableSlice,
    finalizeSlice,
    recoverExpiredSlice,
    listSlicesByRun,
    loadLatestSliceByRun
  };
}
