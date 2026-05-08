import type { ArtifactPreview, ArtifactRef, NormalizedToolResultPayload } from "@endec/domain";

export interface ToolArtifactPolicy {
  spillIfNeeded(input: {
    turnId: string;
    sessionId: string;
    kind: "runtime_output" | "tool_result";
    mimeType?: string;
    content: string;
  }): Promise<
    | {
      kind: "inline";
      content: string;
    }
    | {
      kind: "artifact";
      ref: ArtifactRef;
      preview: ArtifactPreview;
    }
  >;
}

export async function applyToolResultPolicy(input: {
  turnId: string;
  sessionId: string;
  normalizedPayload: NormalizedToolResultPayload;
  artifacts: ToolArtifactPolicy;
}): Promise<{
  state: "executed" | "spilled";
  normalizedPayload: NormalizedToolResultPayload;
  artifactRef?: ArtifactRef;
  preview?: ArtifactPreview;
}> {
  if (input.normalizedPayload.contentType === "empty") {
    return {
      state: "executed",
      normalizedPayload: input.normalizedPayload
    };
  }

  const serializedContent = serializePayload(input.normalizedPayload);
  const materialized = await input.artifacts.spillIfNeeded({
    turnId: input.turnId,
    sessionId: input.sessionId,
    kind: "tool_result",
    mimeType: input.normalizedPayload.contentType === "json" ? "application/json" : "text/plain",
    content: serializedContent
  });

  if (materialized.kind === "inline") {
    return {
      state: "executed",
      normalizedPayload: input.normalizedPayload
    };
  }

  return {
    state: "spilled",
    normalizedPayload: {
      ...input.normalizedPayload,
      value: materialized.preview.previewText
    },
    artifactRef: materialized.ref,
    preview: materialized.preview
  };
}

function serializePayload(payload: NormalizedToolResultPayload) {
  switch (payload.contentType) {
    case "empty":
      return "";
    case "json":
      return JSON.stringify(payload.value ?? null, null, 2);
    case "text":
      return typeof payload.value === "string" ? payload.value : String(payload.value ?? "");
  }
}
