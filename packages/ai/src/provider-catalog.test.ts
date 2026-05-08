import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_PROFILE_IDS,
  DEFAULT_PROVIDER_CATALOG,
  createProviderCatalog,
  getBuiltinProviderProfile,
  listBuiltinProviderProfiles,
  resolveAuth
} from "./index.ts";

describe("provider catalog", () => {
  it("registers multiple providers and lets models override provider defaults", () => {
    const catalog = createProviderCatalog([
      {
        providerId: "custom-openai",
        displayName: "Custom OpenAI",
        protocolFamily: "chat_completions",
        baseUrl: "https://models.example.com/v1",
        auth: {
          type: "bearer",
          token: "CUSTOM_OPENAI_KEY"
        },
        headers: {
          "X-Provider": "provider-default"
        },
        models: [
          {
            modelId: "writer-1",
            displayName: "Writer 1",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: true,
              maxContextTokens: 128000,
              maxOutputTokens: 8192
            }
          },
          {
            modelId: "writer-2",
            displayName: "Writer 2",
            protocolFamily: "responses",
            baseUrl: "https://responses.example.com/v1",
            headers: {
              "X-Provider": "model-override"
            },
            auth: {
              type: "api-key",
              token: "WRITER_TWO_KEY",
              headerName: "x-writer-key"
            },
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false,
              maxContextTokens: 256000,
              maxOutputTokens: 16384
            }
          }
        ]
      },
      {
        providerId: "anthropic-explicit",
        displayName: "Anthropic Explicit",
        protocolFamily: "anthropic_messages",
        baseUrl: "https://anthropic.example.com",
        auth: {
          type: "api-key",
          token: "ANTHROPIC_EXPLICIT_KEY",
          headerName: "x-api-key"
        },
        headers: {
          "anthropic-version": "2023-06-01"
        },
        models: [
          {
            modelId: "claude-like",
            displayName: "Claude Like",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: true,
              maxContextTokens: 200000,
              maxOutputTokens: 64000
            }
          }
        ]
      }
    ]);

    expect(catalog.listProviders().map((provider) => provider.providerId)).toEqual([
      "custom-openai",
      "anthropic-explicit"
    ]);

    const writer1 = catalog.resolveModel({
      providerId: "custom-openai",
      modelId: "writer-1"
    });
    const writer2 = catalog.resolveModel({
      providerId: "custom-openai",
      modelId: "writer-2"
    });

    expect(writer1.metadata).toMatchObject({
      providerId: "custom-openai",
      modelId: "writer-1",
      displayName: "Writer 1",
      protocolFamily: "chat_completions"
    });
    expect(writer1.provider.displayName).toBe("Custom OpenAI");
    expect(writer1.baseUrl).toBe("https://models.example.com/v1");
    expect(writer1.headers).toEqual({
      "X-Provider": "provider-default"
    });
    expect(writer1.auth).toEqual({
      type: "bearer",
      token: "CUSTOM_OPENAI_KEY"
    });

    expect(writer2.metadata).toMatchObject({
      providerId: "custom-openai",
      modelId: "writer-2",
      displayName: "Writer 2",
      protocolFamily: "responses"
    });
    expect(writer2.baseUrl).toBe("https://responses.example.com/v1");
    expect(writer2.headers).toEqual({
      "X-Provider": "model-override"
    });
    expect(writer2.auth).toEqual({
      type: "api-key",
      token: "WRITER_TWO_KEY",
      headerName: "x-writer-key"
    });
  });

  it("ships explicit builtin provider profiles for the required vendors", () => {
    expect(BUILTIN_PROVIDER_PROFILE_IDS).toEqual([
      "openai",
      "anthropic",
      "kimi",
      "glm",
      "minimax"
    ]);

    expect(listBuiltinProviderProfiles().map((profile) => profile.providerId)).toEqual(
      BUILTIN_PROVIDER_PROFILE_IDS
    );

    const providers = DEFAULT_PROVIDER_CATALOG.listProviders();
    expect(providers.map((provider) => provider.providerId)).toEqual(BUILTIN_PROVIDER_PROFILE_IDS);

    const kimi = getBuiltinProviderProfile("kimi");
    expect(kimi).toMatchObject({
      providerId: "kimi",
      displayName: "Kimi",
      protocolFamily: "chat_completions",
      auth: {
        type: "bearer",
        token: {
          env: "KIMI_API_KEY"
        }
      }
    });

    const anthropic = DEFAULT_PROVIDER_CATALOG.resolveModel({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5"
    });
    expect(anthropic.metadata.protocolFamily).toBe("anthropic_messages");
    expect(anthropic.headers).toMatchObject({
      "anthropic-version": "2023-06-01"
    });

    const families = new Set(
      DEFAULT_PROVIDER_CATALOG.listModels().map((model) => model.protocolFamily)
    );
    expect(families).toEqual(
      new Set(["chat_completions", "responses", "anthropic_messages"])
    );
  });

  it("resolves env-backed base urls, headers, and auth without treating missing env vars as literal secrets", () => {
    const catalog = createProviderCatalog([
      {
        providerId: "openai-compatible",
        displayName: "OpenAI Compatible",
        protocolFamily: "chat_completions",
        baseUrl: {
          value: "https://api.example.com/v1",
          env: "OPENAI_COMPATIBLE_BASE_URL"
        },
        auth: {
          type: "bearer",
          token: {
            env: "OPENAI_API_KEY"
          }
        },
        headers: {
          "X-Workspace": {
            env: "WORKSPACE_HEADER",
            value: "workspace-default"
          }
        },
        models: [
          {
            modelId: "chat-skeleton",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false
            }
          }
        ]
      }
    ]);

    const resolvedModel = catalog.resolveModel({
      providerId: "openai-compatible",
      modelId: "chat-skeleton"
    });

    expect(resolveAuth(resolvedModel, {})).toEqual({
      apiKey: undefined,
      apiKeySource: "none",
      baseUrl: "https://api.example.com/v1",
      baseUrlSource: "literal",
      headers: {
        "X-Workspace": "workspace-default"
      }
    });

    expect(
      resolveAuth(resolvedModel, {
        OPENAI_API_KEY: "env-secret",
        OPENAI_COMPATIBLE_BASE_URL: "https://env.example.com/v1",
        WORKSPACE_HEADER: "workspace-alpha"
      })
    ).toEqual({
      apiKey: "env-secret",
      apiKeySource: "env",
      baseUrl: "https://env.example.com/v1",
      baseUrlSource: "env",
      headers: {
        Authorization: "Bearer env-secret",
        "X-Workspace": "workspace-alpha"
      }
    });
  });

  it("resolves canonical OpenAI models through the builtin profile env contract", () => {
    const resolvedModel = DEFAULT_PROVIDER_CATALOG.resolveModel({
      providerId: "openai",
      modelId: "gpt-5.4"
    });

    expect(resolvedModel.metadata.capabilities.supportsTools).toBe(true);
    expect(resolvedModel.baseUrlConfig?.env).toBe("OPENAI_BASE_URL");
  });

  it("lets explicit auth and base url overrides win over provider env defaults", () => {
    const resolvedModel = DEFAULT_PROVIDER_CATALOG.resolveModel({
      providerId: "openai",
      modelId: "gpt-4o-mini"
    });

    const auth = resolveAuth(resolvedModel, {
      env: {
        OPENAI_API_KEY: "env-openai-key",
        OPENAI_BASE_URL: "https://env.openai.example/v1"
      },
      apiKey: "explicit-openai-key",
      baseUrl: "https://explicit.openai.example/v1",
      headers: {
        "X-Trace": "trace-123"
      }
    });

    expect(auth).toEqual({
      apiKey: "explicit-openai-key",
      apiKeySource: "explicit",
      baseUrl: "https://explicit.openai.example/v1",
      baseUrlSource: "explicit",
      headers: {
        Authorization: "Bearer explicit-openai-key",
        "X-Trace": "trace-123"
      }
    });
  });

  it("rejects custom protocol families during catalog registration", () => {
    expect(() =>
      createProviderCatalog([
        {
          providerId: "custom-provider",
          baseUrl: "https://custom.example.com",
          protocolFamily: "custom",
          models: [
            {
              modelId: "custom-model",
              capabilities: {
                supportsTools: true,
                supportsStreaming: true,
                supportsImages: false
              }
            }
          ]
        }
      ])
    ).toThrow("Custom protocol families are not supported by the post-P0 provider catalog");
  });
});
