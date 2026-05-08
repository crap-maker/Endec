import { z } from "zod";

export const ArtifactKindSchema = z.enum(["tool_result", "runtime_output", "attachment", "generated_file", "checkpoint", "other"]);

export const ArtifactRefSchema = z.object({
  artifactId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  kind: ArtifactKindSchema,
  storageKey: z.string(),
  mimeType: z.string().optional(),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.string()
});

export const ArtifactPreviewSchema = z.object({
  artifactId: z.string(),
  ref: ArtifactRefSchema,
  previewText: z.string(),
  truncated: z.boolean(),
  byteLength: z.number().int().nonnegative(),
  sourceRange: z
    .object({
      offset: z.number().int().nonnegative(),
      length: z.number().int().positive()
    })
    .optional()
});

export const ArtifactReadQuerySchema = z.object({
  artifactId: z.string(),
  cursor: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional()
});

export const ArtifactReadResultSchema = z.object({
  artifact: ArtifactRefSchema,
  preview: ArtifactPreviewSchema.optional(),
  content: z.string().optional(),
  range: z.object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    returned: z.number().int().nonnegative()
  }),
  eof: z.boolean(),
  nextCursor: z.string().optional()
});

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ArtifactPreview = z.infer<typeof ArtifactPreviewSchema>;
export type ArtifactReadQuery = z.infer<typeof ArtifactReadQuerySchema>;
export type ArtifactReadResult = z.infer<typeof ArtifactReadResultSchema>;
