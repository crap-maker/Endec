import {
  parseCommandArgs,
  readOptionalOption,
  readOptionalPositiveIntOption
} from "../command-parser.ts";
import { renderSessionListResult, type CliCommandContext } from "../cli-types.ts";

export async function listSessionsCommand(context: CliCommandContext, args: string[]) {
  const { options } = parseCommandArgs(args, {
    stringOptions: ["--workspace", "--source", "--status", "--mode", "--limit", "--cursor"]
  });

  const result = await context.app.operator.listSessions({
    workspaceId: readOptionalOption(options, "--workspace"),
    source: readOptionalOption(options, "--source") as
      | "cli"
      | "tui"
      | "telegram"
      | "feishu"
      | "web"
      | "sdk"
      | undefined,
    status: readOptionalOption(options, "--status") as
      | "active"
      | "waiting_input"
      | "waiting_approval"
      | "paused"
      | "ended"
      | undefined,
    mode: readOptionalOption(options, "--mode") as
      | "chat"
      | "plan"
      | "act"
      | "review"
      | "task"
      | undefined,
    cursor: readOptionalOption(options, "--cursor"),
    limit: readOptionalPositiveIntOption(options, "--limit") ?? 10
  });

  renderSessionListResult(context.stdout, result);
  return 0;
}
