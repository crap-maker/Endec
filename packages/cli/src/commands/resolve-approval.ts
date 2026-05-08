import { CliUsageError, parseCommandArgs, readBooleanOption, readOptionalOption, readRequiredOption } from "../command-parser.ts";
import { renderTurnResult, type CliCommandContext } from "../cli-types.ts";

export async function resolveApprovalCommand(
  resolveContext: () => Promise<CliCommandContext>,
  args: string[]
) {
  const { options } = parseCommandArgs(args, {
    stringOptions: ["--session", "--decision", "--turn", "--scope", "--approver"],
    booleanOptions: ["--deny"]
  });

  const sessionId = readRequiredOption(options, "--session");
  const decisionId = readRequiredOption(options, "--decision");
  const approved = !readBooleanOption(options, "--deny");
  const rawScope = readOptionalOption(options, "--scope");
  if (rawScope && rawScope !== "once" && rawScope !== "turn") {
    throw new CliUsageError(`unsupported value for --scope: ${rawScope} (supported: once, turn)`);
  }

  const scope = rawScope as "once" | "turn" | undefined;
  const context = await resolveContext();
  const result = await context.app.shell.resolveApproval({
    turnId: readOptionalOption(options, "--turn"),
    sessionId,
    decisionId,
    approved,
    scope,
    approverId: readOptionalOption(options, "--approver")
  });

  renderTurnResult(context.stdout, result, {
    command: "approve",
    sessionId,
    decisionId,
    approved
  });
  return 0;
}
