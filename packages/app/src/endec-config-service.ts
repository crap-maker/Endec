import type { ProviderCatalog } from "@endec/ai";
import type { EndecConfig, EndecConfigProvider, EndecConfigSeed } from "./endec-config-store.ts";
import { ensureEndecConfig, loadEndecConfig, updateEndecConfig } from "./endec-config-store.ts";
import type { EndecDataPaths } from "./data-paths.ts";
import { normalizeCurrentModelId, resolveCurrentModelSelection } from "./provider-selection.ts";

export type EndecConfigSnapshot = {
  config: EndecConfig;
  loadedAt: string;
  source: "endec_json" | "seeded_endec_json";
  path: string;
  schemaVersion: number;
};

type EndecConfigServiceInput = {
  paths: Pick<EndecDataPaths, "dataDir" | "configDir" | "endecConfigPath" | "modelsConfigPath">;
  env: Record<string, string | undefined>;
  catalog: ProviderCatalog;
  resolveSeedProvider: (context?: { source?: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk"; accountId?: string }) => Promise<EndecConfigSeed["provider"]> | EndecConfigSeed["provider"];
};

export type EndecConfigService = ReturnType<typeof createEndecConfigService>;

function nowIso() {
  return new Date().toISOString();
}

function normalizeProviderUpdate(input: Partial<EndecConfigProvider>) {
  const providerId = input.providerId?.trim();
  const modelId = input.modelId?.trim();
  const baseUrl = input.baseUrl?.trim();
  const apiKey = input.apiKey?.trim();

  return {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId: normalizeCurrentModelId(modelId) } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {})
  } satisfies Partial<EndecConfigProvider>;
}

function maskSecret(secret: string | undefined) {
  if (!secret) {
    return undefined;
  }

  if (secret.length <= 7) {
    return `${secret.slice(0, 2)}****`;
  }

  return `${secret.slice(0, 3)}****${secret.slice(-4)}`;
}

export function createEndecConfigService(input: EndecConfigServiceInput) {
  const cache = new Map<string, EndecConfigSnapshot>();

  async function resolveSeedProvider(context?: { source?: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk"; accountId?: string }): Promise<EndecConfigProvider> {
    return normalizeProviderUpdate(await input.resolveSeedProvider(context)) as EndecConfigProvider;
  }

  async function seedOrLoad(): Promise<EndecConfigSnapshot> {
    const cached = cache.get(input.paths.endecConfigPath);
    if (cached) {
      return cached;
    }

    const existing = await loadEndecConfig({ paths: input.paths });
    if (existing) {
      const snapshot: EndecConfigSnapshot = {
        config: existing,
        loadedAt: nowIso(),
        source: "endec_json",
        path: input.paths.endecConfigPath,
        schemaVersion: existing.schemaVersion
      };
      cache.set(input.paths.endecConfigPath, snapshot);
      return snapshot;
    }

    const seeded = await ensureEndecConfig({
      paths: input.paths,
      seed: {
        provider: await resolveSeedProvider()
      }
    });
    const snapshot: EndecConfigSnapshot = {
      config: seeded,
      loadedAt: nowIso(),
      source: "seeded_endec_json",
      path: input.paths.endecConfigPath,
      schemaVersion: seeded.schemaVersion
    };
    cache.set(input.paths.endecConfigPath, snapshot);
    return snapshot;
  }

  async function reload(options?: {
    update?: (current: EndecConfig) => EndecConfig | Promise<EndecConfig>;
  }) {
    if (options?.update) {
      const current = (await getSnapshot()).config;
      const updated = await options.update(current);
      const next = await updateEndecConfig({
        paths: input.paths,
        seed: {
          provider: await resolveSeedProvider()
        },
        update() {
          return updated;
        }
      });
      const snapshot: EndecConfigSnapshot = {
        config: next,
        loadedAt: nowIso(),
        source: "endec_json",
        path: input.paths.endecConfigPath,
        schemaVersion: next.schemaVersion
      };
      cache.set(input.paths.endecConfigPath, snapshot);
      return snapshot;
    }

    cache.delete(input.paths.endecConfigPath);
    return seedOrLoad();
  }

  async function getSnapshot(context?: { source?: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk"; accountId?: string }) {
    if (!context) {
      return seedOrLoad();
    }

    const cached = cache.get(input.paths.endecConfigPath);
    if (cached) {
      return cached;
    }

    const existing = await loadEndecConfig({ paths: input.paths });
    if (existing) {
      const snapshot: EndecConfigSnapshot = {
        config: existing,
        loadedAt: nowIso(),
        source: "endec_json",
        path: input.paths.endecConfigPath,
        schemaVersion: existing.schemaVersion
      };
      cache.set(input.paths.endecConfigPath, snapshot);
      return snapshot;
    }

    const seeded = await ensureEndecConfig({
      paths: input.paths,
      seed: {
        provider: await resolveSeedProvider(context)
      }
    });
    const snapshot: EndecConfigSnapshot = {
      config: seeded,
      loadedAt: nowIso(),
      source: "seeded_endec_json",
      path: input.paths.endecConfigPath,
      schemaVersion: seeded.schemaVersion
    };
    cache.set(input.paths.endecConfigPath, snapshot);
    return snapshot;
  }

  async function updateProvider(inputValue: {
    updatedByActorId: string;
    providerId?: string;
    modelId?: string;
    baseUrl?: string;
    apiKey?: string;
    clearBaseUrl?: boolean;
    clearApiKey?: boolean;
  }) {
    const next = await updateEndecConfig({
      paths: input.paths,
      seed: {
        provider: await resolveSeedProvider()
      },
      update(current) {
        const normalized = normalizeProviderUpdate({
          providerId: inputValue.providerId,
          modelId: inputValue.modelId,
          baseUrl: inputValue.clearBaseUrl ? undefined : inputValue.baseUrl,
          apiKey: inputValue.clearApiKey ? undefined : inputValue.apiKey
        });

        return {
          ...current,
          updatedAt: nowIso(),
          ownerSelected: true,
          provider: {
            ...current.provider,
            ...normalized,
            ...(inputValue.clearBaseUrl ? { baseUrl: undefined } : {}),
            ...(inputValue.clearApiKey ? { apiKey: undefined } : {})
          }
        };
      }
    });

    const snapshot: EndecConfigSnapshot = {
      config: next,
      loadedAt: nowIso(),
      source: "endec_json",
      path: input.paths.endecConfigPath,
      schemaVersion: next.schemaVersion
    };
    cache.set(input.paths.endecConfigPath, snapshot);
    return snapshot;
  }

  async function renderMaskedSummary(inputValue?: { revealSecrets?: boolean }) {
    const snapshot = await getSnapshot();
    const provider = snapshot.config.provider;
    const embeddings = snapshot.config.embeddings;

    return [
      `config: ${snapshot.path}`,
      `schemaVersion: ${snapshot.schemaVersion}`,
      `loadedAt: ${snapshot.loadedAt}`,
      `source: ${snapshot.source}`,
      `provider: ${provider.providerId}`,
      `model: ${provider.modelId}`,
      `baseUrl: ${provider.baseUrl ?? "missing"}`,
      inputValue?.revealSecrets
        ? `apiKey: ${provider.apiKey ?? "missing"}`
        : `apiKey: ${maskSecret(provider.apiKey) ?? "missing"}`,
      `embeddings: ${embeddings.enabled ? "enabled" : "disabled"}`,
      `embeddingProvider: ${embeddings.providerId}/${embeddings.modelId}`,
      `embeddingBaseUrl: ${embeddings.baseUrl ?? "missing"}`,
      inputValue?.revealSecrets
        ? `embeddingApiKey: ${embeddings.apiKey ?? "missing"}`
        : `embeddingApiKey: ${maskSecret(embeddings.apiKey) ?? "missing"}`,
      `embeddingIndexBackend: ${embeddings.indexBackend}`,
      `embeddingAllowedKinds: ${embeddings.allowedKinds.join(", ")}`
    ].join("\n");
  }

  async function resolveCurrentModel(inputValue?: { source?: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk"; accountId?: string }) {
    const snapshot = await getSnapshot();
    const currentModel = resolveCurrentModelSelection({
      env: input.env,
      catalog: input.catalog,
      persistedCurrentModel: {
        providerId: snapshot.config.provider.providerId,
        modelId: snapshot.config.provider.modelId
      },
      modelsConfig: undefined
    });

    return {
      ...currentModel,
      baseUrl: snapshot.config.provider.baseUrl ?? currentModel.baseUrl
    };
  }

  return {
    getSnapshot,
    reload,
    updateProvider,
    renderMaskedSummary,
    resolveCurrentModel,
    resolveSeedProvider: async (context: { source?: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk"; accountId?: string } | undefined) => resolveSeedProvider(context),
    resolveSeedProviderConfig: resolveSeedProvider
  };
}
