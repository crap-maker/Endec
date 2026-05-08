import type { MemoryWriteRequest, TurnRequest } from "@endec/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@endec/memory";
import { createContextAssembler } from "./context-assembler.ts";
import { createAppToolPort } from "./tool-port.ts";

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli",
    actorId: "actor_cli",
    input: "What continuity and preference should I follow?",
    attachments: [],
    ...overrides
  };
}

function createWrite(
  overrides: Omit<Partial<MemoryWriteRequest>, "scope" | "workspaceId"> & {
    writeId: string;
    sourceTurnId: string;
    writeKind: MemoryWriteRequest["writeKind"];
    scope?: string;
    workspaceId?: string;
    actorId?: string;
  }
): MemoryWriteRequest {
  return {
    writeId: overrides.writeId,
    sourceTurnId: overrides.sourceTurnId,
    sessionId: overrides.sessionId ?? "session_001",
    workspaceId: overrides.workspaceId ?? "workspace_local",
    actorId: overrides.actorId,
    writeKind: overrides.writeKind,
    evidenceRefs: overrides.evidenceRefs ?? [overrides.sourceTurnId],
    taskId: overrides.taskId,
    scope: overrides.scope as MemoryWriteRequest["scope"],
    proposedMemoryType: overrides.proposedMemoryType,
    importance: overrides.importance,
    dedupeKey: overrides.dedupeKey,
    metadata: overrides.metadata,
    content: overrides.content ?? {
      summary: overrides.writeId,
      evidence: `${overrides.writeId} evidence`
    }
  };
}

function createInlineArtifactPolicy() {
  return {
    async spillIfNeeded(input: {
      turnId: string;
      sessionId: string;
      kind: "runtime_output" | "tool_result";
      mimeType?: string;
      content: string;
    }) {
      return {
        kind: "inline" as const,
        content: input.content
      };
    }
  };
}

async function materializeWrite(store: ReturnType<typeof createMemoryStore>, write: MemoryWriteRequest, at: string) {
  vi.setSystemTime(new Date(at));
  await store.enqueueWrites([write]);
  await store.drainOutbox({ maxItems: 1 });
}

describe("correction observability link", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps observability targets to correction requests that change the next assembled context", async () => {
    const memoryStore = createMemoryStore({ filename: ":memory:" });
    await memoryStore.updateWorkingSet({
      sessionId: "session_001",
      summary: "Objective: stale continuity objective",
      highlights: ["stale continuity objective"],
      sourceRefs: ["turn_initial"],
      objective: "stale continuity objective",
      recentProgress: ["kept the stale continuity envelope"],
      blockers: ["old blocker"],
      openLoops: ["obsolete loop"]
    });
    await materializeWrite(memoryStore, createWrite({
      writeId: "write_old_preference",
      sourceTurnId: "turn_old_preference",
      writeKind: "typed_upsert",
      scope: "user",
      actorId: "actor_cli",
      workspaceId: "workspace_other",
      proposedMemoryType: "preference",
      importance: 1,
      content: { summary: "Old user preference: keep replies ultra terse." }
    }), "2026-04-21T09:00:00.000Z");
    await materializeWrite(memoryStore, createWrite({
      writeId: "write_new_preference",
      sourceTurnId: "turn_new_preference",
      writeKind: "typed_upsert",
      scope: "user",
      actorId: "actor_cli",
      workspaceId: "workspace_other",
      proposedMemoryType: "preference",
      importance: 0.95,
      content: { summary: "New user preference: keep replies concise but explicit." }
    }), "2026-04-21T09:01:00.000Z");

    const toolPort = createAppToolPort({
      cwd: "/workspace",
      artifacts: createInlineArtifactPolicy()
    });
    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        retrieve: memoryStore.retrieve
      },
      taskStore: {
        async loadById() {
          return undefined;
        },
        async loadLatestActiveBySession() {
          return undefined;
        },
        async listActiveBySession() {
          return [];
        }
      },
      resolveToolExposure: async ({ request, session, budget }) =>
        toolPort.describeExposure({
          turnId: request.turnId,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          resolvedMode: budget.resolvedMode
        })
    });

    const firstAssembly = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_observability_before"
      }),
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local"
      },
      budget: {
        resolvedMode: "chat",
        model: {
          providerId: "provider_local",
          modelId: "model_cheap",
          modelTier: "cheap"
        },
        limits: {
          inputTokenBudget: 1000,
          outputTokenBudget: 400,
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      }
    });

    const workingSetTarget = firstAssembly.observability?.continuity.blocks.workingSet.correctionTarget;
    const oldPreferenceTarget = firstAssembly.observability?.durableMemory.items.find(
      (item) => item.writeId === "write_old_preference"
    )?.correctionTarget;
    const newPreferenceId = firstAssembly.observability?.durableMemory.items.find(
      (item) => item.writeId === "write_new_preference"
    )?.memoryId;

    await memoryStore.applyCorrection({
      correctionId: "corr_working_set_from_observability",
      actorId: "operator:cli",
      reason: "rewrite the working set from observability",
      target: workingSetTarget!,
      operation: {
        kind: "rewrite_working_set",
        replace: true,
        workingSet: {
          objective: "corrected continuity objective",
          recentProgress: ["observability drove a working-set rewrite"],
          blockers: ["only the corrected blocker should remain"],
          openLoops: ["resume on the corrected thread"],
          sourceRefs: ["turn_observability_before"]
        }
      }
    });
    await memoryStore.applyCorrection({
      correctionId: "corr_supersede_from_observability",
      actorId: "operator:cli",
      reason: "supersede the old preference from observability",
      target: oldPreferenceTarget!,
      operation: {
        kind: "mark_memory_superseded",
        supersededByMemoryId: newPreferenceId
      }
    });

    const secondAssembly = await assembler.assemble({
      request: createTurnRequest({
        turnId: "turn_observability_after"
      }),
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local"
      },
      budget: {
        resolvedMode: "chat",
        model: {
          providerId: "provider_local",
          modelId: "model_cheap",
          modelTier: "cheap"
        },
        limits: {
          inputTokenBudget: 1000,
          outputTokenBudget: 400,
          memoryInjectionBudget: 240,
          toolResultInjectionBudget: 180,
          maxLoopCount: 4,
          maxToolCallsPerBatch: 4,
          maxToolCallsPerTurn: 4
        }
      }
    });

    const secondMemory = secondAssembly.runtimeRequest.turnContext?.memory;
    const typedMemorySummaries = (secondMemory?.continuity?.typedMemory ?? [])
      .map((item) => String((item.payload as { summary?: unknown } | undefined)?.summary ?? ""))
      .join("\n");

    expect(workingSetTarget).toEqual(expect.objectContaining({ kind: "working_set" }));
    expect(oldPreferenceTarget).toEqual(expect.objectContaining({ kind: "typed_memory", scope: "user" }));
    expect(secondMemory?.continuity?.workingSet.summary).toContain("corrected continuity objective");
    expect(secondMemory?.continuity?.workingSet.summary).not.toContain("stale continuity objective");
    expect(typedMemorySummaries).toContain("New user preference: keep replies concise but explicit.");
    expect(typedMemorySummaries).not.toContain("Old user preference: keep replies ultra terse.");
  });
});
