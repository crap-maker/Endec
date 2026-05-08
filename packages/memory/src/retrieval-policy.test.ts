import { describe, expect, it } from "vitest";
import { isMemoryRecordVisibleToQuery, resolveRetrievalPolicy } from "./retrieval-policy.ts";

describe("resolveRetrievalPolicy", () => {
  it("routes ordinary execution to working set + recent history only", () => {
    const policy = resolveRetrievalPolicy({
      purpose: "turn_context",
      resumeFrom: undefined,
      requestedTask: undefined,
      activeTasks: []
    });

    expect(policy.strategy).toBe("ordinary");
    expect(policy.activeTaskSelection).toEqual({
      mode: "none"
    });
    expect(policy.includeWorkingSet).toBe(true);
    expect(policy.includeRecentHistory).toBe(true);
    expect(policy.includeActiveTask).toBe(false);
    expect(policy.typedMemoryBias).toEqual({
      preferredFamilies: ["fact", "preference", "procedural", "continuity"],
      preferredBuckets: [],
      preferredScopes: ["workspace", "user", "session"],
      preferSelectedTask: false
    });
  });

  it("routes resume requests to continuation strategy", () => {
    const policy = resolveRetrievalPolicy({
      purpose: "turn_context",
      resumeFrom: "checkpoint:turn_001",
      requestedTask: undefined,
      activeTasks: []
    });

    expect(policy.strategy).toBe("continuation");
    expect(policy.reason).toBe("resume_from_checkpoint");
    expect(policy.includeRecentHistory).toBe(true);
    expect(policy.typedMemoryBias).toEqual({
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "blocker", "open_loop", "decision"],
      preferredScopes: ["session", "workspace", "user"],
      preferSelectedTask: true
    });
  });

  it("prefers request.taskId over session fallback active tasks", () => {
    const policy = resolveRetrievalPolicy({
      purpose: "turn_context",
      requestedTask: {
        taskId: "task_requested",
        title: "Requested task",
        status: "active",
        checkpointRef: "checkpoint:requested",
        updatedAt: "2026-04-11T09:00:00.000Z"
      },
      activeTasks: [
        {
          taskId: "task_fallback",
          title: "Fallback task",
          status: "active",
          checkpointRef: "checkpoint:fallback",
          updatedAt: "2026-04-11T10:00:00.000Z"
        }
      ]
    });

    expect(policy.strategy).toBe("active_task_preferred");
    expect(policy.activeTaskSelection).toEqual({
      mode: "request_task",
      taskId: "task_requested"
    });
    expect(policy.includeActiveTask).toBe(true);
    expect(policy.typedMemoryBias).toEqual({
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "procedural", "blocker", "open_loop", "decision"],
      preferredScopes: ["session", "workspace", "user"],
      preferSelectedTask: true
    });
  });

  it("falls back to the latest active task using updated_at desc then task_id desc", () => {
    const policy = resolveRetrievalPolicy({
      purpose: "turn_context",
      requestedTask: undefined,
      activeTasks: [
        {
          taskId: "task_a",
          title: "Task A",
          status: "active",
          checkpointRef: "checkpoint:a",
          updatedAt: "2026-04-11T10:00:00.000Z"
        },
        {
          taskId: "task_z",
          title: "Task Z",
          status: "active",
          checkpointRef: "checkpoint:z",
          updatedAt: "2026-04-11T10:00:00.000Z"
        },
        {
          taskId: "task_old",
          title: "Task old",
          status: "blocked",
          checkpointRef: "checkpoint:old",
          updatedAt: "2026-04-11T09:59:59.000Z"
        }
      ]
    });

    expect(policy.strategy).toBe("active_task_preferred");
    expect(policy.activeTaskSelection).toEqual({
      mode: "latest_active_task",
      taskId: "task_z"
    });
    expect(policy.includeActiveTask).toBe(true);
    expect(policy.typedMemoryBias).toEqual({
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "procedural", "blocker", "open_loop", "decision"],
      preferredScopes: ["session", "workspace", "user"],
      preferSelectedTask: true
    });
  });

  it("restricts boundary-aware retrieval to local, targeted, or explicit cross-group conversation keys", () => {
    expect(isMemoryRecordVisibleToQuery({
      record: {
        conversationBoundaryKey: "private:42",
        visibility: "owner_private"
      },
      query: {
        disclosureMode: "local_only",
        conversationBoundaryKey: "private:42"
      }
    })).toBe(true);

    expect(isMemoryRecordVisibleToQuery({
      record: {
        conversationBoundaryKey: "supergroup:-100456",
        visibility: "conversation_local"
      },
      query: {
        disclosureMode: "local_only",
        conversationBoundaryKey: "private:42"
      }
    })).toBe(false);

    expect(isMemoryRecordVisibleToQuery({
      record: {
        conversationBoundaryKey: "supergroup:-100123",
        visibility: "conversation_local"
      },
      query: {
        disclosureMode: "owner_targeted",
        conversationBoundaryKey: "private:42",
        targetConversationKeys: ["supergroup:-100123"]
      }
    })).toBe(true);

    expect(isMemoryRecordVisibleToQuery({
      record: {
        conversationBoundaryKey: "private:42",
        visibility: "owner_private"
      },
      query: {
        disclosureMode: "owner_targeted",
        conversationBoundaryKey: "private:42",
        targetConversationKeys: ["supergroup:-100123"]
      }
    })).toBe(false);

    expect(isMemoryRecordVisibleToQuery({
      record: {
        conversationBoundaryKey: "supergroup:-100999",
        visibility: "conversation_local"
      },
      query: {
        disclosureMode: "owner_cross_group",
        conversationBoundaryKey: "private:42",
        targetConversationKeys: ["supergroup:-100123", "supergroup:-100999"]
      }
    })).toBe(true);
    expect(isMemoryRecordVisibleToQuery({
      record: {
        conversationBoundaryKey: "supergroup:-100777",
        visibility: "conversation_local"
      },
      query: {
        disclosureMode: "owner_cross_group",
        conversationBoundaryKey: "private:42",
        targetConversationKeys: ["supergroup:-100123", "supergroup:-100999"]
      }
    })).toBe(false);
  });
});
