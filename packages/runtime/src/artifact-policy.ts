import type { ArtifactPreview, ArtifactRef } from "@endec/domain";

export type ArtifactInliningResult = {
  kind: "inline";
  content: string;
};

export type ArtifactSpillResult = {
  kind: "artifact";
  ref: ArtifactRef;
  preview: ArtifactPreview;
};

export type ArtifactMaterialization = ArtifactInliningResult | ArtifactSpillResult;

export interface ArtifactPolicyPort {
  spillIfNeeded(input: {
    turnId: string;
    sessionId: string;
    kind: "runtime_output" | "tool_result";
    mimeType?: string;
    content: string;
  }): Promise<ArtifactMaterialization>;
}
