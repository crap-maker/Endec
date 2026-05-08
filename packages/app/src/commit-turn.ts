import type { ArtifactRef, Mode, SessionEventKind, TurnRequest, TurnResult } from "@endec/domain";
import { deriveSessionStatus } from "./status.ts";

interface SessionCommitEventInput {
  eventId: string;
  eventKind: SessionEventKind;
  createdAt: string;
  summary: string;
  text?: string;
  artifactRefs?: ArtifactRef[];
  sourceRefs?: string[];
}

interface SessionCommitStore {
  commitTurn(input: {
    turnId: string;
    sessionId: string;
    workspaceId: string;
    source: TurnRequest["source"];
    mode: Mode;
    status: TurnResult["status"];
    sessionStatus?: "active" | "waiting_input" | "waiting_approval" | "paused" | "ended";
    currentGoal?: string;
    createdAt: string;
    usage?: TurnResult["usage"];
    events: SessionCommitEventInput[];
  }): Promise<void>;
}

interface ProjectionLikeResult extends Pick<TurnResult, "turnId" | "sessionId" | "resolvedMode" | "status" | "warnings" | "blockedBy"> {
  usage?: TurnResult["usage"];
  messages?: unknown[];
  toolEvents?: unknown[];
  approvals?: unknown[];
  artifacts?: unknown[];
}

function summarizeText(text: string, maxLength = 120) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(empty)";
  }

  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  const record = asRecord(value);
  return !!record && typeof record.artifactId === "string" && typeof record.turnId === "string";
}

function asArtifactRefs(value: unknown): ArtifactRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const refs = value.filter(isArtifactRef);
  return refs.length > 0 ? refs : undefined;
}

function projectMessageEvents(input: {
  turnId: string;
  createdAt: string;
  messages: unknown[] | undefined;
}): SessionCommitEventInput[] {
  const events: SessionCommitEventInput[] = [];

  for (const [index, message] of (input.messages ?? []).entries()) {
    const record = asRecord(message);
    if (!record || typeof record.content !== "string" || typeof record.role !== "string") {
      continue;
    }

    const eventKind =
      record.role === "assistant"
        ? "assistant_message"
        : record.role === "tool"
          ? "tool_result"
          : "system";

    events.push({
      eventId: `${input.turnId}:message:${index}`,
      eventKind,
      createdAt: input.createdAt,
      summary: summarizeText(record.content),
      text: record.content,
      artifactRefs: asArtifactRefs(record.artifactRefs)
    });
  }

  return events;
}

function projectToolEvents(input: {
  turnId: string;
  createdAt: string;
  toolEvents: unknown[] | undefined;
}): SessionCommitEventInput[] {
  const events: SessionCommitEventInput[] = [];

  for (const [index, toolEvent] of (input.toolEvents ?? []).entries()) {
    const record = asRecord(toolEvent);
    if (!record) {
      continue;
    }

    const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
    const status = typeof record.status === "string"
      ? record.status
      : typeof record.state === "string"
        ? record.state
        : "unknown";
    const normalizedPayload = asRecord(record.normalizedPayload);
    const preview = asRecord(record.preview);
    const error = asRecord(record.error);
    const output = record.output
      ?? normalizedPayload?.value
      ?? preview?.previewText
      ?? error?.message
      ?? (typeof record.permissionDecision === "object" && record.permissionDecision !== null
        ? (record.permissionDecision as { reasonText?: unknown }).reasonText
        : undefined);
    const outputText = typeof output === "string"
      ? output
      : output === undefined
        ? ""
        : JSON.stringify(output);
    const artifactRef = isArtifactRef(record.artifact)
      ? record.artifact
      : isArtifactRef(record.artifactRef)
        ? record.artifactRef
        : undefined;

    events.push({
      eventId: `${input.turnId}:tool:${index}`,
      eventKind: "tool_result",
      createdAt: input.createdAt,
      summary: `${toolName} ${status}`,
      text: outputText,
      artifactRefs: artifactRef ? [artifactRef] : undefined
    });
  }

  return events;
}

function projectApprovalEvents(input: {
  turnId: string;
  createdAt: string;
  approvals: unknown[] | undefined;
}): SessionCommitEventInput[] {
  const events: SessionCommitEventInput[] = [];

  for (const [index, approval] of (input.approvals ?? []).entries()) {
    const record = asRecord(approval);
    if (!record) {
      continue;
    }

    const reasonText = typeof record.reasonText === "string" ? record.reasonText : "approval required";
    const behavior = typeof record.behavior === "string" ? record.behavior : "ask";

    events.push({
      eventId: `${input.turnId}:approval:${index}`,
      eventKind: "approval",
      createdAt: input.createdAt,
      summary: `${behavior}: ${summarizeText(reasonText)}`,
      text: reasonText
    });
  }

  return events;
}

function projectWarningEvents(input: {
  turnId: string;
  createdAt: string;
  warnings: string[];
}): SessionCommitEventInput[] {
  return input.warnings.map((warning, index) => ({
    eventId: `${input.turnId}:warning:${index}`,
    eventKind: "warning",
    createdAt: input.createdAt,
    summary: summarizeText(warning),
    text: warning
  }));
}

export async function commitTurnProjection(input: {
  sessionStore: SessionCommitStore;
  request: Pick<TurnRequest, "turnId" | "sessionId" | "workspaceId" | "source" | "input">;
  result: ProjectionLikeResult;
  currentGoal?: string;
  sourceRefs?: string[];
  createdAt?: string;
}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const events: SessionCommitEventInput[] = [];

  if (input.request.input) {
    events.push({
      eventId: `${input.request.turnId}:user`,
      eventKind: "user_message",
      createdAt,
      summary: summarizeText(input.request.input),
      text: input.request.input,
      sourceRefs: [input.request.turnId, ...(input.sourceRefs ?? [])]
    });
  }

  events.push(
    ...projectMessageEvents({
      turnId: input.request.turnId,
      createdAt,
      messages: input.result.messages
    })
  );
  events.push(
    ...projectToolEvents({
      turnId: input.request.turnId,
      createdAt,
      toolEvents: input.result.toolEvents
    })
  );
  events.push(
    ...projectApprovalEvents({
      turnId: input.request.turnId,
      createdAt,
      approvals: input.result.approvals
    })
  );
  events.push(
    ...projectWarningEvents({
      turnId: input.request.turnId,
      createdAt,
      warnings: input.result.warnings
    })
  );

  if (events.length === 1 || (input.result.status !== "completed" && events.length === 0)) {
    const fallbackSummary = `${input.result.status}${input.result.blockedBy ? ` (${input.result.blockedBy})` : ""}`;
    events.push({
      eventId: `${input.request.turnId}:system:status`,
      eventKind: input.result.status === "blocked" ? "approval" : "system",
      createdAt,
      summary: fallbackSummary,
      text: fallbackSummary,
      artifactRefs: asArtifactRefs(input.result.artifacts),
      sourceRefs: [input.request.turnId, ...(input.sourceRefs ?? [])]
    });
  }

  await input.sessionStore.commitTurn({
    turnId: input.request.turnId,
    sessionId: input.request.sessionId,
    workspaceId: input.request.workspaceId,
    source: input.request.source,
    mode: input.result.resolvedMode,
    status: input.result.status,
    sessionStatus: deriveSessionStatus({
      resultStatus: input.result.status,
      blockedBy: input.result.blockedBy
    }),
    currentGoal: input.currentGoal,
    createdAt,
    usage: input.result.usage,
    events
  });
}

export async function commitAdministrativeTurn(input: {
  sessionStore: SessionCommitStore;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  source: TurnRequest["source"];
  mode: Mode;
  status: TurnResult["status"];
  summary: string;
  text?: string;
  warnings?: string[];
  sourceRefs?: string[];
  eventKind?: SessionEventKind;
  createdAt?: string;
}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const events: SessionCommitEventInput[] = [
    {
      eventId: `${input.turnId}:administrative:0`,
      eventKind: input.eventKind ?? "system",
      createdAt,
      summary: input.summary,
      text: input.text ?? input.summary,
      sourceRefs: input.sourceRefs
    },
    ...projectWarningEvents({
      turnId: input.turnId,
      createdAt,
      warnings: input.warnings ?? []
    })
  ];

  await input.sessionStore.commitTurn({
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    source: input.source,
    mode: input.mode,
    status: input.status,
    sessionStatus: deriveSessionStatus({
      resultStatus: input.status
    }),
    createdAt,
    events
  });
}

export function extractSourceRefs(value: unknown): string[] {
  return asStringArray(value) ?? [];
}
