import {
  CliUsageError,
  parseCommandArgs,
  readBooleanOption,
  readOptionalOption,
  readRequiredOption
} from "../command-parser.ts";
import { cliDefaults, renderOperatorTurnInspectionResult, type CliCommandContext } from "../cli-types.ts";

const SUPPORTED_OPERATOR_INSPECT_SECTIONS = [
  "continuity",
  "durableMemory",
  "truncation",
  "driftDiagnostics",
  "budget",
  "continuation",
  "correction"
] as const;

function readRepeatedStringOptions(args: string[], key: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== key) {
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`missing value for ${key}`);
    }
    values.push(value);
    index += 1;
  }

  return values;
}

function parseOperatorInspectSections(args: string[]) {
  const sections = readRepeatedStringOptions(args, "--section");
  for (const section of sections) {
    if (!(SUPPORTED_OPERATOR_INSPECT_SECTIONS as readonly string[]).includes(section)) {
      throw new CliUsageError(
        `unsupported value for --section: ${section} (supported: ${SUPPORTED_OPERATOR_INSPECT_SECTIONS.join(", ")})`
      );
    }
  }

  return sections as Array<(typeof SUPPORTED_OPERATOR_INSPECT_SECTIONS)[number]>;
}

export async function operatorInspectCommand(
  resolveContext: () => Promise<CliCommandContext>,
  args: string[]
) {
  const { options } = parseCommandArgs(args, {
    stringOptions: ["--session", "--workspace", "--actor", "--turn", "--frame", "--section"],
    booleanOptions: ["--full"]
  });

  const sessionId = readRequiredOption(options, "--session");
  const workspaceId = readOptionalOption(options, "--workspace") ?? cliDefaults.workspaceId;
  const actorId = readOptionalOption(options, "--actor");
  const turnId = readOptionalOption(options, "--turn");
  const frameRef = readOptionalOption(options, "--frame");
  const full = readBooleanOption(options, "--full");
  const sections = parseOperatorInspectSections(args);
  const detail = full || sections.length > 0
    ? {
        ...(full ? { verbosity: "full" as const } : {}),
        ...(sections.length > 0 ? { sections } : {})
      }
    : undefined;

  const context = await resolveContext();
  const result = await context.app.operator.inspectOperatorTurn({
    target: {
      sessionId,
      workspaceId,
      ...(actorId ? { actorId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(frameRef ? { frameRef } : {})
    },
    ...(detail ? { detail } : {})
  });

  renderOperatorTurnInspectionResult(context.stdout, { sessionId }, result);
  return 0;
}
