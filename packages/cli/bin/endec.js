#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = resolve(here, "../src/main.ts");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=source",
    "--experimental-strip-types",
    "--experimental-specifier-resolution=node",
    entrypoint,
    ...process.argv.slice(2)
  ],
  {
    stdio: "inherit"
  }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
