import type { ProviderConfigValueInput, ResolvedProviderModel } from "./provider-catalog.ts";

export interface ResolveAuthOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface ResolvedAuth {
  apiKey?: string;
  apiKeySource: "explicit" | "env" | "literal" | "none";
  baseUrl: string;
  baseUrlSource: "explicit" | "env" | "literal" | "none";
  headers: Record<string, string>;
}

interface ResolvedValue {
  value?: string;
  source: "explicit" | "env" | "literal" | "none";
}

function normalizeString(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveValue(
  value: ProviderConfigValueInput | undefined,
  env: Record<string, string | undefined>,
  explicit?: string
): ResolvedValue {
  const explicitValue = normalizeString(explicit);
  if (explicitValue) {
    return {
      value: explicitValue,
      source: "explicit"
    };
  }

  if (!value) {
    return {
      source: "none"
    };
  }

  if (typeof value === "string") {
    const envValue = normalizeString(env[value]);
    if (envValue) {
      return {
        value: envValue,
        source: "env"
      };
    }

    const literalValue = normalizeString(value);
    return literalValue
      ? {
          value: literalValue,
          source: "literal"
        }
      : {
          source: "none"
        };
  }

  const envValue = value.env ? normalizeString(env[value.env]) : undefined;
  if (envValue) {
    return {
      value: envValue,
      source: "env"
    };
  }

  const literalValue = normalizeString(value.value);
  return literalValue
    ? {
        value: literalValue,
        source: "literal"
      }
    : {
        source: "none"
      };
}

function resolveHeaders(
  model: ResolvedProviderModel,
  env: Record<string, string | undefined>,
  explicitHeaders: Record<string, string> | undefined
) {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(model.headerConfigs)) {
    const header = resolveValue(value, env, explicitHeaders?.[key]);
    if (header.value) {
      resolved[key] = header.value;
    }
  }

  if (explicitHeaders) {
    for (const [key, value] of Object.entries(explicitHeaders)) {
      const explicitValue = normalizeString(value);
      if (!explicitValue) {
        continue;
      }
      resolved[key] = explicitValue;
    }
  }

  return resolved;
}

function isResolveAuthOptions(
  input: ResolveAuthOptions | Record<string, string | undefined>
): input is ResolveAuthOptions {
  return (
    typeof input === "object" &&
    input !== null &&
    ("env" in input || "apiKey" in input || "baseUrl" in input || "headers" in input)
  );
}

export function resolveAuth(
  model: ResolvedProviderModel,
  input: ResolveAuthOptions | Record<string, string | undefined> = process.env
): ResolvedAuth {
  const options = isResolveAuthOptions(input) ? input : { env: input };
  const env = options.env ?? process.env;
  const resolvedApiKey = resolveValue(model.auth.token, env, options.apiKey);
  const resolvedBaseUrl = resolveValue(model.baseUrlConfig ?? model.baseUrl, env, options.baseUrl);
  const headers = resolveHeaders(model, env, options.headers);

  if (resolvedApiKey.value && model.auth.type === "bearer") {
    headers.Authorization = `Bearer ${resolvedApiKey.value}`;
  }

  if (resolvedApiKey.value && model.auth.type === "api-key") {
    headers[model.auth.headerName ?? "x-api-key"] = resolvedApiKey.value;
  }

  return {
    apiKey: resolvedApiKey.value,
    apiKeySource: resolvedApiKey.source,
    baseUrl: resolvedBaseUrl.value ?? model.baseUrl,
    baseUrlSource: resolvedBaseUrl.value ? resolvedBaseUrl.source : model.baseUrl ? "literal" : "none",
    headers
  };
}
