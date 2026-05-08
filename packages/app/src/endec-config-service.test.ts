import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_CATALOG } from "@endec/ai";
import { resolveEndecDataPaths } from "./data-paths.ts";
import { createEndecConfigService } from "./endec-config-service.ts";

const tempDirs = new Set<string>();

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "endec-config-service-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { force: true, recursive: true });
    tempDirs.delete(dir);
  }));
});

describe("endec config service", () => {
  it("seeds a missing config from the fallback provider and records loadedAt/source", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const service = createEndecConfigService({
      paths,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt5.4"
      },
      catalog: DEFAULT_PROVIDER_CATALOG,
      resolveSeedProvider: async () => ({
        providerId: "openai",
        modelId: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-seeded-provider-1234"
      })
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.source).toBe("seeded_endec_json");
    expect(snapshot.config.provider).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-seeded-provider-1234"
    });
    expect(snapshot.loadedAt).toMatch(/T/);
    expect(await readFile(paths.endecConfigPath, "utf8")).toContain('"schemaVersion": 1');
  });

  it("reloads config state and refreshes loadedAt after a file update", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const service = createEndecConfigService({
      paths,
      env: {},
      catalog: DEFAULT_PROVIDER_CATALOG,
      resolveSeedProvider: async () => ({
        providerId: "openai",
        modelId: "gpt-5.4"
      })
    });

    const first = await service.getSnapshot();
    const reloaded = await service.reload({
      update: async (current) => ({
        ...current,
        updatedAt: "2026-05-03T12:34:56.000Z"
      })
    });

    expect(reloaded.loadedAt >= first.loadedAt).toBe(true);
    expect(reloaded.config.updatedAt).toBe("2026-05-03T12:34:56.000Z");
  });

  it("updates provider fields through the JSON config and preserves the embedding section", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const service = createEndecConfigService({
      paths,
      env: {},
      catalog: DEFAULT_PROVIDER_CATALOG,
      resolveSeedProvider: async () => ({
        providerId: "openai",
        modelId: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-seeded-provider-1234"
      })
    });

    const updated = await service.updateProvider({
      updatedByActorId: "actor_owner",
      providerId: "anthropic",
      modelId: "claude-sonnet-4.5",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-anthropic-9999"
    });

    expect(updated.config.provider).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4.5",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-anthropic-9999"
    });
    expect(updated.config.ownerSelected).toBe(true);
    expect(updated.config.embeddings.enabled).toBe(false);
    expect(updated.config.embeddings.allowedKinds).toContain("typed_memory");
  });

  it("produces a masked config summary by default", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const service = createEndecConfigService({
      paths,
      env: {},
      catalog: DEFAULT_PROVIDER_CATALOG,
      resolveSeedProvider: async () => ({
        providerId: "openai",
        modelId: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-secret-1234"
      })
    });

    const summary = await service.renderMaskedSummary();

    expect(summary).toContain("provider: openai");
    expect(summary).toContain("model: gpt-5.4");
    expect(summary).toContain("apiKey: sk-****1234");
    expect(summary).not.toContain("sk-secret-1234");
  });

  it("can report the raw config when explicit reveal is requested", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const service = createEndecConfigService({
      paths,
      env: {},
      catalog: DEFAULT_PROVIDER_CATALOG,
      resolveSeedProvider: async () => ({
        providerId: "openai",
        modelId: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-secret-1234"
      })
    });

    const summary = await service.renderMaskedSummary({ revealSecrets: true });

    expect(summary).toContain("apiKey: sk-secret-1234");
  });
});
