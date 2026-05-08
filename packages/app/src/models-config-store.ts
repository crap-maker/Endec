import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { EndecDataPaths } from "./data-paths.ts";

const GPT_5_4_CANONICAL = "gpt-5.4";
const GPT_5_5_CANONICAL = "gpt-5.5";

const ModelsConfigModelSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1)
}).strict();

const ModelsConfigSchema = z.object({
  default: z.string().min(1),
  models: z.array(ModelsConfigModelSchema).min(1)
}).strict().superRefine((value, context) => {
  if (!value.models.some((entry) => entry.id === value.default)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `models config default ${value.default} must match one of models[].id`
    });
  }
});

export type EndecModelsConfigEntry = z.infer<typeof ModelsConfigModelSchema>;
export type EndecModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type EndecCurrentModelSeed = {
  providerId: string;
  modelId: string;
};

type ModelsConfigFileOps = {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
};

type ModelsConfigFileOpsInput = Partial<ModelsConfigFileOps>;

type ModelsConfigStoreInput = {
  paths: Pick<EndecDataPaths, "dataDir" | "configDir" | "modelsConfigPath">;
  fileOps?: ModelsConfigFileOpsInput;
};

type EnsureModelsConfigInput = ModelsConfigStoreInput & {
  currentModel: EndecCurrentModelSeed;
};

type UpdateModelsConfigInput = EnsureModelsConfigInput & {
  update: (current: EndecModelsConfig) => EndecModelsConfig;
};

function createFileOps(overrides?: ModelsConfigFileOpsInput): ModelsConfigFileOps {
  return {
    mkdir,
    readFile,
    rename,
    stat,
    unlink,
    writeFile,
    ...overrides
  };
}

function normalizeCurrentModelId(modelId: string) {
  if (modelId === "gpt5.4") {
    return GPT_5_4_CANONICAL;
  }

  if (modelId === "gpt5.5") {
    return GPT_5_5_CANONICAL;
  }

  return modelId;
}

function createModelEntry(input: EndecCurrentModelSeed): EndecModelsConfigEntry {
  const modelId = normalizeCurrentModelId(input.modelId);

  return {
    id: `${input.providerId}/${modelId}`,
    providerId: input.providerId,
    modelId,
    label: input.providerId === "openai" && modelId === GPT_5_4_CANONICAL
      ? "GPT 5.4"
      : input.providerId === "openai" && modelId === GPT_5_5_CANONICAL
        ? "GPT 5.5"
        : `${input.providerId}/${modelId}`
  };
}

function seedModelsConfig(currentModel: EndecCurrentModelSeed): EndecModelsConfig {
  const currentEntry = createModelEntry(currentModel);
  const models = currentEntry.providerId === "openai" && [GPT_5_4_CANONICAL, GPT_5_5_CANONICAL].includes(currentEntry.modelId)
    ? [
        createModelEntry({ providerId: "openai", modelId: GPT_5_4_CANONICAL }),
        createModelEntry({ providerId: "openai", modelId: GPT_5_5_CANONICAL })
      ]
    : [currentEntry];

  return ModelsConfigSchema.parse({
    default: currentEntry.id,
    models
  });
}

function validateModelsConfig(value: unknown): EndecModelsConfig {
  try {
    return ModelsConfigSchema.parse(value);
  } catch (error) {
    throw new Error(`invalid models config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertResolvedModelsConfigPaths(paths: Pick<EndecDataPaths, "dataDir" | "configDir" | "modelsConfigPath">) {
  const resolvedDataDir = resolve(paths.dataDir);
  const expectedConfigDir = join(resolvedDataDir, "config");
  const expectedModelsConfigPath = join(expectedConfigDir, "models.json");

  if (resolve(paths.configDir) !== expectedConfigDir || resolve(paths.modelsConfigPath) !== expectedModelsConfigPath) {
    throw new Error(`models config paths must stay under the resolved dataDir ${resolvedDataDir}`);
  }
}

async function writeModelsConfigAtomically(input: {
  paths: Pick<EndecDataPaths, "dataDir" | "configDir" | "modelsConfigPath">;
  config: EndecModelsConfig;
  fileOps?: ModelsConfigFileOpsInput;
}) {
  const fileOps = createFileOps(input.fileOps);
  assertResolvedModelsConfigPaths(input.paths);
  await fileOps.mkdir(input.paths.configDir, { recursive: true });

  const tempPath = `${input.paths.modelsConfigPath}.tmp-${randomUUID()}`;
  const payload = `${JSON.stringify(input.config, null, 2)}\n`;

  try {
    await fileOps.writeFile(tempPath, payload, "utf8");
    await fileOps.rename(tempPath, input.paths.modelsConfigPath);
  } catch (error) {
    await fileOps.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function loadModelsConfig(input: ModelsConfigStoreInput): Promise<EndecModelsConfig | undefined> {
  const fileOps = createFileOps(input.fileOps);
  assertResolvedModelsConfigPaths(input.paths);

  try {
    const raw = await fileOps.readFile(input.paths.modelsConfigPath, "utf8");
    return validateModelsConfig(JSON.parse(raw));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}

async function withModelsConfigLock<T>(
  input: EnsureModelsConfigInput,
  run: () => Promise<T>,
  options?: { allowExistingReadShortcut?: boolean }
): Promise<T> {
  const fileOps = createFileOps(input.fileOps);
  await fileOps.mkdir(input.paths.configDir, { recursive: true });
  const lockPath = `${input.paths.modelsConfigPath}.lock`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fileOps.writeFile(lockPath, `${process.pid}`, { flag: "wx" });
      try {
        return await run();
      } finally {
        await fileOps.unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        const concurrent = await loadModelsConfig(input);
        if (concurrent && options?.allowExistingReadShortcut) {
          return concurrent as T;
        }

        const lockStats = await fileOps.stat(lockPath).catch(() => undefined);
        if (lockStats && Date.now() - lockStats.mtimeMs > 30_000) {
          await fileOps.unlink(lockPath).catch(() => undefined);
          continue;
        }

        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        continue;
      }

      throw error;
    }
  }

  throw new Error(`timed out waiting to initialize ${input.paths.modelsConfigPath}`);
}

export async function ensureModelsConfig(input: EnsureModelsConfigInput): Promise<EndecModelsConfig> {
  const existing = await loadModelsConfig(input);
  if (existing) {
    return existing;
  }

  return withModelsConfigLock(input, async () => {
    const afterLock = await loadModelsConfig(input);
    if (afterLock) {
      return afterLock;
    }

    const seeded = seedModelsConfig(input.currentModel);
    await writeModelsConfigAtomically({
      paths: input.paths,
      config: seeded,
      fileOps: input.fileOps
    });
    return seeded;
  }, { allowExistingReadShortcut: true });
}

export async function updateModelsConfig(input: UpdateModelsConfigInput): Promise<EndecModelsConfig> {
  return withModelsConfigLock(input, async () => {
    const current = await loadModelsConfig(input);
    const baseConfig = current ?? seedModelsConfig(input.currentModel);

    if (!current) {
      await writeModelsConfigAtomically({
        paths: input.paths,
        config: baseConfig,
        fileOps: input.fileOps
      });
    }

    const next = validateModelsConfig(input.update(baseConfig));
    await writeModelsConfigAtomically({
      paths: input.paths,
      config: next,
      fileOps: input.fileOps
    });

    return next;
  });
}
