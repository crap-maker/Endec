import { parseCommandArgs, readOptionalOption, readRequiredOption } from "../command-parser.ts";
import { renderRecoverySnapshotResult, type CliCommandContext } from "../cli-types.ts";

export async function pendingCommand(
  resolveContext: () => Promise<CliCommandContext>,
  args: string[]
) {
  const { options } = parseCommandArgs(args, {
    stringOptions: ["--session", "--turn", "--frame"]
  });

  const sessionId = readRequiredOption(options, "--session");
  const turnId = readOptionalOption(options, "--turn");
  const frameRef = readOptionalOption(options, "--frame");
  const context = await resolveContext();
  const result = await context.app.operator.getRecoverySnapshot({
    sessionId,
    turnId,
    frameRef
  });

  renderRecoverySnapshotResult(context.stdout, { sessionId }, result);
  return 0;
}
