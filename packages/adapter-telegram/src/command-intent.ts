import type { ImCommandIntent, ImCommandName } from "@endec/domain";

const KNOWN_COMMANDS = new Set<ImCommandName>([
  "help",
  "status",
  "model",
  "models",
  "persona",
  "recall",
  "history",
  "trust",
  "provider",
  "inspect",
  "reload",
  "restart"
]);
const PASSTHROUGH_COMMANDS = new Set(["background", "bg", "pair"]);

function normalizeBotUsername(botUsername: string | undefined) {
  const normalized = botUsername?.trim().replace(/^@+/, "").toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function tokenizeCommandText(text: string) {
  return text.trim().split(/\s+/u).filter((part) => part.length > 0);
}

function readOptionValue(token: string, nextToken: string | undefined) {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    const value = token.slice(equalsIndex + 1).trim();
    return value.length > 0 ? value : undefined;
  }

  return nextToken?.trim() || undefined;
}

function parseCommandHead(input: {
  text: string;
  botUsername?: string;
}) {
  const [head] = tokenizeCommandText(input.text);
  if (!head?.startsWith("/")) {
    return null;
  }

  const withoutSlash = head.slice(1);
  const [rawName, rawTargetUsername] = withoutSlash.split("@");
  if (!rawName) {
    return null;
  }

  const normalizedTarget = rawTargetUsername?.toLowerCase();
  const expectedBotUsername = normalizeBotUsername(input.botUsername);
  if (normalizedTarget && expectedBotUsername && normalizedTarget !== expectedBotUsername) {
    return null;
  }

  return {
    name: rawName.toLowerCase(),
    addressedUsername: normalizedTarget
  };
}

export function looksLikeTelegramSlashCommand(input: {
  text: string;
  botUsername?: string;
}) {
  const head = parseCommandHead(input);
  return head !== null && !PASSTHROUGH_COMMANDS.has(head.name);
}

export function parseTelegramCommandIntent(input: {
  text: string;
  botUsername?: string;
}): ImCommandIntent | null {
  const head = parseCommandHead(input);
  if (!head) {
    return null;
  }

  if (PASSTHROUGH_COMMANDS.has(head.name)) {
    return null;
  }

  if (!KNOWN_COMMANDS.has(head.name as ImCommandName)) {
    return {
      name: "help",
      args: [],
      options: {
        unknownCommand: head.name
      },
      rawText: input.text.trim(),
      helpRequested: false
    };
  }

  const tokens = tokenizeCommandText(input.text);
  const [, ...tailTokens] = tokens;
  const commandName = head.name as ImCommandName;
  const rawText = input.text.trim();
  const options: Record<string, unknown> = {};
  const args: string[] = [];
  let subcommand: string | undefined;
  let helpRequested = false;

  for (let index = 0; index < tailTokens.length; index += 1) {
    const token = tailTokens[index]!;
    const normalizedToken = token.toLowerCase();

    if (normalizedToken === "--help") {
      helpRequested = true;
      continue;
    }

    if (normalizedToken === "--all") {
      options.all = true;
      continue;
    }

    if (normalizedToken === "--reveal") {
      options.reveal = true;
      continue;
    }

    if (normalizedToken === "--shared-default") {
      options["shared-default"] = true;
      continue;
    }

    if (normalizedToken === "--here") {
      options.here = true;
      subcommand ??= "here";
      continue;
    }

    if (normalizedToken === "--chat" || normalizedToken.startsWith("--chat=")) {
      const value = readOptionValue(token, tailTokens[index + 1]);
      if (value) {
        options.chat = value;
        if (!normalizedToken.startsWith("--chat=")) {
          index += 1;
        }
      }
      continue;
    }

    if (!subcommand && ["model", "models", "persona", "trust", "provider", "inspect"].includes(commandName)) {
      subcommand = token;
      continue;
    }

    args.push(token);
  }

  if (commandName === "help" && !helpRequested) {
    return {
      name: "help",
      subcommand,
      args,
      options,
      rawText,
      helpRequested: false
    };
  }

  if (helpRequested) {
    const helpArgs = args.length > 0 ? args : [commandName];
    return {
      name: commandName,
      subcommand,
      args: helpArgs,
      options,
      rawText,
      helpRequested: true
    };
  }

  return {
    name: commandName,
    subcommand,
    args,
    options,
    rawText,
    helpRequested: false
  };
}
