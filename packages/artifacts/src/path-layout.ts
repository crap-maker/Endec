import { join, normalize, resolve } from "node:path";

const CONTENT_ROOT = "artifacts";
const INDEX_ROOT = join(CONTENT_ROOT, "index");

function sanitizeSegment(value: string) {
  return encodeURIComponent(value);
}

function extensionForMimeType(mimeType?: string) {
  switch (mimeType) {
    case "text/plain":
      return ".txt";
    case "application/json":
      return ".json";
    case "text/markdown":
      return ".md";
    default:
      return ".txt";
  }
}

export function buildArtifactStorageKey(input: {
  sessionId: string;
  turnId: string;
  artifactId: string;
  mimeType?: string;
}) {
  return join(
    CONTENT_ROOT,
    sanitizeSegment(input.sessionId),
    sanitizeSegment(input.turnId),
    `${sanitizeSegment(input.artifactId)}${extensionForMimeType(input.mimeType)}`
  );
}

export function buildArtifactMetadataKey(artifactId: string) {
  return join(INDEX_ROOT, `${sanitizeSegment(artifactId)}.json`);
}

export function resolveArtifactPath(rootDir: string, relativePath: string) {
  const normalized = normalize(relativePath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new Error(`artifact storage key must stay within artifact root: ${relativePath}`);
  }

  const absolute = resolve(rootDir, normalized);
  const resolvedRoot = resolve(rootDir);
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`artifact path escaped root: ${relativePath}`);
  }

  return absolute;
}

export function buildArtifactPaths(input: {
  rootDir: string;
  sessionId: string;
  turnId: string;
  artifactId: string;
  mimeType?: string;
}) {
  const storageKey = buildArtifactStorageKey(input);
  const metadataKey = buildArtifactMetadataKey(input.artifactId);

  return {
    storageKey,
    metadataKey,
    contentPath: resolveArtifactPath(input.rootDir, storageKey),
    metadataPath: resolveArtifactPath(input.rootDir, metadataKey)
  };
}
