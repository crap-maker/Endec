import type {
  ActiveTaskSnapshot,
  TurnRequest,
  TurnResult
} from "@endec/domain";

export interface WorkingSetSynthesisEvent {
  eventId: string;
  turnId: string;
  eventKind: string;
  summary: string;
  text: string;
  createdAt: string;
  sourceRefs: string[];
}

function compactText(value: string | undefined, maxLength = 160) {
  if (typeof value !== "string") {
    return "";
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function uniqueStrings(values: Array<string | undefined>, limit?: number) {
  const deduped = [...new Set(values
    .map((value) => compactText(value))
    .filter((value) => value.length > 0))];

  return typeof limit === "number" ? deduped.slice(0, limit) : deduped;
}

function firstAssistantMessageText(result: Pick<TurnResult, "messages">) {
  for (const message of result.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const record = message as { role?: unknown; content?: unknown };
    if (record.role === "assistant" && typeof record.content === "string") {
      return record.content;
    }
  }

  return "";
}

function isActiveMemoryRef(ref: string) {
  return /^(working_set:|memory:|evidence:|write:)/.test(ref);
}

function renderWorkingSetSummary(input: {
  objective?: string;
  recentProgress: string[];
  recentDecisions: string[];
  blockers: string[];
  openLoops: string[];
}, fallbackSummary?: string) {
  const sections: string[] = [];

  if (input.objective) {
    sections.push(`Objective: ${input.objective}`);
  }

  if (input.recentProgress.length > 0) {
    sections.push(["Recent progress:", ...input.recentProgress.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.recentDecisions.length > 0) {
    sections.push(["Recent decisions:", ...input.recentDecisions.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.blockers.length > 0) {
    sections.push(["Blockers:", ...input.blockers.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.openLoops.length > 0) {
    sections.push(["Open loops:", ...input.openLoops.map((item) => `- ${item}`)].join("\n"));
  }

  return sections.length > 0 ? sections.join("\n\n") : compactText(fallbackSummary);
}

function summarizeDecision(event: WorkingSetSynthesisEvent) {
  const summary = compactText(event.summary, 120);
  if (!summary) {
    return "";
  }

  switch (event.eventKind) {
    case "approval":
      return `Approval: ${summary}`;
    case "system":
      return `System: ${summary}`;
    case "warning":
      return `Warning: ${summary}`;
    default:
      return "";
  }
}

function summarizeCarryForwardProgress(event: WorkingSetSynthesisEvent) {
  const summary = compactText(event.summary, 120);
  if (!summary) {
    return "";
  }

  switch (event.eventKind) {
    case "assistant_message":
      return `Carry-forward: ${summary}`;
    default:
      return "";
  }
}

export function synthesizeWorkingSet(input: {
  request: Pick<TurnRequest, "turnId" | "input">;
  result: Pick<TurnResult, "status" | "blockedBy" | "checkpointRef" | "messages">;
  activeTask?: Omit<ActiveTaskSnapshot, "selectedBy">;
  recentHistory: WorkingSetSynthesisEvent[];
}) {
  const assistantReply = compactText(firstAssistantMessageText(input.result), 120);
  const objective = compactText(input.activeTask?.title ?? input.request.input, 120) || undefined;
  const recentProgress = uniqueStrings([
    input.activeTask?.currentStep ? `Task step: ${input.activeTask.currentStep}` : undefined,
    input.request.input ? `User asked: ${input.request.input}` : undefined,
    assistantReply ? `Assistant replied: ${assistantReply}` : undefined,
    ...input.recentHistory.map(summarizeCarryForwardProgress)
  ], 4);
  const recentDecisions = uniqueStrings(input.recentHistory.map(summarizeDecision), 3);
  const blockers = uniqueStrings([
    input.activeTask?.blockingReason,
    input.result.status === "blocked" && input.result.blockedBy
      ? `Turn blocked by ${input.result.blockedBy}`
      : undefined
  ], 3);
  const openLoops = uniqueStrings([
    input.activeTask?.nextAction,
    input.result.status === "blocked" && input.result.checkpointRef
      ? `Resume from ${input.result.checkpointRef}`
      : undefined
  ], 3);
  const activeMemoryRefs = uniqueStrings(
    input.recentHistory.flatMap((event) => event.sourceRefs.filter(isActiveMemoryRef)),
    6
  );
  const activeTaskRefs = uniqueStrings([
    input.activeTask?.taskId,
    input.activeTask?.checkpointRef
  ], 4);
  const recentEventRefs = uniqueStrings(input.recentHistory.map((event) => event.eventId), 6);
  const sourceRefs = uniqueStrings([
    input.request.turnId,
    input.result.checkpointRef,
    ...activeTaskRefs,
    ...input.recentHistory.flatMap((event) => event.sourceRefs.length > 0 ? event.sourceRefs : [event.turnId]),
    ...recentEventRefs
  ], 16);
  const highlights = uniqueStrings([
    objective,
    recentProgress[0],
    blockers[0],
    openLoops[0]
  ].map((value) => compactText(value, 80)), 4);
  const summary = renderWorkingSetSummary({
    objective,
    recentProgress,
    recentDecisions,
    blockers,
    openLoops
  }, compactText(input.request.input, 120));

  return {
    summary,
    highlights,
    objective,
    recentProgress,
    recentDecisions,
    blockers,
    openLoops,
    activeMemoryRefs,
    activeTaskRefs,
    recentEventRefs,
    sourceRefs
  };
}
