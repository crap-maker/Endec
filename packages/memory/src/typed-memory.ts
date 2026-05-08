import type { EvidenceRecord, EvidenceSurfaceItem, MemoryWriteRequest, TypedMemorySurfaceItem } from "@endec/domain";
import { normalizeMemoryScope } from "./memory-scope.ts";

export type TypedMemoryContract =
  | {
      kind: "candidate_extract";
      status: "pending";
    }
  | {
      kind: "typed_upsert";
      status: "ready";
      memoryType: string;
    };

export type TypedMemoryContractPlan = {
  writeId: string;
  contract: "candidate_extract_pending" | "typed_upsert_ready";
  target: "typed_memory_pipeline" | "typed_memory_store";
  typedMemory: TypedMemoryContract;
  evidence: {
    refs: string[];
  };
};

export type MaterializedTypedMemoryRecord = {
  memoryId: string;
  writeId: string;
  sourceTurnId: string;
  sessionId: string;
  workspaceId: string;
  actorId?: string;
  taskId?: string;
  scope?: MemoryWriteRequest["scope"];
  importance: number;
  kind: MemoryWriteRequest["writeKind"];
  status: "materialized";
  selectionState: "active" | "stale" | "superseded" | "disabled";
  memoryType: string;
  summary: string;
  content: string;
  payload: unknown;
  evidenceRefs: string[];
  conversationBoundaryKey?: string;
  visibility?: MemoryWriteRequest["visibility"];
  borrowedConversationKeys: string[];
  transientBorrowed: boolean;
  createdAt: string;
  updatedAt: string;
  correctedAt?: string;
  supersededByMemoryId?: string;
  correctionId?: string;
  correctionReason?: string;
  correctionActorId?: string;
};

function stringifyScalar(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function renderStructuredContent(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => renderStructuredContent(item))
      .filter((item) => item.length > 0)
      .join("\n");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "summary",
    "content",
    "evidence",
    "assistantResponse",
    "assistant",
    "userInput",
    "user",
    "value",
    "topic",
    "note"
  ];
  const lines: string[] = [];

  for (const key of preferredKeys) {
    const entry = record[key];
    if (entry === undefined) {
      continue;
    }

    const rendered = renderStructuredContent(entry);
    if (rendered.length === 0) {
      continue;
    }

    lines.push(`${key}: ${rendered}`);
  }

  for (const [key, entry] of Object.entries(record)) {
    if (preferredKeys.includes(key)) {
      continue;
    }

    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      const rendered = stringifyScalar(entry).trim();
      if (rendered.length > 0) {
        lines.push(`${key}: ${rendered}`);
      }
    }
  }

  if (lines.length > 0) {
    return lines.join("\n");
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function pickSummary(content: unknown, fallback: string) {
  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const candidates = [record.summary, record.content, record.evidence, record.value, record.userInput, record.assistantResponse]
      .map((value) => renderStructuredContent(value))
      .filter((value) => value.length > 0);

    if (candidates[0]) {
      return candidates[0];
    }
  }

  return fallback;
}

export function createTypedMemoryContract(input: {
  writeId: string;
  write: Pick<MemoryWriteRequest, "writeKind" | "evidenceRefs" | "proposedMemoryType">;
}): TypedMemoryContractPlan {
  if (input.write.writeKind === "typed_upsert") {
    return {
      writeId: input.writeId,
      contract: "typed_upsert_ready",
      target: "typed_memory_store",
      typedMemory: {
        kind: "typed_upsert",
        status: "ready",
        memoryType: input.write.proposedMemoryType ?? "untyped"
      },
      evidence: {
        refs: input.write.evidenceRefs
      }
    };
  }

  return {
    writeId: input.writeId,
    contract: "candidate_extract_pending",
    target: "typed_memory_pipeline",
    typedMemory: {
      kind: "candidate_extract",
      status: "pending"
    },
    evidence: {
      refs: input.write.evidenceRefs
    }
  };
}

export function createTypedMemorySurfaceItem(input: {
  sourceTurnId: string;
  plan: TypedMemoryContractPlan;
}): TypedMemorySurfaceItem {
  return {
    kind: input.plan.typedMemory.kind,
    status: input.plan.typedMemory.status,
    memoryType: "memoryType" in input.plan.typedMemory ? input.plan.typedMemory.memoryType : undefined,
    sourceRefs: [input.sourceTurnId, ...input.plan.evidence.refs],
    payload: {
      contract: input.plan.contract,
      target: input.plan.target,
      writeId: input.plan.writeId
    }
  };
}

export function createEvidenceSurfaceItem(record: Pick<EvidenceRecord, "evidenceId" | "topic" | "content" | "sessionId">) {
  return {
    ref: record.evidenceId,
    topic: record.topic,
    content: record.content,
    sourceRefs: [record.evidenceId, record.sessionId]
  } satisfies EvidenceSurfaceItem;
}

export function createMaterializedMemoryId(write: Pick<MemoryWriteRequest, "writeId" | "sessionId" | "dedupeKey">) {
  if (write.dedupeKey && write.dedupeKey.length > 0) {
    return `typed_memory:${write.sessionId}:${write.dedupeKey}`;
  }

  return `typed_memory:${write.writeId}`;
}

export function createMaterializedTypedMemoryRecord(input: {
  write: MemoryWriteRequest;
  recordedAt: string;
}): MaterializedTypedMemoryRecord {
  const memoryType = input.write.proposedMemoryType
    ?? (input.write.writeKind === "typed_upsert" ? "untyped" : input.write.taskId ? "task_continuity" : "turn_summary");
  const fallbackSummary = input.write.writeKind === "typed_upsert"
    ? `typed memory upsert from ${input.write.sourceTurnId}`
    : `candidate extract from ${input.write.sourceTurnId}`;
  const summary = pickSummary(input.write.content, fallbackSummary);
  const content = renderStructuredContent(input.write.content) || summary;

  if (input.write.writeKind === "typed_upsert" && (!input.write.content || content.trim().length === 0)) {
    throw new Error(`typed_upsert ${input.write.writeId} requires materializable content`);
  }

  return {
    memoryId: createMaterializedMemoryId(input.write),
    writeId: input.write.writeId,
    sourceTurnId: input.write.sourceTurnId,
    sessionId: input.write.sessionId,
    workspaceId: input.write.workspaceId,
    actorId: input.write.actorId,
    taskId: input.write.taskId,
    scope: normalizeMemoryScope({
      scope: input.write.scope,
      kind: input.write.writeKind,
      memoryType,
      taskId: input.write.taskId
    }),
    importance: Math.max(0, input.write.importance ?? 0),
    kind: input.write.writeKind,
    status: "materialized",
    selectionState: "active",
    memoryType,
    summary,
    content,
    payload: input.write.content ?? { summary },
    evidenceRefs: input.write.evidenceRefs,
    conversationBoundaryKey: input.write.conversationBoundaryKey,
    visibility: input.write.visibility,
    borrowedConversationKeys: input.write.borrowedConversationKeys ?? [],
    transientBorrowed: input.write.transientBorrowed ?? false,
    createdAt: input.recordedAt,
    updatedAt: input.recordedAt,
    correctedAt: undefined,
    supersededByMemoryId: undefined,
    correctionId: undefined,
    correctionReason: undefined,
    correctionActorId: undefined
  };
}

export function createMaterializedTypedMemorySurfaceItem(record: MaterializedTypedMemoryRecord): TypedMemorySurfaceItem {
  return {
    kind: record.kind,
    status: record.status,
    scope: record.scope,
    memoryType: record.memoryType,
    sourceRefs: [record.memoryId, record.sourceTurnId, ...record.evidenceRefs],
    payload: {
      memoryId: record.memoryId,
      writeId: record.writeId,
      summary: record.summary,
      content: record.content,
      payload: record.payload
    }
  };
}

function stripDuplicatedSummary(content: string, summary: string) {
  if (content.length === 0 || summary.length === 0) {
    return content;
  }

  const normalizedSummary = summary.trim();
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== normalizedSummary && trimmed !== `summary: ${normalizedSummary}`;
    })
    .join("\n")
    .trim();
}

export function renderTypedMemorySurfaceContent(item: TypedMemorySurfaceItem) {
  if (!item.payload || typeof item.payload !== "object") {
    return item.memoryType ? `${item.kind}: ${item.memoryType}` : item.kind;
  }

  const payload = item.payload as {
    summary?: unknown;
    content?: unknown;
    payload?: unknown;
  };
  const summary = renderStructuredContent(payload.summary);
  const content = stripDuplicatedSummary(
    renderStructuredContent(payload.content ?? payload.payload),
    summary
  );
  const lines = [
    item.scope ? `scope: ${item.scope}` : "",
    item.memoryType ? `type: ${item.memoryType}` : `kind: ${item.kind}`
  ].filter((line) => line.length > 0);

  if (summary.length > 0) {
    lines.push(`summary: ${summary}`);
  }

  if (content.length > 0 && content !== summary) {
    lines.push(content);
  }

  return lines.join("\n");
}
