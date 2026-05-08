import { describe, expect, it } from "vitest";
import {
  AgentTaskStatusSchema,
  BackgroundTurnMarkerSchema,
  ConversationRefSchema,
  CurrentTurnTimeContextSchema,
  OutboundEventSchema,
  RuntimeTurnContextSchema,
  TaskRunStatusSchema
} from "./index.ts";

describe("background task domain contracts", () => {
  it("parses a background worker turn marker", () => {
    const marker = BackgroundTurnMarkerSchema.parse({
      schemaVersion: 1,
      contractVersion: "im.background-turn.v1",
      taskId: "task_001",
      runId: "run_001",
      attemptNo: 1,
      originTurnId: "turn_origin_001",
      executionRole: "background_worker"
    });

    expect(marker).toMatchObject({
      taskId: "task_001",
      runId: "run_001",
      attemptNo: 1,
      originTurnId: "turn_origin_001",
      executionRole: "background_worker"
    });
  });

  it("keeps background task-level and run-level statuses separate", () => {
    expect(TaskRunStatusSchema.options).toEqual([
      "queued",
      "running",
      "blocked",
      "completed",
      "failed",
      "canceled"
    ]);
    expect(AgentTaskStatusSchema.options).toEqual([
      "open",
      "queued",
      "running",
      "blocked",
      "done",
      "failed",
      "canceled"
    ]);
  });

  it("round-trips persisted conversation references owned by the domain", () => {
    const conversationRef = ConversationRefSchema.parse({
      accountId: "acct_bot",
      conversationId: "group:chat_001:thread:thread_777",
      peerId: "chat_001",
      peerKind: "group",
      threadId: "thread_777",
      topicId: "topic_123"
    });

    expect(ConversationRefSchema.parse(JSON.parse(JSON.stringify(conversationRef)))).toMatchObject({
      accountId: "acct_bot",
      conversationId: "group:chat_001:thread:thread_777",
      peerId: "chat_001",
      peerKind: "group",
      threadId: "thread_777",
      topicId: "topic_123"
    });
  });

  it("parses authority control outbound events without session ownership", () => {
    const event = OutboundEventSchema.parse({
      outboundEventId: "outbound_pairing_001",
      workspaceId: "workspace_local",
      actorId: "operator_alpha",
      conversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      },
      channel: "telegram",
      eventKind: "operator_notice",
      renderPayload: {
        schemaVersion: 1,
        contractVersion: "im.authority-control.v1",
        noticeKind: "trusted_conversation_granted",
        message: "Trusted conversation granted.",
        ownerBindingId: "binding_001",
        ownerGeneration: 0,
        conversationRef: {
          accountId: "telegram:bot:endec",
          conversationId: "dm:chat_42",
          peerId: "chat_42",
          peerKind: "dm"
        }
      },
      idempotencyKey: "authority:telegram:acct_bot:trusted_conversation_granted:binding_001",
      status: "pending",
      availableAt: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    expect(event.sessionId).toBeUndefined();
    expect(event.eventKind).toBe("operator_notice");
  });

  it("keeps runtime turn context compatible with a structured time-context packet", () => {
    const timeContext = CurrentTurnTimeContextSchema.parse({
      timezone: "Asia/Shanghai",
      timezoneSource: "server_default",
      nowUtc: "2026-04-29T01:14:00.000Z",
      localNow: "2026-04-29T09:14:00+08:00",
      localDate: "2026-04-29",
      localTime: "09:14",
      weekday: "Tue",
      dayPart: "morning",
      gapKind: "first_turn",
      summary: "Local time is Tue 2026-04-29 09:14 (Asia/Shanghai), morning. This is the first observed interaction in this session."
    });

    const turnContext = RuntimeTurnContextSchema.parse({
      memory: {
        workingSetSummary: "",
        retrievedItems: [],
        injectionPlan: [],
        tokenEstimate: 0,
        sourceRefs: []
      },
      timeContext
    });

    expect(turnContext.timeContext?.summary).toContain("first observed interaction");
  });
});
