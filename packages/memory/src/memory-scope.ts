import type { MemoryQuery, MemoryWriteRequest } from "@endec/domain";

type ScopeCarrier = {
  scope?: string | null;
  kind?: MemoryWriteRequest["writeKind"];
  memoryType?: string;
  taskId?: string | null;
  sessionId?: string;
  workspaceId?: string;
  actorId?: string | null;
};

type ScopeContext = {
  sessionId: string;
  workspaceId: string;
  actorId?: string;
  scopeFilter?: MemoryQuery["scopeFilter"];
  preferredScopes?: MemoryWriteRequest["scope"][];
  queryText?: string;
};

const SESSION_MEMORY_TYPES = new Set([
  "task_continuity",
  "continuation",
  "active_task",
  "blocker",
  "blocked",
  "blocking",
  "open_loop",
  "follow_up",
  "followup",
  "todo",
  "decision",
  "recent_decision",
  "episodic",
  "turn_summary",
  "summary",
  "event",
  "note"
]);

function normalizeMemoryType(memoryType?: string) {
  return memoryType?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
}

export function normalizeMemoryScope(input: ScopeCarrier): NonNullable<MemoryWriteRequest["scope"]> {
  switch (input.scope) {
    case "session":
      return "session";
    case "workspace":
    case "project":
      return "workspace";
    case "user":
      return "user";
  }

  const normalizedMemoryType = normalizeMemoryType(input.memoryType);
  if (input.kind === "candidate_extract" || !!input.taskId || SESSION_MEMORY_TYPES.has(normalizedMemoryType)) {
    return "session";
  }

  return "workspace";
}

function inferScopeHint(queryText?: string): MemoryWriteRequest["scope"] | undefined {
  const normalized = queryText?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["prefer", "preference", "usually", "habit", "style", "personal"].some((term) => normalized.includes(term))) {
    return "user";
  }

  if (["current task", "next step", "blocked", "blocker", "resume", "continue"].some((term) => normalized.includes(term))) {
    return "session";
  }

  if (["workspace", "project", "repo", "repository", "codebase", "convention"].some((term) => normalized.includes(term))) {
    return "workspace";
  }

  return undefined;
}

export function scopeAppliesToContext(input: {
  record: ScopeCarrier;
  scope: MemoryWriteRequest["scope"];
  context: Pick<ScopeContext, "sessionId" | "workspaceId" | "actorId">;
}) {
  switch (input.scope) {
    case "session":
      return input.record.sessionId === input.context.sessionId && input.record.workspaceId === input.context.workspaceId;
    case "workspace":
      return input.record.workspaceId === input.context.workspaceId;
    case "user":
      return !!input.context.actorId && !!input.record.actorId && input.record.actorId === input.context.actorId;
  }
}

export function passesScopeGate(input: {
  record: ScopeCarrier;
  context: Pick<ScopeContext, "sessionId" | "workspaceId" | "actorId" | "scopeFilter">;
}) {
  const scope = normalizeMemoryScope(input.record);
  if (!scopeAppliesToContext({ record: input.record, scope, context: input.context })) {
    return false;
  }

  if (!input.context.scopeFilter) {
    return true;
  }

  return scope === input.context.scopeFilter;
}

export function scoreScope(input: {
  record: ScopeCarrier;
  context: ScopeContext;
}) {
  const scope = normalizeMemoryScope(input.record);
  if (!scopeAppliesToContext({ record: input.record, scope, context: input.context })) {
    return Number.NEGATIVE_INFINITY;
  }

  if (input.context.scopeFilter) {
    return scope === input.context.scopeFilter ? 100 : Number.NEGATIVE_INFINITY;
  }

  const preferredScopes = input.context.preferredScopes ?? [];
  const preferredIndex = preferredScopes.indexOf(scope);
  const preferredScore = preferredIndex >= 0 ? (preferredScopes.length - preferredIndex) * 10 : 0;
  const hintedScope = inferScopeHint(input.context.queryText);
  const hintScore = hintedScope === scope ? 5 : 0;

  return preferredScore + hintScore;
}

export function renderScopeTitle(scope: MemoryWriteRequest["scope"] | undefined) {
  switch (scope) {
    case "session":
      return "session durable memory";
    case "workspace":
      return "workspace durable memory";
    case "user":
      return "user durable memory";
    default:
      return "durable memory";
  }
}
