import { describe, expect, it } from "vitest";
import { createDetachedTask2AckTurnResult, resolveAcceptedDetachedTask2ClaimRace } from "./task2-detached-control.ts";

describe("task2 detached control helpers", () => {
  it("acknowledges detached cancel mutations without a session-only fallback", () => {
    const result = createDetachedTask2AckTurnResult({
      turnId: "run_cancel_ack",
      sessionId: "session_cancel_ack",
      resolvedMode: "chat",
      checkpointRef: "checkpoint:run_cancel_ack",
      frameRef: "frame:run_cancel_ack",
      warning: "operator canceled detached background run"
    });

    expect(result).toMatchObject({
      turnId: "run_cancel_ack",
      sessionId: "session_cancel_ack",
      resolvedMode: "chat",
      status: "interrupted",
      warnings: ["operator canceled detached background run"],
      checkpointRef: "checkpoint:run_cancel_ack",
      frameRef: "frame:run_cancel_ack"
    });
  });

  it.each([
    {
      action: "approve" as const,
      expectedTriggerKind: "approval_resume" as const,
      runStatus: "queued" as const,
      sliceStatus: "queued" as const,
      sliceTriggerKind: "approval_resume" as const,
      continuationPayload: undefined,
      expectedWarning: "Approval already accepted"
    },
    {
      action: "resume" as const,
      expectedTriggerKind: "operator_resume" as const,
      runStatus: "running" as const,
      sliceStatus: "running" as const,
      sliceTriggerKind: "operator_resume" as const,
      continuationPayload: undefined,
      expectedWarning: "Resume already accepted"
    },
    {
      action: "approve" as const,
      expectedTriggerKind: "approval_resume" as const,
      runStatus: "queued" as const,
      sliceStatus: "queued" as const,
      sliceTriggerKind: "recovery_retry" as const,
      continuationPayload: {
        control: {
          action: "approve",
          turnId: "run_approve_race",
          sessionId: "session_approve_race",
          frameRef: "frame:run_approve_race",
          decisionId: "decision_approve_race"
        }
      },
      expectedWarning: "Approval already accepted"
    },
    {
      action: "resume" as const,
      expectedTriggerKind: "operator_resume" as const,
      runStatus: "running" as const,
      sliceStatus: "running" as const,
      sliceTriggerKind: "recovery_retry" as const,
      continuationPayload: {
        control: {
          action: "resume",
          turnId: "run_resume_race",
          sessionId: "session_resume_race",
          frameRef: "frame:run_resume_race"
        }
      },
      expectedWarning: "Resume already accepted"
    }
  ])("treats %s detached claim races as accepted when durable slice truth already advanced", ({
    action,
    expectedTriggerKind,
    runStatus,
    sliceStatus,
    sliceTriggerKind,
    continuationPayload,
    expectedWarning
  }) => {
    const result = resolveAcceptedDetachedTask2ClaimRace({
      control: {
        action,
        turnId: `run_${action}_race`,
        sessionId: `session_${action}_race`,
        frameRef: `frame:run_${action}_race`,
        decisionId: action === "approve" ? `decision_${action}_race` : undefined
      },
      turnId: `run_${action}_race`,
      sessionId: `session_${action}_race`,
      resolvedMode: "act",
      checkpointRef: `checkpoint:run_${action}_race`,
      frameRef: `frame:run_${action}_race`,
      expectedTriggerKind,
      runStatus,
      slices: [
        {
          sliceNo: 2,
          status: sliceStatus,
          triggerKind: sliceTriggerKind,
          continuationPayload
        }
      ]
    });

    expect(result).toMatchObject({
      turnId: `run_${action}_race`,
      sessionId: `session_${action}_race`,
      resolvedMode: "act",
      status: "interrupted",
      warnings: [expect.stringContaining(expectedWarning)],
      checkpointRef: `checkpoint:run_${action}_race`,
      frameRef: `frame:run_${action}_race`
    });
  });

  it("does not hide real detached claim mismatches", () => {
    const result = resolveAcceptedDetachedTask2ClaimRace({
      control: {
        action: "resume",
        turnId: "run_resume_mismatch",
        sessionId: "session_resume_mismatch",
        frameRef: "frame:run_resume_mismatch"
      },
      turnId: "run_resume_mismatch",
      sessionId: "session_resume_mismatch",
      resolvedMode: "chat",
      checkpointRef: "checkpoint:run_resume_mismatch",
      frameRef: "frame:run_resume_mismatch",
      expectedTriggerKind: "operator_resume",
      runStatus: "queued",
      slices: [
        {
          sliceNo: 1,
          status: "queued",
          triggerKind: "recovery_retry",
          continuationPayload: {
            control: {
              action: "resume",
              turnId: "run_resume_mismatch",
              sessionId: "session_resume_mismatch",
              frameRef: "frame:other_recovery_retry"
            }
          }
        }
      ]
    });

    expect(result).toBeUndefined();
  });

  it("does not acknowledge approval recovery-retry heads for the wrong decision id", () => {
    const result = resolveAcceptedDetachedTask2ClaimRace({
      control: {
        action: "approve",
        turnId: "run_approve_decision_mismatch",
        sessionId: "session_approve_decision_mismatch",
        frameRef: "frame:run_approve_decision_mismatch",
        decisionId: "decision_expected"
      },
      turnId: "run_approve_decision_mismatch",
      sessionId: "session_approve_decision_mismatch",
      resolvedMode: "act",
      checkpointRef: "checkpoint:run_approve_decision_mismatch",
      frameRef: "frame:run_approve_decision_mismatch",
      expectedTriggerKind: "approval_resume",
      runStatus: "running",
      slices: [
        {
          sliceNo: 3,
          status: "running",
          triggerKind: "recovery_retry",
          continuationPayload: {
            control: {
              action: "approve",
              turnId: "run_approve_decision_mismatch",
              sessionId: "session_approve_decision_mismatch",
              frameRef: "frame:run_approve_decision_mismatch",
              decisionId: "decision_other"
            }
          }
        }
      ]
    });

    expect(result).toBeUndefined();
  });
});
