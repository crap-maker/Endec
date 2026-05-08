import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderTransport, ProviderTransportRequest } from "@endec/ai";
import { createMemoryStore } from "@endec/memory";
import type { MemoryWriteRequest } from "@endec/domain";
import { ensureEndecDataLayout } from "./data-paths.ts";
import { createEndecApp } from "./index.ts";

type JsonObject = Record<string, unknown>;

function createTurnRequest(overrides: Partial<{
  turnId: string;
  sessionId: string;
  workspaceId: string;
  source: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk";
  actorId: string;
  input: string;
  requestedMode: "chat" | "plan" | "act" | "review" | "task";
}> = {}) {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli" as const,
    actorId: "actor_cli",
    input: "hello from app",
    attachments: [],
    ...overrides
  };
}

function createChatCompletionTransport(
  responses: Array<Array<JsonObject>>,
  onRequest?: (request: ProviderTransportRequest) => void
): ProviderTransport {
  let index = 0;

  return {
    async *stream(request) {
      onRequest?.(request);
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
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

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-correction-surface-"));
}

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("app correction surface", () => {
  it("lets operator inspection targets drive corrections that change the next assembled turn", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "initial continuity reply"
                  }
                }
              ]
            },
            {
              choices: [{ finish_reason: "stop" }],
              usage: {
                prompt_tokens: 24,
                completion_tokens: 12,
                total_tokens: 36
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "corrected continuity reply"
                  }
                }
              ]
            },
            {
              choices: [{ finish_reason: "stop" }],
              usage: {
                prompt_tokens: 30,
                completion_tokens: 12,
                total_tokens: 42
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_initial",
      input: "continue the stale continuity thread"
    }));

    const paths = ensureEndecDataLayout(dataDir);
    const memoryStore = createMemoryStore({ filename: paths.memoryDbPath });
    await memoryStore.enqueueWrites([
      createWrite({
        writeId: "write_old_preference",
        sourceTurnId: "turn_old_preference",
        writeKind: "typed_upsert",
        scope: "user",
        actorId: "actor_cli",
        workspaceId: "workspace_other",
        proposedMemoryType: "preference",
        importance: 1,
        content: { summary: "Old user preference: keep replies ultra terse." }
      }),
      createWrite({
        writeId: "write_new_preference",
        sourceTurnId: "turn_new_preference",
        writeKind: "typed_upsert",
        scope: "user",
        actorId: "actor_cli",
        workspaceId: "workspace_other",
        proposedMemoryType: "preference",
        importance: 0.95,
        content: { summary: "New user preference: keep replies concise but explicit." }
      })
    ]);
    await memoryStore.drainOutbox({ maxItems: 8 });

    const inspection = await app.operator.inspectCorrectionSurface({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      actorId: "actor_cli"
    });
    const oldPreference = inspection.typedMemory.find((item) => item.record.writeId === "write_old_preference");
    const newPreference = inspection.typedMemory.find((item) => item.record.writeId === "write_new_preference");

    await app.operator.applyCorrection({
      correctionId: "corr_rewrite_working_set_001",
      actorId: "operator:cli",
      reason: "rewrite the continuity envelope from inspection",
      target: inspection.workingSet!.target,
      operation: {
        kind: "rewrite_working_set",
        replace: true,
        workingSet: {
          objective: "corrected continuity objective",
          recentProgress: ["inspection rewrote the working set before the next turn"],
          blockers: ["only the corrected blocker should remain"],
          openLoops: ["resume on the corrected continuity thread"],
          sourceRefs: ["turn_observability_001"]
        }
      }
    });
    await app.operator.applyCorrection({
      correctionId: "corr_supersede_old_preference_001",
      actorId: "operator:cli",
      reason: "the older preference should stop participating in selection",
      target: oldPreference!.target,
      operation: {
        kind: "mark_memory_superseded",
        supersededByMemoryId: newPreference!.record.memoryId
      }
    });

    const correctedInspection = await app.operator.inspectCorrectionSurface({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      actorId: "actor_cli"
    });

    await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_after_correction",
      input: "summarize the current continuity and my preference"
    }));

    const secondRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});

    expect(secondRequestBody).toContain("corrected continuity objective");
    expect(secondRequestBody).toContain("inspection rewrote the working set before the next turn");
    expect(secondRequestBody).toContain("New user preference: keep replies concise but explicit.");
    expect(secondRequestBody).not.toContain("Old user preference: keep replies ultra terse.");
    expect(correctedInspection.workingSet?.workingSet.summary).toContain("corrected continuity objective");
    expect(correctedInspection.typedMemory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record: expect.objectContaining({
          writeId: "write_old_preference",
          selectionState: "superseded",
          supersededByMemoryId: newPreference!.record.memoryId
        })
      })
    ]));
  });
});
