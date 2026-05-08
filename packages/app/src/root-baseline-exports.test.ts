import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

const criticalPackages = [
  {
    name: "@endec/domain",
    dir: "packages/domain"
  },
  {
    name: "@endec/tools",
    dir: "packages/tools"
  },
  {
    name: "@endec/app",
    dir: "packages/app"
  },
  {
    name: "@endec/im-adapter",
    dir: "packages/im-adapter"
  },
  {
    name: "@endec/adapter-telegram",
    dir: "packages/adapter-telegram"
  },
  {
    name: "@endec/budget",
    dir: "packages/budget"
  },
  {
    name: "@endec/ai",
    dir: "packages/ai"
  },
  {
    name: "@endec/artifacts",
    dir: "packages/artifacts"
  }
] as const;

describe("root baseline critical exports", () => {
  it("pins critical package exports to explicit source/types/import/default entrypoints", async () => {
    for (const spec of criticalPackages) {
      const packageJson = JSON.parse(
        await readFile(resolve(repoRoot, spec.dir, "package.json"), "utf8")
      );

      expect(packageJson.exports?.["."]).toMatchObject({
        source: "./src/index.ts",
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js"
      });
    }
  });
});
