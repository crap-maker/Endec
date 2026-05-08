#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vitestEntrypoint = require.resolve("vitest/vitest.mjs");

const forwardedArgs = process.argv.slice(2);
const normalizedArgs = [];
let strippedPnpmSeparator = false;

for (const arg of forwardedArgs) {
  if (!strippedPnpmSeparator && arg === "--") {
    strippedPnpmSeparator = true;
    continue;
  }

  normalizedArgs.push(arg);
}

const result = spawnSync(
  process.execPath,
  [vitestEntrypoint, "run", "--root", ".", ...normalizedArgs],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
