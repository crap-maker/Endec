import { BackgroundTurnMarkerSchema, type TurnRequest } from "@endec/domain";

export interface ParsedBackgroundIntent {
  trigger: "command" | "channel_context";
  input: string;
  title: string;
  description: string;
  normalizedIntent: string;
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function deriveTitle(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "后台任务";
  }

  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47)}…`;
}

function parseCommandIntent(input: string): ParsedBackgroundIntent | null {
  const match = input.match(/^\/(background|bg)\s+([\s\S]+)$/i);
  if (!match) {
    return null;
  }

  const taskText = normalizeText(match[2] ?? "");
  if (!taskText) {
    return null;
  }

  return {
    trigger: "command",
    input: taskText,
    title: deriveTitle(taskText),
    description: taskText,
    normalizedIntent: `command:${taskText.toLowerCase()}`
  };
}

function parseStructuredIntent(channelContext: TurnRequest["channelContext"]): ParsedBackgroundIntent | null {
  const raw = channelContext?.backgroundTaskIntent;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (record.kind !== "enqueue") {
    return null;
  }

  const rawTitle = typeof record.title === "string" ? normalizeText(record.title) : "";
  const rawDescription = typeof record.description === "string" ? normalizeText(record.description) : "";
  const rawInput = typeof record.input === "string" ? normalizeText(record.input) : "";
  const description = rawDescription || rawInput;
  if (!description) {
    return null;
  }

  const title = rawTitle || deriveTitle(description);
  return {
    trigger: "channel_context",
    input: description,
    title,
    description,
    normalizedIntent: `context:${title.toLowerCase()}|${description.toLowerCase()}`
  };
}

export function parseBackgroundIntent(request: TurnRequest): ParsedBackgroundIntent | null {
  const command = parseCommandIntent(request.input);
  if (command) {
    return command;
  }

  return parseStructuredIntent(request.channelContext);
}

export function hasBackgroundExecutionMarker(request: TurnRequest) {
  const marker = request.channelContext?.backgroundTask;
  return BackgroundTurnMarkerSchema.safeParse(marker).success;
}
