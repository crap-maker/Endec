import type { CliCommandContext } from "../cli-types.ts";

export async function modelCommand(context: CliCommandContext) {
  const status = await context.app.operator.getStatus();
  context.stdout.write(`model: ${status.currentModel.providerId}/${status.currentModel.modelId}\n`);
  if (status.currentModel.baseUrl) {
    context.stdout.write(`baseUrl: ${status.currentModel.baseUrl}\n`);
  }
  return 0;
}
