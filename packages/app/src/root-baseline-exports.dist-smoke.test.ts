import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");

const criticalPackages = [
  {
    name: "@endec/domain",
    dir: "packages/domain",
    assertion: `
      if (mod.ApprovalScopeValues?.join(",") !== "once,turn") {
        throw new Error("@endec/domain dist entrypoint did not preserve once|turn approval scopes");
      }
    `
  },
  {
    name: "@endec/tools",
    dir: "packages/tools",
    assertion: `
      if (typeof mod.createActToolExposure !== "function") {
        throw new Error("@endec/tools dist entrypoint did not expose createActToolExposure");
      }

      if (typeof mod.createReadonlyToolPort !== "function") {
        throw new Error("@endec/tools dist entrypoint did not expose createReadonlyToolPort");
      }
    `
  },
  {
    name: "@endec/app",
    dir: "packages/app",
    assertion: `
      if (typeof mod.createEndecApp !== "function") {
        throw new Error("@endec/app dist entrypoint did not expose createEndecApp");
      }
    `
  },
  {
    name: "@endec/im-adapter",
    dir: "packages/im-adapter",
    assertion: `
      if (typeof mod.createImAdapter !== "function") {
        throw new Error("@endec/im-adapter dist entrypoint did not expose createImAdapter");
      }

      if (typeof mod.createMentionGate !== "function") {
        throw new Error("@endec/im-adapter dist entrypoint did not expose createMentionGate");
      }
    `
  },
  {
    name: "@endec/adapter-telegram",
    dir: "packages/adapter-telegram",
    assertion: `
      if (typeof mod.runTelegramBot !== "function") {
        throw new Error("@endec/adapter-telegram dist entrypoint did not expose runTelegramBot");
      }

      if (typeof mod.createTelegramMentionGate !== "function") {
        throw new Error("@endec/adapter-telegram dist entrypoint did not expose createTelegramMentionGate");
      }
    `
  }
] as const;

describe("root baseline critical dist exports", () => {
  it("self-imports critical dist entrypoints under plain node and preserves current runtime truth", async () => {
    for (const spec of criticalPackages) {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            const mod = await import(${JSON.stringify(spec.name)});
            ${spec.assertion}
            console.log("CRITICAL_EXPORT_OK", ${JSON.stringify(spec.name)});
          `
        ],
        {
          cwd: resolve(repoRoot, spec.dir)
        }
      );

      expect(stdout).toContain(`CRITICAL_EXPORT_OK ${spec.name}`);
    }
  }, 120_000);
});
