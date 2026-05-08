import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = new Set<string>();

async function createTempDir() {
  const directory = await mkdtemp(join(tmpdir(), "endec-tg-runner-"));
  tempDirs.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("plain-node runner dist smoke", () => {
  it("loads the built bin under plain node without falling back to workspace .ts entries", async () => {
    const dataDir = await createTempDir();
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

    const smoke = spawnSync("node", ["packages/adapter-telegram/dist/bin.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ENDEC_DATA_DIR: dataDir
      }
    });

    expect(smoke.status, smoke.stderr || smoke.stdout).toBe(1);
    expect(smoke.stderr).toContain("Missing required environment variable: TELEGRAM_BOT_TOKEN");
    expect(smoke.stderr).not.toContain("ERR_UNKNOWN_FILE_EXTENSION");
    expect(smoke.stderr).not.toContain("/packages/app/src/index.ts");
  }, 120_000);
});
