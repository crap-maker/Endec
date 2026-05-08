import { describe, expect, it } from "vitest";
import {
  MemoryEmbeddingConfigSchema,
  MemoryEmbeddingDocumentSchema,
  chunkEmbeddingDocument,
  isEmbeddingDocumentVisible
} from "./embedding-config.ts";

describe("memory embedding config seam", () => {
  it("parses a valid config limited to memory/chat document kinds", () => {
    const parsed = MemoryEmbeddingConfigSchema.parse({
      enabled: true,
      providerId: "openai",
      modelId: "text-embedding-3-small",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-embedding-1234",
      indexBackend: "sqlite_vec",
      allowedKinds: ["chat_summary", "typed_memory", "evidence", "memory_md", "user_memory_doc"],
      chunking: {
        maxDocumentChars: 12000,
        maxChunkChars: 2400,
        overlapChars: 200
      }
    });

    expect(parsed.allowedKinds).toEqual([
      "chat_summary",
      "typed_memory",
      "evidence",
      "memory_md",
      "user_memory_doc"
    ]);
  });

  it("rejects non-memory/source-code document kinds by contract", () => {
    expect(() =>
      MemoryEmbeddingDocumentSchema.parse({
        documentId: "doc_source_001",
        workspaceId: "workspace_local",
        kind: "source_code",
        visibility: "conversation_local",
        conversationBoundaryKey: "supergroup:release-room",
        sourceRefs: ["packages/app/src/create-endec-app.ts"],
        content: "export function notAllowed() {}"
      })
    ).toThrow(/invalid enum value/i);
  });

  it("chunks long memory documents without losing document metadata", () => {
    const chunks = chunkEmbeddingDocument({
      document: {
        documentId: "doc_memory_001",
        workspaceId: "workspace_local",
        kind: "typed_memory",
        visibility: "conversation_local",
        conversationBoundaryKey: "supergroup:release-room",
        sourceRefs: ["typed_memory:release-room:decision:001"],
        content: "A".repeat(2500)
      },
      chunking: {
        maxDocumentChars: 5000,
        maxChunkChars: 1000,
        overlapChars: 100
      }
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      documentId: "doc_memory_001",
      chunkIndex: 0,
      chunkCount: 3,
      kind: "typed_memory",
      visibility: "conversation_local",
      conversationBoundaryKey: "supergroup:release-room"
    });
    expect(chunks[2]?.content.length).toBeLessThanOrEqual(1000);
  });

  it("respects owner-private and targeted conversation visibility boundaries", () => {
    const ownerPrivate = {
      documentId: "doc_owner_001",
      workspaceId: "workspace_local",
      kind: "typed_memory" as const,
      visibility: "owner_private" as const,
      conversationBoundaryKey: "private:42",
      sourceRefs: ["typed_memory:owner:001"],
      content: "owner-only preference"
    };
    const targetedShared = {
      documentId: "doc_shared_001",
      workspaceId: "workspace_local",
      kind: "evidence" as const,
      visibility: "conversation_local" as const,
      conversationBoundaryKey: "supergroup:release-room",
      sourceRefs: ["evidence:release-room:001"],
      content: "release room decision"
    };

    expect(
      isEmbeddingDocumentVisible({
        document: ownerPrivate,
        query: {
          conversationBoundaryKey: "private:42",
          disclosureMode: "local_only",
          targetConversationKeys: []
        }
      })
    ).toBe(true);

    expect(
      isEmbeddingDocumentVisible({
        document: ownerPrivate,
        query: {
          conversationBoundaryKey: "supergroup:release-room",
          disclosureMode: "local_only",
          targetConversationKeys: []
        }
      })
    ).toBe(false);

    expect(
      isEmbeddingDocumentVisible({
        document: targetedShared,
        query: {
          conversationBoundaryKey: "private:42",
          disclosureMode: "owner_targeted",
          targetConversationKeys: ["supergroup:release-room"]
        }
      })
    ).toBe(true);
  });
});
