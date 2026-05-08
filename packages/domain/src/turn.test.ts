import { describe, expect, it } from "vitest";
import { TurnRequestSchema, TurnResultSchema } from "./turn.ts";
import { InflightTurnSchema, SessionStateSchema, TaskStateSchema } from "./session.ts";
import { MemoryQuerySchema, MemoryWriteRequestSchema } from "./memory.ts";

describe("turn contracts", () => {
  it("accepts canonical cli and IM-flavored turn requests", () => {
    const cliParsed = TurnRequestSchema.parse({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    const imParsed = TurnRequestSchema.parse({
      turnId: "turn_002",
      sessionId: "session_im_001",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "user_telegram_001",
      input: "hello from telegram",
      attachments: [],
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "group:chat_001:thread:thread_777",
        peerId: "chat_001",
        peerKind: "group",
        parentConversationId: "group:chat_001",
        baseConversationId: "group:chat_001",
        threadId: "thread_777"
      },
      channelContext: {
        messageId: "msg_001",
        chatType: "group"
      }
    });

    expect(cliParsed.workspaceId).toBe("workspace_local");
    expect(imParsed.conversationRef?.conversationId).toBe("group:chat_001:thread:thread_777");
  });

  it("preserves IM steer metadata and provider-reported cache/context usage details", () => {
    const parsed = TurnResultSchema.parse({
      turnId: "turn_steer_001",
      sessionId: "session_steer_001",
      resolvedMode: "act",
      status: "completed",
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 32,
        outputTokens: 11,
        totalTokens: 43,
        estimatedCost: 0.002,
        cacheReadTokens: 24,
        cacheWriteTokens: 8,
        contextUsedTokens: 4096,
        maxContextTokens: 128000
      },
      warnings: [],
      checkpointRef: "checkpoint_steer_001"
    });

    const request = TurnRequestSchema.parse({
      turnId: "turn_steer_002",
      sessionId: "session_steer_002",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "user_telegram_001",
      input: "also inspect the failing worker",
      attachments: [],
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "dm:chat_001",
        peerId: "chat_001",
        peerKind: "dm"
      },
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "telegram:dm:chat_001",
          conversationScope: "direct",
          disclosureMode: "owner_targeted"
        },
        messageMode: "steer"
      },
      controlIntent: {
        kind: "steer",
        focusRunId: "run_001",
        imControl: {
          messageMode: "steer",
          source: "telegram",
          messageId: "msg_001",
          senderId: "user_telegram_001",
          text: "also inspect the failing worker",
          capturedAt: "2026-05-02T00:00:00.000Z"
        }
      }
    });

    expect(parsed.usage.cacheReadTokens).toBe(24);
    expect(parsed.usage.cacheWriteTokens).toBe(8);
    expect(parsed.usage.contextUsedTokens).toBe(4096);
    expect(parsed.usage.maxContextTokens).toBe(128000);
    expect(request.imContext?.messageMode).toBe("steer");
    expect(request.controlIntent?.imControl?.messageId).toBe("msg_001");
  });

  it("accepts a blocked turn result", () => {
    const parsed = TurnResultSchema.parse({
      turnId: "turn_001",
      sessionId: "session_001",
      resolvedMode: "act",
      status: "blocked",
      messages: [],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedCost: 0.001
      },
      warnings: [],
      checkpointRef: "checkpoint_001",
      blockedBy: "permission"
    });

    expect(parsed.status).toBe("blocked");
  });

  it("accepts canonical session, task, inflight, and memory values", () => {
    const session = SessionStateSchema.parse({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      createdFrom: "cli",
      lastSource: "cli",
      mode: "act",
      status: "active",
      currentGoal: "ship endec",
      workingSetRef: "working_set:1",
      workingSetVersion: 1,
      activeTaskIds: ["task_001"],
      recentTurnRefs: ["turn_001"],
      lastEventSeq: 1,
      lastTurnAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const task = TaskStateSchema.parse({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Ship MVP",
      description: "Finish P0",
      kind: "act",
      status: "active",
      lastTurnId: "turn_001",
      checkpointRef: "checkpoint_001",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const inflight = InflightTurnSchema.parse({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 1,
      pendingApprovalRef: "approval_001",
      checkpointRef: "checkpoint_001",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const query = MemoryQuerySchema.parse({
      queryId: "query_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      purpose: "turn_context",
      memoryTypes: ["working_set"],
      maxItems: 5,
      maxInjectTokens: 256,
      queryText: "auth migration",
      taskId: "task_001",
      topicHints: ["auth"],
      timeRange: { start: new Date(0).toISOString(), end: new Date().toISOString() },
      scopeFilter: "workspace"
    });

    const write = MemoryWriteRequestSchema.parse({
      writeId: "write_001",
      sourceTurnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      writeKind: "candidate_extract",
      evidenceRefs: ["turn_001"],
      taskId: "task_001",
      scope: "workspace",
      proposedMemoryType: "episodic",
      importance: 0.8,
      dedupeKey: "dedupe:001",
      metadata: { topic: "auth" }
    });

    expect(session.mode).toBe("act");
    expect(task.kind).toBe("act");
    expect(inflight.waitingReason).toBe("permission");
    expect(query.scopeFilter).toBe("workspace");
    expect(write.proposedMemoryType).toBe("episodic");
  });
});
