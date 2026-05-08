import { describe, expect, it } from "vitest";
import {
  buildCurrentTurnTimeContext,
  resolveEffectiveTimezone,
  resolveServerTimezone,
  selectRecentInteractionAnchor
} from "./time-context.ts";

describe("time-context", () => {
  it("prefers TZ env and falls back to runtime timezone or UTC", () => {
    expect(resolveServerTimezone({ env: { TZ: "Asia/Shanghai" } })).toBe("Asia/Shanghai");
    expect(resolveServerTimezone({ env: {}, runtimeTimezone: () => "America/Los_Angeles" })).toBe("America/Los_Angeles");
    expect(resolveServerTimezone({ env: {}, runtimeTimezone: () => undefined })).toBe("UTC");
  });

  it("resolves owner timezone ahead of the server default", () => {
    expect(resolveEffectiveTimezone({
      ownerTimezone: "Asia/Shanghai",
      serverTimezone: "America/Los_Angeles"
    })).toEqual({
      timezone: "Asia/Shanghai",
      timezoneSource: "owner_preference"
    });
    expect(resolveEffectiveTimezone({
      serverTimezone: "America/Los_Angeles"
    })).toEqual({
      timezone: "America/Los_Angeles",
      timezoneSource: "server_default"
    });
  });

  it("builds a deterministic first-turn summary with server timezone fallback", () => {
    const context = buildCurrentTurnTimeContext({
      nowUtc: "2026-04-29T13:14:00.000Z",
      serverTimezone: "Asia/Shanghai"
    });

    expect(context).toMatchObject({
      timezone: "Asia/Shanghai",
      timezoneSource: "server_default",
      localDate: "2026-04-29",
      localTime: "21:14",
      weekday: "Wed",
      dayPart: "evening",
      gapKind: "first_turn",
      summary: "Local time is Wed 2026-04-29 21:14 (Asia/Shanghai), evening. This is the first observed interaction in this session."
    });
    expect(context.previousInteractionAtUtc).toBeUndefined();
    expect(context.previousInteractionLocal).toBeUndefined();
  });

  it("classifies same-day gaps and reports elapsed minutes", () => {
    const context = buildCurrentTurnTimeContext({
      nowUtc: "2026-04-29T13:14:00.000Z",
      previousInteractionAtUtc: "2026-04-29T12:56:00.000Z",
      serverTimezone: "Asia/Shanghai"
    });

    expect(context).toMatchObject({
      gapKind: "same_day",
      calendarDayDelta: 0,
      elapsedSincePreviousInteractionMinutes: 18,
      summary: "Local time is Wed 2026-04-29 21:14 (Asia/Shanghai), evening. The last observed interaction was earlier today, 18 minutes ago."
    });
  });

  it("classifies overnight gaps using owner timezone precedence and previous day part", () => {
    const context = buildCurrentTurnTimeContext({
      nowUtc: "2026-04-29T01:05:00.000Z",
      previousInteractionAtUtc: "2026-04-28T12:40:00.000Z",
      ownerTimezone: "Asia/Shanghai",
      serverTimezone: "America/Los_Angeles"
    });

    expect(context).toMatchObject({
      timezone: "Asia/Shanghai",
      timezoneSource: "owner_preference",
      localDate: "2026-04-29",
      localTime: "09:05",
      dayPart: "morning",
      gapKind: "overnight",
      calendarDayDelta: 1,
      previousInteractionLocal: "2026-04-28T20:40:00+08:00",
      summary: "Local time is Wed 2026-04-29 09:05 (Asia/Shanghai), morning. The last observed interaction was yesterday evening, so this is an overnight continuation."
    });
  });

  it("classifies multi-day gaps deterministically", () => {
    const context = buildCurrentTurnTimeContext({
      nowUtc: "2026-05-01T02:12:00.000Z",
      previousInteractionAtUtc: "2026-04-28T15:12:00.000Z",
      serverTimezone: "Asia/Shanghai"
    });

    expect(context).toMatchObject({
      gapKind: "multi_day",
      calendarDayDelta: 3,
      summary: "Local time is Fri 2026-05-01 10:12 (Asia/Shanghai), morning. The last observed interaction was 3 days ago, so this is a multi-day continuation."
    });
  });

  it("derives the latest owner-visible anchor while excluding warnings, tool noise, background callbacks, and control-path churn", () => {
    const anchor = selectRecentInteractionAnchor([
      {
        eventId: "event_warning",
        turnId: "turn_warning",
        eventKind: "warning",
        summary: "soft_limit",
        text: "soft_limit",
        createdAt: "2026-04-29T12:00:00.000Z",
        sourceRefs: ["turn_warning"]
      },
      {
        eventId: "event_tool",
        turnId: "turn_tool",
        eventKind: "tool_result",
        summary: "read success",
        text: "workspace listing",
        createdAt: "2026-04-29T11:59:00.000Z",
        sourceRefs: ["turn_tool"]
      },
      {
        eventId: "event_background_assistant",
        turnId: "run_bg_1234567890abcdef",
        eventKind: "assistant_message",
        summary: "background work finished",
        text: "background work finished",
        createdAt: "2026-04-29T11:58:30.000Z",
        sourceRefs: ["run_bg_1234567890abcdef"]
      },
      {
        eventId: "event_system",
        turnId: "operator_cancel_turn_001",
        eventKind: "system",
        summary: "turn turn_001 interrupted: cancelled",
        text: "cancelled",
        createdAt: "2026-04-29T11:58:00.000Z",
        sourceRefs: ["turn_001"]
      },
      {
        eventId: "event_notice",
        turnId: "authority_notice_turn_001",
        eventKind: "system",
        summary: "Trusted conversation granted for group:chat_100.",
        text: "Trusted conversation granted for group:chat_100.",
        createdAt: "2026-04-29T11:57:00.000Z",
        sourceRefs: ["turn_notice"]
      },
      {
        eventId: "event_owner_reply",
        turnId: "turn_owner_visible_001",
        eventKind: "assistant_message",
        summary: "Saved your timezone = Asia/Shanghai.",
        text: "Saved your timezone = Asia/Shanghai.",
        createdAt: "2026-04-29T11:56:00.000Z",
        sourceRefs: ["turn_owner_visible_001"]
      }
    ]);

    expect(anchor).toMatchObject({
      eventId: "event_owner_reply",
      createdAt: "2026-04-29T11:56:00.000Z"
    });
  });
});
