import type { CliCommandContext } from "../cli-types.ts";
import { renderArtifactPreviewResult, renderArtifactReadResult } from "../cli-types.ts";
import {
  CliUsageError,
  parseCommandArgs,
  readOptionalOption,
  readRequiredOption
} from "../command-parser.ts";

const ARTIFACT_HELP_LINE = "usage: endec artifact <preview|read> ...";
const ARTIFACT_PREVIEW_HELP_LINE = "usage: endec artifact preview --artifact <id>";
const ARTIFACT_READ_HELP_LINE =
  "usage: endec artifact read --artifact <id> [--offset <n>] [--limit <n>] [--cursor <token>]";

function isHelpFlag(token: string | undefined) {
  return token === "--help" || token === "-h";
}

function parseNonNegativeInteger(value: string, option: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, option: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${option} must be a positive integer`);
  }
  return parsed;
}

export async function artifactCommand(context: CliCommandContext, args: string[]) {
  const subcommand = args[0];

  if (!subcommand || isHelpFlag(subcommand)) {
    context.stdout.write(`${ARTIFACT_HELP_LINE}\n`);
    return 0;
  }

  if (subcommand === "preview") {
    if (isHelpFlag(args[1])) {
      context.stdout.write(`${ARTIFACT_PREVIEW_HELP_LINE}\n`);
      return 0;
    }

    const parsed = parseCommandArgs(args.slice(1), {
      stringOptions: ["--artifact"]
    });
    if (parsed.positionals.length > 0) {
      throw new CliUsageError("artifact preview does not accept additional arguments");
    }

    const artifactId = readRequiredOption(parsed.options, "--artifact");
    const result = await context.app.operator.getArtifactPreview({ artifactId });

    if (!result) {
      context.stderr.write(`endec: artifact not found: ${artifactId}\n`);
      return 1;
    }

    renderArtifactPreviewResult(context.stdout, result);
    return 0;
  }

  if (subcommand === "read") {
    if (isHelpFlag(args[1])) {
      context.stdout.write(`${ARTIFACT_READ_HELP_LINE}\n`);
      return 0;
    }

    const parsed = parseCommandArgs(args.slice(1), {
      stringOptions: ["--artifact", "--offset", "--limit", "--cursor"]
    });
    if (parsed.positionals.length > 0) {
      throw new CliUsageError("artifact read does not accept additional arguments");
    }

    const artifactId = readRequiredOption(parsed.options, "--artifact");
    const offset = readOptionalOption(parsed.options, "--offset");
    const limit = readOptionalOption(parsed.options, "--limit");
    const cursor = readOptionalOption(parsed.options, "--cursor");

    const result = await context.app.operator.readArtifact({
      artifactId,
      cursor,
      offset: offset ? parseNonNegativeInteger(offset, "--offset") : undefined,
      limit: limit ? parsePositiveInteger(limit, "--limit") : undefined
    });

    if (!result) {
      context.stderr.write(`endec: artifact not found: ${artifactId}\n`);
      return 1;
    }

    renderArtifactReadResult(context.stdout, result);
    return 0;
  }

  throw new CliUsageError("artifact requires a subcommand: preview or read");
}
