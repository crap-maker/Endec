import { describe, expect, it } from "vitest";
import {
  completeOwnerInit,
  normalizeTimezoneText,
  planOwnerInitUpdate,
  resolveOwnerPreferences
} from "./owner-init.ts";

describe("owner-init", () => {
  it("merges sparse stored preferences with defaults", () => {
    expect(resolveOwnerPreferences({
      serverTimezone: "Asia/Shanghai",
      stored: {
        source: "telegram",
        accountId: "acct_bot",
        ownerGeneration: 0,
        ownerBindingId: "binding_001",
        ownerActorId: "actor_owner_001",
        ownerDisplayName: "Alice",
        createdAt: "2026-04-29T00:00:00.000Z",
        updatedAt: "2026-04-29T00:00:00.000Z"
      }
    })).toEqual({
      ownerDisplayName: "Alice",
      assistantDisplayName: "Endec",
      timezone: "Asia/Shanghai",
      timezoneSource: "server_default"
    });
  });

  it("normalizes deterministic timezone aliases to IANA ids", () => {
    expect(normalizeTimezoneText("Asia/Shanghai")).toEqual({ normalizedTimezone: "Asia/Shanghai", ambiguous: false });
    expect(normalizeTimezoneText("UTC+8")).toEqual({ normalizedTimezone: "Asia/Shanghai", ambiguous: false });
    expect(normalizeTimezoneText("Beijing time")).toEqual({ normalizedTimezone: "Asia/Shanghai", ambiguous: false });
    expect(normalizeTimezoneText("Shanghai timezone")).toEqual({ normalizedTimezone: "Asia/Shanghai", ambiguous: false });
    expect(normalizeTimezoneText("洛杉矶时间")).toEqual({ normalizedTimezone: "America/Los_Angeles", ambiguous: false });
  });

  it("rejects ambiguous timezone text safely", () => {
    expect(normalizeTimezoneText("PT")).toEqual({ normalizedTimezone: undefined, ambiguous: true });
    expect(normalizeTimezoneText("美国时间")).toEqual({ normalizedTimezone: undefined, ambiguous: true });
  });

  it("captures bounded fields with rules-first parsing", () => {
    const plan = planOwnerInitUpdate({
      text: "Call me Alice and call yourself Momo.",
      serverTimezone: "Asia/Shanghai"
    });

    expect(plan).toMatchObject({
      outcome: "apply",
      updates: {
        ownerDisplayName: "Alice",
        assistantDisplayName: "Momo"
      }
    });
    expect(Object.keys(plan.outcome === "apply" ? plan.updates : {})).toEqual([
      "ownerDisplayName",
      "assistantDisplayName"
    ]);
  });

  it("maps explicit skip to a terminal completion reason", () => {
    expect(planOwnerInitUpdate({
      text: "skip this for now",
      serverTimezone: "Asia/Shanghai"
    })).toEqual({
      outcome: "skip",
      completionReason: "explicit_skip"
    });
  });

  it("falls through on ambiguous mixed input instead of writing", () => {
    expect(planOwnerInitUpdate({
      text: "Maybe call me A or B, and timezone is somewhere in the US I guess.",
      serverTimezone: "Asia/Shanghai"
    })).toEqual({
      outcome: "ambiguous"
    });
  });

  it("validates model-assisted candidates without requiring a second model call", () => {
    expect(planOwnerInitUpdate({
      text: "regular chat",
      serverTimezone: "Asia/Shanghai",
      candidate: {
        outcome: "candidate",
        fields: {
          ownerDisplayName: "Alice",
          assistantDisplayName: "Momo",
          timezoneText: "Beijing time",
          ignoredExtraField: "nope"
        } as Record<string, unknown>,
        confidence: "high"
      }
    })).toEqual({
      outcome: "apply",
      updates: {
        ownerDisplayName: "Alice",
        assistantDisplayName: "Momo",
        timezone: "Asia/Shanghai"
      }
    });
  });

  it("marks completion only for explicit terminal reasons", () => {
    expect(completeOwnerInit({
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerBindingId: "binding_001",
      promptVersion: 1,
      status: "prompted",
      promptSentAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    }, {
      reason: "fields_captured",
      now: "2026-04-29T00:05:00.000Z"
    })).toMatchObject({
      status: "completed",
      completionReason: "fields_captured",
      completedAt: "2026-04-29T00:05:00.000Z"
    });
  });
});
