import { z } from "zod";
import type { MemoryQuery } from "@endec/domain";
import { MemoryVisibilitySchema } from "@endec/domain";
import { isMemoryRecordVisibleToQuery } from "./retrieval-policy.ts";

export const MemoryEmbeddingDocumentKindSchema = z.enum([
  "chat_summary",
  "typed_memory",
  "evidence",
  "memory_md",
  "user_memory_doc"
]);

export const MemoryEmbeddingChunkingSchema = z.object({
  maxDocumentChars: z.number().int().positive(),
  maxChunkChars: z.number().int().positive(),
  overlapChars: z.number().int().nonnegative()
}).superRefine((value, context) => {
  if (value.overlapChars >= value.maxChunkChars) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "overlapChars must be smaller than maxChunkChars"
    });
  }
});

export const MemoryEmbeddingConfigSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  indexBackend: z.literal("sqlite_vec"),
  allowedKinds: z.array(MemoryEmbeddingDocumentKindSchema).min(1),
  chunking: MemoryEmbeddingChunkingSchema
}).strict();

export const MemoryEmbeddingDocumentSchema = z.object({
  documentId: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: MemoryEmbeddingDocumentKindSchema,
  visibility: MemoryVisibilitySchema,
  conversationBoundaryKey: z.string().optional(),
  sourceRefs: z.array(z.string()).min(1),
  content: z.string().min(1)
}).strict();

export const MemoryEmbeddingChunkSchema = MemoryEmbeddingDocumentSchema.extend({
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive()
});

export type MemoryEmbeddingConfig = z.infer<typeof MemoryEmbeddingConfigSchema>;
export type MemoryEmbeddingDocument = z.infer<typeof MemoryEmbeddingDocumentSchema>;
export type MemoryEmbeddingChunk = z.infer<typeof MemoryEmbeddingChunkSchema>;

export function chunkEmbeddingDocument(input: {
  document: MemoryEmbeddingDocument;
  chunking: z.infer<typeof MemoryEmbeddingChunkingSchema>;
}): MemoryEmbeddingChunk[] {
  const chunking = MemoryEmbeddingChunkingSchema.parse(input.chunking);
  const document = MemoryEmbeddingDocumentSchema.parse(input.document);
  const cappedContent = document.content.slice(0, chunking.maxDocumentChars);

  if (cappedContent.length <= chunking.maxChunkChars) {
    return [
      MemoryEmbeddingChunkSchema.parse({
        ...document,
        content: cappedContent,
        chunkIndex: 0,
        chunkCount: 1
      })
    ];
  }

  const chunks: MemoryEmbeddingChunk[] = [];
  const step = chunking.maxChunkChars - chunking.overlapChars;
  for (let start = 0; start < cappedContent.length; start += step) {
    const content = cappedContent.slice(start, start + chunking.maxChunkChars);
    if (!content) {
      continue;
    }

    chunks.push({
      ...document,
      content,
      chunkIndex: chunks.length,
      chunkCount: 1
    });

    if (start + chunking.maxChunkChars >= cappedContent.length) {
      break;
    }
  }

  return chunks.map((chunk, index, all) => MemoryEmbeddingChunkSchema.parse({
    ...chunk,
    chunkIndex: index,
    chunkCount: all.length
  }));
}

export function isEmbeddingDocumentVisible(input: {
  document: Pick<MemoryEmbeddingDocument, "conversationBoundaryKey" | "visibility">;
  query: Pick<MemoryQuery, "conversationBoundaryKey" | "disclosureMode" | "targetConversationKeys">;
}) {
  return isMemoryRecordVisibleToQuery({
    record: input.document,
    query: input.query
  });
}
