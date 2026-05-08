import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskStore } from "./task-store.ts";
import { ensureTasksSchema } from "./schema.ts";
import { createTaskRunStore } from "./task-run-store.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), "endec-task-runs-"));
  tempDirs.add(dir);
  return join(dir, "tasks.sqlite");
}

const conversationRef = {
  accountId: "telegram_bot",
  conversationId: "chat_100/thread_7",
  peerId: "100",
  peerKind: "group" as const,
  threadId: "7"
};

function turnRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "telegram",
    actorId: "actor_001",
    input: "investigate failures",
    attachments: [],
    requestedMode: "act",
    conversationRef,
    ...overrides
  };
}

async function createTask(store: ReturnType<typeof createTaskRunStore>, overrides: Partial<Parameters<ReturnType<typeof createTaskRunStore>["createBackgroundTask"]>[0]> = {}) {
  return store.createBackgroundTask({
    taskId: "task_001",
    workspaceId: "workspace_local",
    sessionId: "session_001",
    actorId: "actor_001",
    conversationRef,
    title: "Investigate failures",
    description: "Find why CI failed",
    sourceTurnId: "turn_001",
    now: "2026-04-25T00:00:00.000Z",
    ...overrides
  });
}

describe("TaskRunStore", () => {
  it("enqueueRun creates a queued run and loadRunById returns its stored payload", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);

    const run = await store.enqueueRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      conversationRef,
      idempotencyKey: "enqueue:turn_001",
      turnRequest: turnRequest(),
      sourceTurnId: "turn_001",
      maxAttempts: 3,
      now: "2026-04-25T00:00:01.000Z"
    });

    expect(run).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      status: "queued",
      runKind: "normal",
      attemptNo: 1,
      maxAttempts: 3,
      sourceTurnId: "turn_001"
    });
    expect(run.conversationRef).toEqual(conversationRef);
    expect(run.turnRequest).toMatchObject({ turnId: "turn_001", input: "investigate failures" });

    await expect(store.loadRunById("run_001")).resolves.toMatchObject({
      runId: "run_001",
      status: "queued",
      turnRequest: { turnId: "turn_001" }
    });
  });

  it("enqueueRun returns the existing run for the same task idempotency key", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);

    const first = await store.enqueueRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "same-key",
      turnRequest: turnRequest({ turnId: "turn_original" }),
      maxAttempts: 2,
      now: "2026-04-25T00:00:01.000Z"
    });
    const duplicate = await store.enqueueRun({
      runId: "run_duplicate",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "same-key",
      turnRequest: turnRequest({ turnId: "turn_duplicate" }),
      maxAttempts: 2,
      now: "2026-04-25T00:00:02.000Z"
    });

    expect(duplicate.runId).toBe(first.runId);
    expect(duplicate.turnRequest).toMatchObject({ turnId: "turn_original" });
    await expect(store.listRunsByTask("task_001")).resolves.toHaveLength(1);
  });

  it("claimNextRun leases the highest-priority oldest queued run", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_low_old",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "low-old",
      turnRequest: turnRequest({ turnId: "turn_low_old" }),
      priority: 0,
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.enqueueRun({
      runId: "run_high_old",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "high-old",
      turnRequest: turnRequest({ turnId: "turn_high_old" }),
      priority: 10,
      now: "2026-04-25T00:00:02.000Z"
    });
    await store.enqueueRun({
      runId: "run_high_new",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "high-new",
      turnRequest: turnRequest({ turnId: "turn_high_new" }),
      priority: 10,
      now: "2026-04-25T00:00:03.000Z"
    });

    const claim = await store.claimNextRun({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-25T00:00:10.000Z"
    });

    expect(claim).toMatchObject({ status: "claimed", run: { runId: "run_high_old", status: "running", leaseOwner: "worker_001" } });
    if (claim.status !== "claimed") throw new Error("expected claim");
    expect(claim.run.leaseExpiresAt).toBe("2026-04-25T00:01:10.000Z");
  });

  it("schema claim index matches claim query ordering", async () => {
    const db = new Database(await tempDb());
    ensureTasksSchema(db);

    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_runs_claim'"
    ).get() as { sql: string } | undefined;

    expect(row?.sql).toContain("ON task_runs (status, priority DESC, created_at ASC, run_id ASC)");
    db.close();
  });

  it("createRun enforces the parent task foreign key", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });

    await expect(Promise.resolve().then(() => store.createRun({
      runId: "run_missing_task",
      taskId: "task_missing",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      attentionMode: "foreground_attached",
      now: "2026-04-25T00:00:01.000Z"
    }))).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("loadRunById normalizes legacy lease_expired rows to canonical failed", async () => {
    const filename = await tempDb();
    const db = new Database(filename);
    ensureTasksSchema(db);
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
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'background', 'active', ?, '', ?, ?)
    `).run(
      "task_legacy",
      "workspace_local",
      "session_001",
      "Investigate failures",
      "Find why CI failed",
      "turn_001",
      "2026-04-25T00:00:00.000Z",
      "2026-04-25T00:00:00.000Z"
    );
    db.prepare(`
      INSERT INTO task_runs (
        run_id,
        task_id,
        workspace_id,
        session_id,
        status,
        attention_mode,
        run_kind,
        attempt_no,
        idempotency_key,
        turn_request_json,
        max_attempts,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'lease_expired', 'background_detached', 'normal', 1, ?, '{}', 1, ?, ?)
    `).run(
      "run_legacy",
      "task_legacy",
      "workspace_local",
      "session_001",
      "legacy:run_legacy",
      "2026-04-25T00:00:01.000Z",
      "2026-04-25T00:00:01.000Z"
    );
    db.close();

    const store = createTaskRunStore({ filename });
    await expect(store.loadRunById("run_legacy")).resolves.toMatchObject({
      runId: "run_legacy",
      status: "failed"
    });
  });

  it("renewRunLease renews when owner matches and lease is not expired", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_lease_ok",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "renew-ok",
      turnRequest: turnRequest(),
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 1_000, now: "2026-04-25T00:00:02.000Z" });

    const renewed = await store.renewRunLease({
      runId: "run_lease_ok",
      leaseOwner: "worker_a",
      leaseDurationMs: 10_000,
      now: "2026-04-25T00:00:02.500Z"
    });

    expect(renewed).toMatchObject({
      runId: "run_lease_ok",
      status: "running",
      leaseOwner: "worker_a",
      leaseExpiresAt: "2026-04-25T00:00:12.500Z"
    });
  });

  it("renewRunLease returns undefined for wrong owner", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_wrong_owner",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "renew-wrong-owner",
      turnRequest: turnRequest(),
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 1_000, now: "2026-04-25T00:00:02.000Z" });

    await expect(store.renewRunLease({
      runId: "run_wrong_owner",
      leaseOwner: "worker_b",
      leaseDurationMs: 10_000,
      now: "2026-04-25T00:00:02.500Z"
    })).resolves.toBeUndefined();
  });

  it("renewRunLease returns undefined when lease is already expired", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_lease_expired",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "renew-expired",
      turnRequest: turnRequest(),
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 1_000, now: "2026-04-25T00:00:02.000Z" });

    await expect(store.renewRunLease({
      runId: "run_lease_expired",
      leaseOwner: "worker_a",
      leaseDurationMs: 10_000,
      now: "2026-04-25T00:00:04.000Z"
    })).resolves.toBeUndefined();
  });

  it("claimNextRun does not claim a non-expired running run", async () => {
    const filename = await tempDb();
    const storeA = createTaskRunStore({ filename });
    const storeB = createTaskRunStore({ filename });
    await createTask(storeA);
    await storeA.enqueueRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "claim-once",
      turnRequest: turnRequest(),
      now: "2026-04-25T00:00:01.000Z"
    });

    await expect(storeA.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:02.000Z" }))
      .resolves.toMatchObject({ status: "claimed", run: { runId: "run_001" } });
    await expect(storeB.claimNextRun({ workerId: "worker_b", leaseDurationMs: 60_000, now: "2026-04-25T00:00:03.000Z" }))
      .resolves.toEqual({ status: "none" });
  });

  it("markLeaseExpired does not mark an unexpired running run", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_unexpired",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "mark-unexpired",
      turnRequest: turnRequest(),
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:02.000Z" });

    const result = await store.markLeaseExpired({
      runId: "run_unexpired",
      retryRunId: "run_unexpired_retry",
      retryIdempotencyKey: "retry:run_unexpired",
      now: "2026-04-25T00:00:03.000Z"
    });

    expect(result).toEqual({ expired: undefined, retry: undefined });
    await expect(store.loadRunById("run_unexpired")).resolves.toMatchObject({ status: "running" });
  });

  it("expired running run is persisted as canonical failed and retry creates a new attempt row", async () => {
    const filename = await tempDb();
    const store = createTaskRunStore({ filename });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_attempt_1",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "attempt-1",
      turnRequest: turnRequest(),
      maxAttempts: 3,
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 1_000, now: "2026-04-25T00:00:02.000Z" });

    const result = await store.markLeaseExpired({
      runId: "run_attempt_1",
      retryRunId: "run_attempt_2",
      retryIdempotencyKey: "retry:run_attempt_1",
      now: "2026-04-25T00:00:04.000Z"
    });

    expect(result.expired).toMatchObject({ runId: "run_attempt_1", status: "failed", finishedAt: "2026-04-25T00:00:04.000Z" });
    expect(result.retry).toMatchObject({
      runId: "run_attempt_2",
      status: "queued",
      attemptNo: 2,
      retryOfRunId: "run_attempt_1"
    });
    const runs = await store.listRunsByTask("task_001");
    expect(runs.map((run) => [run.runId, run.status, run.attemptNo])).toEqual([
      ["run_attempt_1", "failed", 1],
      ["run_attempt_2", "queued", 2]
    ]);

    const db = new Database(filename, { readonly: true });
    const row = db.prepare("SELECT status FROM task_runs WHERE run_id = ?").get("run_attempt_1") as { status: string };
    db.close();
    expect(row.status).toBe("failed");
  });

  it("suspendRun stores pending refs, blocking reason, and removes it from claimable queue", async () => {
    const filename = await tempDb();
    const store = createTaskRunStore({ filename });
    const taskStore = createTaskStore({ filename });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "suspend-me",
      turnRequest: turnRequest(),
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:02.000Z" });

    const suspended = await store.suspendRun({
      runId: "run_001",
      pendingApprovalRef: "approval_123",
      pendingControlRef: "frame_123",
      blockedBy: "permission",
      resultSummary: "needs approval",
      now: "2026-04-25T00:00:03.000Z"
    });

    expect(suspended).toMatchObject({
      status: "blocked",
      pendingApprovalRef: "approval_123",
      pendingControlRef: "frame_123",
      resultSummary: "needs approval"
    });
    await expect(store.claimNextRun({ workerId: "worker_b", leaseDurationMs: 60_000, now: "2026-04-25T00:00:04.000Z" }))
      .resolves.toEqual({ status: "none" });
    await expect(store.loadBackgroundTask("task_001")).resolves.toMatchObject({ agentStatus: "blocked" });
    await expect(taskStore.loadById("task_001")).resolves.toMatchObject({
      status: "blocked",
      blockingReason: "permission"
    });
  });

  it("cancelQueuedOrSuspendedRun deterministically cancels queued and suspended runs", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_queued",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "queued-cancel",
      turnRequest: turnRequest({ turnId: "turn_queued" }),
      now: "2026-04-25T00:00:01.000Z"
    });
    const queuedCancel = await store.cancelQueuedOrSuspendedRun({
      runId: "run_queued",
      reason: "user requested",
      now: "2026-04-25T00:00:02.000Z"
    });
    expect(queuedCancel).toMatchObject({ status: "canceled", cancelReason: "user requested" });
    await expect(store.loadBackgroundTask("task_001")).resolves.toMatchObject({ agentStatus: "canceled" });

    await createTask(store, { taskId: "task_002", sessionId: "session_002" });
    await store.enqueueRun({
      runId: "run_suspended",
      taskId: "task_002",
      workspaceId: "workspace_local",
      sessionId: "session_002",
      idempotencyKey: "suspended-cancel",
      turnRequest: turnRequest({ turnId: "turn_suspended", sessionId: "session_002" }),
      now: "2026-04-25T00:00:03.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:04.000Z" });
    await store.suspendRun({ runId: "run_suspended", pendingApprovalRef: "approval", now: "2026-04-25T00:00:05.000Z" });
    const suspendedCancel = await store.cancelQueuedOrSuspendedRun({
      runId: "run_suspended",
      reason: "operator canceled",
      now: "2026-04-25T00:00:06.000Z"
    });
    expect(suspendedCancel).toMatchObject({ status: "canceled", cancelReason: "operator canceled" });
    await expect(store.loadBackgroundTask("task_002")).resolves.toMatchObject({ agentStatus: "canceled" });
  });

  it("running run can be failed interrupted cancel_requested and then canceled through legal transitions", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);

    await store.enqueueRun({
      runId: "run_failed_1",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "failed-1",
      turnRequest: turnRequest({ turnId: "turn_failed" }),
      maxAttempts: 2,
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:02.000Z" });
    const failedResult = await store.failRun({
      runId: "run_failed_1",
      resultSummary: "provider error",
      error: { code: "provider_error" },
      retryRunId: "run_failed_2",
      retryIdempotencyKey: "retry:run_failed_1",
      now: "2026-04-25T00:00:03.000Z"
    });
    expect(failedResult.failed).toMatchObject({ status: "failed", error: { code: "provider_error" } });
    expect(failedResult.retry).toMatchObject({ runId: "run_failed_2", status: "queued", attemptNo: 2, retryOfRunId: "run_failed_1" });

    await createTask(store, { taskId: "task_002", sessionId: "session_002" });
    await store.enqueueRun({
      runId: "run_interrupted",
      taskId: "task_002",
      workspaceId: "workspace_local",
      sessionId: "session_002",
      idempotencyKey: "interrupted",
      turnRequest: turnRequest({ turnId: "turn_interrupted", sessionId: "session_002" }),
      now: "2026-04-25T00:00:04.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:05.000Z" });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:05.500Z" });
    const interrupted = await store.interruptRun({
      runId: "run_interrupted",
      resultSummary: "runtime interrupted",
      now: "2026-04-25T00:00:06.000Z"
    });
    expect(interrupted).toMatchObject({ status: "failed", resultSummary: "runtime interrupted" });

    await createTask(store, { taskId: "task_003", sessionId: "session_003" });
    await store.enqueueRun({
      runId: "run_cancel_requested",
      taskId: "task_003",
      workspaceId: "workspace_local",
      sessionId: "session_003",
      idempotencyKey: "cancel-requested",
      turnRequest: turnRequest({ turnId: "turn_cancel", sessionId: "session_003" }),
      now: "2026-04-25T00:00:07.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:08.000Z" });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:08.500Z" });
    const cancelRequested = await store.requestRunCancellation({
      runId: "run_cancel_requested",
      reason: "operator requested",
      now: "2026-04-25T00:00:09.000Z"
    });
    expect(cancelRequested).toMatchObject({
      status: "running",
      cancelRequestedAt: "2026-04-25T00:00:09.000Z",
      cancelReason: "operator requested"
    });
    const canceled = await store.markRunCanceled({
      runId: "run_cancel_requested",
      resultSummary: "cancellation observed",
      now: "2026-04-25T00:00:10.000Z"
    });
    expect(canceled).toMatchObject({ status: "canceled", resultSummary: "cancellation observed" });
    await expect(store.loadBackgroundTask("task_003")).resolves.toMatchObject({ agentStatus: "canceled" });
  });

  it("terminal run cannot be re-completed or re-canceled in invalid ways", async () => {
    const store = createTaskRunStore({ filename: await tempDb() });
    await createTask(store);
    await store.enqueueRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      idempotencyKey: "terminal",
      turnRequest: turnRequest(),
      now: "2026-04-25T00:00:01.000Z"
    });
    await store.claimNextRun({ workerId: "worker_a", leaseDurationMs: 60_000, now: "2026-04-25T00:00:02.000Z" });
    const completed = await store.completeRun({ runId: "run_001", resultSummary: "done", now: "2026-04-25T00:00:03.000Z" });
    expect(completed).toMatchObject({ status: "completed", resultSummary: "done" });

    await expect(store.completeRun({ runId: "run_001", resultSummary: "again", now: "2026-04-25T00:00:04.000Z" }))
      .resolves.toBeUndefined();
    await expect(store.cancelQueuedOrSuspendedRun({ runId: "run_001", reason: "too late", now: "2026-04-25T00:00:05.000Z" }))
      .resolves.toBeUndefined();
    await expect(store.loadRunById("run_001")).resolves.toMatchObject({ status: "completed", resultSummary: "done" });
  });
});
