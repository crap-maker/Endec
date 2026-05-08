import { parseCommandArgs, readOptionalOption } from "../command-parser.ts";
import {
  cliDefaults,
  createTurnId,
  renderTurnResult,
  type CliCommandContext,
  type CliTurnRequest
} from "../cli-types.ts";

export async function executeTurnCommand(context: CliCommandContext, args: string[]) {
  const { options, positionals } = parseCommandArgs(args, {
    stringOptions: ["--session", "--workspace", "--actor", "--turn", "--mode", "--task", "--resume-from"]
  });

  const input = positionals.join(" ").trim();
  if (!input) {
    return { exitCode: 0, handled: false as const };
  }

  const request: CliTurnRequest = {
    turnId: readOptionalOption(options, "--turn") ?? createTurnId(context.now),
    sessionId: readOptionalOption(options, "--session") ?? cliDefaults.sessionId,
    workspaceId: readOptionalOption(options, "--workspace") ?? cliDefaults.workspaceId,
    source: "cli",
    actorId: readOptionalOption(options, "--actor") ?? cliDefaults.actorId,
    input,
    attachments: []
  };

  const requestedMode = readOptionalOption(options, "--mode") as CliTurnRequest["requestedMode"];
  if (requestedMode) {
    request.requestedMode = requestedMode;
  }

  const taskId = readOptionalOption(options, "--task");
  if (taskId) {
    request.taskId = taskId;
  }

  const resumeFrom = readOptionalOption(options, "--resume-from");
  if (resumeFrom) {
    request.resumeFrom = resumeFrom;
  }

  const result = await context.app.shell.executeTurn(request);
  renderTurnResult(context.stdout, result);
  return { exitCode: 0, handled: true as const };
}
