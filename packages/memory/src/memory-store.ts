import {
  CorrectionRequestSchema,
  type ActiveTaskSnapshot,
  type CorrectionInspection,
  type CorrectionRequest,
  type CorrectionRequestInput,
  type CorrectionResult,
  type EvidenceRecord,
  type EvidenceSearchQuery,
  type EvidenceSurfaceItem,
  type MemoryQuery,
  type ProjectionDerivedRefSurfaceItem,
  type MemoryWriteRequest,
  type RecentHistorySurface,
  type TypedMemorySurfaceItem
} from "@endec/domain";
import type { RuntimeContextBlock, RuntimeMemoryContext } from "@endec/runtime";
import Database from "better-sqlite3";
import { writeDailyMemoryProjectionFile } from "./memory-file-projection.ts";
import { consumeOutboxEntry } from "./outbox-consumer.ts";
import { isMemoryRecordVisibleToQuery, resolveRetrievalPolicy, selectActiveTaskSnapshot } from "./retrieval-policy.ts";
import { ensureMemorySchema } from "./schema.ts";
import { normalizeMemoryScope, renderScopeTitle } from "./memory-scope.ts";
import { selectTypedMemorySurfacesWithObservability } from "./typed-memory-selection.ts";
import { normalizeWorkingSetSurface } from "./working-set.ts";
import {
  createEvidenceSurfaceItem,
  renderTypedMemorySurfaceContent,
  type MaterializedTypedMemoryRecord
} from "./typed-memory.ts";

type LatestWorkingSetRow = {
  workingSetRef: string;
  version: number;
  summary: string;
  objective: string | null;
  recentProgress: string;
  recentDecisions: string;
  blockers: string;
  openLoops: string;
  activeMemoryRefs: string;
  activeTaskRefs: string;
  recentEventRefs: string;
  highlights: string;
  blockerSnapshot: string | null;
  sourceRefs: string;
};

type RetrieveInput =
  | (Pick<
      MemoryQuery,
      "queryId" | "sessionId" | "workspaceId" | "purpose" | "memoryTypes" | "maxItems" | "maxInjectTokens"
    > &
      Partial<Pick<MemoryQuery, "taskId" | "resumeFrom" | "queryText" | "topicHints" | "scopeFilter" | "actorId" | "conversationBoundaryKey" | "disclosureMode" | "targetConversationKeys" | "borrowedConversationKeys" | "transientBorrowed" | "visibility">>)
  | {
      query: Pick<
        MemoryQuery,
        "queryId" | "sessionId" | "workspaceId" | "purpose" | "memoryTypes" | "maxItems" | "maxInjectTokens"
      > &
        Partial<Pick<MemoryQuery, "taskId" | "resumeFrom" | "queryText" | "topicHints" | "scopeFilter" | "actorId" | "conversationBoundaryKey" | "disclosureMode" | "targetConversationKeys" | "borrowedConversationKeys" | "transientBorrowed" | "visibility">>;
      recentHistory?: RecentHistorySurface;
      requestedTask?: Omit<ActiveTaskSnapshot, "selectedBy">;
      activeTasks?: Array<Omit<ActiveTaskSnapshot, "selectedBy">>;
      typedMemory?: TypedMemorySurfaceItem[];
      evidence?: EvidenceSurfaceItem[];
      projectionDerivedRefs?: ProjectionDerivedRefSurfaceItem[];
    };

type EvidenceRow = EvidenceRecord & {
  workspaceId: string;
  conversationBoundaryKey: string | null;
  visibility: MemoryWriteRequest["visibility"] | null;
  borrowedConversationKeysJson: string;
  transientBorrowed: number;
};

type TypedMemoryRow = {
  memoryId: string;
  writeId: string;
  sourceTurnId: string;
  sessionId: string;
  workspaceId: string;
  actorId: string | null;
  taskId: string | null;
  scope: string | null;
  importance: number;
  kind: MemoryWriteRequest["writeKind"];
  status: "materialized";
  selectionState: "active" | "stale" | "superseded" | "disabled";
  memoryType: string;
  summary: string;
  content: string;
  payloadJson: string;
  evidenceRefs: string;
  conversationBoundaryKey: string | null;
  visibility: MemoryWriteRequest["visibility"] | null;
  borrowedConversationKeysJson: string;
  transientBorrowed: number;
  createdAt: string;
  updatedAt: string;
  correctedAt: string | null;
  supersededByMemoryId: string | null;
  correctionId: string | null;
  correctionReason: string | null;
  correctionActorId: string | null;
};

type OutboxRow = {
  writeId: string;
  sourceTurnId: string;
  sessionId: string;
  workspaceId: string;
  writeKind: MemoryWriteRequest["writeKind"];
  evidenceRefs: string;
  payloadJson: string;
  createdAt: string;
  processedAt: string | null;
  status: "pending" | "processed" | "failed";
  attemptCount: number;
  lastError: string | null;
  failedAt: string | null;
};

type ProjectionDerivedRefRow = {
  ref: string;
  workspaceId: string;
  day: string;
  section: string;
  summary: string;
  sourceRefs: string;
  turnRefs: string;
  updatedAt: string;
};

function tokenize(value: string) {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function scoreText(queryText: string, ...values: string[]) {
  const queryTerms = tokenize(queryText);
  if (queryTerms.length === 0) {
    return 0;
  }

  const normalizedQuery = queryTerms.join(" ");
  const allTerms = new Set(values.flatMap((value) => tokenize(value)));
  const normalizedValues = values.map((value) => tokenize(value).join(" "));
  let score = 0;

  for (const normalizedValue of normalizedValues) {
    if (normalizedValue.includes(normalizedQuery)) {
      score += 8;
    }
  }

  if (queryTerms.every((term) => allTerms.has(term))) {
    score += 5;
  }

  for (const term of queryTerms) {
    if (allTerms.has(term)) {
      score += 2;
    }
  }

  return score;
}

function scoreEvidence(row: EvidenceRow, queryText: string) {
  return scoreText(queryText, row.topic, row.content);
}

function scoreProjectionDerivedRef(row: ProjectionDerivedRefSurfaceItem, queryText: string) {
  return scoreText(queryText, row.day, row.section, row.summary);
}

function normalizeRetrieveInput(input: RetrieveInput) {
  if ("query" in input) {
    return {
      query: input.query,
      recentHistory: input.recentHistory,
      requestedTask: input.requestedTask,
      activeTasks: input.activeTasks,
      typedMemory: input.typedMemory,
      evidence: input.evidence,
      projectionDerivedRefs: input.projectionDerivedRefs
    };
  }

  return {
    query: input,
    recentHistory: undefined,
    requestedTask: undefined,
    activeTasks: undefined,
    typedMemory: undefined,
    evidence: undefined,
    projectionDerivedRefs: undefined
  };
}

function estimateTokenCount(content: string, maxTokens: number) {
  if (!content.trim()) {
    return 0;
  }

  return Math.min(maxTokens, Math.max(1, Math.ceil(content.length / 4)));
}

function buildContextBlocks(input: {
  policy: ReturnType<typeof resolveRetrievalPolicy>;
  workingSet: {
    ref?: string;
    version?: number;
    summary: string;
    sourceRefs: string[];
  };
  recentHistory: RecentHistorySurface;
  activeTask?: ActiveTaskSnapshot;
  typedMemory: TypedMemorySurfaceItem[];
  evidence: EvidenceSurfaceItem[];
  turnId: string;
  maxInjectTokens: number;
}): RuntimeContextBlock[] {
  const blocks: RuntimeContextBlock[] = [];
  const tokenSlice = Math.max(1, Math.floor(input.maxInjectTokens / 4));

  if (input.policy.includeWorkingSet && input.workingSet.summary) {
    blocks.push({
      blockId: `memory:${input.turnId}:working_set`,
      kind: "memory",
      title: "session working set",
      content: input.workingSet.summary,
      tokenCount: estimateTokenCount(input.workingSet.summary, tokenSlice * 2),
      sourceRefs: input.workingSet.sourceRefs,
      metadata: {
        workingSetRef: input.workingSet.ref,
        workingSetVersion: input.workingSet.version
      }
    });
  }

  if (input.policy.includeRecentHistory && input.recentHistory.summary) {
    blocks.push({
      blockId: `memory:${input.turnId}:recent_history`,
      kind: "history",
      title: "recent history",
      content: input.recentHistory.summary,
      tokenCount: estimateTokenCount(input.recentHistory.summary, tokenSlice),
      sourceRefs: input.recentHistory.refs
    });
  }

  if (input.policy.includeActiveTask && input.activeTask) {
    const content = [
      input.activeTask.title,
      input.activeTask.currentStep,
      input.activeTask.nextAction,
      input.activeTask.blockingReason
    ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");

    blocks.push({
      blockId: `memory:${input.turnId}:active_task`,
      kind: "task",
      title: "active task",
      content,
      tokenCount: estimateTokenCount(content, tokenSlice),
      sourceRefs: [input.activeTask.taskId, input.activeTask.checkpointRef].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      ),
      metadata: {
        status: input.activeTask.status,
        selectedBy: input.activeTask.selectedBy
      }
    });
  }

  if (input.policy.includeTypedMemory) {
    for (const [index, item] of input.typedMemory.entries()) {
      const content = renderTypedMemorySurfaceContent(item);
      blocks.push({
        blockId: `memory:${input.turnId}:typed_memory:${item.scope ?? "unknown"}:${index}`,
        kind: "memory",
        title: renderScopeTitle(item.scope),
        content,
        tokenCount: estimateTokenCount(content, tokenSlice),
        sourceRefs: item.sourceRefs,
        metadata: {
          scope: item.scope,
          status: item.status,
          payload: item.payload
        }
      });
    }
  }

  if (input.policy.includeEvidence) {
    for (const [index, item] of input.evidence.entries()) {
      const content = [item.topic, item.content].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
      blocks.push({
        blockId: `memory:${input.turnId}:evidence:${index}`,
        kind: "resource",
        title: "evidence",
        content,
        tokenCount: estimateTokenCount(content, tokenSlice),
        sourceRefs: item.sourceRefs
      });
    }
  }

  return blocks;
}

function toTypedMemoryRecord(row: TypedMemoryRow): MaterializedTypedMemoryRecord {
  return {
    memoryId: row.memoryId,
    writeId: row.writeId,
    sourceTurnId: row.sourceTurnId,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    actorId: row.actorId ?? undefined,
    taskId: row.taskId ?? undefined,
    scope: normalizeMemoryScope({
      scope: row.scope,
      kind: row.kind,
      memoryType: row.memoryType,
      taskId: row.taskId,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      actorId: row.actorId
    }),
    importance: row.importance,
    kind: row.kind,
    status: row.status,
    selectionState: row.selectionState ?? "active",
    memoryType: row.memoryType,
    summary: row.summary,
    content: row.content,
    payload: JSON.parse(row.payloadJson),
    evidenceRefs: JSON.parse(row.evidenceRefs) as string[],
    conversationBoundaryKey: row.conversationBoundaryKey ?? undefined,
    visibility: row.visibility ?? undefined,
    borrowedConversationKeys: JSON.parse(row.borrowedConversationKeysJson) as string[],
    transientBorrowed: row.transientBorrowed === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    correctedAt: row.correctedAt ?? undefined,
    supersededByMemoryId: row.supersededByMemoryId ?? undefined,
    correctionId: row.correctionId ?? undefined,
    correctionReason: row.correctionReason ?? undefined,
    correctionActorId: row.correctionActorId ?? undefined
  };
}

function toProjectionDerivedRefSurfaceItem(row: ProjectionDerivedRefRow): ProjectionDerivedRefSurfaceItem {
  return {
    ref: row.ref,
    day: row.day,
    section: row.section,
    summary: row.summary,
    sourceRefs: JSON.parse(row.sourceRefs) as string[],
    turnRefs: JSON.parse(row.turnRefs) as string[]
  };
}

function toWorkingSetSurface(row: LatestWorkingSetRow | undefined) {
  if (!row) {
    return normalizeWorkingSetSurface({
      summary: "",
      sourceRefs: []
    });
  }

  return normalizeWorkingSetSurface({
    ref: row.workingSetRef,
    version: row.version,
    summary: row.summary,
    objective: row.objective ?? undefined,
    recentProgress: JSON.parse(row.recentProgress) as string[],
    recentDecisions: JSON.parse(row.recentDecisions) as string[],
    blockers: JSON.parse(row.blockers) as string[],
    openLoops: JSON.parse(row.openLoops) as string[],
    activeMemoryRefs: JSON.parse(row.activeMemoryRefs) as string[],
    activeTaskRefs: JSON.parse(row.activeTaskRefs) as string[],
    recentEventRefs: JSON.parse(row.recentEventRefs) as string[],
    sourceRefs: JSON.parse(row.sourceRefs) as string[]
  });
}

function createWorkingSetCorrectionTarget(input: { sessionId: string; workspaceId: string; workingSetRef?: string }) {
  return {
    kind: "working_set" as const,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    workingSetRef: input.workingSetRef
  };
}

function createTypedMemoryCorrectionTarget(record: MaterializedTypedMemoryRecord) {
  return {
    kind: "typed_memory" as const,
    memoryId: record.memoryId,
    scope: record.scope,
    workspaceId: record.workspaceId,
    actorId: record.actorId,
    taskId: record.taskId
  };
}

function applyWorkingSetPatch(input: {
  base: ReturnType<typeof normalizeWorkingSetSurface>;
  patch: NonNullable<Extract<CorrectionRequest["operation"], { kind: "rewrite_working_set" }>["workingSet"]>;
  replace: boolean;
  correctionId: string;
}) {
  const base = input.replace
    ? normalizeWorkingSetSurface({
        summary: "",
        sourceRefs: []
      })
    : input.base;
  const sourceRefs = [
    ...(input.patch.sourceRefs ?? base.sourceRefs),
    base.ref,
    input.correctionId
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return normalizeWorkingSetSurface({
    ref: base.ref,
    version: base.version,
    summary: input.patch.summary ?? base.summary,
    objective: input.patch.objective ?? (input.replace ? undefined : base.objective),
    recentProgress: input.patch.recentProgress ?? (input.replace ? [] : base.recentProgress),
    recentDecisions: input.patch.recentDecisions ?? (input.replace ? [] : base.recentDecisions),
    blockers: input.patch.blockers ?? (input.replace ? [] : base.blockers),
    openLoops: input.patch.openLoops ?? (input.replace ? [] : base.openLoops),
    activeMemoryRefs: input.patch.activeMemoryRefs ?? (input.replace ? [] : base.activeMemoryRefs),
    activeTaskRefs: input.patch.activeTaskRefs ?? (input.replace ? [] : base.activeTaskRefs),
    recentEventRefs: input.patch.recentEventRefs ?? (input.replace ? [] : base.recentEventRefs),
    sourceRefs
  });
}

export function createMemoryStore(input: {
  filename: string;
  dailyMemoryProjectionDir?: string;
}) {
  const { filename, dailyMemoryProjectionDir } = input;
  const db = new Database(filename);
  ensureMemorySchema(db);

  const loadLatestVersionStmt = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS version
    FROM session_working_sets
    WHERE session_id = ?
  `);
  const insertWorkingSetStmt = db.prepare(`
    INSERT INTO session_working_sets (
      working_set_ref,
      session_id,
      version,
      summary,
      objective,
      recent_progress,
      recent_decisions,
      blockers,
      open_loops,
      active_memory_refs,
      active_task_refs,
      recent_event_refs,
      highlights,
      blocker_snapshot,
      source_refs,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const loadLatestWorkingSetStmt = db.prepare(`
    SELECT
      working_set_ref AS workingSetRef,
      version,
      summary,
      objective,
      recent_progress AS recentProgress,
      recent_decisions AS recentDecisions,
      blockers,
      open_loops AS openLoops,
      active_memory_refs AS activeMemoryRefs,
      active_task_refs AS activeTaskRefs,
      recent_event_refs AS recentEventRefs,
      highlights,
      blocker_snapshot AS blockerSnapshot,
      source_refs AS sourceRefs
    FROM session_working_sets
    WHERE session_id = ?
    ORDER BY version DESC
    LIMIT 1
  `);
  const loadWorkingSetByRefStmt = db.prepare(`
    SELECT
      working_set_ref AS workingSetRef,
      version,
      summary,
      objective,
      recent_progress AS recentProgress,
      recent_decisions AS recentDecisions,
      blockers,
      open_loops AS openLoops,
      active_memory_refs AS activeMemoryRefs,
      active_task_refs AS activeTaskRefs,
      recent_event_refs AS recentEventRefs,
      highlights,
      blocker_snapshot AS blockerSnapshot,
      source_refs AS sourceRefs
    FROM session_working_sets
    WHERE working_set_ref = ?
    LIMIT 1
  `);
  const insertOutboxStmt = db.prepare(`
    INSERT OR IGNORE INTO memory_outbox (
      write_id,
      source_turn_id,
      session_id,
      workspace_id,
      write_kind,
      evidence_refs,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listOutboxStmt = db.prepare(`
    SELECT
      write_id AS writeId,
      source_turn_id AS sourceTurnId,
      session_id AS sessionId,
      workspace_id AS workspaceId,
      write_kind AS writeKind,
      evidence_refs AS evidenceRefs,
      payload_json AS payloadJson,
      created_at AS createdAt,
      processed_at AS processedAt,
      status,
      attempt_count AS attemptCount,
      last_error AS lastError,
      failed_at AS failedAt
    FROM memory_outbox
    ORDER BY created_at ASC, write_id ASC
  `);
  const insertEvidenceStmt = db.prepare(`
    INSERT OR REPLACE INTO evidence_store (
      evidence_id,
      workspace_id,
      session_id,
      topic,
      content,
      conversation_boundary_key,
      visibility,
      borrowed_conversation_keys_json,
      transient_borrowed,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listEvidenceByWorkspaceStmt = db.prepare(`
    SELECT
      evidence_id AS evidenceId,
      workspace_id AS workspaceId,
      session_id AS sessionId,
      topic,
      content,
      conversation_boundary_key AS conversationBoundaryKey,
      visibility,
      borrowed_conversation_keys_json AS borrowedConversationKeysJson,
      transient_borrowed AS transientBorrowed,
      created_at AS createdAt
    FROM evidence_store
    WHERE workspace_id = ?
  `);
  const upsertTypedMemoryStmt = db.prepare(`
    INSERT INTO typed_memory_store (
      memory_id,
      write_id,
      source_turn_id,
      session_id,
      workspace_id,
      actor_id,
      task_id,
      scope,
      importance,
      memory_kind,
      status,
      selection_state,
      memory_type,
      summary,
      content,
      payload_json,
      evidence_refs,
      conversation_boundary_key,
      visibility,
      borrowed_conversation_keys_json,
      transient_borrowed,
      created_at,
      updated_at,
      corrected_at,
      superseded_by_memory_id,
      correction_id,
      correction_reason,
      correction_actor_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      write_id = excluded.write_id,
      source_turn_id = excluded.source_turn_id,
      session_id = excluded.session_id,
      workspace_id = excluded.workspace_id,
      actor_id = excluded.actor_id,
      task_id = excluded.task_id,
      scope = excluded.scope,
      importance = excluded.importance,
      memory_kind = excluded.memory_kind,
      status = excluded.status,
      selection_state = excluded.selection_state,
      memory_type = excluded.memory_type,
      summary = excluded.summary,
      content = excluded.content,
      payload_json = excluded.payload_json,
      evidence_refs = excluded.evidence_refs,
      conversation_boundary_key = excluded.conversation_boundary_key,
      visibility = excluded.visibility,
      borrowed_conversation_keys_json = excluded.borrowed_conversation_keys_json,
      transient_borrowed = excluded.transient_borrowed,
      updated_at = excluded.updated_at,
      corrected_at = excluded.corrected_at,
      superseded_by_memory_id = excluded.superseded_by_memory_id,
      correction_id = excluded.correction_id,
      correction_reason = excluded.correction_reason,
      correction_actor_id = excluded.correction_actor_id
  `);
  const listTypedMemoryStmt = db.prepare(`
    SELECT
      memory_id AS memoryId,
      write_id AS writeId,
      source_turn_id AS sourceTurnId,
      session_id AS sessionId,
      workspace_id AS workspaceId,
      actor_id AS actorId,
      task_id AS taskId,
      scope,
      importance,
      memory_kind AS kind,
      status,
      selection_state AS selectionState,
      memory_type AS memoryType,
      summary,
      content,
      payload_json AS payloadJson,
      evidence_refs AS evidenceRefs,
      conversation_boundary_key AS conversationBoundaryKey,
      visibility,
      borrowed_conversation_keys_json AS borrowedConversationKeysJson,
      transient_borrowed AS transientBorrowed,
      created_at AS createdAt,
      updated_at AS updatedAt,
      corrected_at AS correctedAt,
      superseded_by_memory_id AS supersededByMemoryId,
      correction_id AS correctionId,
      correction_reason AS correctionReason,
      correction_actor_id AS correctionActorId
    FROM typed_memory_store
    WHERE workspace_id = ?
      OR (? IS NOT NULL AND actor_id = ?)
    ORDER BY updated_at DESC, memory_id DESC
  `);
  const listTypedMemoryForRetrievalStmt = db.prepare(`
    SELECT
      memory_id AS memoryId,
      write_id AS writeId,
      source_turn_id AS sourceTurnId,
      session_id AS sessionId,
      workspace_id AS workspaceId,
      actor_id AS actorId,
      task_id AS taskId,
      scope,
      importance,
      memory_kind AS kind,
      status,
      selection_state AS selectionState,
      memory_type AS memoryType,
      summary,
      content,
      payload_json AS payloadJson,
      evidence_refs AS evidenceRefs,
      conversation_boundary_key AS conversationBoundaryKey,
      visibility,
      borrowed_conversation_keys_json AS borrowedConversationKeysJson,
      transient_borrowed AS transientBorrowed,
      created_at AS createdAt,
      updated_at AS updatedAt,
      corrected_at AS correctedAt,
      superseded_by_memory_id AS supersededByMemoryId,
      correction_id AS correctionId,
      correction_reason AS correctionReason,
      correction_actor_id AS correctionActorId
    FROM typed_memory_store
    WHERE workspace_id = ?
      OR scope = 'user'
      OR (? IS NOT NULL AND actor_id = ?)
    ORDER BY updated_at DESC, memory_id DESC
  `);
  const listTypedMemoryByWorkspaceDayStmt = db.prepare(`
    SELECT
      memory_id AS memoryId,
      write_id AS writeId,
      source_turn_id AS sourceTurnId,
      session_id AS sessionId,
      workspace_id AS workspaceId,
      actor_id AS actorId,
      task_id AS taskId,
      scope,
      importance,
      memory_kind AS kind,
      status,
      selection_state AS selectionState,
      memory_type AS memoryType,
      summary,
      content,
      payload_json AS payloadJson,
      evidence_refs AS evidenceRefs,
      conversation_boundary_key AS conversationBoundaryKey,
      visibility,
      borrowed_conversation_keys_json AS borrowedConversationKeysJson,
      transient_borrowed AS transientBorrowed,
      created_at AS createdAt,
      updated_at AS updatedAt,
      corrected_at AS correctedAt,
      superseded_by_memory_id AS supersededByMemoryId,
      correction_id AS correctionId,
      correction_reason AS correctionReason,
      correction_actor_id AS correctionActorId
    FROM typed_memory_store
    WHERE workspace_id = ? AND substr(updated_at, 1, 10) = ?
    ORDER BY updated_at ASC, memory_type ASC, memory_id ASC
  `);
  const loadTypedMemoryByIdStmt = db.prepare(`
    SELECT
      memory_id AS memoryId,
      write_id AS writeId,
      source_turn_id AS sourceTurnId,
      session_id AS sessionId,
      workspace_id AS workspaceId,
      actor_id AS actorId,
      task_id AS taskId,
      scope,
      importance,
      memory_kind AS kind,
      status,
      selection_state AS selectionState,
      memory_type AS memoryType,
      summary,
      content,
      payload_json AS payloadJson,
      evidence_refs AS evidenceRefs,
      conversation_boundary_key AS conversationBoundaryKey,
      visibility,
      borrowed_conversation_keys_json AS borrowedConversationKeysJson,
      transient_borrowed AS transientBorrowed,
      created_at AS createdAt,
      updated_at AS updatedAt,
      corrected_at AS correctedAt,
      superseded_by_memory_id AS supersededByMemoryId,
      correction_id AS correctionId,
      correction_reason AS correctionReason,
      correction_actor_id AS correctionActorId
    FROM typed_memory_store
    WHERE memory_id = ?
    LIMIT 1
  `);
  const applyTypedMemoryCorrectionStmt = db.prepare(`
    UPDATE typed_memory_store
    SET
      selection_state = ?,
      superseded_by_memory_id = ?,
      correction_id = ?,
      correction_reason = ?,
      correction_actor_id = ?,
      corrected_at = ?,
      updated_at = ?
    WHERE memory_id = ?
  `);
  const deleteProjectionDerivedRefsByWorkspaceDayStmt = db.prepare(`
    DELETE FROM projection_derived_refs
    WHERE workspace_id = ? AND day = ?
  `);
  const insertProjectionDerivedRefStmt = db.prepare(`
    INSERT OR REPLACE INTO projection_derived_refs (
      ref,
      workspace_id,
      day,
      section,
      summary,
      source_refs,
      turn_refs,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listProjectionDerivedRefsByWorkspaceStmt = db.prepare(`
    SELECT
      ref,
      workspace_id AS workspaceId,
      day,
      section,
      summary,
      source_refs AS sourceRefs,
      turn_refs AS turnRefs,
      updated_at AS updatedAt
    FROM projection_derived_refs
    WHERE workspace_id = ?
    ORDER BY day DESC, CASE WHEN section = 'day' THEN 0 ELSE 1 END ASC, updated_at DESC, ref ASC
  `);
  const markOutboxProcessedStmt = db.prepare(`
    UPDATE memory_outbox
    SET
      status = 'processed',
      processed_at = ?,
      attempt_count = attempt_count + 1,
      last_error = NULL,
      failed_at = NULL
    WHERE write_id = ?
  `);
  const markOutboxFailedStmt = db.prepare(`
    UPDATE memory_outbox
    SET
      status = 'failed',
      attempt_count = attempt_count + 1,
      last_error = ?,
      failed_at = ?,
      processed_at = NULL
    WHERE write_id = ?
  `);
  type ListedOutboxEntry = {
    writeId: string;
    sourceTurnId: string;
    sessionId: string;
    workspaceId: string;
    writeKind: MemoryWriteRequest["writeKind"];
    evidenceRefs: string[];
    payload: MemoryWriteRequest;
    createdAt: string;
    processedAt: string | null;
    status: "pending" | "processed" | "failed";
    attemptCount: number;
    lastError: string | null;
    failedAt: string | null;
  };

  function listOutboxEntries(): ListedOutboxEntry[] {
    return (listOutboxStmt.all() as OutboxRow[]).map((row) => ({
      writeId: row.writeId,
      sourceTurnId: row.sourceTurnId,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      writeKind: row.writeKind,
      evidenceRefs: JSON.parse(row.evidenceRefs) as string[],
      payload: JSON.parse(row.payloadJson) as MemoryWriteRequest,
      createdAt: row.createdAt,
      processedAt: row.processedAt,
      status: row.status,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
      failedAt: row.failedAt
    }));
  }

  const materializeOutboxTxn = db.transaction((outbox: ListedOutboxEntry, processedAt: string) => {
    const consumed = consumeOutboxEntry(outbox);

    upsertTypedMemoryStmt.run(
      consumed.typedMemory.memoryId,
      consumed.typedMemory.writeId,
      consumed.typedMemory.sourceTurnId,
      consumed.typedMemory.sessionId,
      consumed.typedMemory.workspaceId,
      consumed.typedMemory.actorId ?? null,
      consumed.typedMemory.taskId ?? null,
      consumed.typedMemory.scope ?? null,
      consumed.typedMemory.importance,
      consumed.typedMemory.kind,
      consumed.typedMemory.status,
      consumed.typedMemory.selectionState,
      consumed.typedMemory.memoryType,
      consumed.typedMemory.summary,
      consumed.typedMemory.content,
      JSON.stringify(consumed.typedMemory.payload),
      JSON.stringify(consumed.typedMemory.evidenceRefs),
      consumed.typedMemory.conversationBoundaryKey ?? null,
      consumed.typedMemory.visibility ?? null,
      JSON.stringify(consumed.typedMemory.borrowedConversationKeys),
      consumed.typedMemory.transientBorrowed ? 1 : 0,
      consumed.typedMemory.createdAt,
      processedAt,
      consumed.typedMemory.correctedAt ?? null,
      consumed.typedMemory.supersededByMemoryId ?? null,
      consumed.typedMemory.correctionId ?? null,
      consumed.typedMemory.correctionReason ?? null,
      consumed.typedMemory.correctionActorId ?? null
    );

    if (consumed.evidence) {
      insertEvidenceStmt.run(
        consumed.evidence.evidenceId,
        outbox.workspaceId,
        consumed.evidence.sessionId,
        consumed.evidence.topic,
        consumed.evidence.content,
        consumed.typedMemory.conversationBoundaryKey ?? null,
        consumed.typedMemory.visibility ?? null,
        JSON.stringify(consumed.typedMemory.borrowedConversationKeys),
        consumed.typedMemory.transientBorrowed ? 1 : 0,
        consumed.evidence.createdAt
      );
    }

    markOutboxProcessedStmt.run(processedAt, outbox.writeId);
  });
  const replaceProjectionDerivedRefsByWorkspaceDayTxn = db.transaction((input: {
    workspaceId: string;
    day: string;
    refs: ProjectionDerivedRefSurfaceItem[];
    updatedAt: string;
  }) => {
    deleteProjectionDerivedRefsByWorkspaceDayStmt.run(input.workspaceId, input.day);

    for (const ref of input.refs) {
      insertProjectionDerivedRefStmt.run(
        ref.ref,
        input.workspaceId,
        ref.day,
        ref.section,
        ref.summary,
        JSON.stringify(ref.sourceRefs),
        JSON.stringify(ref.turnRefs),
        input.updatedAt
      );
    }
  });

  function projectDailyMemoryForDate(input: { workspaceId: string; day: string; updatedAt: string }) {
    if (!dailyMemoryProjectionDir) {
      return;
    }

    const records = (listTypedMemoryByWorkspaceDayStmt.all(input.workspaceId, input.day) as TypedMemoryRow[])
      .map(toTypedMemoryRecord);

    if (records.length === 0) {
      return;
    }

    const projection = writeDailyMemoryProjectionFile({
      rootDir: dailyMemoryProjectionDir,
      workspaceId: input.workspaceId,
      day: input.day,
      records
    });

    replaceProjectionDerivedRefsByWorkspaceDayTxn({
      workspaceId: input.workspaceId,
      day: input.day,
      refs: projection.projectionDerivedRefs,
      updatedAt: input.updatedAt
    });
  }

  async function persistWorkingSet(input: {
    sessionId: string;
    summary: string;
    highlights: string[];
    sourceRefs: string[];
    blockerSnapshot?: string;
    objective?: string;
    recentProgress?: string[];
    recentDecisions?: string[];
    blockers?: string[];
    openLoops?: string[];
    activeMemoryRefs?: string[];
    activeTaskRefs?: string[];
    recentEventRefs?: string[];
  }) {
    const row = loadLatestVersionStmt.get(input.sessionId) as { version: number };
    const version = row.version + 1;
    const workingSetRef = `working_set:${input.sessionId}:${version}`;
    const workingSet = normalizeWorkingSetSurface({
      ref: workingSetRef,
      version,
      summary: input.summary,
      objective: input.objective,
      recentProgress: input.recentProgress,
      recentDecisions: input.recentDecisions,
      blockers: input.blockers,
      openLoops: input.openLoops,
      activeMemoryRefs: input.activeMemoryRefs,
      activeTaskRefs: input.activeTaskRefs,
      recentEventRefs: input.recentEventRefs,
      sourceRefs: input.sourceRefs
    });

    insertWorkingSetStmt.run(
      workingSetRef,
      input.sessionId,
      version,
      workingSet.summary,
      workingSet.objective ?? null,
      JSON.stringify(workingSet.recentProgress),
      JSON.stringify(workingSet.recentDecisions),
      JSON.stringify(workingSet.blockers),
      JSON.stringify(workingSet.openLoops),
      JSON.stringify(workingSet.activeMemoryRefs),
      JSON.stringify(workingSet.activeTaskRefs),
      JSON.stringify(workingSet.recentEventRefs),
      JSON.stringify(input.highlights),
      input.blockerSnapshot ?? null,
      JSON.stringify(workingSet.sourceRefs),
      new Date().toISOString()
    );

    return { workingSetRef, version, workingSet };
  }

  return {
    async updateWorkingSet(input: {
      sessionId: string;
      summary: string;
      highlights: string[];
      sourceRefs: string[];
      blockerSnapshot?: string;
      objective?: string;
      recentProgress?: string[];
      recentDecisions?: string[];
      blockers?: string[];
      openLoops?: string[];
      activeMemoryRefs?: string[];
      activeTaskRefs?: string[];
      recentEventRefs?: string[];
    }) {
      const persisted = await persistWorkingSet(input);
      return { workingSetRef: persisted.workingSetRef, version: persisted.version };
    },

    async retrieve(input: RetrieveInput): Promise<RuntimeMemoryContext> {
      const normalized = normalizeRetrieveInput(input);
      const latest = normalized.query.memoryTypes.includes("working_set")
        ? (loadLatestWorkingSetStmt.get(normalized.query.sessionId) as LatestWorkingSetRow | undefined)
        : undefined;
      const policy = resolveRetrievalPolicy({
        purpose: normalized.query.purpose,
        resumeFrom: normalized.query.resumeFrom,
        requestedTask: normalized.requestedTask,
        activeTasks: normalized.activeTasks
      });
      const activeTask = selectActiveTaskSnapshot({
        purpose: normalized.query.purpose,
        resumeFrom: normalized.query.resumeFrom,
        requestedTask: normalized.requestedTask,
        activeTasks: normalized.activeTasks
      });
      const workingSet = toWorkingSetSurface(latest);
      const recentHistory = normalized.recentHistory ?? {
        summary: "",
        refs: [],
        turnRefs: []
      };
      const durableTypedMemory = normalized.query.memoryTypes.includes("typed_memory")
        ? (listTypedMemoryForRetrievalStmt.all(
            normalized.query.workspaceId,
            normalized.query.actorId ?? null,
            normalized.query.actorId ?? null
          ) as TypedMemoryRow[])
          .map(toTypedMemoryRecord)
          .filter((record) => isMemoryRecordVisibleToQuery({
            record: {
              conversationBoundaryKey: record.conversationBoundaryKey,
              visibility: record.visibility
            },
            query: normalized.query
          }))
        : [];
      const typedMemorySelection = normalized.typedMemory
        ? undefined
        : selectTypedMemorySurfacesWithObservability({
            rows: durableTypedMemory,
            policy,
            selectedTaskId: activeTask?.taskId ?? normalized.query.taskId,
            purpose: normalized.query.purpose,
            queryText: normalized.query.queryText,
            scopeFilter: normalized.query.scopeFilter,
            sessionId: normalized.query.sessionId,
            workspaceId: normalized.query.workspaceId,
            actorId: normalized.query.actorId,
            maxItems: normalized.query.maxItems
          });
      const typedMemory = normalized.typedMemory ?? typedMemorySelection?.items ?? [];
      const evidenceRecords = normalized.evidence
        ? []
        : normalized.query.memoryTypes.includes("evidence")
          ? searchEvidenceRows({
              rows: (listEvidenceByWorkspaceStmt.all(normalized.query.workspaceId) as EvidenceRow[])
                .filter((row) => isMemoryRecordVisibleToQuery({
                  record: {
                    conversationBoundaryKey: row.conversationBoundaryKey ?? undefined,
                    visibility: row.visibility ?? undefined
                  },
                  query: normalized.query
                })),
              queryText: normalized.query.queryText,
              maxItems: normalized.query.maxItems
            })
          : [];
      const evidence = normalized.evidence ?? evidenceRecords.map(createEvidenceSurfaceItem);
      const durableProjectionDerivedRefs = normalized.projectionDerivedRefs
        ? []
        : (listProjectionDerivedRefsByWorkspaceStmt.all(normalized.query.workspaceId) as ProjectionDerivedRefRow[])
          .map(toProjectionDerivedRefSurfaceItem);
      const projectionDerivedRefs = normalized.projectionDerivedRefs
        ?? selectProjectionDerivedRefs({
          rows: durableProjectionDerivedRefs,
          queryText: normalized.query.queryText,
          maxItems: normalized.query.maxItems
        });
      const contextBlocks = buildContextBlocks({
        policy,
        workingSet,
        recentHistory,
        activeTask,
        typedMemory,
        evidence,
        turnId: normalized.query.queryId,
        maxInjectTokens: normalized.query.maxInjectTokens
      });
      const tokenEstimate = contextBlocks.reduce((total, block) => total + (block.tokenCount ?? 0), 0);
      const sourceRefs = [...new Set([
        ...workingSet.sourceRefs,
        ...typedMemory.flatMap((item) => item.sourceRefs),
        ...evidence.flatMap((item) => item.sourceRefs)
      ])];
      const retrievedItems = [
        ...(policy.includeWorkingSet && workingSet.summary ? [{ kind: "working_set", summary: workingSet.summary }] : []),
        ...(policy.includeRecentHistory && recentHistory.summary ? [{ kind: "recent_history", summary: recentHistory.summary }] : []),
        ...(policy.includeActiveTask && activeTask ? [{ kind: "active_task", taskId: activeTask.taskId }] : []),
        ...(policy.includeTypedMemory
          ? typedMemory.map((item) => ({
              kind: "typed_memory",
              memoryType: item.memoryType,
              sourceRefs: item.sourceRefs
            }))
          : []),
        ...(policy.includeEvidence
          ? evidence.map((item) => ({
              kind: "evidence",
              ref: item.ref,
              sourceRefs: item.sourceRefs
            }))
          : [])
      ];
      const injectionPlan = contextBlocks.map((block) => ({
        kind: block.kind,
        tokenBudget: block.tokenCount ?? 0,
        blockId: block.blockId
      }));

      return {
        workingSetSummary: workingSet.summary,
        retrievedItems,
        injectionPlan,
        tokenEstimate,
        sourceRefs,
        continuity: {
          retrievalPolicy: policy,
          recentHistory,
          workingSet,
          activeTask,
          typedMemory,
          evidence,
          projectionDerivedRefs
        },
        contextBlocks,
        observability: {
          durableMemory: typedMemorySelection?.observability
        }
      };
    },

    async enqueueWrites(writes: MemoryWriteRequest[]) {
      for (const write of writes) {
        insertOutboxStmt.run(
          write.writeId,
          write.sourceTurnId,
          write.sessionId,
          write.workspaceId,
          write.writeKind,
          JSON.stringify(write.evidenceRefs),
          JSON.stringify(write),
          new Date().toISOString()
        );
      }

      return writes;
    },

    async listOutbox() {
      return listOutboxEntries();
    },

    async drainOutbox(input: { maxItems: number; includeFailed?: boolean }) {
      const eligible = listOutboxEntries()
        .filter((row) => row.status === "pending" || (input.includeFailed && row.status === "failed"))
        .sort((left, right) => {
          if (left.status !== right.status) {
            return left.status === "pending" ? -1 : 1;
          }

          if (left.createdAt !== right.createdAt) {
            return left.createdAt.localeCompare(right.createdAt);
          }

          return left.writeId.localeCompare(right.writeId);
        })
        .slice(0, input.maxItems);
      let processedCount = 0;
      let failedCount = 0;
      let projectionFailureCount = 0;

      for (const outbox of eligible) {
        try {
          const processedAt = new Date().toISOString();
          materializeOutboxTxn(outbox, processedAt);
          processedCount += 1;

          try {
            projectDailyMemoryForDate({
              workspaceId: outbox.workspaceId,
              day: processedAt.slice(0, 10),
              updatedAt: processedAt
            });
          } catch {
            projectionFailureCount += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          markOutboxFailedStmt.run(message, new Date().toISOString(), outbox.writeId);
          failedCount += 1;
        }
      }

      return {
        processedCount,
        failedCount,
        projectionFailureCount,
        attemptedWriteIds: eligible.map((row) => row.writeId)
      };
    },

    async listTypedMemory(input: { sessionId: string; workspaceId: string; actorId?: string }) {
      return (listTypedMemoryStmt.all(input.workspaceId, input.actorId ?? null, input.actorId ?? null) as TypedMemoryRow[]).map(toTypedMemoryRecord);
    },

    async inspectCorrections(input: {
      sessionId: string;
      workspaceId: string;
      actorId?: string;
    }): Promise<CorrectionInspection> {
      const workingSet = toWorkingSetSurface(loadLatestWorkingSetStmt.get(input.sessionId) as LatestWorkingSetRow | undefined);
      const typedMemory = (listTypedMemoryStmt.all(input.workspaceId, input.actorId ?? null, input.actorId ?? null) as TypedMemoryRow[])
        .map(toTypedMemoryRecord)
        .map((record) => ({
          target: createTypedMemoryCorrectionTarget(record),
          record
        }));

      return {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        workingSet: workingSet.ref
          ? {
              target: createWorkingSetCorrectionTarget({
                sessionId: input.sessionId,
                workspaceId: input.workspaceId,
                workingSetRef: workingSet.ref
              }),
              workingSet
            }
          : undefined,
        typedMemory
      };
    },

    async applyCorrection(rawInput: CorrectionRequestInput): Promise<CorrectionResult> {
      const input = CorrectionRequestSchema.parse(rawInput);
      const appliedAt = new Date().toISOString();

      if (input.target.kind === "working_set") {
        const targetedRow = input.target.workingSetRef
          ? loadWorkingSetByRefStmt.get(input.target.workingSetRef) as LatestWorkingSetRow | undefined
          : loadLatestWorkingSetStmt.get(input.target.sessionId) as LatestWorkingSetRow | undefined;
        const baseWorkingSet = toWorkingSetSurface(targetedRow);

        const correctedWorkingSet = input.operation.kind === "refresh_working_set"
          ? normalizeWorkingSetSurface({
              summary: "",
              sourceRefs: [baseWorkingSet.ref, input.correctionId].filter((value): value is string => typeof value === "string" && value.length > 0)
            })
          : input.operation.kind === "rewrite_working_set"
            ? applyWorkingSetPatch({
                base: baseWorkingSet,
                patch: input.operation.workingSet,
                replace: input.operation.replace,
                correctionId: input.correctionId
              })
            : baseWorkingSet;

        const persisted = await persistWorkingSet({
          sessionId: input.target.sessionId,
          summary: correctedWorkingSet.summary,
          highlights: [
            correctedWorkingSet.objective,
            correctedWorkingSet.recentProgress[0],
            correctedWorkingSet.blockers[0],
            correctedWorkingSet.openLoops[0]
          ].filter((value): value is string => typeof value === "string" && value.length > 0),
          sourceRefs: correctedWorkingSet.sourceRefs,
          objective: correctedWorkingSet.objective,
          recentProgress: correctedWorkingSet.recentProgress,
          recentDecisions: correctedWorkingSet.recentDecisions,
          blockers: correctedWorkingSet.blockers,
          openLoops: correctedWorkingSet.openLoops,
          activeMemoryRefs: correctedWorkingSet.activeMemoryRefs,
          activeTaskRefs: correctedWorkingSet.activeTaskRefs,
          recentEventRefs: correctedWorkingSet.recentEventRefs
        });

        return {
          correctionId: input.correctionId,
          target: createWorkingSetCorrectionTarget({
            sessionId: input.target.sessionId,
            workspaceId: input.target.workspaceId,
            workingSetRef: persisted.workingSetRef
          }),
          applied: true,
          appliedAt,
          summary: input.operation.kind === "refresh_working_set"
            ? `working set refreshed for ${input.target.sessionId}`
            : `working set rewritten for ${input.target.sessionId}`,
          workingSet: persisted.workingSet
        };
      }

      const existingRow = loadTypedMemoryByIdStmt.get(input.target.memoryId) as TypedMemoryRow | undefined;
      if (!existingRow) {
        throw new Error(`Typed memory ${input.target.memoryId} does not exist.`);
      }

      const selectionState = input.operation.kind === "mark_memory_stale"
        ? "stale"
        : input.operation.kind === "mark_memory_superseded"
          ? "superseded"
          : input.operation.kind === "disable_memory"
            ? "disabled"
            : input.operation.kind === "restore_memory"
              ? "active"
              : toTypedMemoryRecord(existingRow).selectionState;
      const supersededByMemoryId = input.operation.kind === "mark_memory_superseded"
        ? input.operation.supersededByMemoryId ?? null
        : null;

      applyTypedMemoryCorrectionStmt.run(
        selectionState,
        supersededByMemoryId,
        input.correctionId,
        input.reason ?? null,
        input.actorId ?? null,
        appliedAt,
        appliedAt,
        input.target.memoryId
      );

      const updatedRow = loadTypedMemoryByIdStmt.get(input.target.memoryId) as TypedMemoryRow | undefined;
      if (!updatedRow) {
        throw new Error(`Typed memory ${input.target.memoryId} disappeared during correction.`);
      }

      return {
        correctionId: input.correctionId,
        target: createTypedMemoryCorrectionTarget(toTypedMemoryRecord(updatedRow)),
        applied: true,
        appliedAt,
        summary: `${selectionState} correction applied to ${input.target.memoryId}`,
        typedMemory: toTypedMemoryRecord(updatedRow)
      };
    },

    async appendEvidence(input: {
      evidenceId: string;
      workspaceId: string;
      sessionId: string;
      content: string;
      topic: string;
    }) {
      insertEvidenceStmt.run(
        input.evidenceId,
        input.workspaceId,
        input.sessionId,
        input.topic,
        input.content,
        null,
        null,
        JSON.stringify([]),
        0,
        new Date().toISOString()
      );
    },

    async searchEvidence(input: EvidenceSearchQuery) {
      const rows = listEvidenceByWorkspaceStmt.all(input.workspaceId) as EvidenceRow[];
      return searchEvidenceRows({ rows, queryText: input.queryText, maxItems: input.maxItems });
    }
  };
}

function selectProjectionDerivedRefs(input: {
  rows: ProjectionDerivedRefSurfaceItem[];
  queryText?: string;
  maxItems: number;
}) {
  const limit = Math.max(0, input.maxItems);
  if (limit === 0) {
    return [];
  }

  if (!input.queryText || input.queryText.trim().length === 0) {
    return input.rows.slice(0, limit);
  }

  return input.rows
    .map((row) => ({ row, score: scoreProjectionDerivedRef(row, input.queryText as string) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.row.day !== left.row.day) {
        return right.row.day.localeCompare(left.row.day);
      }

      if (left.row.section !== right.row.section && (left.row.section === "day" || right.row.section === "day")) {
        return left.row.section === "day" ? -1 : 1;
      }

      return left.row.ref.localeCompare(right.row.ref);
    })
    .slice(0, limit)
    .map((entry) => entry.row);
}

function searchEvidenceRows(input: {
  rows: EvidenceRow[];
  queryText?: string;
  maxItems: number;
}) {
  if (!input.queryText || input.queryText.trim().length === 0) {
    return [];
  }

  return input.rows
    .map((row) => ({ row, score: scoreEvidence(row, input.queryText as string) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.row.createdAt !== left.row.createdAt) {
        return right.row.createdAt.localeCompare(left.row.createdAt);
      }

      return left.row.evidenceId.localeCompare(right.row.evidenceId);
    })
    .slice(0, input.maxItems)
    .map((entry) => ({
      evidenceId: entry.row.evidenceId,
      sessionId: entry.row.sessionId,
      topic: entry.row.topic,
      content: entry.row.content,
      createdAt: entry.row.createdAt
    } satisfies EvidenceRecord));
}
