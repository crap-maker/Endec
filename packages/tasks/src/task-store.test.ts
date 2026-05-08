import { describe, expect, it } from "vitest";
import { TaskStateSchema } from "@endec/domain";
import { createTaskStore } from "./task-store";

describe("TaskStore", () => {
  it("persists and reloads a canonical task row", async () => {
    const store = createTaskStore({ filename: ":memory:" });
    await store.upsertTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Ship MVP",
      description: "Finish P0",
      kind: "act",
      status: "active",
      lastTurnId: "turn_001",
      checkpointRef: "checkpoint_001"
    });

    const task = await store.loadById("task_001");
    expect(task?.workspaceId).toBe("workspace_local");
    expect(task?.sessionId).toBe("session_001");
    expect(task?.title).toBe("Ship MVP");
    expect(task?.description).toBe("Finish P0");
    expect(task?.kind).toBe("act");
    expect(task?.status).toBe("active");
    expect(task?.checkpointRef).toBe("checkpoint_001");
  });

  it("lists active tasks for a session", async () => {
    const store = createTaskStore({ filename: ":memory:" });
    await store.upsertTask({
      taskId: "task_active",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Ship MVP",
      description: "Finish P0",
      kind: "act",
      status: "active",
      lastTurnId: "turn_001",
      checkpointRef: "checkpoint_001"
    });
    await store.upsertTask({
      taskId: "task_done",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Archive",
      description: "Done",
      kind: "review",
      status: "done",
      lastTurnId: "turn_002",
      checkpointRef: "checkpoint_002"
    });

    const tasks = await store.listActiveBySession("session_001");

    expect(tasks).toEqual([
      {
        taskId: "task_active",
        status: "active",
        lastTurnId: "turn_001"
      }
    ]);
  });

  it("loads the latest active task snapshot with a stable order", async () => {
    const store = createTaskStore({ filename: ":memory:" });
    await store.upsertTask({
      taskId: "task_alpha",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Alpha",
      description: "Older active task",
      kind: "act",
      status: "active",
      lastTurnId: "turn_001",
      checkpointRef: "checkpoint_alpha"
    });
    await store.upsertTask({
      taskId: "task_beta",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Beta",
      description: "Newer blocked task",
      kind: "act",
      status: "blocked",
      lastTurnId: "turn_002",
      checkpointRef: "checkpoint_beta"
    });

    const latest = await store.loadLatestActiveBySession("session_001");

    expect(latest).toMatchObject({
      taskId: "task_beta",
      status: "blocked",
      checkpointRef: "checkpoint_beta"
    });
  });

  it("keeps legacy task statuses and ordering compatible before background migrations", async () => {
    const parsedStatuses = ["active", "blocked", "cancelled"].map((status) => TaskStateSchema.parse({
      taskId: `task_${status}`,
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: `Legacy ${status}`,
      description: "legacy compatibility row",
      kind: "background",
      status,
      lastTurnId: `turn_${status}`,
      checkpointRef: `checkpoint_${status}`,
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z"
    }).status);

    expect(parsedStatuses).toEqual(["active", "blocked", "cancelled"]);

    const store = createTaskStore({ filename: ":memory:" });
    await store.upsertTask({
      taskId: "task_active",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Active legacy task",
      description: "old active task",
      kind: "act",
      status: "active",
      lastTurnId: "turn_active",
      checkpointRef: "checkpoint_active"
    });
    await store.upsertTask({
      taskId: "task_blocked",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Blocked legacy task",
      description: "old blocked task",
      kind: "background",
      status: "blocked",
      lastTurnId: "turn_blocked",
      checkpointRef: "checkpoint_blocked"
    });
    await store.upsertTask({
      taskId: "task_cancelled",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Cancelled legacy task",
      description: "old cancelled task",
      kind: "background",
      status: "cancelled",
      lastTurnId: "turn_cancelled",
      checkpointRef: "checkpoint_cancelled"
    });

    const active = await store.listActiveBySession("session_001");
    expect(active.map((task) => task.status)).toEqual(["blocked", "active"]);

    const cancelled = await store.loadById("task_cancelled");
    expect(cancelled?.status).toBe("cancelled");
  });
});
