import { describe, expect, it } from "vitest";
import type { ActiveTaskSnapshot, TurnRequest, TurnResult } from "@endec/domain";
import { synthesizeWorkingSet, type WorkingSetSynthesisEvent } from "./working-set-synthesis.ts";

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli",
    actorId: "actor_cli",
    input: "Write the failing tests for working set synthesis.",
    attachments: [],
    ...overrides
  };
}

function createTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    resolvedMode: "act",
    status: "completed",
    messages: [
      {
        role: "assistant",
        content: "The failing tests are in place."
      }
    ],
    toolEvents: [],
    taskUpdates: [],
    usage: {
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      estimatedCost: 0
    },
    warnings: [],
    checkpointRef: "checkpoint:turn_001",
    nextSessionStateRef: "session_state_ref:turn_001",
    ...overrides
  };
}

function createActiveTask(overrides: Partial<Omit<ActiveTaskSnapshot, "selectedBy">> = {}): Omit<ActiveTaskSnapshot, "selectedBy"> {
  return {
    taskId: "task_001",
    title: "Batch 3 / Lane 1 — working set synthesis",
    status: "active",
    checkpointRef: "checkpoint:task_001",
    currentStep: "write the failing tests",
    nextAction: "make the memory continuity tests pass",
    updatedAt: "2026-04-17T08:00:00.000Z",
    ...overrides
  };
}

function createRecentHistory(items: WorkingSetSynthesisEvent[] = []): WorkingSetSynthesisEvent[] {
  return items;
}

describe("synthesizeWorkingSet", () => {
  it("synthesizes objective, recent decisions, blockers, open loops, and refs from session truth", () => {
    const workingSet = synthesizeWorkingSet({
      request: createTurnRequest({
        turnId: "turn_blocked",
        input: "Continue the lane 1 implementation after approval."
      }),
      result: createTurnResult({
        turnId: "turn_blocked",
        status: "blocked",
        messages: [],
        warnings: ["budget requires confirmation"],
        blockedBy: "user_decision",
        checkpointRef: "checkpoint:turn_blocked"
      }),
      activeTask: createActiveTask({
        status: "blocked",
        currentStep: "resume the blocked implementation",
        nextAction: "resume after the operator approves the budget",
        blockingReason: "awaiting operator approval"
      }),
      recentHistory: createRecentHistory([
        {
          eventId: "turn_blocked:approval:0",
          turnId: "turn_blocked",
          eventKind: "approval",
          summary: "ask: budget requires confirmation",
          text: "budget requires confirmation",
          createdAt: "2026-04-17T08:05:00.000Z",
          sourceRefs: ["turn_blocked", "checkpoint:turn_blocked"]
        },
        {
          eventId: "turn_blocked:user",
          turnId: "turn_blocked",
          eventKind: "user_message",
          summary: "Continue the lane 1 implementation after approval.",
          text: "Continue the lane 1 implementation after approval.",
          createdAt: "2026-04-17T08:04:00.000Z",
          sourceRefs: ["turn_blocked"]
        },
        {
          eventId: "turn_prev:message:0",
          turnId: "turn_prev",
          eventKind: "assistant_message",
          summary: "preserved typed memory ranking",
          text: "preserved typed memory ranking",
          createdAt: "2026-04-17T08:03:00.000Z",
          sourceRefs: ["working_set:session_001:2", "evidence:turn_prev"]
        }
      ])
    });

    expect(workingSet).toMatchObject({
      objective: "Batch 3 / Lane 1 — working set synthesis",
      recentDecisions: ["Approval: ask: budget requires confirmation"],
      blockers: ["awaiting operator approval", "Turn blocked by user_decision"],
      openLoops: [
        "resume after the operator approves the budget",
        "Resume from checkpoint:turn_blocked"
      ],
      activeMemoryRefs: ["working_set:session_001:2", "evidence:turn_prev"],
      activeTaskRefs: ["task_001", "checkpoint:task_001"],
      recentEventRefs: [
        "turn_blocked:approval:0",
        "turn_blocked:user",
        "turn_prev:message:0"
      ]
    });
    expect(workingSet.recentProgress).toEqual(
      expect.arrayContaining([
        "Task step: resume the blocked implementation",
        "User asked: Continue the lane 1 implementation after approval."
      ])
    );
    expect(workingSet.sourceRefs).toEqual(
      expect.arrayContaining([
        "turn_blocked",
        "checkpoint:turn_blocked",
        "task_001",
        "checkpoint:task_001",
        "turn_blocked:approval:0",
        "working_set:session_001:2",
        "evidence:turn_prev"
      ])
    );
  });

  it("carries forward recent assistant and system history into the working-set continuity core", () => {
    const workingSet = synthesizeWorkingSet({
      request: createTurnRequest({
        turnId: "turn_carry_forward",
        input: "Continue the same foreground task without restarting."
      }),
      result: createTurnResult({
        turnId: "turn_carry_forward",
        messages: [],
        checkpointRef: "checkpoint:turn_carry_forward"
      }),
      activeTask: createActiveTask({
        title: "Continuity hardening",
        currentStep: undefined,
        nextAction: "land the continuity-core ordering"
      }),
      recentHistory: createRecentHistory([
        {
          eventId: "turn_prev:assistant_message:0",
          turnId: "turn_prev",
          eventKind: "assistant_message",
          summary: "Preserved the active task authority surface.",
          text: "Preserved the active task authority surface.",
          createdAt: "2026-04-17T08:18:00.000Z",
          sourceRefs: ["turn_prev", "checkpoint:turn_prev"]
        },
        {
          eventId: "turn_prev:system:0",
          turnId: "turn_prev",
          eventKind: "system",
          summary: "Decision: continuity core must outrank generic durable memory.",
          text: "Decision: continuity core must outrank generic durable memory.",
          createdAt: "2026-04-17T08:17:00.000Z",
          sourceRefs: ["turn_prev"]
        },
        {
          eventId: "turn_prev:warning:0",
          turnId: "turn_prev",
          eventKind: "warning",
          summary: "Budget pressure can still trim low-priority durable memory.",
          text: "Budget pressure can still trim low-priority durable memory.",
          createdAt: "2026-04-17T08:16:00.000Z",
          sourceRefs: ["turn_prev"]
        }
      ])
    });

    expect(workingSet.objective).toBe("Continuity hardening");
    expect(workingSet.recentProgress).toEqual(
      expect.arrayContaining([
        "User asked: Continue the same foreground task without restarting.",
        "Carry-forward: Preserved the active task authority surface."
      ])
    );
    expect(workingSet.recentDecisions).toEqual(
      expect.arrayContaining([
        "System: Decision: continuity core must outrank generic durable memory.",
        "Warning: Budget pressure can still trim low-priority durable memory."
      ])
    );
    expect(workingSet.openLoops).toContain("land the continuity-core ordering");
    expect(workingSet.sourceRefs).toEqual(
      expect.arrayContaining([
        "turn_carry_forward",
        "checkpoint:turn_carry_forward",
        "turn_prev",
        "checkpoint:turn_prev",
        "turn_prev:assistant_message:0"
      ])
    );
  });

  it("updates recent progress and refs when the active task or latest turn changes", () => {
    const first = synthesizeWorkingSet({
      request: createTurnRequest({
        turnId: "turn_first",
        input: "Write the failing tests for working set synthesis."
      }),
      result: createTurnResult({
        turnId: "turn_first",
        checkpointRef: "checkpoint:turn_first",
        messages: [
          {
            role: "assistant",
            content: "The failing tests are in place."
          }
        ]
      }),
      activeTask: createActiveTask({
        currentStep: "write the failing tests",
        nextAction: "implement the structured synthesis"
      }),
      recentHistory: createRecentHistory([
        {
          eventId: "turn_first:message:0",
          turnId: "turn_first",
          eventKind: "assistant_message",
          summary: "The failing tests are in place.",
          text: "The failing tests are in place.",
          createdAt: "2026-04-17T08:10:00.000Z",
          sourceRefs: []
        },
        {
          eventId: "turn_first:user",
          turnId: "turn_first",
          eventKind: "user_message",
          summary: "Write the failing tests for working set synthesis.",
          text: "Write the failing tests for working set synthesis.",
          createdAt: "2026-04-17T08:09:00.000Z",
          sourceRefs: ["turn_first"]
        }
      ])
    });

    const second = synthesizeWorkingSet({
      request: createTurnRequest({
        turnId: "turn_second",
        input: "Implement the structured synthesis and wire the refs."
      }),
      result: createTurnResult({
        turnId: "turn_second",
        checkpointRef: "checkpoint:turn_second",
        messages: [
          {
            role: "assistant",
            content: "The structured synthesis is wired."
          }
        ]
      }),
      activeTask: createActiveTask({
        currentStep: "implement the structured synthesis",
        nextAction: "run app + memory verification"
      }),
      recentHistory: createRecentHistory([
        {
          eventId: "turn_second:message:0",
          turnId: "turn_second",
          eventKind: "assistant_message",
          summary: "The structured synthesis is wired.",
          text: "The structured synthesis is wired.",
          createdAt: "2026-04-17T08:20:00.000Z",
          sourceRefs: []
        },
        {
          eventId: "turn_second:user",
          turnId: "turn_second",
          eventKind: "user_message",
          summary: "Implement the structured synthesis and wire the refs.",
          text: "Implement the structured synthesis and wire the refs.",
          createdAt: "2026-04-17T08:19:00.000Z",
          sourceRefs: ["turn_second"]
        },
        {
          eventId: "turn_first:message:0",
          turnId: "turn_first",
          eventKind: "assistant_message",
          summary: "The failing tests are in place.",
          text: "The failing tests are in place.",
          createdAt: "2026-04-17T08:10:00.000Z",
          sourceRefs: []
        },
        {
          eventId: "turn_first:user",
          turnId: "turn_first",
          eventKind: "user_message",
          summary: "Write the failing tests for working set synthesis.",
          text: "Write the failing tests for working set synthesis.",
          createdAt: "2026-04-17T08:09:00.000Z",
          sourceRefs: ["turn_first"]
        }
      ])
    });

    expect(second.recentProgress).not.toEqual(first.recentProgress);
    expect(second.recentProgress).toEqual(
      expect.arrayContaining([
        "Task step: implement the structured synthesis",
        "User asked: Implement the structured synthesis and wire the refs.",
        "Assistant replied: The structured synthesis is wired."
      ])
    );
    expect(second.recentEventRefs).toEqual(
      expect.arrayContaining(["turn_second:message:0", "turn_second:user"])
    );
    expect(second.sourceRefs).toEqual(
      expect.arrayContaining([
        "turn_second",
        "checkpoint:turn_second",
        "task_001",
        "turn_second:message:0",
        "turn_second:user"
      ])
    );
  });
});
