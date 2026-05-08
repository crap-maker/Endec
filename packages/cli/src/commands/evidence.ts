import type { CliCommandContext } from "../cli-types.ts";
import { renderEvidenceSearchResult } from "../cli-types.ts";
import {
  CliUsageError,
  parseCommandArgs,
  readOptionalOption,
  readRequiredOption
} from "../command-parser.ts";

const EVIDENCE_HELP_LINE = "usage: endec evidence search --workspace <id> [--limit <n>] <query...>";

function isHelpFlag(token: string | undefined) {
  return token === "--help" || token === "-h";
}

function parsePositiveInteger(value: string, option: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${option} must be a positive integer`);
  }
  return parsed;
}

export async function evidenceCommand(context: CliCommandContext, args: string[]) {
  const subcommand = args[0];

  if (!subcommand || isHelpFlag(subcommand)) {
    context.stdout.write(`${EVIDENCE_HELP_LINE}\n`);
    return 0;
  }

  if (subcommand !== "search") {
    throw new CliUsageError("evidence requires the search subcommand");
  }

  if (isHelpFlag(args[1])) {
    context.stdout.write(`${EVIDENCE_HELP_LINE}\n`);
    return 0;
  }

  const parsed = parseCommandArgs(args.slice(1), {
    stringOptions: ["--workspace", "--limit"]
  });

  const queryText = parsed.positionals.join(" ").trim();
  if (queryText.length === 0) {
    throw new CliUsageError("missing query for evidence search");
  }

  const workspaceId = readRequiredOption(parsed.options, "--workspace");
  const limit = readOptionalOption(parsed.options, "--limit");
  const result = await context.app.operator.searchEvidence({
    workspaceId,
    queryText,
    maxItems: limit ? parsePositiveInteger(limit, "--limit") : 5
  });

  renderEvidenceSearchResult(context.stdout, result);
  return 0;
}
