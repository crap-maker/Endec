import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const appIndexUrl = new URL("./index.ts", import.meta.url).href;

describe("@endec/app runtime importability", () => {
  it("imports src/index.ts under node strip-types ESM", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--conditions=source",
        "--experimental-strip-types",
        "--experimental-specifier-resolution=node",
        "--input-type=module",
        "-e",
        `const mod = await import(${JSON.stringify(appIndexUrl)}); console.log("APP_INDEX_OK", typeof mod.createEndecApp);`
      ],
      {
        cwd: new URL("..", import.meta.url)
      }
    );

    expect(stdout).toContain("APP_INDEX_OK function");
  });
});
