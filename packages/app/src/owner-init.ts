import type {
  OwnerInitCompletionReason,
  OwnerInitState,
  OwnerPreferences,
  ResolvedOwnerPreferences
} from "@endec/domain";

type BoundedFieldUpdates = {
  ownerDisplayName?: string;
  assistantDisplayName?: string;
  timezone?: string;
};

type OwnerInitInterpretationCandidate = {
  outcome: "no_signal" | "candidate" | "ambiguous";
  fields?: Record<string, unknown>;
  confidence?: "high" | "medium" | "low";
  ambiguityReason?: string;
};

const DIRECT_TIMEZONE_ALIASES = new Map<string, string>([
  ["beijing time", "Asia/Shanghai"],
  ["shanghai timezone", "Asia/Shanghai"],
  ["shanghai time", "Asia/Shanghai"],
  ["utc+8", "Asia/Shanghai"],
  ["utc +8", "Asia/Shanghai"],
  ["los angeles time", "America/Los_Angeles"],
  ["los angeles timezone", "America/Los_Angeles"],
  ["洛杉矶时间", "America/Los_Angeles"],
  ["北京时间", "Asia/Shanghai"],
  ["上海时间", "Asia/Shanghai"]
]);
const AMBIGUOUS_TIMEZONE_ALIASES = new Set(["pt", "pst", "美国时间", "us time", "somewhere in the us"]);
const SKIP_PATTERNS = [/\bskip\b/i, /for now/i, /先这样/, /跳过/, /以后再说/];
const AMBIGUOUS_NAME_PATTERNS = [/\bor\b/i, /或者/, /maybe/i, /guess/i];

function isValidTimezone(value: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date("2026-01-01T00:00:00.000Z"));
    return true;
  } catch {
    return false;
  }
}

function cleanCapturedValue(value: string) {
  return value.trim().replace(/[。.!]$/, "").trim();
}

export function resolveOwnerPreferences(input: {
  serverTimezone: string;
  stored?: Pick<OwnerPreferences, "source" | "accountId" | "ownerGeneration" | "ownerBindingId" | "ownerActorId" | "ownerDisplayName" | "assistantDisplayName" | "timezone" | "createdAt" | "updatedAt">;
}): ResolvedOwnerPreferences {
  return {
    ownerDisplayName: input.stored?.ownerDisplayName,
    assistantDisplayName: input.stored?.assistantDisplayName?.trim() || "Endec",
    timezone: input.stored?.timezone?.trim() || input.serverTimezone,
    timezoneSource: input.stored?.timezone?.trim() ? "owner_preference" : "server_default"
  };
}

export function normalizeTimezoneText(text: string): { normalizedTimezone?: string; ambiguous: boolean } {
  const candidate = text.trim();
  if (!candidate) {
    return { normalizedTimezone: undefined, ambiguous: false };
  }

  if (isValidTimezone(candidate)) {
    return { normalizedTimezone: candidate, ambiguous: false };
  }

  const normalizedKey = candidate.toLowerCase();
  if (DIRECT_TIMEZONE_ALIASES.has(normalizedKey)) {
    return { normalizedTimezone: DIRECT_TIMEZONE_ALIASES.get(normalizedKey), ambiguous: false };
  }

  if (AMBIGUOUS_TIMEZONE_ALIASES.has(normalizedKey)) {
    return { normalizedTimezone: undefined, ambiguous: true };
  }

  return { normalizedTimezone: undefined, ambiguous: false };
}

function parseOwnerDisplayName(text: string) {
  const match = text.match(/(?:call me|my name is|我叫|叫我)\s+(.+?)(?=(?:\s+and\s+(?:call yourself|timezone|time zone|set timezone|use timezone)|\s*,|\.|!|，|。|$))/i);
  if (!match) {
    return { value: undefined, ambiguous: false };
  }

  const value = cleanCapturedValue(match[1] ?? "");
  return {
    value: value || undefined,
    ambiguous: AMBIGUOUS_NAME_PATTERNS.some((pattern) => pattern.test(value))
  };
}

function parseAssistantDisplayName(text: string) {
  const match = text.match(/(?:call yourself|your name should be|you should be called|你叫)\s+(.+?)(?=(?:\s+and\s+(?:call me|timezone|time zone|set timezone|use timezone)|\s*,|\.|!|，|。|$))/i);
  if (!match) {
    return { value: undefined, ambiguous: false };
  }

  const value = cleanCapturedValue(match[1] ?? "");
  return {
    value: value || undefined,
    ambiguous: AMBIGUOUS_NAME_PATTERNS.some((pattern) => pattern.test(value))
  };
}

function parseTimezone(text: string) {
  const directMatch = text.match(/(?:timezone is|timezone:|set timezone to|use timezone|时区是)\s+([^,.!，。]+)/i);
  const looseMatch = text.match(/\b(?:UTC[+-]\d{1,2}|[A-Za-z_]+\/[A-Za-z_]+|Beijing time|Shanghai timezone|Los Angeles time)\b/i);
  const chineseLooseMatch = text.match(/(?:北京时间|上海时间|洛杉矶时间)/);
  const raw = directMatch?.[1] ?? looseMatch?.[0] ?? chineseLooseMatch?.[0];
  if (!raw) {
    return { value: undefined, ambiguous: false };
  }

  const normalized = normalizeTimezoneText(cleanCapturedValue(raw));
  return {
    value: normalized.normalizedTimezone,
    ambiguous: normalized.ambiguous || (!normalized.normalizedTimezone && /timezone|时区|UTC|时间/i.test(raw))
  };
}

function extractCandidateUpdates(candidate: OwnerInitInterpretationCandidate | undefined) {
  if (!candidate || candidate.outcome !== "candidate" || !candidate.fields || candidate.confidence === "low") {
    return { updates: {} as BoundedFieldUpdates, ambiguous: candidate?.outcome === "ambiguous" };
  }

  const updates: BoundedFieldUpdates = {};
  const fields = candidate.fields;
  if (typeof fields.ownerDisplayName === "string" && fields.ownerDisplayName.trim()) {
    updates.ownerDisplayName = fields.ownerDisplayName.trim();
  }
  if (typeof fields.assistantDisplayName === "string" && fields.assistantDisplayName.trim()) {
    updates.assistantDisplayName = fields.assistantDisplayName.trim();
  }
  if (typeof fields.timezoneText === "string" && fields.timezoneText.trim()) {
    const normalized = normalizeTimezoneText(fields.timezoneText.trim());
    if (normalized.ambiguous) {
      return { updates: {} as BoundedFieldUpdates, ambiguous: true };
    }
    if (normalized.normalizedTimezone) {
      updates.timezone = normalized.normalizedTimezone;
    }
  }

  return { updates, ambiguous: false };
}

export function planOwnerInitUpdate(input: {
  text: string;
  serverTimezone: string;
  candidate?: OwnerInitInterpretationCandidate;
}):
  | { outcome: "apply"; updates: BoundedFieldUpdates }
  | { outcome: "skip"; completionReason: Extract<OwnerInitCompletionReason, "explicit_skip"> }
  | { outcome: "ambiguous" }
  | { outcome: "no_signal" } {
  const text = input.text.trim();
  if (!text) {
    return { outcome: "no_signal" };
  }

  if (SKIP_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      outcome: "skip",
      completionReason: "explicit_skip"
    };
  }

  const ownerDisplayName = parseOwnerDisplayName(text);
  const assistantDisplayName = parseAssistantDisplayName(text);
  const timezone = parseTimezone(text);
  if (ownerDisplayName.ambiguous || assistantDisplayName.ambiguous || timezone.ambiguous) {
    return { outcome: "ambiguous" };
  }

  const updates: BoundedFieldUpdates = {};
  if (ownerDisplayName.value) {
    updates.ownerDisplayName = ownerDisplayName.value;
  }
  if (assistantDisplayName.value) {
    updates.assistantDisplayName = assistantDisplayName.value;
  }
  if (timezone.value) {
    updates.timezone = timezone.value;
  }

  if (Object.keys(updates).length > 0) {
    return {
      outcome: "apply",
      updates
    };
  }

  const candidatePlan = extractCandidateUpdates(input.candidate);
  if (candidatePlan.ambiguous) {
    return { outcome: "ambiguous" };
  }
  if (Object.keys(candidatePlan.updates).length > 0) {
    return {
      outcome: "apply",
      updates: candidatePlan.updates
    };
  }

  return { outcome: input.candidate?.outcome === "ambiguous" ? "ambiguous" : "no_signal" };
}

export function completeOwnerInit(state: OwnerInitState, input: {
  reason: OwnerInitCompletionReason;
  now: string;
}): OwnerInitState {
  return {
    ...state,
    status: "completed",
    promptSentAt: state.status === "prompted" ? state.promptSentAt : state.promptSentAt,
    completionReason: input.reason,
    completedAt: input.now,
    updatedAt: input.now
  } as OwnerInitState;
}
