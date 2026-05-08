import {
  CliUsageError,
  parseCommandArgs,
  readOptionalOption,
  readRequiredOption
} from "../command-parser.ts";
import { renderSessionLookupResult, type CliCommandContext } from "../cli-types.ts";

export async function lookupEventCommand(context: CliCommandContext, args: string[]) {
  const { options } = parseCommandArgs(args, {
    stringOptions: ["--session", "--event", "--turn"]
  });

  const eventId = readOptionalOption(options, "--event");
  const turnId = readOptionalOption(options, "--turn");
  if ((eventId && turnId) || (!eventId && !turnId)) {
    throw new CliUsageError("provide exactly one of --event or --turn");
  }

  const result = await context.app.operator.lookupSessionEvent({
    sessionId: readRequiredOption(options, "--session"),
    eventId,
    turnId
  });

  return renderSessionLookupResult(context.stdout, result) ? 0 : 1;
}
