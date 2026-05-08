import type { ActiveTaskSnapshot, ExecutionRetrievalPolicy, MemoryQuery, MemoryVisibility } from "@endec/domain";

type RetrievalPolicyInput = {
  purpose: MemoryQuery["purpose"];
  resumeFrom?: string;
  requestedTask?: Omit<ActiveTaskSnapshot, "selectedBy">;
  activeTasks?: Array<Omit<ActiveTaskSnapshot, "selectedBy">>;
};

type BoundaryQuery = Pick<MemoryQuery, "conversationBoundaryKey" | "disclosureMode" | "targetConversationKeys">;
type BoundaryRecord = {
  conversationBoundaryKey?: string;
  visibility?: MemoryVisibility;
};

function isDirectBoundaryKey(boundaryKey: string | undefined) {
  return typeof boundaryKey === "string"
    && (boundaryKey.startsWith("private:") || boundaryKey.startsWith("dm:"));
}

export function isMemoryRecordVisibleToQuery(input: {
  record: BoundaryRecord;
  query: BoundaryQuery;
}) {
  const disclosureMode = input.query.disclosureMode;
  const currentBoundaryKey = input.query.conversationBoundaryKey;

  if (!disclosureMode || !currentBoundaryKey) {
    return true;
  }

  if (!isDirectBoundaryKey(currentBoundaryKey) && input.record.visibility === "owner_private") {
    return false;
  }

  const recordBoundaryKey = input.record.conversationBoundaryKey;
  if (!recordBoundaryKey) {
    return false;
  }

  switch (disclosureMode) {
    case "local_only":
      return recordBoundaryKey === currentBoundaryKey;
    case "owner_targeted":
    case "owner_cross_group":
      return (input.query.targetConversationKeys ?? []).includes(recordBoundaryKey)
        && input.record.visibility !== "owner_private";
  }
}

function compareActiveTasks(
  left: Omit<ActiveTaskSnapshot, "selectedBy">,
  right: Omit<ActiveTaskSnapshot, "selectedBy">
) {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }

  return right.taskId.localeCompare(left.taskId);
}

function selectLatestActiveTask(tasks: Array<Omit<ActiveTaskSnapshot, "selectedBy">>) {
  return [...tasks].sort(compareActiveTasks)[0];
}

function resolveTypedMemoryBias(strategy: ExecutionRetrievalPolicy["strategy"]): ExecutionRetrievalPolicy["typedMemoryBias"] {
  if (strategy === "continuation") {
    return {
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "blocker", "open_loop", "decision"],
      preferredScopes: ["session", "workspace", "user"],
      preferSelectedTask: true
    };
  }

  if (strategy === "active_task_preferred") {
    return {
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "procedural", "blocker", "open_loop", "decision"],
      preferredScopes: ["session", "workspace", "user"],
      preferSelectedTask: true
    };
  }

  return {
    preferredFamilies: ["fact", "preference", "procedural", "continuity"],
    preferredBuckets: [],
    preferredScopes: ["workspace", "user", "session"],
    preferSelectedTask: false
  };
}

export function resolveRetrievalPolicy(input: RetrievalPolicyInput): ExecutionRetrievalPolicy {
  if (input.resumeFrom) {
    return {
      strategy: "continuation",
      reason: "resume_from_checkpoint",
      activeTaskSelection: input.requestedTask
        ? {
            mode: "request_task",
            taskId: input.requestedTask.taskId
          }
        : input.activeTasks?.length
          ? {
              mode: "latest_active_task",
              taskId: selectLatestActiveTask(input.activeTasks)?.taskId
            }
          : {
              mode: "none"
            },
      includeWorkingSet: true,
      includeRecentHistory: true,
      includeActiveTask: !!(input.requestedTask || input.activeTasks?.length),
      includeTypedMemory: true,
      includeEvidence: true,
      typedMemoryBias: resolveTypedMemoryBias("continuation")
    };
  }

  if (input.requestedTask) {
    return {
      strategy: "active_task_preferred",
      activeTaskSelection: {
        mode: "request_task",
        taskId: input.requestedTask.taskId
      },
      includeWorkingSet: true,
      includeRecentHistory: true,
      includeActiveTask: true,
      includeTypedMemory: true,
      includeEvidence: true,
      typedMemoryBias: resolveTypedMemoryBias("active_task_preferred")
    };
  }

  const latestActiveTask = input.activeTasks?.length ? selectLatestActiveTask(input.activeTasks) : undefined;
  if (latestActiveTask) {
    return {
      strategy: "active_task_preferred",
      activeTaskSelection: {
        mode: "latest_active_task",
        taskId: latestActiveTask.taskId
      },
      includeWorkingSet: true,
      includeRecentHistory: true,
      includeActiveTask: true,
      includeTypedMemory: true,
      includeEvidence: true,
      typedMemoryBias: resolveTypedMemoryBias("active_task_preferred")
    };
  }

  return {
    strategy: "ordinary",
    activeTaskSelection: {
      mode: "none"
    },
    includeWorkingSet: true,
    includeRecentHistory: true,
    includeActiveTask: false,
    includeTypedMemory: true,
    includeEvidence: true,
    typedMemoryBias: resolveTypedMemoryBias("ordinary")
  };
}

export function selectActiveTaskSnapshot(input: RetrievalPolicyInput): ActiveTaskSnapshot | undefined {
  if (input.requestedTask) {
    return {
      ...input.requestedTask,
      selectedBy: "request_task"
    };
  }

  const latestActiveTask = input.activeTasks?.length ? selectLatestActiveTask(input.activeTasks) : undefined;
  if (!latestActiveTask) {
    return undefined;
  }

  return {
    ...latestActiveTask,
    selectedBy: "latest_active_task"
  };
}
