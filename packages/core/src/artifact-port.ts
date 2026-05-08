import type { ArtifactPreview, ArtifactReadQuery, ArtifactReadResult, ArtifactRef } from "@endec/domain";

export interface ArtifactQueryPort {
  getArtifactPreview(ref: Pick<ArtifactRef, "artifactId"> | ArtifactRef): Promise<ArtifactPreview | null>;
  readArtifact(query: ArtifactReadQuery): Promise<ArtifactReadResult | null>;
  queryArtifact(query: ArtifactReadQuery): Promise<ArtifactReadResult | null>;
}

export interface ArtifactSpillPort {
  spillArtifact(input: {
    turnId: string;
    sessionId: string;
    kind: ArtifactRef["kind"];
    mimeType?: string;
    content: string;
  }): Promise<{ ref: ArtifactRef; preview: ArtifactPreview }>;
}
