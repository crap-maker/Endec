import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderCatalog, type ProviderRegistration } from "@endec/ai";
import { resolveEndecDataPaths } from "./data-paths.ts";
import { createEndecConfigService } from "./endec-config-service.ts";
import { createProviderControlService } from "./provider-control-service.ts";

const providerRegistrations: ProviderRegistration[] = [
  {
    providerId: "openai",
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
    protocolFamily: "chat_completions",
    models: [
      {
        modelId: "gpt-5.4",
        displayName: "GPT 5.4",
        protocolFamily: "chat_completions",
        capabilities: {
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: true,
          maxContextTokens: 400000,
          maxOutputTokens: 128000
        }
      },
      {
        modelId: "gpt-5.5",
        displayName: "GPT 5.5",
        protocolFamily: "chat_completions",
        capabilities: {
          supportsTools: true,
          supportsStreaming: true,
          supportsImages: true,
          maxContextTokens: 400000,
          maxOutputTokens: 128000
        }
      }
    ]
  },
  {
    providerId: "anthropic",
    displayName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: {
      type: "api-key",
      token: {
        env: "ANTHROPIC_API_KEY"
      },
      headerName: "x-api-key"
    },
    protocolFamily: "anthropic_messages",
    models: [
      {
        modelId: "claude-sonnet-4.5",
        displayName: "Claude Sonnet 4.5",
        protocolFamily: "anthropic_messages",
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
];

const tempDirs = new Set<string>();

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "endec-provider-control-"));
  tempDirs.add(dir);
  return dir;
}

async function createService() {
  const dataDir = await tempDataDir();
  const paths = resolveEndecDataPaths(dataDir);
  const catalog = createProviderCatalog(providerRegistrations);
  const configService = createEndecConfigService({
    paths,
    env: {
      ENDEC_PROVIDER: "openai",
      ENDEC_PROVIDER_MODEL: "gpt-5.5",
      OPENAI_BASE_URL: "https://env.openai.example/v1",
      OPENAI_API_KEY: "sk-env-openai-9876"
    },
    catalog,
    resolveSeedProvider: async () => ({
      providerId: "openai",
      modelId: "gpt-5.5",
      baseUrl: "https://env.openai.example/v1",
      apiKey: "sk-env-openai-9876"
    })
  });

  const service = createProviderControlService({
    configService,
    catalog,
    env: {
      ENDEC_PROVIDER: "openai",
      ENDEC_PROVIDER_MODEL: "gpt-5.5",
      OPENAI_BASE_URL: "https://env.openai.example/v1",
      OPENAI_API_KEY: "sk-env-openai-9876"
    }
  });

  return { configService, service };
}

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

describe("createProviderControlService", () => {
  it("renders masked provider state by default", async () => {
    const { configService, service } = await createService();

    await configService.updateProvider({
      updatedByActorId: "actor_owner",
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://persisted.openai.example/v1",
      apiKey: "sk-persisted-openai-1234"
    });

    await expect(service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        args: [],
        options: {},
        rawText: "/provider",
        helpRequested: false
      },
      allowReveal: false
    })).resolves.toContain("key: sk-****1234 (source: persisted)");
  });

  it("renders the full key only on the explicit reveal path", async () => {
    const { configService, service } = await createService();

    await configService.updateProvider({
      updatedByActorId: "actor_owner",
      apiKey: "sk-persisted-openai-1234"
    });

    await expect(service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "key",
        args: ["show"],
        options: { reveal: true },
        rawText: "/provider key show --reveal",
        helpRequested: false
      },
      allowReveal: true
    })).resolves.toBe("key: sk-persisted-openai-1234 (source: persisted)");
  });

  it("normalizes legacy model aliases to canonical IDs when mutating provider state", async () => {
    const { configService, service } = await createService();

    const reply = await service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "model",
        args: ["openai/gpt5.4"],
        options: {},
        rawText: "/provider model openai/gpt5.4",
        helpRequested: false
      },
      allowReveal: false
    });

    expect(reply).toContain("model: gpt-5.4 (source: persisted)");
    await expect(configService.getSnapshot()).resolves.toMatchObject({
      config: {
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4"
        }
      }
    });
  });

  it("persists base URL mutations", async () => {
    const { configService, service } = await createService();

    const reply = await service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "baseurl",
        args: ["https://custom.openai.example/v1"],
        options: {},
        rawText: "/provider baseurl https://custom.openai.example/v1",
        helpRequested: false
      },
      allowReveal: false
    });

    expect(reply).toContain("baseUrl: https://custom.openai.example/v1 (source: persisted)");
    await expect(configService.getSnapshot()).resolves.toMatchObject({
      config: {
        provider: {
          baseUrl: "https://custom.openai.example/v1"
        }
      }
    });
  });

  it("clears provider-specific base URL overrides and secrets when the provider changes", async () => {
    const { configService, service } = await createService();

    await configService.updateProvider({
      updatedByActorId: "actor_owner",
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://custom.openai.example/v1",
      apiKey: "sk-openai-only-1111"
    });

    const reply = await service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "model",
        args: ["anthropic/claude-sonnet-4.5"],
        options: {},
        rawText: "/provider model anthropic/claude-sonnet-4.5",
        helpRequested: false
      },
      allowReveal: false
    });

    expect(reply).toContain("provider: anthropic (source: persisted)");
    expect(reply).toContain("baseUrl: https://api.anthropic.com (source: builtin)");
    expect(reply).toContain("key: missing (source: missing)");
    await expect(configService.getSnapshot()).resolves.toMatchObject({
      config: {
        provider: {
          providerId: "anthropic",
          modelId: "claude-sonnet-4.5"
        }
      }
    });
  });

  it("rejects invalid or secret-bearing base URL mutations before they can leak in summaries", async () => {
    const { configService, service } = await createService();
    const expectedError = "Invalid provider base URL. Use an absolute http(s) URL without embedded credentials, query strings, or fragments.";

    await expect(service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "baseurl",
        args: ["not-a-url"],
        options: {},
        rawText: "/provider baseurl not-a-url",
        helpRequested: false
      },
      allowReveal: false
    })).resolves.toBe(expectedError);

    await expect(service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "baseurl",
        args: ["https://owner:secret@custom.openai.example/v1"],
        options: {},
        rawText: "/provider baseurl https://owner:secret@custom.openai.example/v1",
        helpRequested: false
      },
      allowReveal: false
    })).resolves.toBe(expectedError);

    await expect(configService.getSnapshot()).resolves.toMatchObject({
      config: {
        provider: {
          providerId: "openai"
        }
      }
    });
  });

  it("sets and changes the persisted provider key while keeping replies masked", async () => {
    const { configService, service } = await createService();

    const firstReply = await service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "key",
        args: ["set", "sk-first-provider-key-1111"],
        options: {},
        rawText: "/provider key set sk-first-provider-key-1111",
        helpRequested: false
      },
      allowReveal: false
    });
    const secondReply = await service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "key",
        args: ["set", "sk-second-provider-key-2222"],
        options: {},
        rawText: "/provider key set sk-second-provider-key-2222",
        helpRequested: false
      },
      allowReveal: false
    });

    expect(firstReply).toContain("key: sk-****1111 (source: persisted)");
    expect(secondReply).toContain("key: sk-****2222 (source: persisted)");
    await expect(configService.getSnapshot()).resolves.toMatchObject({
      config: {
        provider: {
          apiKey: "sk-second-provider-key-2222"
        }
      }
    });
  });

  it("clears the persisted key and falls back to env semantics", async () => {
    const { configService, service } = await createService();

    await configService.updateProvider({
      updatedByActorId: "actor_owner",
      apiKey: "sk-persisted-openai-1234"
    });

    const reply = await service.execute({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      commandIntent: {
        name: "provider",
        subcommand: "key",
        args: ["clear"],
        options: {},
        rawText: "/provider key clear",
        helpRequested: false
      },
      allowReveal: false
    });

    expect(reply).toContain("key: sk-****9876 (source: env)");
    await expect(configService.getSnapshot()).resolves.toMatchObject({
      config: {
        provider: {
          apiKey: undefined
        }
      }
    });
  });
});
