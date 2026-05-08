import { listBuiltinProviderProfiles, resolveAuth, type ProviderCatalog, type ProviderRegistration } from "@endec/ai";
import type { ProviderModelMetadata } from "@endec/domain";
import type { EndecModelsConfig } from "./models-config-store.ts";

export const DEFAULT_PROVIDER_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_PROVIDER_ID = "local-default";
export const DEFAULT_CHEAP_MODEL_ID = "cheap-default";
export const DEFAULT_STRONG_MODEL_ID = "strong-default";
export const PROVIDER_MODEL_DISCOVERY_PATH = "/models";
export const SHARED_PROVIDER_ENV = "ENDEC_PROVIDER";
export const CHEAP_PROVIDER_ENV = "ENDEC_PROVIDER_CHEAP";
export const STRONG_PROVIDER_ENV = "ENDEC_PROVIDER_STRONG";
export const SHARED_PROVIDER_MODEL_ENV = "ENDEC_PROVIDER_MODEL";
export const CHEAP_PROVIDER_MODEL_ENV = "ENDEC_PROVIDER_CHEAP_MODEL";
export const STRONG_PROVIDER_MODEL_ENV = "ENDEC_PROVIDER_STRONG_MODEL";

const LEGACY_MODEL_ID_ALIASES = new Map<string, string>([
  ["gpt5.4", "gpt-5.4"],
  ["gpt5.5", "gpt-5.5"]
]);

export type EndecExecuteModelTier = "cheap" | "strong";
export type EndecModelCapabilityKind = "chat" | "embedding" | "unknown";
export type EndecModelSelectionSource = "persisted_override" | "env" | "catalog";
export type EndecStatusWarningCode =
  | "provider_embeddings_only"
  | "default_model_unconfigured"
  | "default_model_misaligned"
  | "provider_model_capability_mismatch"
  | "provider_model_capability_unknown";

export interface EndecExecuteModelSelection {
  modelTier: EndecExecuteModelTier;
  providerId: string;
  modelId: string;
  modelCapability: EndecModelCapabilityKind;
  executeCapable: boolean;
  selectionSource: EndecModelSelectionSource;
  providerConfigured: boolean;
  modelConfigured: boolean;
}

export interface EndecStatusWarning {
  code: EndecStatusWarningCode;
  message: string;
  modelTier: EndecExecuteModelTier;
  providerId: string;
  modelId?: string;
}

export interface ProviderSelectionOverride {
  providerId: string;
  modelId: string;
}

export type CanonicalVisibleModelSelectionSource = "persisted_provider_control" | "env" | "derived_legacy" | "catalog";

export interface CanonicalVisibleModelSelection {
  providerId: string;
  modelId: string;
  selectionSource: CanonicalVisibleModelSelectionSource;
}

export type ProviderSelectionResolution = {
  cheap: EndecExecuteModelSelection;
  strong: EndecExecuteModelSelection;
};

export type EndecCurrentModelSelectionSource =
  | "provider_control"
  | "persisted_current_model"
  | "models_config_default"
  | "env"
  | "legacy_override_aligned"
  | "legacy_override_strong"
  | "legacy_override_cheap"
  | "catalog";

export type EndecCurrentModelSelection = {
  providerId: string;
  modelId: string;
  baseUrl?: string;
  selectionSource: EndecCurrentModelSelectionSource;
  providerConfigured: boolean;
  modelConfigured: boolean;
};

export interface ProviderAvailabilityInspection {
  providerId: string;
  baseUrl: string;
  availableModelIds: string[];
}

function normalizeEnvValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function normalizeLegacyModelId(modelId: string | undefined) {
  const normalized = normalizeEnvValue(modelId);
  if (!normalized) {
    return undefined;
  }

  return LEGACY_MODEL_ID_ALIASES.get(normalized) ?? normalized;
}

export function normalizeCurrentModelId(modelId: string) {
  return normalizeLegacyModelId(modelId) ?? modelId;
}

function currentModelIdCandidates(modelId: string) {
  const normalized = normalizeCurrentModelId(modelId);
  if (normalized === "gpt-5.4") {
    return [normalized, "gpt5.4"];
  }

  if (normalized === "gpt-5.5") {
    return [normalized, "gpt5.5"];
  }

  return [normalized];
}

function isEmbeddingLikeModelId(modelId: string) {
  return /embed(ding)?|bge|e5|gte|rerank/i.test(modelId);
}

export function inferModelCapability(input: {
  modelId: string;
  metadata?: Pick<ProviderModelMetadata, "capabilities">;
}): EndecModelCapabilityKind {
  if (isEmbeddingLikeModelId(input.modelId)) {
    return "embedding";
  }

  const capabilities = input.metadata?.capabilities;
  if (!capabilities) {
    return "unknown";
  }

  if (capabilities.supportsTools || capabilities.supportsStreaming || (capabilities.maxOutputTokens ?? 0) > 0) {
    return "chat";
  }

  return "unknown";
}

function listProviderIds(catalog: ProviderCatalog) {
  const seen = new Set<string>();
  const providerIds: string[] = [];

  for (const model of catalog.listModels()) {
    if (seen.has(model.providerId)) {
      continue;
    }

    seen.add(model.providerId);
    providerIds.push(model.providerId);
  }

  return providerIds;
}

function listProviderModels(catalog: ProviderCatalog, providerId: string) {
  return catalog.listModels().filter((model) => model.providerId === providerId);
}

function findFirstExecuteModel(models: ProviderModelMetadata[]) {
  return models.find((model) => inferModelCapability({ modelId: model.modelId, metadata: model }) === "chat") ?? null;
}

function resolveConfiguredProviderId(input: {
  modelTier: EndecExecuteModelTier;
  env: Record<string, string | undefined>;
  overrides?: Partial<Record<EndecExecuteModelTier, ProviderSelectionOverride>>;
}) {
  const overrideProviderId = normalizeEnvValue(input.overrides?.[input.modelTier]?.providerId);
  if (overrideProviderId) {
    return overrideProviderId;
  }

  const sharedProviderId = normalizeEnvValue(input.env[SHARED_PROVIDER_ENV]);
  const tierProviderId = normalizeEnvValue(
    input.env[input.modelTier === "strong" ? STRONG_PROVIDER_ENV : CHEAP_PROVIDER_ENV]
  );

  return tierProviderId ?? sharedProviderId;
}

function resolveConfiguredModelId(input: {
  modelTier: EndecExecuteModelTier;
  env: Record<string, string | undefined>;
  overrides?: Partial<Record<EndecExecuteModelTier, ProviderSelectionOverride>>;
}) {
  const overrideModelId = normalizeLegacyModelId(input.overrides?.[input.modelTier]?.modelId);
  if (overrideModelId) {
    return overrideModelId;
  }

  const sharedModelId = normalizeLegacyModelId(input.env[SHARED_PROVIDER_MODEL_ENV]);
  const tierModelId = normalizeLegacyModelId(
    input.env[input.modelTier === "strong" ? STRONG_PROVIDER_MODEL_ENV : CHEAP_PROVIDER_MODEL_ENV]
  );

  return tierModelId ?? sharedModelId;
}

function cloneRegistration<T>(value: T): T {
  return structuredClone(value);
}

function listExplicitKnownProviderModelSelections(env: Record<string, string | undefined>) {
  return (["cheap", "strong"] as const).reduce<Array<{ providerId: string; modelId: string }>>((entries, modelTier) => {
    const providerId = resolveConfiguredProviderId({ modelTier, env });
    const modelId = resolveConfiguredModelId({ modelTier, env });

    if (!providerId || !modelId) {
      return entries;
    }

    if (entries.some((entry) => entry.providerId === providerId && entry.modelId === modelId)) {
      return entries;
    }

    entries.push({ providerId, modelId });
    return entries;
  }, []);
}

function injectExplicitKnownProviderModels(input: {
  env: Record<string, string | undefined>;
  registrations: ProviderRegistration[];
}) {
  const registrations = [...input.registrations];
  const builtinProviders = new Map(
    listBuiltinProviderProfiles().map((registration) => [registration.providerId, registration])
  );

  for (const selection of listExplicitKnownProviderModelSelections(input.env)) {
    let registrationIndex = registrations.findIndex((registration) => registration.providerId === selection.providerId);

    if (registrationIndex === -1) {
      const builtinRegistration = builtinProviders.get(selection.providerId);
      if (!builtinRegistration) {
        continue;
      }

      registrations.push(builtinRegistration);
      registrationIndex = registrations.length - 1;
    }

    const registration = registrations[registrationIndex];
    if (!registration || registration.models.some((model) => model.modelId === selection.modelId)) {
      continue;
    }

    const templateModel = registration.models[0];
    if (!templateModel) {
      continue;
    }

    const mutableRegistration = cloneRegistration(registration);
    const dynamicModel = cloneRegistration(templateModel);
    dynamicModel.modelId = selection.modelId;
    dynamicModel.displayName = selection.modelId;
    mutableRegistration.models.push(dynamicModel);
    registrations[registrationIndex] = mutableRegistration;
  }

  return registrations;
}

function resolveFallbackProviderId(input: {
  modelTier: EndecExecuteModelTier;
  catalog: ProviderCatalog;
}) {
  const providerIds = listProviderIds(input.catalog);

  if (providerIds.includes(DEFAULT_PROVIDER_ID)) {
    return DEFAULT_PROVIDER_ID;
  }

  const providerWithExecuteModel = providerIds.find((providerId) => {
    const providerModels = listProviderModels(input.catalog, providerId);
    return findFirstExecuteModel(providerModels) !== null;
  });

  return providerWithExecuteModel ?? providerIds[0] ?? DEFAULT_PROVIDER_ID;
}

function resolveFallbackModelId(input: {
  modelTier: EndecExecuteModelTier;
  catalog: ProviderCatalog;
  providerId: string;
}) {
  const providerModels = listProviderModels(input.catalog, input.providerId);
  const preferredDefaultModelId = input.modelTier === "strong" ? DEFAULT_STRONG_MODEL_ID : DEFAULT_CHEAP_MODEL_ID;
  const preferredDefaultModel = providerModels.find((model) => model.modelId === preferredDefaultModelId);

  if (preferredDefaultModel) {
    return preferredDefaultModel.modelId;
  }

  return findFirstExecuteModel(providerModels)?.modelId ?? providerModels[0]?.modelId ?? preferredDefaultModelId;
}

function determineExecuteCapable(input: {
  modelCapability: EndecModelCapabilityKind;
  modelConfigured: boolean;
}) {
  if (input.modelCapability === "embedding") {
    return false;
  }

  if (input.modelCapability === "chat") {
    return true;
  }

  return input.modelConfigured;
}

function resolveSelectionForTier(input: {
  modelTier: EndecExecuteModelTier;
  env: Record<string, string | undefined>;
  catalog: ProviderCatalog;
  overrides?: Partial<Record<EndecExecuteModelTier, ProviderSelectionOverride>>;
}) {
  const persistedOverride = input.overrides?.[input.modelTier];
  const providerConfigured = Boolean(resolveConfiguredProviderId(input));
  const modelConfigured = Boolean(resolveConfiguredModelId(input));
  const providerId = resolveConfiguredProviderId(input) ?? resolveFallbackProviderId(input);
  const modelId = resolveConfiguredModelId(input) ?? resolveFallbackModelId({
    modelTier: input.modelTier,
    catalog: input.catalog,
    providerId
  });
  const metadata = input.catalog.findModel({ providerId, modelId })?.metadata;
  const modelCapability = inferModelCapability({
    modelId,
    metadata
  });

  return {
    modelTier: input.modelTier,
    providerId,
    modelId,
    modelCapability,
    executeCapable: determineExecuteCapable({
      modelCapability,
      modelConfigured
    }),
    selectionSource: persistedOverride ? "persisted_override" : providerConfigured || modelConfigured ? "env" : "catalog",
    providerConfigured,
    modelConfigured
  } satisfies EndecExecuteModelSelection;
}

function resolveProviderBaseUrl(input: {
  catalog: ProviderCatalog;
  providerId: string;
  env: Record<string, string | undefined>;
}) {
  const provider = input.catalog.findProvider(input.providerId);
  if (!provider) {
    return undefined;
  }

  const envBaseUrl = provider.baseUrlConfig?.env
    ? normalizeEnvValue(input.env[provider.baseUrlConfig.env])
    : undefined;

  return envBaseUrl ?? normalizeEnvValue(provider.baseUrl);
}

function resolveCurrentModelBaseUrl(input: {
  catalog: ProviderCatalog;
  selection: { providerId: string; modelId: string };
  env: Record<string, string | undefined>;
}) {
  for (const candidateModelId of currentModelIdCandidates(input.selection.modelId)) {
    const resolvedModel = input.catalog.findModel({
      providerId: input.selection.providerId,
      modelId: candidateModelId
    });
    if (resolvedModel) {
      return resolveAuth(resolvedModel, { env: input.env }).baseUrl;
    }
  }

  return resolveProviderBaseUrl({
    catalog: input.catalog,
    providerId: input.selection.providerId,
    env: input.env
  });
}

function normalizeCurrentSelection(selection: ProviderSelectionOverride) {
  return {
    providerId: selection.providerId,
    modelId: normalizeCurrentModelId(selection.modelId)
  } satisfies ProviderSelectionOverride;
}

function resolveModelsConfigDefault(modelsConfig: EndecModelsConfig | undefined) {
  if (!modelsConfig) {
    return undefined;
  }

  const entry = modelsConfig.models.find((model) => model.id === modelsConfig.default);
  if (!entry) {
    return undefined;
  }

  return normalizeCurrentSelection({
    providerId: entry.providerId,
    modelId: entry.modelId
  });
}

function resolveLegacyEnvCurrentModelSelection(env: Record<string, string | undefined>) {
  const cheapProviderId = normalizeEnvValue(env[CHEAP_PROVIDER_ENV]);
  const cheapModelId = normalizeLegacyModelId(env[CHEAP_PROVIDER_MODEL_ENV]);
  const strongProviderId = normalizeEnvValue(env[STRONG_PROVIDER_ENV]);
  const strongModelId = normalizeLegacyModelId(env[STRONG_PROVIDER_MODEL_ENV]);

  const cheap = cheapProviderId && cheapModelId
    ? normalizeCurrentSelection({ providerId: cheapProviderId, modelId: cheapModelId })
    : undefined;
  const strong = strongProviderId && strongModelId
    ? normalizeCurrentSelection({ providerId: strongProviderId, modelId: strongModelId })
    : undefined;

  if (cheap && strong && cheap.providerId === strong.providerId && cheap.modelId === strong.modelId) {
    return strong;
  }

  return strong ?? cheap;
}

function resolveLegacyCurrentModelSelection(overrides?: Partial<Record<EndecExecuteModelTier, ProviderSelectionOverride>>) {
  const cheap = overrides?.cheap ? normalizeCurrentSelection(overrides.cheap) : undefined;
  const strong = overrides?.strong ? normalizeCurrentSelection(overrides.strong) : undefined;

  if (
    cheap &&
    strong &&
    cheap.providerId === strong.providerId &&
    cheap.modelId === strong.modelId
  ) {
    return {
      selection: strong,
      selectionSource: "legacy_override_aligned" as const
    };
  }

  if (strong) {
    return {
      selection: strong,
      selectionSource: "legacy_override_strong" as const
    };
  }

  if (cheap) {
    return {
      selection: cheap,
      selectionSource: "legacy_override_cheap" as const
    };
  }

  return undefined;
}

export function resolveCurrentModelSelection(input: {
  env: Record<string, string | undefined>;
  catalog: ProviderCatalog;
  persistedCurrentModel?: ProviderSelectionOverride | null;
  modelsConfig?: EndecModelsConfig;
  providerControl?: ProviderSelectionOverride | null;
  legacyOverrides?: Partial<Record<EndecExecuteModelTier, ProviderSelectionOverride>>;
}): EndecCurrentModelSelection {
  const sharedProviderId = normalizeEnvValue(input.env[SHARED_PROVIDER_ENV]);
  const sharedModelId = normalizeLegacyModelId(input.env[SHARED_PROVIDER_MODEL_ENV]);
  const providerControl = input.providerControl ? normalizeCurrentSelection(input.providerControl) : undefined;
  const persistedCurrentModel = input.persistedCurrentModel ? normalizeCurrentSelection(input.persistedCurrentModel) : undefined;
  const modelsConfigDefault = resolveModelsConfigDefault(input.modelsConfig);
  const legacyEnvSelection = resolveLegacyEnvCurrentModelSelection(input.env);
  const legacySelection = resolveLegacyCurrentModelSelection(input.legacyOverrides);

  const selected = providerControl
    ? {
        selection: providerControl,
        selectionSource: "provider_control" as const,
        providerConfigured: true,
        modelConfigured: true
      }
    : persistedCurrentModel
      ? {
          selection: persistedCurrentModel,
          selectionSource: "persisted_current_model" as const,
          providerConfigured: true,
          modelConfigured: true
        }
      : sharedProviderId || sharedModelId
        ? (() => {
            const providerId = sharedProviderId ?? resolveFallbackProviderId({
              modelTier: "cheap",
              catalog: input.catalog
            });
            const modelId = sharedModelId ?? resolveFallbackModelId({
              modelTier: "cheap",
              catalog: input.catalog,
              providerId
            });

            return {
              selection: normalizeCurrentSelection({
                providerId,
                modelId
              }),
              selectionSource: "env" as const,
              providerConfigured: Boolean(sharedProviderId),
              modelConfigured: Boolean(sharedModelId)
            };
          })()
        : modelsConfigDefault
          ? {
              selection: modelsConfigDefault,
              selectionSource: "models_config_default" as const,
              providerConfigured: true,
              modelConfigured: true
            }
          : legacyEnvSelection
            ? {
                selection: legacyEnvSelection,
                selectionSource: "env" as const,
                providerConfigured: true,
                modelConfigured: true
              }
            : legacySelection
              ? {
                  selection: legacySelection.selection,
                  selectionSource: legacySelection.selectionSource,
                  providerConfigured: true,
                  modelConfigured: true
                }
              : {
                  selection: {
                    providerId: resolveFallbackProviderId({ modelTier: "cheap", catalog: input.catalog }),
                    modelId: normalizeCurrentModelId(resolveFallbackModelId({
                      modelTier: "cheap",
                      catalog: input.catalog,
                      providerId: resolveFallbackProviderId({ modelTier: "cheap", catalog: input.catalog })
                    }))
                  },
                  selectionSource: "catalog" as const,
                  providerConfigured: false,
                  modelConfigured: false
                };

  return {
    providerId: selected.selection.providerId,
    modelId: selected.selection.modelId,
    baseUrl: resolveCurrentModelBaseUrl({
      catalog: input.catalog,
      selection: selected.selection,
      env: input.env
    }),
    selectionSource: selected.selectionSource,
    providerConfigured: selected.providerConfigured,
    modelConfigured: selected.modelConfigured
  };
}

export function resolveConfiguredExecuteModelSelections(input: {
  env: Record<string, string | undefined>;
  catalog: ProviderCatalog;
  overrides?: Partial<Record<EndecExecuteModelTier, ProviderSelectionOverride>>;
}): ProviderSelectionResolution {
  return {
    cheap: resolveSelectionForTier({
      modelTier: "cheap",
      env: input.env,
      catalog: input.catalog,
      overrides: input.overrides
    }),
    strong: resolveSelectionForTier({
      modelTier: "strong",
      env: input.env,
      catalog: input.catalog,
      overrides: input.overrides
    })
  };
}

export function resolveCanonicalVisibleModelSelection(input: {
  env: Record<string, string | undefined>;
  catalog: ProviderCatalog;
  persistedProviderControl?: Pick<ProviderSelectionOverride, "providerId" | "modelId">;
  overrides?: Partial<Record<EndecExecuteModelTier, ProviderSelectionOverride>>;
}): CanonicalVisibleModelSelection {
  const persistedProviderId = normalizeEnvValue(input.persistedProviderControl?.providerId);
  const persistedModelId = normalizeLegacyModelId(input.persistedProviderControl?.modelId);
  if (persistedProviderId && persistedModelId) {
    return {
      providerId: persistedProviderId,
      modelId: persistedModelId,
      selectionSource: "persisted_provider_control"
    };
  }

  const sharedProviderId = normalizeEnvValue(input.env[SHARED_PROVIDER_ENV]);
  const sharedModelId = normalizeLegacyModelId(input.env[SHARED_PROVIDER_MODEL_ENV]);
  if (sharedProviderId && sharedModelId) {
    return {
      providerId: sharedProviderId,
      modelId: sharedModelId,
      selectionSource: "env"
    };
  }

  const cheapOverride = input.overrides?.cheap
    ? {
        providerId: normalizeEnvValue(input.overrides.cheap.providerId),
        modelId: normalizeLegacyModelId(input.overrides.cheap.modelId)
      }
    : undefined;
  const strongOverride = input.overrides?.strong
    ? {
        providerId: normalizeEnvValue(input.overrides.strong.providerId),
        modelId: normalizeLegacyModelId(input.overrides.strong.modelId)
      }
    : undefined;

  if (cheapOverride?.providerId && cheapOverride.modelId && strongOverride?.providerId && strongOverride.modelId) {
    if (cheapOverride.providerId === strongOverride.providerId && cheapOverride.modelId === strongOverride.modelId) {
      return {
        providerId: strongOverride.providerId,
        modelId: strongOverride.modelId,
        selectionSource: "derived_legacy"
      };
    }

    return {
      providerId: strongOverride.providerId,
      modelId: strongOverride.modelId,
      selectionSource: "derived_legacy"
    };
  }

  if (strongOverride?.providerId && strongOverride.modelId) {
    return {
      providerId: strongOverride.providerId,
      modelId: strongOverride.modelId,
      selectionSource: "derived_legacy"
    };
  }

  if (cheapOverride?.providerId && cheapOverride.modelId) {
    return {
      providerId: cheapOverride.providerId,
      modelId: cheapOverride.modelId,
      selectionSource: "derived_legacy"
    };
  }

  const resolved = resolveConfiguredExecuteModelSelections({
    env: input.env,
    catalog: input.catalog,
    overrides: input.overrides
  }).strong;

  return {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    selectionSource: "catalog"
  };
}

function summarizeAvailableModels(availableModelIds: string[]) {
  return availableModelIds.reduce(
    (summary, modelId) => {
      const capability = inferModelCapability({ modelId });
      if (capability === "chat") {
        summary.chat += 1;
      } else if (capability === "embedding") {
        summary.embedding += 1;
      } else {
        summary.unknown += 1;
      }

      return summary;
    },
    { chat: 0, embedding: 0, unknown: 0 }
  );
}

function createProviderEmbeddingsOnlyWarning(input: {
  selection: EndecExecuteModelSelection;
  inspection: ProviderAvailabilityInspection;
}) {
  const availableModels = input.inspection.availableModelIds.join(", ") || "<none>";

  return {
    code: "provider_embeddings_only",
    modelTier: input.selection.modelTier,
    providerId: input.selection.providerId,
    message:
      `Provider ${input.selection.providerId} is reachable at ${input.inspection.baseUrl} but only embedding models were reported. ` +
      `Available models: ${availableModels}`
  } satisfies EndecStatusWarning;
}

function createDefaultModelUnconfiguredWarning(input: {
  selection: EndecExecuteModelSelection;
  inspection: ProviderAvailabilityInspection;
}) {
  const envName = input.selection.modelTier === "strong" ? STRONG_PROVIDER_MODEL_ENV : CHEAP_PROVIDER_MODEL_ENV;
  const availableModels = input.inspection.availableModelIds.join(", ") || "<none>";

  return {
    code: "default_model_unconfigured",
    modelTier: input.selection.modelTier,
    providerId: input.selection.providerId,
    modelId: input.selection.modelId,
    message:
      `No execute default model is configured for the ${input.selection.modelTier} tier on provider ${input.selection.providerId}. ` +
      `Current fallback ${input.selection.providerId}/${input.selection.modelId} is not exposed by the reachable provider. ` +
      `Available models: ${availableModels}. Set ${SHARED_PROVIDER_MODEL_ENV} or ${envName} to a chat-capable model.`
  } satisfies EndecStatusWarning;
}

function createDefaultModelMisalignedWarning(input: {
  selection: EndecExecuteModelSelection;
  inspection: ProviderAvailabilityInspection;
}) {
  const availableModels = input.inspection.availableModelIds.join(", ") || "<none>";

  return {
    code: "default_model_misaligned",
    modelTier: input.selection.modelTier,
    providerId: input.selection.providerId,
    modelId: input.selection.modelId,
    message:
      `Configured execute default ${input.selection.providerId}/${input.selection.modelId} for the ${input.selection.modelTier} tier ` +
      `is not exposed by the reachable provider. Available models: ${availableModels}`
  } satisfies EndecStatusWarning;
}

function createCapabilityMismatchWarning(selection: EndecExecuteModelSelection) {
  return {
    code: "provider_model_capability_mismatch",
    modelTier: selection.modelTier,
    providerId: selection.providerId,
    modelId: selection.modelId,
    message:
      `Configured execute default ${selection.providerId}/${selection.modelId} for the ${selection.modelTier} tier is embedding-only, ` +
      "so it cannot be used on Endec's execute path."
  } satisfies EndecStatusWarning;
}

function createUnknownCapabilityWarning(selection: EndecExecuteModelSelection) {
  return {
    code: "provider_model_capability_unknown",
    modelTier: selection.modelTier,
    providerId: selection.providerId,
    modelId: selection.modelId,
    message:
      `Configured execute default ${selection.providerId}/${selection.modelId} for the ${selection.modelTier} tier could not be pre-classified, ` +
      "so Endec cannot confirm execute compatibility before live provider inspection."
  } satisfies EndecStatusWarning;
}

export function evaluateExecuteSelectionStatus(input: {
  selection: EndecExecuteModelSelection;
  inspection?: ProviderAvailabilityInspection | null;
}) {
  const warnings: EndecStatusWarning[] = [];

  if (input.selection.modelCapability === "embedding") {
    warnings.push(createCapabilityMismatchWarning(input.selection));
  }

  if (input.selection.modelCapability === "unknown" && !input.selection.executeCapable) {
    warnings.push(createUnknownCapabilityWarning(input.selection));
  }

  if (!input.inspection) {
    return {
      warnings,
      executeReady: input.selection.executeCapable && warnings.length === 0
    };
  }

  const availableSummary = summarizeAvailableModels(input.inspection.availableModelIds);
  const providerHasNoChatModels =
    input.inspection.availableModelIds.length > 0 && availableSummary.chat === 0 && availableSummary.embedding > 0;

  if (providerHasNoChatModels) {
    warnings.push(
      createProviderEmbeddingsOnlyWarning({
        selection: input.selection,
        inspection: input.inspection
      })
    );
  }

  if (
    input.inspection.availableModelIds.length > 0 &&
    !input.inspection.availableModelIds.includes(input.selection.modelId)
  ) {
    warnings.push(
      input.selection.modelConfigured
        ? createDefaultModelMisalignedWarning({
            selection: input.selection,
            inspection: input.inspection
          })
        : createDefaultModelUnconfiguredWarning({
            selection: input.selection,
            inspection: input.inspection
          })
    );
  }

  return {
    warnings,
    executeReady: input.selection.executeCapable && warnings.length === 0
  };
}

export function createProviderRegistrations(input: {
  env: Record<string, string | undefined>;
  providerRegistrations?: ProviderRegistration[];
}) {
  const baseRegistrations = input.providerRegistrations && input.providerRegistrations.length > 0
    ? input.providerRegistrations
    : [
        {
          providerId: DEFAULT_PROVIDER_ID,
          displayName: "Local default",
          baseUrl: normalizeEnvValue(input.env.ENDEC_PROVIDER_BASE_URL) ?? DEFAULT_PROVIDER_BASE_URL,
          auth: {
            type: "none"
          },
          models: ([
            {
              modelId: resolveConfiguredModelId({ modelTier: "cheap", env: input.env }) ?? DEFAULT_CHEAP_MODEL_ID,
              displayName: "Cheap default",
              protocolFamily: "chat_completions",
              capabilities: {
                supportsTools: true,
                supportsStreaming: true,
                supportsImages: false,
                maxContextTokens: 128000,
                maxOutputTokens: 16384
              }
            },
            {
              modelId: resolveConfiguredModelId({ modelTier: "strong", env: input.env }) ?? DEFAULT_STRONG_MODEL_ID,
              displayName: "Strong default",
              protocolFamily: "chat_completions",
              capabilities: {
                supportsTools: true,
                supportsStreaming: true,
                supportsImages: false,
                maxContextTokens: 128000,
                maxOutputTokens: 16384
              }
            }
          ] satisfies ProviderRegistration["models"]).reduce<ProviderRegistration["models"]>((entries, modelDefault) => {
            if (entries.some((entry) => entry.modelId === modelDefault.modelId)) {
              return entries;
            }

            entries.push(modelDefault);
            return entries;
          }, [])
        }
      ] satisfies ProviderRegistration[];

  return injectExplicitKnownProviderModels({
    env: input.env,
    registrations: baseRegistrations
  });
}
