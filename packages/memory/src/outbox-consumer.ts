import type { EvidenceRecord, MemoryWriteRequest, TypedMemorySurfaceItem } from "@endec/domain";
import {
  createMaterializedTypedMemoryRecord,
  createTypedMemoryContract,
  createTypedMemorySurfaceItem,
  type MaterializedTypedMemoryRecord
} from "./typed-memory.ts";

export type OutboxConsumptionResult = {
  typedMemory: MaterializedTypedMemoryRecord;
  evidence?: EvidenceRecord;
};

function deriveEvidenceTopic(write: MemoryWriteRequest, typedMemory: MaterializedTypedMemoryRecord) {
  if (write.content && typeof write.content === "object" && !Array.isArray(write.content)) {
    const topic = (write.content as { topic?: unknown }).topic;
    if (typeof topic === "string" && topic.trim().length > 0) {
      return topic.trim();
    }
  }

  return typedMemory.memoryType;
}

function deriveEvidenceContent(write: MemoryWriteRequest, typedMemory: MaterializedTypedMemoryRecord) {
  if (write.content && typeof write.content === "object" && !Array.isArray(write.content)) {
    const evidence = (write.content as { evidence?: unknown; content?: unknown }).evidence
      ?? (write.content as { content?: unknown }).content;
    if (typeof evidence === "string" && evidence.trim().length > 0) {
      return evidence.trim();
    }
  }

  return typedMemory.content;
}

export function planOutboxConsumption(input: {
  writeId: string;
  sourceTurnId: string;
  sessionId: string;
  workspaceId: string;
  writeKind: MemoryWriteRequest["writeKind"];
  evidenceRefs: string[];
  payload: MemoryWriteRequest;
  createdAt: string;
  processedAt: string | null;
}) {
  return createTypedMemoryContract({
    writeId: input.writeId,
    write: input.payload
  });
}

export function consumeOutboxEntry(input: {
  writeId: string;
  sourceTurnId: string;
  sessionId: string;
  workspaceId: string;
  writeKind: MemoryWriteRequest["writeKind"];
  evidenceRefs: string[];
  payload: MemoryWriteRequest;
  createdAt: string;
  processedAt: string | null;
}): OutboxConsumptionResult {
  const typedMemory = createMaterializedTypedMemoryRecord({
    write: input.payload,
    recordedAt: input.createdAt
  });

  if (input.payload.writeKind !== "candidate_extract") {
    return { typedMemory };
  }

  return {
    typedMemory,
    evidence: {
      evidenceId: `evidence:${input.writeId}`,
      sessionId: input.sessionId,
      topic: deriveEvidenceTopic(input.payload, typedMemory),
      content: deriveEvidenceContent(input.payload, typedMemory),
      createdAt: input.createdAt
    }
  };
}

export function createOutboxTypedMemorySurface(input: {
  writeId: string;
  sourceTurnId: string;
  sessionId: string;
  workspaceId: string;
  writeKind: MemoryWriteRequest["writeKind"];
  evidenceRefs: string[];
  payload: MemoryWriteRequest;
  createdAt: string;
  processedAt: string | null;
}): TypedMemorySurfaceItem {
  const plan = planOutboxConsumption(input);
  return createTypedMemorySurfaceItem({
    sourceTurnId: input.sourceTurnId,
    plan
  });
}
