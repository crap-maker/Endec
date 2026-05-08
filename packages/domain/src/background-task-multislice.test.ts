import { describe, expect, it } from "vitest";
import {
  RunAttentionModeSchema,
  RunBudgetLedgerSchema,
  RunControlInputSchema,
  RunContinuationKindSchema,
  RuntimeSliceSnapshotSchema,
  RuntimeSliceStatusSchema,
  SliceLaneSchema,
  SliceTriggerKindSchema,
  TaskRunSnapshotSchema,
  TaskRunStatusSchema,
  normalizeLegacyTaskRunStatus
} from "./index.ts";

describe("multi-slice background task contracts", () => {
  it("freezes the new durable run and slice vocabularies", () => {
    expect(TaskRunStatusSchema.options).toEqual([
      "queued",
      "running",
      "blocked",
      "completed",
      "failed",
      "canceled"
    ]);
    expect(RuntimeSliceStatusSchema.options).toEqual([
      "queued",
      "running",
      "yielded",
      "blocked",
      "completed",
      "failed",
      "canceled",
      "lease_expired"
    ]);
    expect(RunAttentionModeSchema.options).toEqual([
      "foreground_attached",
      "background_detached"
    ]);
    expect(SliceLaneSchema.options).toEqual(["foreground", "background"]);
    expect(SliceTriggerKindSchema.options).toEqual([
      "initial",
      "auto_continue",
      "user_resume",
      "approval_resume",
      "recovery_retry",
      "operator_resume",
      "legacy_cutover"
    ]);
    expect(RunContinuationKindSchema.options).toEqual([
      "auto_continue",
      "user_resume",
      "approval_resume",
      "operator_resume",
      "recovery_retry"
    ]);
  });

  it("parses run-centric continuation and budget truth", () => {
    const run = TaskRunSnapshotSchema.parse({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      status: "queued",
      attentionMode: "foreground_attached",
      runKind: "normal",
      attemptNo: 1,
      maxAttempts: 1,
      continuationKind: "auto_continue",
      continuationPayload: {
        pendingToolBatch: ["bash"]
      },
      continuationUpdatedAt: "2026-04-30T00:00:10.000Z",
      cumulativeInputTokens: 12,
      cumulativeOutputTokens: 4,
      cumulativeTotalTokens: 16,
      cumulativeEstimatedCost: 0.01,
      autonomyWindowSliceCount: 1,
      autonomyWindowToolCallCount: 2,
      foregroundBurstSliceCount: 1,
      foregroundBurstStartedAt: "2026-04-30T00:00:00.000Z",
      lastHumanInputAt: "2026-04-30T00:00:00.000Z",
      runStartedAt: "2026-04-30T00:00:00.000Z",
      runDeadlineAt: "2026-04-30T00:10:00.000Z",
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:10.000Z"
    });

    expect(run.continuationKind).toBe("auto_continue");
    expect(run.cumulativeTotalTokens).toBe(16);
    expect(RunBudgetLedgerSchema.parse(run).foregroundBurstSliceCount).toBe(1);
  });

  it("requires structured steer payloads instead of ad-hoc control objects", () => {
    expect(() =>
      RunControlInputSchema.parse({
        controlSeq: 1,
        controlId: "control_missing_text",
        taskId: "task_001",
        runId: "run_001",
        kind: "steer",
        payload: {
          imControl: {
            messageMode: "steer",
            source: "telegram",
            messageId: "msg_001"
          }
        },
        createdAt: "2026-04-30T00:00:05.000Z"
      })
    ).toThrow();

    const parsed = RunControlInputSchema.parse({
      controlSeq: 2,
      controlId: "control_steer_001",
      taskId: "task_001",
      runId: "run_001",
      kind: "steer",
      payload: {
        text: "also inspect logs",
        imControl: {
          messageMode: "steer",
          source: "telegram",
          messageId: "msg_002",
          senderId: "user_telegram_001"
        }
      },
      createdAt: "2026-04-30T00:00:06.000Z"
    });

    expect(parsed.payload).toMatchObject({
      text: "also inspect logs",
      imControl: {
        messageMode: "steer",
        messageId: "msg_002"
      }
    });
  });

  it("parses runtime slice and queued control input truth", () => {
    const slice = RuntimeSliceSnapshotSchema.parse({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      sliceNo: 1,
      triggerKind: "initial",
      lane: "foreground",
      status: "queued",
      budgetSnapshot: { maxToolCallsPerSlice: 8 },
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z"
    });
    const control = RunControlInputSchema.parse({
      controlSeq: 1,
      controlId: "control_001",
      taskId: "task_001",
      runId: "run_001",
      kind: "follow_up",
      payload: { text: "also inspect logs" },
      createdAt: "2026-04-30T00:00:05.000Z"
    });

    expect(slice.triggerKind).toBe("initial");
    expect(control.kind).toBe("follow_up");
  });

  it("normalizes legacy persisted run statuses for migration compatibility", () => {
    expect(normalizeLegacyTaskRunStatus("suspended")).toBe("blocked");
    expect(normalizeLegacyTaskRunStatus("succeeded")).toBe("completed");
    expect(normalizeLegacyTaskRunStatus("cancel_requested")).toBe("running");
    expect(normalizeLegacyTaskRunStatus("lease_expired")).toBe("failed");
  });
});
