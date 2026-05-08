import type { ArtifactPreview, ArtifactRef } from "@endec/domain";

export const DEFAULT_ARTIFACT_PREVIEW_CHARS = 2_000;

export function createArtifactPreview(input: {
  ref: ArtifactRef;
  content: string;
  maxChars?: number;
}): ArtifactPreview {
  const maxChars = input.maxChars ?? DEFAULT_ARTIFACT_PREVIEW_CHARS;
  const originalByteLength = Buffer.byteLength(input.content, "utf8");

  let previewText = input.content;
  let truncated = false;

  if (previewText.length > maxChars) {
    truncated = true;
    previewText = previewText.slice(0, maxChars);
    const lastNewline = previewText.lastIndexOf("\n");
    if (lastNewline > Math.floor(maxChars / 2)) {
      previewText = previewText.slice(0, lastNewline + 1);
    }
  }

  return {
    artifactId: input.ref.artifactId,
    ref: input.ref,
    previewText,
    truncated,
    byteLength: originalByteLength,
    sourceRange: {
      offset: 0,
      length: Buffer.byteLength(previewText, "utf8")
    }
  };
}
