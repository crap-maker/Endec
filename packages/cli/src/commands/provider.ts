import type { CliCommandContext } from "../cli-types.ts";

export async function providerCommand(context: CliCommandContext) {
  const status = await context.app.operator.getStatus();
  context.stdout.write(`provider: ${status.currentModel.providerId}\n`);
  context.stdout.write(`model: ${status.currentModel.modelId}\n`);
  context.stdout.write(`configSource: ${status.config.source}\n`);
  context.stdout.write(`configVersion: ${status.config.schemaVersion}\n`);
  context.stdout.write(`configLoadedAt: ${status.config.loadedAt}\n`);
  if (status.currentModel.baseUrl) {
    context.stdout.write(`baseUrl: ${status.currentModel.baseUrl}\n`);
  }
  return 0;
}
