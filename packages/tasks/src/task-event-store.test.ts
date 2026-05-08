import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureTasksSchema } from "./schema.ts";
import { createTaskEventStore } from "./task-event-store.ts";

async function withStore(testFn: (store: ReturnType<typeof createTaskEventStore>, filename: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "endec-task-events-"));
  const filename = join(directory, "tasks.sqlite");
  try {
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
        plan_json,
        artifacts_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)
    `).run("task_001", "workspace_local", "session_001", "Task 1", "Test task 1", "background", "active", "turn_001", "checkpoint_001", "2026-04-25T00:00:00.000Z", "2026-04-25T00:00:00.000Z");
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
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)
    `).run("task_002", "workspace_local", "session_001", "Task 2", "Test task 2", "background", "active", "turn_002", "checkpoint_002", "2026-04-25T00:00:00.000Z", "2026-04-25T00:00:00.000Z");
    db.prepare(`
      INSERT INTO task_runs (
        run_id,
        task_id,
        workspace_id,
        session_id,
        status,
        run_kind,
        attempt_no,
        idempotency_key,
        turn_request_json,
        max_attempts,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("run_001", "task_001", "workspace_local", "session_001", "queued", "normal", 1, "run-key-001", "{}", 1, "2026-04-25T00:00:00.000Z", "2026-04-25T00:00:00.000Z");
    db.prepare(`
      INSERT INTO task_runs (
        run_id,
        task_id,
        workspace_id,
        session_id,
        status,
        run_kind,
        attempt_no,
        idempotency_key,
        turn_request_json,
        max_attempts,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("run_002", "task_001", "workspace_local", "session_001", "queued", "normal", 2, "run-key-002", "{}", 1, "2026-04-25T00:00:00.000Z", "2026-04-25T00:00:00.000Z");
    db.close();

    const store = createTaskEventStore({ filename });
    await testFn(store, filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("TaskEventStore", () => {
  it("append first event gets seq 1", async () => {
    await withStore(async (store) => {
      const event = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "task_created",
        severity: "info",
        message: "Task created"
      });

      expect(event.seq).toBe(1);
      expect(event.taskId).toBe("task_001");
      expect(event.runId).toBeUndefined();
    });
  });

  it("append multiple task events increments seq monotonically", async () => {
    await withStore(async (store) => {
      const events = [];
      for (const eventType of ["task_created", "run_queued", "run_started"] as const) {
        events.push(await store.appendTaskEvent({
          taskId: "task_001",
          workspaceId: "workspace_local",
          eventType,
          severity: "info",
          message: eventType
        }));
      }

      expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    });
  });

  it("events for different tasks have independent seq", async () => {
    await withStore(async (store) => {
      const firstTaskEvent = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "task_created",
        severity: "info",
        message: "Task 1 created"
      });
      const secondTaskEvent = await store.appendTaskEvent({
        taskId: "task_002",
        workspaceId: "workspace_local",
        eventType: "task_created",
        severity: "info",
        message: "Task 2 created"
      });
      const firstTaskSecondEvent = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "run_queued",
        severity: "info",
        message: "Task 1 queued"
      });

      expect(firstTaskEvent.seq).toBe(1);
      expect(secondTaskEvent.seq).toBe(1);
      expect(firstTaskSecondEvent.seq).toBe(2);
    });
  });

  it("idempotency key prevents duplicate events for same task", async () => {
    await withStore(async (store) => {
      const first = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "task_created",
        severity: "info",
        message: "Task created",
        idempotencyKey: "create-key"
      });
      const duplicate = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "run_failed",
        severity: "error",
        message: "This duplicate should not be inserted",
        idempotencyKey: "create-key"
      });
      const next = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "run_queued",
        severity: "info",
        message: "Run queued"
      });

      expect(duplicate).toEqual(first);
      expect(next.seq).toBe(2);
      await expect(store.listEventsByTask({ taskId: "task_001" })).resolves.toHaveLength(2);
    });
  });

  it("same idempotency key can be used on different tasks", async () => {
    await withStore(async (store) => {
      const first = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "task_created",
        severity: "info",
        message: "Task 1 created",
        idempotencyKey: "shared-key"
      });
      const second = await store.appendTaskEvent({
        taskId: "task_002",
        workspaceId: "workspace_local",
        eventType: "task_created",
        severity: "info",
        message: "Task 2 created",
        idempotencyKey: "shared-key"
      });

      expect(first.taskId).toBe("task_001");
      expect(second.taskId).toBe("task_002");
      expect(first.seq).toBe(1);
      expect(second.seq).toBe(1);
      expect(first.eventId).not.toBe(second.eventId);
    });
  });

  it("listEventsByTask returns seq ascending", async () => {
    await withStore(async (store) => {
      await store.appendTaskEvent({ taskId: "task_001", workspaceId: "workspace_local", eventType: "run_started", severity: "info", message: "third" });
      await store.appendTaskEvent({ taskId: "task_001", workspaceId: "workspace_local", eventType: "task_created", severity: "info", message: "first" });
      await store.appendTaskEvent({ taskId: "task_001", workspaceId: "workspace_local", eventType: "run_queued", severity: "info", message: "second" });

      const events = await store.listEventsByTask({ taskId: "task_001" });

      expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.message)).toEqual(["third", "first", "second"]);
    });
  });

  it("listEventsByRun filters run events", async () => {
    await withStore(async (store) => {
      await store.appendTaskEvent({ taskId: "task_001", workspaceId: "workspace_local", eventType: "task_created", severity: "info", message: "task only" });
      await store.appendTaskEvent({ taskId: "task_001", runId: "run_001", workspaceId: "workspace_local", eventType: "run_queued", severity: "info", message: "run 1 queued" });
      await store.appendTaskEvent({ taskId: "task_001", runId: "run_002", workspaceId: "workspace_local", eventType: "run_queued", severity: "info", message: "run 2 queued" });
      await store.appendTaskEvent({ taskId: "task_001", runId: "run_001", workspaceId: "workspace_local", eventType: "run_started", severity: "info", message: "run 1 started" });

      const events = await store.listEventsByRun({ runId: "run_001" });

      expect(events.map((event) => ({ runId: event.runId, seq: event.seq, message: event.message }))).toEqual([
        { runId: "run_001", seq: 2, message: "run 1 queued" },
        { runId: "run_001", seq: 4, message: "run 1 started" }
      ]);
    });
  });

  it("rejects duplicate (task_id, seq) at DB level", async () => {
    await withStore(async (_store, filename) => {
      const db = new Database(filename);
      try {
        db.prepare(`
          INSERT INTO task_events (
            event_id,
            task_id,
            run_id,
            workspace_id,
            seq,
            event_type,
            severity,
            message,
            data_json,
            idempotency_key,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          "event_a",
          "task_001",
          null,
          "workspace_local",
          1,
          "task_created",
          "info",
          "first",
          null,
          null,
          "2026-04-25T00:00:00.000Z"
        );

        expect(() =>
          db.prepare(`
            INSERT INTO task_events (
              event_id,
              task_id,
              run_id,
              workspace_id,
              seq,
              event_type,
              severity,
              message,
              data_json,
              idempotency_key,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            "event_b",
            "task_001",
            null,
            "workspace_local",
            1,
            "run_queued",
            "info",
            "duplicate seq",
            null,
            null,
            "2026-04-25T00:00:01.000Z"
          )
        ).toThrow(/UNIQUE constraint failed: task_events\.task_id, task_events\.seq/);
      } finally {
        db.close();
      }
    });
  });

  it("appendTaskEvent rejects invalid eventType", async () => {
    await withStore(async (store) => {
      await expect(
        store.appendTaskEvent({
          taskId: "task_001",
          workspaceId: "workspace_local",
          eventType: "not_a_valid_event_type",
          severity: "info",
          message: "invalid event type"
        } as any)
      ).rejects.toMatchObject({ name: "ZodError" });
    });
  });

  it("appendTaskEvent rejects invalid severity", async () => {
    await withStore(async (store) => {
      await expect(
        store.appendTaskEvent({
          taskId: "task_001",
          workspaceId: "workspace_local",
          eventType: "task_created",
          severity: "not_a_valid_severity",
          message: "invalid severity"
        } as any)
      ).rejects.toMatchObject({ name: "ZodError" });
    });
  });

  it("listEventsByTask returns [] for task with no events", async () => {
    await withStore(async (store) => {
      await expect(store.listEventsByTask({ taskId: "task_002" })).resolves.toEqual([]);
    });
  });

  it("payload JSON round-trips and invalid JSON is not possible through API", async () => {
    await withStore(async (store) => {
      const payload = {
        nested: { ok: true, count: 2 },
        values: ["a", "b"]
      };
      const event = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "run_failed",
        severity: "error",
        message: "Run failed with structured data",
        data: payload
      });

      expect(event.data).toEqual(payload);
      const [loaded] = await store.listEventsByTask({ taskId: "task_001" });
      expect(loaded.data).toEqual(payload);
      expect(typeof loaded.data).toBe("object");
    });
  });

  it("data undefined round-trips as undefined", async () => {
    await withStore(async (store) => {
      const event = await store.appendTaskEvent({
        taskId: "task_001",
        workspaceId: "workspace_local",
        eventType: "run_queued",
        severity: "info",
        message: "no data field",
        data: undefined
      });

      expect(event.data).toBeUndefined();
      const [loaded] = await store.listEventsByTask({ taskId: "task_001" });
      expect(loaded.data).toBeUndefined();
    });
  });
});
