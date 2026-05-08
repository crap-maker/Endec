import { parseCommandArgs, readOptionalOption, readRequiredOption } from "../command-parser.ts";
import { cliDefaults, renderTurnResult, type CliCommandContext } from "../cli-types.ts";

export async function resumeTurnCommand(
  resolveContext: () => Promise<CliCommandContext>,
  args: string[]
) {
  const { options, positionals } = parseCommandArgs(args, {
    stringOptions: ["--session", "--workspace", "--turn"]
  });

  const sessionId = readRequiredOption(options, "--session");
  const context = await resolveContext();
  const result = await context.app.shell.resumeTurn({
    turnId: readOptionalOption(options, "--turn"),
    sessionId,
    workspaceId: readOptionalOption(options, "--workspace") ?? cliDefaults.workspaceId,
    input: positionals.length > 0 ? positionals.join(" ") : undefined
  });

  renderTurnResult(context.stdout, result, {
    command: "resume",
    sessionId
  });
  return 0;
}
