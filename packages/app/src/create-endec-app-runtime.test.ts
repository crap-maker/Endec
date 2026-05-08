import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const appIndexUrl = new URL("./index.ts", import.meta.url).href;

describe("@endec/app real create runtime", () => {
  it("creates a real app instance under node strip-types ESM", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--conditions=source",
        "--experimental-strip-types",
        "--experimental-specifier-resolution=node",
        "--input-type=module",
        "-e",
        [
          "import { mkdtempSync, rmSync } from 'node:fs';",
          "import { tmpdir } from 'node:os';",
          "import { join } from 'node:path';",
          `const mod = await import(${JSON.stringify(appIndexUrl)});`,
          "const dataDir = mkdtempSync(join(tmpdir(), 'endec-app-'));",
          "try {",
          "  const app = mod.createEndecApp({ dataDir, providerTransport: { async *stream() {} } });",
          "  console.log('APP_CREATE_OK', typeof app.shell.executeTurn, typeof app.operator.getStatus);",
          "} finally {",
          "  rmSync(dataDir, { recursive: true, force: true });",
          "}"
        ].join("\n")
      ],
      {
        cwd: new URL("..", import.meta.url)
      }
    );

    expect(stdout).toContain("APP_CREATE_OK function function");
  }, 15_000);
});
