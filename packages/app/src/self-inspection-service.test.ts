import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_CATALOG } from "@endec/ai";
import { resolveEndecDataPaths } from "./data-paths.ts";
import { createEndecConfigService } from "./endec-config-service.ts";
import { createSelfInspectionService } from "./self-inspection-service.ts";

const tempDirs = new Set<string>();

async function createTempFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "endec-self-inspect-"));
  tempDirs.add(rootDir);

  const repoRoot = join(rootDir, "repo");
  const dataDir = join(rootDir, "data");
  await mkdir(join(repoRoot, "packages", "app", "src"), { recursive: true });
  await mkdir(join(repoRoot, "packages", "app", "dist"), { recursive: true });
  await mkdir(join(repoRoot, "docs"), { recursive: true });
  await mkdir(join(dataDir, "state"), { recursive: true });

  await writeFile(join(repoRoot, "packages", "app", "src", "example.ts"), "export const sourceAnswer = 42;\n", "utf8");
  await writeFile(join(repoRoot, "packages", "app", "dist", "example.js"), "export const buildAnswer = 43;\n", "utf8");
  await writeFile(join(repoRoot, "PRODUCT.md"), "# Product\nOwner docs live here.\n", "utf8");
  await writeFile(join(repoRoot, ".env"), "OPENAI_API_KEY=dotenv-raw-secret\n", "utf8");
  await writeFile(join(dataDir, "state", "access.sqlite"), "not-a-real-sqlite", "utf8");

  const configService = createEndecConfigService({
    paths: resolveEndecDataPaths(dataDir),
    env: {
      ENDEC_PROVIDER: "openai",
      ENDEC_PROVIDER_MODEL: "gpt-5.4",
      OPENAI_BASE_URL: "https://env.openai.test/v1",
      OPENAI_API_KEY: "env-openai-secret-1234"
    },
    catalog: DEFAULT_PROVIDER_CATALOG,
    resolveSeedProvider: async () => ({
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://env.openai.test/v1",
      apiKey: "env-openai-secret-1234"
    })
  });
  const service = createSelfInspectionService({
    repoRoot,
    dataDir,
    configService
  });

  return {
    repoRoot,
    dataDir,
    configService,
    service
  };
}

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("createSelfInspectionService", () => {
  it("inspects bounded source, build, docs, and config targets", async () => {
    const { service } = await createTempFixture();

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "source",
      args: ["packages/app/src/example.ts"]
    })).resolves.toContain("export const sourceAnswer = 42;");

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "build",
      args: ["packages/app/dist/example.js"]
    })).resolves.toContain("export const buildAnswer = 43;");

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "docs",
      args: ["PRODUCT.md"]
    })).resolves.toContain("Owner docs live here.");

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "config",
      args: []
    })).resolves.toContain("provider: openai");
  });

  it("supports bounded list, search, and snippet reads across the allowed self-awareness surfaces", async () => {
    const { service } = await createTempFixture();

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "source",
      args: ["list", "packages/app/src", "--pattern", "**/*.ts"]
    })).resolves.toContain("packages/app/src/example.ts");

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "source",
      args: ["search", "sourceAnswer", "packages/app/src"]
    })).resolves.toContain("packages/app/src/example.ts:1: export const sourceAnswer = 42;");

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "docs",
      args: ["read", "PRODUCT.md", "--offset", "0", "--limit", "12"]
    })).resolves.toContain("# Product");
  });

  it("rejects protected raw targets for dotenv files, sqlite files, and generic env dumps", async () => {
    const { service, dataDir } = await createTempFixture();

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "source",
      args: [".env"]
    })).resolves.toContain("Protected raw target");

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "source",
      args: [join(dataDir, "state", "access.sqlite")]
    })).resolves.toContain("Protected raw target");

    await expect(service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "config",
      args: ["env"]
    })).resolves.toContain("Protected raw target");
  });

  it("masks config output by default", async () => {
    const { configService, service } = await createTempFixture();
    await configService.updateProvider({
      updatedByActorId: "actor_owner",
      apiKey: "persisted-openai-secret-9999"
    });

    const reply = await service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "config",
      args: []
    });

    expect(reply).toContain("apiKey: per****9999");
    expect(reply).not.toContain("persisted-openai-secret-9999");
  });

  it("reveals the full config secret only when the request is explicit", async () => {
    const { configService, service } = await createTempFixture();
    await configService.updateProvider({
      updatedByActorId: "actor_owner",
      apiKey: "persisted-openai-secret-9999"
    });

    const maskedReply = await service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "config",
      args: []
    });
    const revealedReply = await service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "config",
      args: ["--reveal"]
    });

    expect(maskedReply).toContain("apiKey: per****9999");
    expect(maskedReply).not.toContain("persisted-openai-secret-9999");
    expect(revealedReply).toContain("apiKey: persisted-openai-secret-9999");
  });

  it("never leaks raw secret values in inspection summaries", async () => {
    const { configService, service } = await createTempFixture();
    await configService.updateProvider({
      updatedByActorId: "actor_owner",
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrl: "https://persisted.openai.test/v1",
      apiKey: "persisted-openai-secret-9999"
    });

    const configReply = await service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "config",
      args: []
    });
    const dotenvReply = await service.inspect({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "source",
      args: [".env"]
    });

    expect(configReply).not.toContain("env-openai-secret-1234");
    expect(configReply).not.toContain("persisted-openai-secret-9999");
    expect(dotenvReply).not.toContain("dotenv-raw-secret");
  });
});
