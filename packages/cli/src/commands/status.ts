import type { CliCommandContext } from "../cli-types.ts";
import { renderStatusResult } from "../cli-types.ts";

export async function statusCommand(context: CliCommandContext) {
  const result = await context.app.operator.getStatus();
  renderStatusResult(context.stdout, result);
  return 0;
}
