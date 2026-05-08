import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { buildDailyMemoryProjection } from "./daily-memory-renderer.ts";
import type { MaterializedTypedMemoryRecord } from "./typed-memory.ts";

const SAFE_PATH_SEGMENT_PATTERN = /^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/;

function sanitizePathSegment(value: string) {
  if (SAFE_PATH_SEGMENT_PATTERN.test(value)) {
    return value;
  }

  return `~${Buffer.from(value, "utf8").toString("base64url")}`;
}

function assertRootConfinedPath(rootDir: string, filename: string) {
  const relativePath = relative(rootDir, filename);

  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new Error(`Daily memory projection escaped root: ${filename}`);
  }
}

export function resolveDailyMemoryProjectionPath(input: {
  rootDir: string;
  workspaceId: string;
  day: string;
}) {
  const rootDir = resolve(input.rootDir);
  const filename = resolve(rootDir, sanitizePathSegment(input.workspaceId), `${input.day}.md`);

  assertRootConfinedPath(rootDir, filename);

  return filename;
}

export function writeDailyMemoryProjectionFile(input: {
  rootDir: string;
  workspaceId: string;
  day: string;
  records: MaterializedTypedMemoryRecord[];
}) {
  const filename = resolveDailyMemoryProjectionPath(input);
  const built = buildDailyMemoryProjection({
    workspaceId: input.workspaceId,
    day: input.day,
    records: input.records
  });
  const temporaryFilename = `${filename}.tmp`;

  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(temporaryFilename, built.content, "utf8");
  renameSync(temporaryFilename, filename);

  return {
    filename,
    content: built.content,
    projectionDerivedRefs: built.projectionDerivedRefs
  };
}
