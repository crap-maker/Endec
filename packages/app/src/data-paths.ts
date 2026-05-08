import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EndecDataPaths {
  dataDir: string;
  sessionsDbPath: string;
  tasksDbPath: string;
  memoryDbPath: string;
  costLedgerDbPath: string;
  accessDbPath: string;
  configDir: string;
  modelsConfigPath: string;
  endecConfigPath: string;
  artifactsDir: string;
  dailyMemoryProjectionDir: string;
}

export function resolveEndecDataPaths(dataDir: string): EndecDataPaths {
  const resolvedDataDir = resolve(dataDir);

  return {
    dataDir: resolvedDataDir,
    sessionsDbPath: join(resolvedDataDir, "state", "sessions.sqlite"),
    tasksDbPath: join(resolvedDataDir, "state", "tasks.sqlite"),
    memoryDbPath: join(resolvedDataDir, "state", "memory.sqlite"),
    costLedgerDbPath: join(resolvedDataDir, "state", "cost-ledger.sqlite"),
    accessDbPath: join(resolvedDataDir, "state", "access.sqlite"),
    configDir: join(resolvedDataDir, "config"),
    modelsConfigPath: join(resolvedDataDir, "config", "models.json"),
    endecConfigPath: join(resolvedDataDir, "config", "endec.json"),
    artifactsDir: join(resolvedDataDir, "artifacts"),
    dailyMemoryProjectionDir: join(resolvedDataDir, "projections", "memory", "daily")
  };
}

export function ensureEndecDataLayout(dataDir: string): EndecDataPaths {
  const paths = resolveEndecDataPaths(dataDir);

  mkdirSync(join(paths.dataDir, "state"), { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  mkdirSync(paths.dailyMemoryProjectionDir, { recursive: true });

  return paths;
}
