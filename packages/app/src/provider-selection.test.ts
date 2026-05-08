import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CATALOG, createProviderCatalog } from "@endec/ai";
import {
  createProviderRegistrations,
  evaluateExecuteSelectionStatus,
  resolveCanonicalVisibleModelSelection,
  resolveConfiguredExecuteModelSelections,
  resolveCurrentModelSelection
} from "./provider-selection.ts";

describe("createProviderRegistrations", () => {
  it("deduplicates identical shared default model ids so the provider catalog stays valid", () => {
    const registrations = createProviderRegistrations({
      env: {
        ENDEC_PROVIDER_MODEL: "qwen2.5:latest"
      }
    });

    const catalog = createProviderCatalog(registrations);

    expect(catalog.listModels()).toEqual([
      expect.objectContaining({
        providerId: "local-default",
        modelId: "qwen2.5:latest"
      })
    ]);
  });

  it("registers explicit external models for known builtin providers", () => {
    const registrations = createProviderRegistrations({
      env: {
        ENDEC_PROVIDER: "anthropic",
        ENDEC_PROVIDER_MODEL: "glm-5.1"
      }
    });

    const catalog = createProviderCatalog(registrations);
    const resolved = catalog.resolveModel({
      providerId: "anthropic",
      modelId: "glm-5.1"
    });

    expect(resolved.metadata).toMatchObject({
      providerId: "anthropic",
      modelId: "glm-5.1",
      protocolFamily: "anthropic_messages"
    });
    expect(resolved.auth).toMatchObject({
      type: "api-key",
      headerName: "x-api-key"
    });
    expect(resolved.headers).toMatchObject({
      "anthropic-version": "2023-06-01"
    });
  });
});

describe("resolveCurrentModelSelection", () => {
  it("returns one current-model resolver output and prefers persisted current model over models.json defaults", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt5.4"
      },
      catalog: DEFAULT_PROVIDER_CATALOG,
      persistedCurrentModel: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5"
      },
      modelsConfig: {
        default: "openai/gpt-5.4",
        models: [
          {
            id: "openai/gpt-5.4",
            providerId: "openai",
            modelId: "gpt-5.4",
            label: "GPT 5.4"
          }
        ]
      }
    });

    expect(selection).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      baseUrl: "https://api.anthropic.com",
      selectionSource: "persisted_current_model"
    });
  });

  it("lets a changed shared env override an auto-seeded models.json default when no explicit current model exists", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER: "anthropic",
        ENDEC_PROVIDER_MODEL: "claude-sonnet-4-5"
      },
      catalog: DEFAULT_PROVIDER_CATALOG,
      modelsConfig: {
        default: "openai/gpt-5.4",
        models: [
          {
            id: "openai/gpt-5.4",
            providerId: "openai",
            modelId: "gpt-5.4",
            label: "GPT 5.4"
          }
        ]
      }
    });

    expect(selection).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      baseUrl: "https://api.anthropic.com",
      selectionSource: "env"
    });
  });

  it("prefers the env-resolved OpenAI proxy baseUrl when no explicit owner override exists", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4",
        OPENAI_BASE_URL: "https://api.psydo.top/v1"
      },
      catalog: DEFAULT_PROVIDER_CATALOG,
      modelsConfig: {
        default: "openai/gpt-5.4",
        models: [
          {
            id: "openai/gpt-5.4",
            providerId: "openai",
            modelId: "gpt-5.4",
            label: "GPT 5.4"
          }
        ]
      }
    });

    expect(selection).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://api.psydo.top/v1",
      selectionSource: "env"
    });
  });

  it("keeps an explicit persisted current model authoritative across restart-style env changes", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER: "anthropic",
        ENDEC_PROVIDER_MODEL: "claude-sonnet-4-5"
      },
      catalog: DEFAULT_PROVIDER_CATALOG,
      persistedCurrentModel: {
        providerId: "openai",
        modelId: "gpt5.4"
      },
      modelsConfig: {
        default: "openai/gpt-5.4",
        models: [
          {
            id: "openai/gpt-5.4",
            providerId: "openai",
            modelId: "gpt-5.4",
            label: "GPT 5.4"
          }
        ]
      }
    });

    expect(selection).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      selectionSource: "persisted_current_model"
    });
  });

  it("normalizes legacy GPT aliases to canonical current-model ids", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt5.4"
      },
      catalog: DEFAULT_PROVIDER_CATALOG
    });

    expect(selection).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4",
      selectionSource: "env"
    });
  });

  it("imports deprecated tier env compatibility when shared env is absent", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER_CHEAP: "openai",
        ENDEC_PROVIDER_CHEAP_MODEL: "gpt5.4",
        ENDEC_PROVIDER_STRONG: "openai",
        ENDEC_PROVIDER_STRONG_MODEL: "gpt5.5"
      },
      catalog: DEFAULT_PROVIDER_CATALOG
    });

    expect(selection).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.5",
      selectionSource: "env"
    });
  });

  it("preserves shared model-only env compatibility through the current-model resolver", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER_MODEL: "qwen2.5:latest"
      },
      catalog: createProviderCatalog(createProviderRegistrations({
        env: {
          ENDEC_PROVIDER_MODEL: "qwen2.5:latest"
        }
      }))
    });

    expect(selection).toMatchObject({
      providerId: "local-default",
      modelId: "qwen2.5:latest",
      baseUrl: "http://127.0.0.1:11434/v1",
      selectionSource: "env"
    });
  });

  it("falls back sanely when both models.json and persisted current-model state are absent", () => {
    const selection = resolveCurrentModelSelection({
      env: {},
      catalog: createProviderCatalog(createProviderRegistrations({ env: {} }))
    });

    expect(selection).toMatchObject({
      providerId: "local-default",
      modelId: "cheap-default",
      baseUrl: "http://127.0.0.1:11434/v1",
      selectionSource: "catalog"
    });
  });

  it("resolves one canonical visible model when legacy internal tier overrides diverge", () => {
    const visibleModel = resolveCanonicalVisibleModelSelection({
      env: {},
      catalog: DEFAULT_PROVIDER_CATALOG,
      overrides: {
        cheap: { providerId: "openai", modelId: "gpt5.4" },
        strong: { providerId: "openai", modelId: "gpt5.5" }
      }
    });

    expect(visibleModel).toEqual({
      providerId: "openai",
      modelId: "gpt-5.5",
      selectionSource: "derived_legacy"
    });
  });

  it("does not invent a local fallback baseUrl for unknown current-model providers", () => {
    const selection = resolveCurrentModelSelection({
      env: {
        ENDEC_PROVIDER: "unknown-provider",
        ENDEC_PROVIDER_MODEL: "custom-model"
      },
      catalog: DEFAULT_PROVIDER_CATALOG
    });

    expect(selection).toMatchObject({
      providerId: "unknown-provider",
      modelId: "custom-model",
      selectionSource: "env"
    });
    expect(selection.baseUrl).toBeUndefined();
  });
});

describe("resolveConfiguredExecuteModelSelections", () => {
  it("does not pre-classify an explicitly configured external chat model as embedding-only when catalog metadata is missing", () => {
    const catalog = createProviderCatalog([
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        protocolFamily: "anthropic_messages",
        baseUrl: "https://api.anthropic.test",
        auth: {
          type: "api-key"
        },
        models: [
          {
            modelId: "claude-sonnet-4-5",
            displayName: "Claude Sonnet 4.5",
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

    const selection = resolveConfiguredExecuteModelSelections({
      env: {
        ENDEC_PROVIDER: "anthropic",
        ENDEC_PROVIDER_MODEL: "glm-5.1"
      },
      catalog
    }).cheap;
    const status = evaluateExecuteSelectionStatus({
      selection,
      inspection: {
        providerId: "anthropic",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        availableModelIds: ["glm-5.1"]
      }
    });

    expect(selection).toMatchObject({
      providerId: "anthropic",
      modelId: "glm-5.1",
      modelCapability: "unknown",
      executeCapable: true,
      selectionSource: "env",
      providerConfigured: true,
      modelConfigured: true
    });
    expect(status).toEqual({
      executeReady: true,
      warnings: []
    });
  });

  it("selects canonical OpenAI models and normalizes legacy aliases from env overrides", () => {
    const selection = resolveConfiguredExecuteModelSelections({
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt5.4",
        ENDEC_PROVIDER_STRONG_MODEL: "gpt-5.5"
      },
      catalog: DEFAULT_PROVIDER_CATALOG
    });

    expect(selection.cheap.modelId).toBe("gpt-5.4");
    expect(selection.cheap.modelCapability).toBe("chat");
    expect(selection.strong.modelId).toBe("gpt-5.5");
    expect(selection.strong.modelCapability).toBe("chat");
  });

  it("applies persisted model overrides ahead of env defaults and persists canonical ids", () => {
    const catalog = createProviderCatalog(createProviderRegistrations({
      env: {
        ENDEC_PROVIDER_CHEAP: "openai",
        ENDEC_PROVIDER_CHEAP_MODEL: "gpt5.4"
      }
    }));
    const resolved = resolveConfiguredExecuteModelSelections({
      env: {
        ENDEC_PROVIDER_CHEAP: "openai",
        ENDEC_PROVIDER_CHEAP_MODEL: "gpt5.4"
      },
      catalog,
      overrides: {
        cheap: { providerId: "openai", modelId: "gpt5.5" }
      }
    });

    expect(resolved.cheap.modelId).toBe("gpt-5.5");
    expect(resolved.cheap.providerId).toBe("openai");
  });

  it("reports unknown capability accurately instead of calling it embedding-only when pre-classification is impossible", () => {
    const catalog = createProviderCatalog([
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        protocolFamily: "anthropic_messages",
        baseUrl: "https://api.anthropic.test",
        auth: {
          type: "api-key"
        },
        models: []
      }
    ]);

    const selection = resolveConfiguredExecuteModelSelections({
      env: {
        ENDEC_PROVIDER: "anthropic"
      },
      catalog
    }).cheap;
    const status = evaluateExecuteSelectionStatus({
      selection,
      inspection: null
    });

    expect(selection).toMatchObject({
      providerId: "anthropic",
      modelId: "cheap-default",
      modelCapability: "unknown",
      executeCapable: false,
      modelConfigured: false
    });
    expect(status.executeReady).toBe(false);
    expect(status.warnings).toEqual([
      expect.objectContaining({
        code: "provider_model_capability_unknown",
        message: expect.stringContaining("could not be pre-classified")
      })
    ]);
  });
});
