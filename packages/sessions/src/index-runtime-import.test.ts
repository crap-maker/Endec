import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("../../../", import.meta.url);

describe("@endec/sessions runtime importability", () => {
  it("imports src/index.ts under node strip-types ESM", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--conditions=source",
        "--experimental-strip-types",
        "--experimental-specifier-resolution=node",
        "-e",
        "import('./packages/sessions/src/index.ts').then((mod) => console.log('SESSIONS_INDEX_OK', Object.keys(mod).length))"
      ],
      {
        cwd: repoRoot
      }
    );

    expect(stdout).toContain("SESSIONS_INDEX_OK");
  });
});
