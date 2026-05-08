#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EndecApp } from "@endec/app";
import { CliUsageError, isCliUsageError, parseCommandArgs } from "./command-parser.ts";
import { type CliAppInput, type CliCommandContext, resolveCliApp } from "./cli-types.ts";
import { artifactCommand } from "./commands/artifact.ts";
import { browseHistoryCommand } from "./commands/browse-history.ts";
import { cancelTurnCommand } from "./commands/cancel-turn.ts";
import { evidenceCommand } from "./commands/evidence.ts";
import { executeTurnCommand } from "./commands/execute-turn.ts";
import { lookupEventCommand } from "./commands/lookup-event.ts";
import { listSessionsCommand } from "./commands/list-sessions.ts";
import { modelCommand } from "./commands/model.ts";
import { operatorAccessCommand, isOperatorAccessSubcommand } from "./commands/operator-access.ts";
import { operatorInspectCommand } from "./commands/operator-inspect.ts";
import { pendingCommand } from "./commands/pending.ts";
import { providerCommand } from "./commands/provider.ts";
import { resolveApprovalCommand } from "./commands/resolve-approval.ts";
import { resumeTurnCommand } from "./commands/resume-turn.ts";
import { searchEventsCommand } from "./commands/search-events.ts";
import { statusCommand } from "./commands/status.ts";

const ROOT_HELP_LINES = [
  "usage: endec <prompt...>",
  "   or: endec execute <prompt...> [--session <id>] [--workspace <id>] [--actor <id>] [--turn <id>] [--mode <chat|plan|act|review|task>] [--task <id>] [--resume-from <ref>]",
  "   or: endec status",
  "   or: endec pending --session <id> [--turn <id>] [--frame <ref>]",
  "   or: endec operator inspect --session <id> [--workspace <id>] [--actor <id>] [--turn <id>] [--frame <ref>] [--full] [--section <name>...]",
  "   or: endec operator owner --source <cli|tui|telegram|feishu|web|sdk> --account <id>",
  "   or: endec operator pair-claims --source <cli|tui|telegram|feishu|web|sdk> --account <id>",
  "   or: endec operator pair-approve --source <cli|tui|telegram|feishu|web|sdk> --account <id> --code <code> [--operator-actor <id>]",
  "   or: endec operator owner-reset --source <cli|tui|telegram|feishu|web|sdk> --account <id> [--reason <text>] [--operator-actor <id>]",
  "   or: endec operator trusted-list --source <cli|tui|telegram|feishu|web|sdk> --account <id>",
  "   or: endec operator trusted-revoke --source <cli|tui|telegram|feishu|web|sdk> --account <id> --trust <id> [--reason <text>] [--operator-actor <id>]",
  "   or: endec sessions [--workspace <id>] [--source <cli|tui|telegram|feishu|web|sdk>] [--status <active|waiting_input|waiting_approval|paused|ended>] [--mode <chat|plan|act|review|task>] [--limit <n>] [--cursor <cursor>]",
  "   or: endec history --session <id> [--limit <n>] [--cursor <cursor>] [--before-turn <id>]",
  "   or: endec events --workspace <id> <query...> [--session <id>] [--kind <eventKind>] [--limit <n>] [--cursor <cursor>]",
  "   or: endec event --session <id> [--event <id> | --turn <id>]",
  "   or: endec artifact preview --artifact <id>",
  "   or: endec artifact read --artifact <id> [--offset <n>] [--limit <n>] [--cursor <token>]",
  "   or: endec evidence search --workspace <id> [--limit <n>] <query...>",
  "   or: endec resume --session <id> [--workspace <id>] [--turn <id>] [message...]",
  "   or: endec approve --session <id> --decision <id> [--deny] [--turn <id>] [--scope <once|turn>] [--approver <id>]",
  "   or: endec cancel --session <id> [--workspace <id>] [--turn <id>] [--reason <text>]",
  "   or: endec provider",
  "   or: endec model",
  "",
  "tip: bare prompts are shorthand for 'endec execute <prompt...>'; use '--' to stop option parsing inside prompt text."
] as const;

const COMMAND_USAGE: Record<KnownCommand, string> = {
  execute:
    "usage: endec execute <prompt...> [--session <id>] [--workspace <id>] [--actor <id>] [--turn <id>] [--mode <chat|plan|act|review|task>] [--task <id>] [--resume-from <ref>]",
  status: "usage: endec status",
  pending: "usage: endec pending --session <id> [--turn <id>] [--frame <ref>]",
  operator:
    "usage: endec operator <inspect|owner|pair-claims|pair-approve|owner-reset|trusted-list|trusted-revoke> ...",
  sessions:
    "usage: endec sessions [--workspace <id>] [--source <cli|tui|telegram|feishu|web|sdk>] [--status <active|waiting_input|waiting_approval|paused|ended>] [--mode <chat|plan|act|review|task>] [--limit <n>] [--cursor <cursor>]",
  history: "usage: endec history --session <id> [--limit <n>] [--cursor <cursor>] [--before-turn <id>]",
  events:
    "usage: endec events --workspace <id> <query...> [--session <id>] [--kind <eventKind>] [--limit <n>] [--cursor <cursor>]",
  event: "usage: endec event --session <id> [--event <id> | --turn <id>]",
  artifact: "usage: endec artifact <preview|read> ...",
  evidence: "usage: endec evidence search --workspace <id> [--limit <n>] <query...>",
  resume: "usage: endec resume --session <id> [--workspace <id>] [--turn <id>] [message...]",
  approve:
    "usage: endec approve --session <id> --decision <id> [--deny] [--turn <id>] [--scope <once|turn>] [--approver <id>]",
  cancel: "usage: endec cancel --session <id> [--workspace <id>] [--turn <id>] [--reason <text>]",
  provider: "usage: endec provider",
  model: "usage: endec model"
};

const OPERATOR_SUBCOMMAND_USAGE = {
  inspect:
    "usage: endec operator inspect --session <id> [--workspace <id>] [--actor <id>] [--turn <id>] [--frame <ref>] [--full] [--section <name>...]",
  owner: "usage: endec operator owner --source <cli|tui|telegram|feishu|web|sdk> --account <id>",
  "pair-claims": "usage: endec operator pair-claims --source <cli|tui|telegram|feishu|web|sdk> --account <id>",
  "pair-approve": "usage: endec operator pair-approve --source <cli|tui|telegram|feishu|web|sdk> --account <id> --code <code> [--operator-actor <id>]",
  "owner-reset": "usage: endec operator owner-reset --source <cli|tui|telegram|feishu|web|sdk> --account <id> [--reason <text>] [--operator-actor <id>]",
  "trusted-list": "usage: endec operator trusted-list --source <cli|tui|telegram|feishu|web|sdk> --account <id>",
  "trusted-revoke": "usage: endec operator trusted-revoke --source <cli|tui|telegram|feishu|web|sdk> --account <id> --trust <id> [--reason <text>] [--operator-actor <id>]"
} as const;

type OperatorSubcommand = keyof typeof OPERATOR_SUBCOMMAND_USAGE;

type KnownCommand =
  | "status"
  | "pending"
  | "operator"
  | "execute"
  | "sessions"
  | "history"
  | "events"
  | "event"
  | "artifact"
  | "evidence"
  | "resume"
  | "approve"
  | "cancel"
  | "provider"
  | "model";

export class CliAppBootstrapError extends Error {
  readonly dataDir: string;
  readonly stage: "load" | "create";
  override readonly cause: unknown;

  constructor(input: { dataDir: string; stage: "load" | "create"; cause: unknown }) {
    super("Failed to initialize the Endec CLI application");
    this.name = "CliAppBootstrapError";
    this.dataDir = input.dataDir;
    this.stage = input.stage;
    this.cause = input.cause;
  }
}

function formatErrorCause(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isKnownCommand(command: string | undefined): command is KnownCommand {
  return (
    command === "status" ||
    command === "artifact" ||
    command === "evidence" ||
    command === "execute" ||
    command === "pending" ||
    command === "operator" ||
    command === "sessions" ||
    command === "history" ||
    command === "events" ||
    command === "event" ||
    command === "resume" ||
    command === "approve" ||
    command === "cancel" ||
    command === "provider" ||
    command === "model"
  );
}

function describeCommand(args: string[]) {
  return isKnownCommand(args[0]) ? args[0] : "execute";
}

function resolveUsageCommand(args: string[]): KnownCommand | undefined {
  return isKnownCommand(args[0]) ? args[0] : args.length > 0 ? "execute" : undefined;
}

function isHelpFlag(token: string | undefined) {
  return token === "--help" || token === "-h";
}

function writeLines(output: { write(text: string): void }, lines: readonly string[]) {
  for (const line of lines) {
    output.write(`${line}\n`);
  }
}

function writeRootHelp(output: { write(text: string): void }) {
  writeLines(output, ROOT_HELP_LINES);
}

function resolveOperatorUsageCommand(args: string[]): OperatorSubcommand | undefined {
  if (args[0] !== "operator") {
    return undefined;
  }

  if (args[1] === "inspect") {
    return "inspect";
  }

  return isOperatorAccessSubcommand(args[1]) ? args[1] : undefined;
}

function writeCommandUsage(output: { write(text: string): void }, command: KnownCommand, args: string[] = []) {
  if (command === "operator") {
    const operatorUsageCommand = resolveOperatorUsageCommand(args);
    if (operatorUsageCommand) {
      output.write(`${OPERATOR_SUBCOMMAND_USAGE[operatorUsageCommand]}\n`);
      return;
    }
  }

  output.write(`${COMMAND_USAGE[command]}\n`);
}

function writeCliBootstrapError(
  output: { write(text: string): void },
  error: CliAppBootstrapError,
  args: string[]
) {
  const action = error.stage === "load" ? "loaded" : "created";

  output.write("endec: failed to initialize the application for this CLI command.\n");
  output.write(`The real @endec/app runtime could not be ${action}, so ${describeCommand(args)} cannot run.\n`);
  output.write(`dataDir: ${error.dataDir}\n`);
  output.write(`cause: ${formatErrorCause(error.cause)}\n`);
}

const DEPLOYMENT_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const;
const SHARED_DATA_VOLUME_PATTERN = /(^|\s)["']?\.\/data:\/data["']?(\s|$)/m;

function tryReadText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isEndecRepoRoot(cwd: string) {
  const packageJson = tryReadText(resolve(cwd, "package.json"));
  if (!packageJson) {
    return false;
  }

  try {
    const parsed = JSON.parse(packageJson) as { name?: unknown };
    return parsed.name === "endec";
  } catch {
    return false;
  }
}

function composeMapsSharedDataDir(cwd: string) {
  return DEPLOYMENT_COMPOSE_FILES.some((file) => {
    const contents = tryReadText(resolve(cwd, file));
    return contents ? SHARED_DATA_VOLUME_PATTERN.test(contents) : false;
  });
}

function resolveImplicitDataDir(cwd: string) {
  const sharedDataDir = resolve(cwd, "data");

  if (isEndecRepoRoot(cwd)) {
    return sharedDataDir;
  }

  if (composeMapsSharedDataDir(cwd)) {
    return sharedDataDir;
  }

  return resolve(cwd, ".endec");
}

function resolveDefaultDataDir(input?: { dataDir?: string; env?: NodeJS.ProcessEnv; cwd?: string }) {
  if (input?.dataDir !== undefined) {
    return input.dataDir;
  }

  const env = input?.env ?? process.env;
  if (env.ENDEC_DATA_DIR !== undefined) {
    return env.ENDEC_DATA_DIR;
  }

  return resolveImplicitDataDir(input?.cwd ?? process.cwd());
}

function extractGlobalCliConfig(argv: string[]) {
  const rewrittenArgv = argv.slice(0, 2);
  let dataDir: string | undefined;

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      rewrittenArgv.push(...argv.slice(index));
      break;
    }

    if (token === "--data-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError("missing value for --data-dir");
      }

      dataDir = value;
      index += 1;
      continue;
    }

    rewrittenArgv.push(token);
  }

  return {
    argv: rewrittenArgv,
    dataDir
  };
}

export async function createDefaultApp(input?: {
  dataDir?: string;
  loadCreateEndecApp?: () => Promise<{
    createEndecApp(config: { dataDir: string; env: NodeJS.ProcessEnv }): EndecApp | Promise<EndecApp>;
  }>;
}) {
  const dataDir = resolveDefaultDataDir({ dataDir: input?.dataDir });
  const loadCreateEndecApp = input?.loadCreateEndecApp ?? (() => import("@endec/app"));

  let createEndecApp: (config: { dataDir: string; env: NodeJS.ProcessEnv }) => EndecApp | Promise<EndecApp>;
  try {
    ({ createEndecApp } = await loadCreateEndecApp());
  } catch (cause) {
    throw new CliAppBootstrapError({
      dataDir,
      stage: "load",
      cause
    });
  }

  try {
    return await createEndecApp({
      dataDir,
      env: process.env
    });
  } catch (cause) {
    throw new CliAppBootstrapError({
      dataDir,
      stage: "create",
      cause
    });
  }
}

export async function runCli(input: {
  argv: string[];
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  app: CliAppInput;
  now?: () => number;
}) {
  const args = input.argv.slice(2);
  const command = args[0];
  const now = input.now ?? (() => Date.now());
  let contextPromise: Promise<CliCommandContext> | undefined;

  const getContext = () => {
    contextPromise ??= resolveCliApp(input.app).then((app) => ({
      stdout: input.stdout,
      stderr: input.stderr,
      app,
      now
    }));
    return contextPromise;
  };

  try {
    if (args.length === 0 || isHelpFlag(command)) {
      writeRootHelp(input.stdout);
      return 0;
    }

    if (command === "help") {
      if (isKnownCommand(args[1])) {
        writeCommandUsage(input.stdout, args[1], args.slice(1));
        return 0;
      }

      writeRootHelp(input.stdout);
      return 0;
    }

    if (isKnownCommand(command) && isHelpFlag(args[1]) && args.length === 2) {
      writeCommandUsage(input.stdout, command, args);
      return 0;
    }

    if (command === "operator" && isHelpFlag(args[2]) && args.length === 3 && resolveOperatorUsageCommand(args)) {
      writeCommandUsage(input.stdout, command, args);
      return 0;
    }

    if (command === "status") {
      if (args.length > 1) {
        throw new CliUsageError("status does not accept additional arguments");
      }
      return await statusCommand(await getContext());
    }

    if (command === "pending") {
      return await pendingCommand(getContext, args.slice(1));
    }

    if (command === "operator") {
      const subcommand = args[1];
      if (subcommand === "inspect") {
        return await operatorInspectCommand(getContext, args.slice(2));
      }
      if (isOperatorAccessSubcommand(subcommand)) {
        return await operatorAccessCommand(getContext, subcommand, args.slice(2));
      }
      throw new CliUsageError(
        "operator requires subcommand: inspect, owner, pair-claims, pair-approve, owner-reset, trusted-list, or trusted-revoke"
      );
    }

    if (command === "sessions") {
      return await listSessionsCommand(await getContext(), args.slice(1));
    }

    if (command === "history") {
      return await browseHistoryCommand(await getContext(), args.slice(1));
    }

    if (command === "events") {
      return await searchEventsCommand(await getContext(), args.slice(1));
    }

    if (command === "event") {
      return await lookupEventCommand(await getContext(), args.slice(1));
    }

    if (command === "artifact") {
      return await artifactCommand(await getContext(), args.slice(1));
    }

    if (command === "evidence") {
      return await evidenceCommand(await getContext(), args.slice(1));
    }

    if (command === "resume") {
      return await resumeTurnCommand(getContext, args.slice(1));
    }

    if (command === "approve") {
      return await resolveApprovalCommand(getContext, args.slice(1));
    }

    if (command === "cancel") {
      return await cancelTurnCommand(getContext, args.slice(1));
    }

    if (command === "provider") {
      if (args.length > 1) {
        throw new CliUsageError("provider does not accept additional arguments");
      }
      return await providerCommand(await getContext());
    }

    if (command === "model") {
      if (args.length > 1) {
        throw new CliUsageError("model does not accept additional arguments");
      }
      return await modelCommand(await getContext());
    }

    if (command === "execute") {
      const parsed = parseCommandArgs(args.slice(1), {
        stringOptions: ["--session", "--workspace", "--actor", "--turn", "--mode", "--task", "--resume-from"]
      });

      if (parsed.positionals.join(" ").trim().length === 0) {
        throw new CliUsageError("missing prompt for execute");
      }

      const result = await executeTurnCommand(await getContext(), args.slice(1));
      return result.exitCode;
    }

    const result = await executeTurnCommand(await getContext(), args);
    if (result.handled) {
      return result.exitCode;
    }

    writeRootHelp(input.stdout);
    return 0;
  } catch (error) {
    if (isCliUsageError(error)) {
      input.stderr.write(`endec: ${error.message}\n`);
      const usageCommand = resolveUsageCommand(args);
      if (usageCommand) {
        writeCommandUsage(input.stderr, usageCommand, args);
      }
      return 1;
    }

    if (error instanceof CliAppBootstrapError) {
      writeCliBootstrapError(input.stderr, error, args);
      return 1;
    }

    if (error instanceof Error) {
      input.stderr.write(`endec: ${error.message}\n`);
      return 1;
    }

    input.stderr.write(`endec: ${formatErrorCause(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const bootstrap = extractGlobalCliConfig(process.argv);
    const exitCode = await runCli({
      argv: bootstrap.argv,
      stdout: process.stdout,
      stderr: process.stderr,
      app: () => createDefaultApp({ dataDir: bootstrap.dataDir })
    });

    process.exitCode = exitCode;
  } catch (error) {
    if (isCliUsageError(error)) {
      process.stderr.write(`endec: ${error.message}\n`);
      process.stderr.write(`${ROOT_HELP_LINES[0]}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
