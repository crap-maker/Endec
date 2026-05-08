import {
  parseCommandArgs,
  readOptionalOption,
  readOptionalPositiveIntOption,
  readRequiredOption
} from "../command-parser.ts";
import { renderSessionBrowseResult, type CliCommandContext } from "../cli-types.ts";

export async function browseHistoryCommand(context: CliCommandContext, args: string[]) {
  const { options } = parseCommandArgs(args, {
    stringOptions: ["--session", "--limit", "--cursor", "--before-turn"]
  });

  const result = await context.app.operator.browseSessionHistory({
    sessionId: readRequiredOption(options, "--session"),
    cursor: readOptionalOption(options, "--cursor"),
    beforeTurnId: readOptionalOption(options, "--before-turn"),
    limit: readOptionalPositiveIntOption(options, "--limit") ?? 10
  });

  renderSessionBrowseResult(context.stdout, result);
  return 0;
}
