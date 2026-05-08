import { parseCommandArgs, readOptionalOption, readRequiredOption } from "../command-parser.ts";
import { cliDefaults, renderTurnResult, type CliCommandContext } from "../cli-types.ts";

export async function cancelTurnCommand(
  resolveContext: () => Promise<CliCommandContext>,
  args: string[]
) {
  const { options } = parseCommandArgs(args, {
    stringOptions: ["--session", "--workspace", "--turn", "--reason"]
  });

  const sessionId = readRequiredOption(options, "--session");
  const context = await resolveContext();
  const result = await context.app.shell.cancelInflightTurn({
    turnId: readOptionalOption(options, "--turn"),
    sessionId,
    workspaceId: readOptionalOption(options, "--workspace") ?? cliDefaults.workspaceId,
    reason: readOptionalOption(options, "--reason")
  });

  renderTurnResult(context.stdout, result, {
    command: "cancel",
    sessionId
  });
  return 0;
}
