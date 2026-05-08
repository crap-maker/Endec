import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const memoryIndexUrl = new URL("./index.ts", import.meta.url).href;

describe("@endec/memory runtime importability", () => {
  it("imports src/index.ts under node strip-types ESM", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--conditions=source",
        "--experimental-strip-types",
        "--experimental-specifier-resolution=node",
        "--input-type=module",
        "-e",
        `const mod = await import(${JSON.stringify(memoryIndexUrl)}); console.log("MEMORY_INDEX_OK", typeof mod.createMemoryStore);`
      ],
      {
        cwd: new URL("..", import.meta.url)
      }
    );

    expect(stdout).toContain("MEMORY_INDEX_OK function");
  });
});
