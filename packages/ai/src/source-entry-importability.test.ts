import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));

describe("source entry importability", () => {
  it("imports src/index.ts under node strip-types esm", () => {
    const script = `
      import(${JSON.stringify(indexPath)})
        .then((mod) => {
          console.log("AI_INDEX_OK", Object.keys(mod).length);
        })
        .catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
    `;

    const result = spawnSync(
      process.execPath,
      ["--conditions=source", "--experimental-strip-types", "--experimental-specifier-resolution=node", "-e", script],
      {
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("AI_INDEX_OK");
  });
});
