import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");
const appPackageDir = resolve(import.meta.dirname, "..");
const requiredBuiltArtifacts = [
  "packages/tools/dist/index.js",
  "packages/tasks/dist/index.js",
  "packages/app/dist/index.js"
] as const;

function assertBuiltArtifactsPresent() {
  for (const relativePath of requiredBuiltArtifacts) {
    const absolutePath = resolve(repoRoot, relativePath);

    if (!existsSync(absolutePath)) {
      throw new Error(`Missing built artifact for dist smoke: ${relativePath}. Run \`pnpm build\` before \`test:dist\`.`);
    }
  }
}

async function importBuiltPackagesFromPlainNode() {
  const script = `
    import { mkdtemp, rm } from "node:fs/promises";
    import { join } from "node:path";
    import { tmpdir } from "node:os";

    const dataDir = await mkdtemp(join(tmpdir(), "endec-runtime-importability-"));

    try {
      const tools = await import("@endec/tools");
      if (typeof tools.createReadonlyToolPort !== "function") {
        throw new Error("@endec/tools did not expose createReadonlyToolPort from the built entrypoint");
      }

      const tasks = await import("@endec/tasks");
      if (typeof tasks.createTaskStore !== "function") {
        throw new Error("@endec/tasks did not expose createTaskStore from the built entrypoint");
      }

      const app = await import("@endec/app");
      if (typeof app.createEndecApp !== "function") {
        throw new Error("@endec/app did not expose createEndecApp from the built entrypoint");
      }

      const instance = app.createEndecApp({
        dataDir,
        providerTransport: {
          async *stream() {}
        }
      });

      if (!instance?.shell || !instance?.operator || !instance?.im) {
        throw new Error("@endec/app createEndecApp did not return the expected app surface");
      }

      console.log("plain-node-import-ok");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  `;

  return execFileAsync("node", ["--input-type=module", "-e", script], {
    cwd: appPackageDir
  });
}

describe("built runtime importability", () => {
  it("resolves @endec/tools, @endec/tasks, and @endec/app through dist entrypoints in plain node esm", async () => {
    assertBuiltArtifactsPresent();

    await expect(importBuiltPackagesFromPlainNode()).resolves.toMatchObject({
      stdout: expect.stringContaining("plain-node-import-ok")
    });
  }, 180_000);
});
