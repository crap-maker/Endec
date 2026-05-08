import type {
  CurrentTurnTimeContext,
  CurrentTurnTimeDayPart,
  CurrentTurnTimeTimezoneSource
} from "@endec/domain";
import { CurrentTurnTimeContextSchema } from "@endec/domain";

type TimeContextCandidate = {
  timezone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: CurrentTurnTimeContext["weekday"];
  offset: string;
};

type TimeAnchor = {
  eventId: string;
  turnId: string;
  eventKind: string;
  summary: string;
  text: string;
  createdAt: string;
  sourceRefs: string[];
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const OWNER_VISIBLE_ANCHOR_EVENT_KINDS = new Set(["user_message", "assistant_message"]);
const BACKGROUND_TURN_ID_PREFIX = "run_bg_";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function isValidTimezone(value: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date("2026-01-01T00:00:00.000Z"));
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timezone === "string" && timezone.length > 0 ? timezone : undefined;
  } catch {
    return undefined;
  }
}

function formatParts(isoUtc: string, timezone: string): TimeContextCandidate {
  const date = new Date(isoUtc);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset"
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const rawOffset = map.timeZoneName ?? "GMT+00:00";
  const offset = rawOffset.startsWith("GMT") ? rawOffset.slice(3) : rawOffset;

  return {
    timezone,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: (WEEKDAY_LABELS.find((label) => label === map.weekday) ?? "Sun") as CurrentTurnTimeContext["weekday"],
    offset: offset === "" ? "+00:00" : offset
  };
}

function formatLocalTimestamp(candidate: TimeContextCandidate) {
  return `${candidate.year}-${pad2(candidate.month)}-${pad2(candidate.day)}T${pad2(candidate.hour)}:${pad2(candidate.minute)}:${pad2(candidate.second)}${candidate.offset}`;
}

function formatLocalDate(candidate: TimeContextCandidate) {
  return `${candidate.year}-${pad2(candidate.month)}-${pad2(candidate.day)}`;
}

function formatLocalClock(candidate: TimeContextCandidate) {
  return `${pad2(candidate.hour)}:${pad2(candidate.minute)}`;
}

function classifyDayPart(hour: number): CurrentTurnTimeDayPart {
  if (hour < 6) {
    return "early_morning";
  }
  if (hour < 12) {
    return "morning";
  }
  if (hour < 18) {
    return "afternoon";
  }
  if (hour < 22) {
    return "evening";
  }
  return "night";
}

function calendarDayIndex(candidate: TimeContextCandidate) {
  return Date.UTC(candidate.year, candidate.month - 1, candidate.day) / 86_400_000;
}

function humanizeDayPart(dayPart: CurrentTurnTimeDayPart) {
  return dayPart.replaceAll("_", " ");
}

export function resolveServerTimezone(input: {
  env?: Record<string, string | undefined>;
  runtimeTimezone?: () => string | undefined;
}) {
  const envTimezone = input.env?.TZ?.trim();
  if (envTimezone && isValidTimezone(envTimezone)) {
    return envTimezone;
  }

  if (input.runtimeTimezone) {
    const runtimeTimezone = input.runtimeTimezone();
    if (runtimeTimezone && isValidTimezone(runtimeTimezone)) {
      return runtimeTimezone;
    }
    return "UTC";
  }

  const runtimeTimezone = resolveRuntimeTimezone();
  if (runtimeTimezone && isValidTimezone(runtimeTimezone)) {
    return runtimeTimezone;
  }

  return "UTC";
}

export function resolveEffectiveTimezone(input: {
  ownerTimezone?: string;
  serverTimezone: string;
}): { timezone: string; timezoneSource: CurrentTurnTimeTimezoneSource } {
  const ownerTimezone = input.ownerTimezone?.trim();
  if (ownerTimezone && isValidTimezone(ownerTimezone)) {
    return {
      timezone: ownerTimezone,
      timezoneSource: "owner_preference"
    };
  }

  return {
    timezone: input.serverTimezone,
    timezoneSource: "server_default"
  };
}

function shouldUseAsRecentInteractionAnchor(anchor: TimeAnchor) {
  if (!OWNER_VISIBLE_ANCHOR_EVENT_KINDS.has(anchor.eventKind)) {
    return false;
  }

  if (anchor.turnId.startsWith(BACKGROUND_TURN_ID_PREFIX)) {
    return false;
  }

  return true;
}

export function selectRecentInteractionAnchor(anchors: TimeAnchor[]) {
  return anchors.find(shouldUseAsRecentInteractionAnchor);
}

export function buildCurrentTurnTimeContext(input: {
  nowUtc: string;
  previousInteractionAtUtc?: string;
  ownerTimezone?: string;
  serverTimezone: string;
}): CurrentTurnTimeContext {
  const effectiveTimezone = resolveEffectiveTimezone({
    ownerTimezone: input.ownerTimezone,
    serverTimezone: input.serverTimezone
  });
  const nowLocal = formatParts(input.nowUtc, effectiveTimezone.timezone);
  const nowDayPart = classifyDayPart(nowLocal.hour);
  const base = {
    timezone: effectiveTimezone.timezone,
    timezoneSource: effectiveTimezone.timezoneSource,
    nowUtc: input.nowUtc,
    localNow: formatLocalTimestamp(nowLocal),
    localDate: formatLocalDate(nowLocal),
    localTime: formatLocalClock(nowLocal),
    weekday: nowLocal.weekday,
    dayPart: nowDayPart
  } satisfies Omit<CurrentTurnTimeContext, "gapKind" | "summary">;

  if (!input.previousInteractionAtUtc) {
    return CurrentTurnTimeContextSchema.parse({
      ...base,
      gapKind: "first_turn",
      summary: `Local time is ${nowLocal.weekday} ${base.localDate} ${base.localTime} (${effectiveTimezone.timezone}), ${humanizeDayPart(nowDayPart)}. This is the first observed interaction in this session.`
    });
  }

  const previousLocal = formatParts(input.previousInteractionAtUtc, effectiveTimezone.timezone);
  const elapsedMinutes = Math.max(0, Math.floor((new Date(input.nowUtc).getTime() - new Date(input.previousInteractionAtUtc).getTime()) / 60_000));
  const calendarDayDelta = Math.max(0, calendarDayIndex(nowLocal) - calendarDayIndex(previousLocal));

  if (calendarDayDelta === 0) {
    return CurrentTurnTimeContextSchema.parse({
      ...base,
      previousInteractionAtUtc: input.previousInteractionAtUtc,
      previousInteractionLocal: formatLocalTimestamp(previousLocal),
      elapsedSincePreviousInteractionMinutes: elapsedMinutes,
      calendarDayDelta,
      gapKind: "same_day",
      summary: `Local time is ${nowLocal.weekday} ${base.localDate} ${base.localTime} (${effectiveTimezone.timezone}), ${humanizeDayPart(nowDayPart)}. The last observed interaction was earlier today, ${elapsedMinutes} minutes ago.`
    });
  }

  if (calendarDayDelta === 1) {
    const previousDayPart = classifyDayPart(previousLocal.hour);
    return CurrentTurnTimeContextSchema.parse({
      ...base,
      previousInteractionAtUtc: input.previousInteractionAtUtc,
      previousInteractionLocal: formatLocalTimestamp(previousLocal),
      elapsedSincePreviousInteractionMinutes: elapsedMinutes,
      calendarDayDelta,
      gapKind: "overnight",
      summary: `Local time is ${nowLocal.weekday} ${base.localDate} ${base.localTime} (${effectiveTimezone.timezone}), ${humanizeDayPart(nowDayPart)}. The last observed interaction was yesterday ${humanizeDayPart(previousDayPart)}, so this is an overnight continuation.`
    });
  }

  return CurrentTurnTimeContextSchema.parse({
    ...base,
    previousInteractionAtUtc: input.previousInteractionAtUtc,
    previousInteractionLocal: formatLocalTimestamp(previousLocal),
    elapsedSincePreviousInteractionMinutes: elapsedMinutes,
    calendarDayDelta,
    gapKind: "multi_day",
    summary: `Local time is ${nowLocal.weekday} ${base.localDate} ${base.localTime} (${effectiveTimezone.timezone}), ${humanizeDayPart(nowDayPart)}. The last observed interaction was ${calendarDayDelta} days ago, so this is a multi-day continuation.`
  });
}

export function buildCurrentTimeContextBlock(input: {
  turnId: string;
  timeContext: CurrentTurnTimeContext;
}) {
  const content = [
    `timezone: ${input.timeContext.timezone} (${input.timeContext.timezoneSource})`,
    `local now: ${input.timeContext.weekday} ${input.timeContext.localDate} ${input.timeContext.localTime}`,
    `day part: ${input.timeContext.dayPart}`,
    `gap kind: ${input.timeContext.gapKind}`,
    `summary: ${input.timeContext.summary}`
  ].join("\n");

  return {
    blockId: `current_time_context:${input.turnId}`,
    kind: "instruction" as const,
    title: "current time context",
    content,
    sourceRefs: [input.turnId]
  };
}
