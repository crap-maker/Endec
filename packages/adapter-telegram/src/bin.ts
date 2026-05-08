#!/usr/bin/env node
import { loadTelegramRunnerConfigFromEnv, runTelegramBot } from "./run.ts";

function formatError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

try {
  const config = loadTelegramRunnerConfigFromEnv(process.env);
  process.stdout.write(
    `endec-telegram: starting account=${config.accountId} workspace=${config.workspaceId} dataDir=${config.dataDir}\n`
  );

  const result = await runTelegramBot({
    config,
    env: process.env
  });

  process.stdout.write(
    `endec-telegram: stopped account=${result.config.accountId} workspace=${result.config.workspaceId} nextUpdateId=${result.pollResult.nextUpdateId}\n`
  );
} catch (error) {
  process.stderr.write(`endec-telegram: ${formatError(error)}\n`);
  process.exitCode = 1;
}
