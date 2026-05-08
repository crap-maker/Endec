import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEndecDataPaths } from "./data-paths.ts";
import { ensureModelsConfig, loadModelsConfig, updateModelsConfig } from "./models-config-store.ts";

const tempDirs = new Set<string>();

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "endec-models-config-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { force: true, recursive: true });
    tempDirs.delete(dir);
  }));
});

describe("models config store", () => {
  it("initializes a missing models.json under the resolved temp dataDir", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    const config = await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5"
      }
    });

    expect(config).toEqual({
      default: "anthropic/claude-sonnet-4-5",
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          label: "anthropic/claude-sonnet-4-5"
        }
      ]
    });
    expect(await loadModelsConfig({ paths })).toEqual(config);
  });

  it("never writes outside the resolved temp dataDir during initialization", async () => {
    const rootDir = await tempDataDir();
    const unresolvedDataDir = join(rootDir, "nested", "..", "runtime-data");
    const resolvedDataDir = resolve(unresolvedDataDir);
    const paths = resolveEndecDataPaths(unresolvedDataDir);

    await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: "openai",
        modelId: "gpt5.4"
      }
    });

    expect(paths.dataDir).toBe(resolvedDataDir);
    expect(paths.modelsConfigPath).toBe(join(resolvedDataDir, "config", "models.json"));
    expect(paths.modelsConfigPath.startsWith(`${resolvedDataDir}/`)).toBe(true);
    expect(await readdir(paths.configDir)).toEqual(["models.json"]);
  });

  it("rejects forged config paths that escape the resolved dataDir", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    await expect(ensureModelsConfig({
      paths: {
        ...paths,
        configDir: join(paths.dataDir, "config"),
        modelsConfigPath: join(paths.dataDir, "..", "escaped-models.json")
      },
      currentModel: {
        providerId: "openai",
        modelId: "gpt5.4"
      }
    })).rejects.toThrow(/resolved dataDir/i);
  });

  it("preserves existing valid files byte-for-byte until an explicit update call", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const originalBytes = `${JSON.stringify({
      default: "openai/custom-model",
      models: [
        {
          id: "openai/custom-model",
          providerId: "openai",
          modelId: "custom-model",
          label: "Custom model"
        }
      ]
    }, null, 4)}\n`;

    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.modelsConfigPath, originalBytes, "utf8");

    const ensured = await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: "openai",
        modelId: "gpt5.4"
      }
    });
    const afterEnsure = await readFile(paths.modelsConfigPath, "utf8");

    expect(ensured.default).toBe("openai/custom-model");
    expect(afterEnsure).toBe(originalBytes);

    const updated = await updateModelsConfig({
      paths,
      currentModel: {
        providerId: "openai",
        modelId: "gpt5.4"
      },
      update(current) {
        return {
          default: current.default,
          models: [
            ...current.models,
            {
              id: "openai/gpt-5.5",
              providerId: "openai",
              modelId: "gpt-5.5",
              label: "GPT 5.5"
            }
          ]
        };
      }
    });

    expect(updated.models).toEqual([
      {
        id: "openai/custom-model",
        providerId: "openai",
        modelId: "custom-model",
        label: "Custom model"
      },
      {
        id: "openai/gpt-5.5",
        providerId: "openai",
        modelId: "gpt-5.5",
        label: "GPT 5.5"
      }
    ]);
    expect(await readFile(paths.modelsConfigPath, "utf8")).not.toBe(originalBytes);
  });

  it("recovers from a stale initialization lock instead of wedging models.json creation", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const lockPath = `${paths.modelsConfigPath}.lock`;

    await mkdir(paths.configDir, { recursive: true });
    await writeFile(lockPath, "stale-lock", "utf8");
    await utimes(lockPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

    const config = await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: "openai",
        modelId: "gpt5.4"
      }
    });

    expect(config.default).toBe("openai/gpt-5.4");
    expect(await readdir(paths.configDir)).toEqual(["models.json"]);
  });

  it("writes atomically with a temp file and rename, leaving no partial json on failure", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const original = await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5"
      }
    });
    const originalBytes = await readFile(paths.modelsConfigPath, "utf8");

    await expect(updateModelsConfig({
      paths,
      currentModel: {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5"
      },
      update(current) {
        return {
          default: current.default,
          models: [
            ...current.models,
            {
              id: "openai/gpt-5.4",
              providerId: "openai",
              modelId: "gpt-5.4",
              label: "GPT 5.4"
            }
          ]
        };
      },
      fileOps: {
        async rename() {
          throw new Error("simulated rename failure");
        }
      }
    })).rejects.toThrow("simulated rename failure");

    expect(await loadModelsConfig({ paths })).toEqual(original);
    expect(await readFile(paths.modelsConfigPath, "utf8")).toBe(originalBytes);
    expect(await readdir(paths.configDir)).toEqual(["models.json"]);
  });

  it("seeds the resolved current model and expands to the GPT 5.4 / GPT 5.5 pair when appropriate", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    const config = await ensureModelsConfig({
      paths,
      currentModel: {
        providerId: "openai",
        modelId: "gpt5.5"
      }
    });

    expect(config).toEqual({
      default: "openai/gpt-5.5",
      models: [
        {
          id: "openai/gpt-5.4",
          providerId: "openai",
          modelId: "gpt-5.4",
          label: "GPT 5.4"
        },
        {
          id: "openai/gpt-5.5",
          providerId: "openai",
          modelId: "gpt-5.5",
          label: "GPT 5.5"
        }
      ]
    });
  });

  it("rejects invalid models.json content with strict validation", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.modelsConfigPath, JSON.stringify({ models: [] }), "utf8");

    await expect(loadModelsConfig({ paths })).rejects.toThrow(/models config/i);
  });
});
