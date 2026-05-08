import type { MemoryWriteRequest, TurnRequest, TurnResult } from "@endec/domain";
import { describe, expect, it } from "vitest";
import { filterMemoryWritesForImContext } from "./memory-write-policy.ts";

function createWrite(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
  return {
    writeId: "write_001",
    sourceTurnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    writeKind: "candidate_extract",
    evidenceRefs: ["turn_001"],
    content: { summary: "memory summary" },
    ...overrides
  };
}

function createResult(memoryWrites: MemoryWriteRequest[]): TurnResult {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    resolvedMode: "chat",
    status: "completed",
    messages: [{ role: "assistant", content: "ok" }],
    toolEvents: [],
    taskUpdates: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
    warnings: [],
    checkpointRef: "checkpoint:turn_001",
    memoryWrites
  };
}

function createRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "telegram",
    actorId: "actor_owner",
    input: "/recall --chat release-room what changed",
    attachments: [],
    conversationRef: {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm"
    },
    ...overrides
  };
}

describe("filterMemoryWritesForImContext", () => {
  it("marks targeted owner-DM recall as transient borrowed context and excludes it from memory writes", () => {
    const writes = filterMemoryWritesForImContext({
      request: createRequest({
        turnId: "turn_owner_recall_001",
        sessionId: "session_owner_dm",
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "owner_targeted",
            targetConversationKeys: ["supergroup:-100123"],
            borrowedConversationKeys: ["supergroup:-100123"],
            transientBorrowed: true
          }
        }
      }),
      result: createResult([
        createWrite({
          writeId: "write_001",
          sourceTurnId: "turn_owner_recall_001",
          sessionId: "session_owner_dm"
        })
      ])
    });

    expect(writes).toEqual([]);
  });

  it("stamps IM memory writes with privacy metadata for shared conversations", () => {
    const writes = filterMemoryWritesForImContext({
      request: createRequest({
        turnId: "turn_group_001",
        sessionId: "session_group_001",
        actorId: "actor_member",
        input: "summarize the rollout",
        conversationRef: {
          accountId: "acct_bot",
          conversationId: "supergroup:-100123",
          peerId: "-100123",
          peerKind: "group",
          baseConversationId: "supergroup:-100123"
        },
        imContext: {
          activationKind: "interactive_turn",
          boundary: {
            boundaryKey: "supergroup:-100123",
            conversationScope: "shared",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      }),
      result: createResult([
        createWrite({
          writeId: "write_group_001",
          sourceTurnId: "turn_group_001",
          sessionId: "session_group_001"
        })
      ])
    });

    expect(writes).toEqual([
      expect.objectContaining({
        writeId: "write_group_001",
        conversationBoundaryKey: "supergroup:-100123",
        disclosureMode: "local_only",
        targetConversationKeys: [],
        borrowedConversationKeys: [],
        transientBorrowed: false,
        visibility: "conversation_local"
      })
    ]);
  });
});
