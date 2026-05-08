import {
  CliUsageError,
  parseCommandArgs,
  readOptionalOption,
  readOptionalPositiveIntOption,
  readRequiredOption
} from "../command-parser.ts";
import { renderSessionSearchResult, type CliCommandContext } from "../cli-types.ts";

export async function searchEventsCommand(context: CliCommandContext, args: string[]) {
  const { options, positionals } = parseCommandArgs(args, {
    stringOptions: ["--workspace", "--session", "--kind", "--limit", "--cursor"]
  });

  const queryText = positionals.join(" ").trim();
  if (!queryText) {
    throw new CliUsageError("missing query text for events");
  }

  const kind = readOptionalOption(options, "--kind");
  const result = await context.app.operator.searchSessionEvents({
    workspaceId: readRequiredOption(options, "--workspace"),
    sessionId: readOptionalOption(options, "--session"),
    queryText,
    eventKinds: kind ? [kind as "user_message" | "assistant_message" | "tool_call" | "tool_result" | "approval" | "warning" | "system"] : undefined,
    cursor: readOptionalOption(options, "--cursor"),
    limit: readOptionalPositiveIntOption(options, "--limit") ?? 10
  });

  renderSessionSearchResult(context.stdout, result);
  return 0;
}
