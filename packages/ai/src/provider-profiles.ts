import type { ProviderCapability } from "@endec/domain";
import type { ProviderRegistration } from "./provider-catalog.ts";

export const BUILTIN_PROVIDER_PROFILE_IDS = ["openai", "anthropic", "kimi", "glm", "minimax"] as const;

export type BuiltinProviderProfileId = (typeof BUILTIN_PROVIDER_PROFILE_IDS)[number];

function cloneRegistration(registration: ProviderRegistration): ProviderRegistration {
  return {
    ...registration,
    auth: registration.auth
      ? {
          ...registration.auth,
          token:
            typeof registration.auth.token === "object" && registration.auth.token
              ? { ...registration.auth.token }
              : registration.auth.token
        }
      : undefined,
    headers: registration.headers
      ? Object.fromEntries(
          Object.entries(registration.headers).map(([key, value]) => [
            key,
            typeof value === "object" && value ? { ...value } : value
          ])
        )
      : undefined,
    models: registration.models.map((model) => ({
      ...model,
      capabilities: { ...model.capabilities },
      auth: model.auth
        ? {
            ...model.auth,
            token:
              typeof model.auth.token === "object" && model.auth.token ? { ...model.auth.token } : model.auth.token
          }
        : undefined,
      headers: model.headers
        ? Object.fromEntries(
            Object.entries(model.headers).map(([key, value]) => [
              key,
              typeof value === "object" && value ? { ...value } : value
            ])
          )
        : undefined,
      baseUrl: typeof model.baseUrl === "object" && model.baseUrl ? { ...model.baseUrl } : model.baseUrl
    })),
    baseUrl: typeof registration.baseUrl === "object" ? { ...registration.baseUrl } : registration.baseUrl
  };
}

function caps(input: ProviderCapability): ProviderCapability {
  return input;
}

const BUILTIN_PROVIDER_PROFILES: Record<BuiltinProviderProfileId, ProviderRegistration> = {
  openai: {
    providerId: "openai",
    profileId: "openai",
    displayName: "OpenAI",
    baseUrl: {
      value: "https://api.openai.com/v1",
      env: "OPENAI_BASE_URL"
    },
    auth: {
      type: "bearer",
      token: {
        env: "OPENAI_API_KEY"
      }
    },
    models: [
      {
        modelId: "gpt-4o-mini",
        displayName: "GPT-4o mini",
        protocolFamily: "chat_completions",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: true,
          maxContextTokens: 128000,
          maxOutputTokens: 16384
        })
      },
      {
        modelId: "gpt-5-mini",
        displayName: "GPT-5 mini",
        protocolFamily: "responses",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: true,
          maxContextTokens: 400000,
          maxOutputTokens: 128000
        })
      },
      {
        modelId: "gpt-5.4",
        displayName: "GPT 5.4",
        protocolFamily: "chat_completions",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: true,
          maxContextTokens: 400000,
          maxOutputTokens: 128000
        })
      },
      {
        modelId: "gpt-5.5",
        displayName: "GPT 5.5",
        protocolFamily: "chat_completions",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: true,
          maxContextTokens: 400000,
          maxOutputTokens: 128000
        })
      }
    ]
  },
  anthropic: {
    providerId: "anthropic",
    profileId: "anthropic",
    displayName: "Anthropic",
    baseUrl: {
      value: "https://api.anthropic.com",
      env: "ANTHROPIC_BASE_URL"
    },
    headers: {
      "anthropic-version": {
        value: "2023-06-01",
        env: "ANTHROPIC_VERSION"
      }
    },
    auth: {
      type: "api-key",
      token: {
        env: "ANTHROPIC_API_KEY"
      },
      headerName: "x-api-key"
    },
    models: [
      {
        modelId: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        protocolFamily: "anthropic_messages",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: true,
          maxContextTokens: 200000,
          maxOutputTokens: 64000
        })
      }
    ]
  },
  kimi: {
    providerId: "kimi",
    profileId: "kimi",
    displayName: "Kimi",
    protocolFamily: "chat_completions",
    baseUrl: {
      value: "https://api.moonshot.cn/v1",
      env: "KIMI_BASE_URL"
    },
    auth: {
      type: "bearer",
      token: {
        env: "KIMI_API_KEY"
      }
    },
    models: [
      {
        modelId: "moonshot-v1-8k",
        displayName: "Moonshot v1 8K",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: false
        })
      },
      {
        modelId: "moonshot-v1-32k",
        displayName: "Moonshot v1 32K",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: false
        })
      }
    ]
  },
  glm: {
    providerId: "glm",
    profileId: "glm",
    displayName: "GLM",
    protocolFamily: "chat_completions",
    baseUrl: {
      value: "https://open.bigmodel.cn/api/paas/v4",
      env: "GLM_BASE_URL"
    },
    auth: {
      type: "bearer",
      token: {
        env: "GLM_API_KEY"
      }
    },
    models: [
      {
        modelId: "glm-4-flash",
        displayName: "GLM-4 Flash",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: false
        })
      },
      {
        modelId: "glm-4-plus",
        displayName: "GLM-4 Plus",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: false
        })
      }
    ]
  },
  minimax: {
    providerId: "minimax",
    profileId: "minimax",
    displayName: "MiniMax",
    protocolFamily: "chat_completions",
    baseUrl: {
      value: "https://api.minimax.chat/v1",
      env: "MINIMAX_BASE_URL"
    },
    auth: {
      type: "bearer",
      token: {
        env: "MINIMAX_API_KEY"
      }
    },
    models: [
      {
        modelId: "MiniMax-Text-01",
        displayName: "MiniMax Text 01",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: false
        })
      },
      {
        modelId: "MiniMax-M1",
        displayName: "MiniMax M1",
        capabilities: caps({
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: false
        })
      }
    ]
  }
};

export function getBuiltinProviderProfile(profileId: BuiltinProviderProfileId): ProviderRegistration {
  return cloneRegistration(BUILTIN_PROVIDER_PROFILES[profileId]);
}

export function listBuiltinProviderProfiles(): ProviderRegistration[] {
  return BUILTIN_PROVIDER_PROFILE_IDS.map((profileId) => getBuiltinProviderProfile(profileId));
}
