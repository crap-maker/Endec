import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEndecDataPaths } from "./data-paths.ts";
import { ensureEndecConfig, loadEndecConfig, updateEndecConfig } from "./endec-config-store.ts";

const tempDirs = new Set<string>();

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "endec-config-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { force: true, recursive: true });
    tempDirs.delete(dir);
  }));
});

describe("endec config store", () => {
  it("initializes a missing endec.json under the resolved temp dataDir", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    const config = await ensureEndecConfig({
      paths,
      seed: {
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-seeded-provider-1234"
        }
      }
    });

    expect(config.schemaVersion).toBe(1);
    expect(config.ownerSelected).toBe(false);
    expect(config.provider).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-seeded-provider-1234"
    });
    expect(config.embeddings).toMatchObject({
      enabled: false,
      indexBackend: "sqlite_vec",
      allowedKinds: ["chat_summary", "typed_memory", "evidence", "memory_md", "user_memory_doc"]
    });
    expect(await loadEndecConfig({ paths })).toEqual(config);
  });

  it("never writes outside the resolved temp dataDir during initialization", async () => {
    const rootDir = await tempDataDir();
    const unresolvedDataDir = join(rootDir, "nested", "..", "runtime-data");
    const resolvedDataDir = resolve(unresolvedDataDir);
    const paths = resolveEndecDataPaths(unresolvedDataDir);

    await ensureEndecConfig({
      paths,
      seed: {
        provider: {
          providerId: "anthropic",
          modelId: "claude-sonnet-4.5"
        }
      }
    });

    expect(paths.dataDir).toBe(resolvedDataDir);
    expect(paths.endecConfigPath).toBe(join(resolvedDataDir, "config", "endec.json"));
    expect(paths.endecConfigPath.startsWith(`${resolvedDataDir}/`)).toBe(true);
    expect(await readdir(paths.configDir)).toEqual(["endec.json"]);
  });

  it("rejects forged config paths that escape the resolved dataDir", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    await expect(ensureEndecConfig({
      paths: {
        ...paths,
        endecConfigPath: join(paths.dataDir, "..", "escaped-endec.json")
      },
      seed: {
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4"
        }
      }
    })).rejects.toThrow(/resolved dataDir/i);
  });

  it("creates a backup before overwrite and leaves no partial json on rename failure", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    const original = await ensureEndecConfig({
      paths,
      seed: {
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          apiKey: "sk-original-1111"
        }
      }
    });
    const originalBytes = await readFile(paths.endecConfigPath, "utf8");

    await expect(updateEndecConfig({
      paths,
      update(current) {
        return {
          ...current,
          updatedAt: "2026-05-03T12:00:00.000Z",
          provider: {
            ...current.provider,
            modelId: "gpt-5.5"
          }
        };
      },
      fileOps: {
        async rename() {
          throw new Error("simulated rename failure");
        }
      }
    })).rejects.toThrow("simulated rename failure");

    const entries = await readdir(paths.configDir);
    expect(entries).toContain("endec.json");
    expect(entries.some((entry) => entry.startsWith("endec.json.bak-"))).toBe(true);
    expect(await loadEndecConfig({ paths })).toEqual(original);
    expect(await readFile(paths.endecConfigPath, "utf8")).toBe(originalBytes);
  });

  it("tightens file permissions on create and update", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    await ensureEndecConfig({
      paths,
      seed: {
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          apiKey: "sk-secret-1111"
        }
      }
    });
    await chmod(paths.endecConfigPath, 0o644);

    await updateEndecConfig({
      paths,
      update(current) {
        return {
          ...current,
          updatedAt: "2026-05-03T12:10:00.000Z"
        };
      }
    });

    expect((await stat(paths.endecConfigPath)).mode & 0o777).toBe(0o600);
  });

  it("recovers from a stale lock instead of wedging endec.json creation", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);
    const lockPath = `${paths.endecConfigPath}.lock`;

    await mkdir(paths.configDir, { recursive: true });
    await writeFile(lockPath, "stale-lock", "utf8");
    await utimes(lockPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

    const config = await ensureEndecConfig({
      paths,
      seed: {
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4"
        }
      }
    });

    expect(config.provider.modelId).toBe("gpt-5.4");
    expect(await readdir(paths.configDir)).toEqual(["endec.json"]);
  });

  it("rejects invalid endec.json content with strict validation", async () => {
    const dataDir = await tempDataDir();
    const paths = resolveEndecDataPaths(dataDir);

    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.endecConfigPath, JSON.stringify({ provider: {} }), "utf8");

    await expect(loadEndecConfig({ paths })).rejects.toThrow(/endec config/i);
  });
});
