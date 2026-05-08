import type { ProviderCapability, ProviderModelMetadata, ProviderProtocolFamily } from "@endec/domain";
import { listBuiltinProviderProfiles } from "./provider-profiles.ts";

export type ProviderAuthType = "bearer" | "api-key" | "none";

export interface ProviderConfigValue {
  value?: string;
  env?: string;
}

export type ProviderConfigValueInput = string | ProviderConfigValue;

export interface ProviderAuthConfig {
  type: ProviderAuthType;
  token?: ProviderConfigValueInput;
  headerName?: string;
}

export interface ProviderModelRegistration {
  modelId: string;
  displayName?: string;
  protocolFamily?: ProviderProtocolFamily;
  capabilities: ProviderCapability;
  baseUrl?: ProviderConfigValueInput;
  headers?: Record<string, ProviderConfigValueInput>;
  auth?: ProviderAuthConfig;
}

export interface ProviderRegistration {
  providerId: string;
  displayName?: string;
  profileId?: string;
  protocolFamily?: ProviderProtocolFamily;
  baseUrl: ProviderConfigValueInput;
  headers?: Record<string, ProviderConfigValueInput>;
  auth?: ProviderAuthConfig;
  models: ProviderModelRegistration[];
}

export interface ResolvedProviderRegistration {
  providerId: string;
  displayName?: string;
  profileId?: string;
  protocolFamily?: ProviderProtocolFamily;
  baseUrl: string;
  baseUrlConfig?: ProviderConfigValue;
  headers: Record<string, string>;
  headerConfigs: Record<string, ProviderConfigValue>;
  auth: ProviderAuthConfig;
}

export interface ResolvedProviderModel {
  provider: ResolvedProviderRegistration;
  metadata: ProviderModelMetadata;
  baseUrl: string;
  baseUrlConfig?: ProviderConfigValue;
  headers: Record<string, string>;
  headerConfigs: Record<string, ProviderConfigValue>;
  auth: ProviderAuthConfig;
}

function createKey(providerId: string, modelId: string) {
  return `${providerId}:${modelId}`;
}

function assertSupportedProtocolFamily(protocolFamily: ProviderProtocolFamily | undefined) {
  if (protocolFamily === "custom") {
    throw new Error("Custom protocol families are not supported by the post-P0 provider catalog");
  }
}

function normalizeConfigValue(input: ProviderConfigValueInput | undefined): ProviderConfigValue | undefined {
  if (typeof input === "string") {
    return {
      value: input
    };
  }

  if (!input) {
    return undefined;
  }

  return {
    value: input.value,
    env: input.env
  };
}

function materializeConfigValue(input: ProviderConfigValueInput | undefined) {
  return normalizeConfigValue(input)?.value;
}

function normalizeHeaders(
  headers: Record<string, ProviderConfigValueInput> | undefined
): Record<string, ProviderConfigValue> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, normalizeConfigValue(value) ?? {}])
  );
}

function materializeHeaders(headers: Record<string, ProviderConfigValue>) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => typeof value.value === "string")
      .map(([key, value]) => [key, value.value as string])
  );
}

function normalizeAuthConfig(auth?: ProviderAuthConfig): ProviderAuthConfig {
  const resolved = auth ?? { type: "none" as const };

  if (resolved.type === "none") {
    return {
      type: "none"
    };
  }

  return {
    ...resolved,
    token: typeof resolved.token === "object" && resolved.token ? normalizeConfigValue(resolved.token) : resolved.token
  };
}

function resolveProtocolFamily(provider: ProviderRegistration, model: ProviderModelRegistration) {
  const protocolFamily = model.protocolFamily ?? provider.protocolFamily;

  if (!protocolFamily) {
    throw new Error(`Provider model ${provider.providerId}/${model.modelId} is missing a protocol family`);
  }

  assertSupportedProtocolFamily(protocolFamily);
  return protocolFamily;
}

export class ProviderCatalog {
  private readonly providers = new Map<string, ResolvedProviderRegistration>();
  private readonly models = new Map<string, ResolvedProviderModel>();

  constructor(registrations: ProviderRegistration[]) {
    for (const provider of registrations) {
      if (this.providers.has(provider.providerId)) {
        throw new Error(`Duplicate provider registration: ${provider.providerId}`);
      }

      assertSupportedProtocolFamily(provider.protocolFamily);

      const providerBaseUrlConfig = normalizeConfigValue(provider.baseUrl);
      const providerHeaderConfigs = normalizeHeaders(provider.headers);
      const resolvedProvider: ResolvedProviderRegistration = {
        providerId: provider.providerId,
        displayName: provider.displayName,
        profileId: provider.profileId,
        protocolFamily: provider.protocolFamily,
        baseUrl: materializeConfigValue(provider.baseUrl) ?? "",
        baseUrlConfig: providerBaseUrlConfig,
        headers: materializeHeaders(providerHeaderConfigs),
        headerConfigs: providerHeaderConfigs,
        auth: normalizeAuthConfig(provider.auth)
      };

      this.providers.set(provider.providerId, resolvedProvider);

      for (const model of provider.models) {
        const modelKey = createKey(provider.providerId, model.modelId);
        if (this.models.has(modelKey)) {
          throw new Error(`Duplicate provider/model registration: ${provider.providerId}/${model.modelId}`);
        }

        const protocolFamily = resolveProtocolFamily(provider, model);
        const headerConfigs = {
          ...resolvedProvider.headerConfigs,
          ...normalizeHeaders(model.headers)
        };
        const auth = model.auth ? normalizeAuthConfig(model.auth) : resolvedProvider.auth;
        const baseUrlConfig = normalizeConfigValue(model.baseUrl) ?? resolvedProvider.baseUrlConfig;

        const metadata: ProviderModelMetadata = {
          providerId: provider.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          protocolFamily,
          capabilities: model.capabilities
        };

        this.models.set(modelKey, {
          provider: resolvedProvider,
          metadata,
          baseUrl: materializeConfigValue(model.baseUrl) ?? resolvedProvider.baseUrl,
          baseUrlConfig,
          headers: materializeHeaders(headerConfigs),
          headerConfigs,
          auth
        });
      }
    }
  }

  resolveProvider(providerId: string): ResolvedProviderRegistration {
    const resolved = this.findProvider(providerId);
    if (!resolved) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return resolved;
  }

  findProvider(providerId: string): ResolvedProviderRegistration | null {
    return this.providers.get(providerId) ?? null;
  }

  listProviders(): ResolvedProviderRegistration[] {
    return [...this.providers.values()];
  }

  resolveModel(input: Pick<ProviderModelMetadata, "providerId" | "modelId">): ResolvedProviderModel {
    const resolved = this.findModel(input);
    if (!resolved) {
      throw new Error(`Unknown provider/model combination: ${input.providerId}/${input.modelId}`);
    }
    return resolved;
  }

  findModel(input: Pick<ProviderModelMetadata, "providerId" | "modelId">): ResolvedProviderModel | null {
    return this.models.get(createKey(input.providerId, input.modelId)) ?? null;
  }

  listModels(): ProviderModelMetadata[] {
    return [...this.models.values()].map((entry) => entry.metadata);
  }
}

export function createProviderCatalog(registrations: ProviderRegistration[]) {
  return new ProviderCatalog(registrations);
}

export const DEFAULT_PROVIDER_CATALOG = createProviderCatalog(listBuiltinProviderProfiles());
