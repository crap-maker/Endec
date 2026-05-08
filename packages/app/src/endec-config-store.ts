import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MemoryEmbeddingConfigSchema } from "@endec/memory";
import type { EndecDataPaths } from "./data-paths.ts";

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_EMBEDDING_ALLOWED_KINDS = [
  "chat_summary",
  "typed_memory",
  "evidence",
  "memory_md",
  "user_memory_doc"
] as const;

const EndecProviderConfigSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional()
}).strict();

export const EndecConfigSchema = z.object({
  schemaVersion: z.literal(DEFAULT_SCHEMA_VERSION),
  updatedAt: z.string().min(1),
  ownerSelected: z.boolean(),
  provider: EndecProviderConfigSchema,
  embeddings: MemoryEmbeddingConfigSchema
}).strict();

export type EndecConfig = z.infer<typeof EndecConfigSchema>;
export type EndecConfigProvider = z.infer<typeof EndecProviderConfigSchema>;
export type EndecConfigSeed = {
  provider: EndecConfigProvider;
  embeddings?: Partial<z.input<typeof MemoryEmbeddingConfigSchema>>;
};

type EndecConfigFileOps = {
  copyFile: typeof copyFile;
  chmod: typeof chmod;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  stat: typeof stat;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
};

type EndecConfigStoreInput = {
  paths: Pick<EndecDataPaths, "dataDir" | "configDir" | "endecConfigPath">;
  fileOps?: Partial<EndecConfigFileOps>;
};

type EnsureEndecConfigInput = EndecConfigStoreInput & {
  seed: EndecConfigSeed;
};

type UpdateEndecConfigInput = EndecConfigStoreInput & {
  seed?: EndecConfigSeed;
  update: (current: EndecConfig) => EndecConfig;
};

function createFileOps(overrides?: Partial<EndecConfigFileOps>): EndecConfigFileOps {
  return {
    copyFile,
    chmod,
    mkdir,
    readFile,
    rename,
    stat,
    unlink,
    writeFile,
    ...overrides
  };
}

function normalizeModelId(modelId: string) {
  return modelId === "gpt5.4"
    ? "gpt-5.4"
    : modelId === "gpt5.5"
      ? "gpt-5.5"
      : modelId;
}

function normalizeProvider(provider: EndecConfigProvider): EndecConfigProvider {
  return {
    ...provider,
    modelId: normalizeModelId(provider.modelId)
  };
}

function defaultEmbeddingConfig(seed: EndecConfigProvider) {
  return MemoryEmbeddingConfigSchema.parse({
    enabled: false,
    providerId: seed.providerId,
    modelId: seed.modelId,
    baseUrl: seed.baseUrl,
    apiKey: seed.apiKey,
    indexBackend: "sqlite_vec",
    allowedKinds: [...DEFAULT_EMBEDDING_ALLOWED_KINDS],
    chunking: {
      maxDocumentChars: 12000,
      maxChunkChars: 2400,
      overlapChars: 200
    }
  });
}

function seedEndecConfig(seed: EndecConfigSeed): EndecConfig {
  const provider = normalizeProvider(seed.provider);
  const embeddingsSeed = seed.embeddings ?? {};
  return EndecConfigSchema.parse({
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ownerSelected: false,
    provider,
    embeddings: MemoryEmbeddingConfigSchema.parse({
      ...defaultEmbeddingConfig(provider),
      ...embeddingsSeed,
      providerId: embeddingsSeed.providerId ?? provider.providerId,
      modelId: normalizeModelId(embeddingsSeed.modelId ?? provider.modelId),
      baseUrl: embeddingsSeed.baseUrl ?? provider.baseUrl,
      apiKey: embeddingsSeed.apiKey ?? provider.apiKey,
      allowedKinds: embeddingsSeed.allowedKinds ?? [...DEFAULT_EMBEDDING_ALLOWED_KINDS]
    })
  });
}

function assertResolvedEndecConfigPaths(paths: Pick<EndecDataPaths, "dataDir" | "configDir" | "endecConfigPath">) {
  const resolvedDataDir = resolve(paths.dataDir);
  const expectedConfigDir = join(resolvedDataDir, "config");
  const expectedEndecConfigPath = join(expectedConfigDir, "endec.json");

  if (resolve(paths.configDir) !== expectedConfigDir || resolve(paths.endecConfigPath) !== expectedEndecConfigPath) {
    throw new Error(`endec config paths must stay under the resolved dataDir ${resolvedDataDir}`);
  }
}

function isMissingError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function writeEndecConfigAtomically(input: {
  paths: Pick<EndecDataPaths, "dataDir" | "configDir" | "endecConfigPath">;
  config: EndecConfig;
  fileOps?: Partial<EndecConfigFileOps>;
}) {
  const fileOps = createFileOps(input.fileOps);
  assertResolvedEndecConfigPaths(input.paths);
  await fileOps.mkdir(input.paths.configDir, { recursive: true });

  const tempPath = `${input.paths.endecConfigPath}.tmp-${randomUUID()}`;
  const payload = `${JSON.stringify(input.config, null, 2)}\n`;

  try {
    const existing = await fileOps.stat(input.paths.endecConfigPath).catch(() => undefined);
    if (existing) {
      const backupPath = `${input.paths.endecConfigPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      await fileOps.copyFile(input.paths.endecConfigPath, backupPath);
      await fileOps.chmod(backupPath, 0o600).catch(() => undefined);
    }

    await fileOps.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    await fileOps.rename(tempPath, input.paths.endecConfigPath);
    await fileOps.chmod(input.paths.endecConfigPath, 0o600).catch(() => undefined);
  } catch (error) {
    await fileOps.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function loadEndecConfig(input: EndecConfigStoreInput): Promise<EndecConfig | undefined> {
  const fileOps = createFileOps(input.fileOps);
  assertResolvedEndecConfigPaths(input.paths);

  try {
    const raw = await fileOps.readFile(input.paths.endecConfigPath, "utf8");
    return EndecConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`invalid endec config: ${error.message}`);
    }

    if (error instanceof z.ZodError) {
      throw new Error(`invalid endec config: ${error.message}`);
    }

    throw error;
  }
}

async function withEndecConfigLock<T>(
  input: EnsureEndecConfigInput,
  run: () => Promise<T>,
  options?: { allowExistingReadShortcut?: boolean }
): Promise<T> {
  const fileOps = createFileOps(input.fileOps);
  await fileOps.mkdir(input.paths.configDir, { recursive: true });
  const lockPath = `${input.paths.endecConfigPath}.lock`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fileOps.writeFile(lockPath, `${process.pid}`, { flag: "wx" });
      try {
        return await run();
      } finally {
        await fileOps.unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST") {
        const concurrent = await loadEndecConfig(input);
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

  throw new Error(`timed out waiting to initialize ${input.paths.endecConfigPath}`);
}

export async function ensureEndecConfig(input: EnsureEndecConfigInput): Promise<EndecConfig> {
  const existing = await loadEndecConfig(input);
  if (existing) {
    return existing;
  }

  return withEndecConfigLock(input, async () => {
    const afterLock = await loadEndecConfig(input);
    if (afterLock) {
      return afterLock;
    }

    const seeded = seedEndecConfig(input.seed);
    await writeEndecConfigAtomically({
      paths: input.paths,
      config: seeded,
      fileOps: input.fileOps
    });
    return seeded;
  }, { allowExistingReadShortcut: true });
}

export async function updateEndecConfig(input: UpdateEndecConfigInput): Promise<EndecConfig> {
  return withEndecConfigLock({
    paths: input.paths,
    seed: input.seed ?? {
      provider: {
        providerId: "openai",
        modelId: "gpt-5.4"
      }
    },
    fileOps: input.fileOps
  }, async () => {
    const current = await loadEndecConfig(input);
    const baseConfig = current ?? seedEndecConfig(input.seed ?? {
      provider: {
        providerId: "openai",
        modelId: "gpt-5.4"
      }
    });

    if (!current) {
      await writeEndecConfigAtomically({
        paths: input.paths,
        config: baseConfig,
        fileOps: input.fileOps
      });
    }

    const next = EndecConfigSchema.parse(input.update(baseConfig));
    await writeEndecConfigAtomically({
      paths: input.paths,
      config: next,
      fileOps: input.fileOps
    });
    return next;
  }, { allowExistingReadShortcut: true });
}
