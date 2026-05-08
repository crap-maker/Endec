import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingExecution } from "@endec/domain";
import { createSessionQueryStore } from "./query-store.ts";
import { createSessionStore } from "./session-store.ts";

function createBlockedPendingExecution(): PendingExecution {
  return {
    schemaVersion: 1 as const,
    contractVersion: "ws0.pending-execution.v1" as const,
    pendingExecutionId: "pending:turn_001",
    frameRef: "frame:turn_001",
    checkpointRef: "checkpoint:turn_001",
    status: "blocked" as const,
    frame: {
      schemaVersion: 1 as const,
      contractVersion: "ws0.execution-frame.v1" as const,
      frameRef: "frame:turn_001",
      checkpointRef: "checkpoint:turn_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      phase: "awaiting_permission" as const,
      step: "tool_batch",
      pendingToolCalls: [],
      pendingPermissionDecisions: [
        {
          decisionId: "decision_001",
          behavior: "ask" as const,
          scope: "once" as const,
          reasonCode: "tool_requires_approval",
          reasonText: "write_file requires approval",
          issuedAt: "2026-04-13T01:00:00.000Z",
          requestedBy: "turn_001"
        }
      ],
      loopCount: 1,
      toolCallCount: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        estimatedCost: 0
      },
      continuation: {
        continuationKind: "awaiting_operator" as const,
        allowedActions: ["approve", "deny", "resume", "cancel"],
        metadata: {}
      }
    },
    runtimeSelfAwareness: {
      schemaVersion: 1 as const,
      contractVersion: "ws5.runtime-self-awareness.v1" as const,
      source: "cli" as const,
      channel: "cli" as const,
      mode: "chat" as const,
      exposedToolNames: ["read", "bash"],
      replyPath: "blocked" as const,
      constraints: [
        {
          code: "tool_requires_approval",
          summary: "write_file requires approval",
          blocking: true,
          metadata: {
            pendingApprovalRef: "decision_001"
          }
        }
      ]
    }
  };
}

function createDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "endec-session-query-"));
  return {
    filename: join(dir, `${randomUUID()}.sqlite`),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

describe("createSessionQueryStore.loadRecentHistory", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("returns recent history entries with before-turn filtering", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "first turn",
      attachments: []
    });

    await store.commitTurn({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "chat",
      status: "completed",
      createdAt: "2026-04-11T10:00:00.000Z",
      events: [
        {
          eventId: "turn_001:user",
          eventKind: "user_message",
          createdAt: "2026-04-11T10:00:00.000Z",
          summary: "User asked the first question.",
          text: "first turn"
        },
        {
          eventId: "turn_001:assistant",
          eventKind: "assistant_message",
          createdAt: "2026-04-11T10:00:01.000Z",
          summary: "Assistant answered the first question.",
          text: "first answer",
          sourceRefs: ["turn_001"]
        }
      ]
    });

    await store.commitTurn({
      turnId: "turn_002",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "chat",
      status: "completed",
      createdAt: "2026-04-11T10:01:00.000Z",
      events: [
        {
          eventId: "turn_002:user",
          eventKind: "user_message",
          createdAt: "2026-04-11T10:01:00.000Z",
          summary: "User asked the second question.",
          text: "second turn"
        },
        {
          eventId: "turn_002:assistant",
          eventKind: "assistant_message",
          createdAt: "2026-04-11T10:01:01.000Z",
          summary: "Assistant answered the second question.",
          text: "second answer",
          sourceRefs: ["turn_002"]
        }
      ]
    });

    const latest = await queries.loadRecentHistory({
      sessionId: "session_001",
      limit: 2
    });
    const beforeTurnTwo = await queries.loadRecentHistory({
      sessionId: "session_001",
      beforeTurnId: "turn_002",
      limit: 5
    });

    expect(latest.map((entry) => entry.turnId)).toEqual(["turn_002", "turn_002"]);
    expect(beforeTurnTwo.map((entry) => entry.turnId)).toEqual(["turn_001", "turn_001"]);
    expect(beforeTurnTwo[0]).toMatchObject({
      eventKind: "assistant_message",
      text: "first answer",
      sourceRefs: ["turn_001"]
    });
  });

  it("projects a blocked recoverable turn into an operator-facing recovery snapshot", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });

    await store.commitTurn({
      turnId: "turn_prev",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "chat",
      status: "completed",
      createdAt: "2026-04-13T00:59:00.000Z",
      currentGoal: "operator snapshot recovery",
      events: [
        {
          eventId: "turn_prev:user",
          eventKind: "user_message",
          createdAt: "2026-04-13T00:59:00.000Z",
          summary: "User set the current goal.",
          text: "operator snapshot recovery"
        }
      ]
    });

    await store.markInflight({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 1,
      pendingApprovalRef: "decision_001",
      checkpointRef: "checkpoint:turn_001",
      frameRef: "frame:turn_001",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: createBlockedPendingExecution()
    });

    await expect(queries.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toMatchObject({
      schemaVersion: 1,
      contractVersion: "ws5.operator-recovery-snapshot.v1",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      recoverable: true,
      hasPendingExecution: true,
      turnId: "turn_001",
      frameRef: "frame:turn_001",
      checkpointRef: "checkpoint:turn_001",
      blockedBy: "permission",
      waitingReason: "permission",
      state: "awaiting_permission",
      allowedActions: ["approve", "deny", "resume", "cancel"],
      pendingApprovalRef: "decision_001",
      pendingDecision: expect.objectContaining({
        decisionId: "decision_001",
        reasonCode: "tool_requires_approval"
      }),
      contextSummary: {
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "chat",
        currentGoal: "operator snapshot recovery",
        activeTaskIds: [],
        recentTurnRefs: ["turn_prev"]
      },
      runtimeSelfAwareness: expect.objectContaining({
        contractVersion: "ws5.runtime-self-awareness.v1",
        replyPath: "blocked",
        exposedToolNames: ["read", "bash"]
      })
    });
  });

  it("projects the current pending ask decision instead of the first mixed-batch decision", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_mixed_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "run edit then bash",
      attachments: []
    });

    const pendingExecution = createBlockedPendingExecution();
    pendingExecution.runtimeSelfAwareness = undefined;
    pendingExecution.frame.pendingToolCalls = [
      {
        toolCallId: "tool_call_bash_001",
        toolName: "bash",
        arguments: {
          command: "cat notes.txt"
        }
      }
    ];
    pendingExecution.frame.pendingPermissionDecisions = [
      {
        decisionId: "tool_call_edit_001",
        behavior: "allow",
        scope: "once",
        reasonCode: "tool_auto_allowed",
        reasonText: "edit is auto-allowed by the current tool exposure policy",
        issuedAt: "2026-04-13T01:00:00.000Z",
        requestedBy: "turn_mixed_001"
      },
      {
        decisionId: "tool_call_bash_001",
        behavior: "ask",
        scope: "once",
        reasonCode: "tool_requires_approval",
        reasonText: "bash requires operator approval before it can run",
        issuedAt: "2026-04-13T01:00:01.000Z",
        requestedBy: "turn_mixed_001"
      }
    ];

    await store.markInflight({
      turnId: "turn_mixed_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 2,
      pendingApprovalRef: "tool_call_bash_001",
      checkpointRef: "checkpoint:turn_mixed_001",
      frameRef: "frame:turn_mixed_001",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        ...pendingExecution,
        pendingExecutionId: "pending:turn_mixed_001",
        frameRef: "frame:turn_mixed_001",
        checkpointRef: "checkpoint:turn_mixed_001",
        frame: {
          ...pendingExecution.frame,
          frameRef: "frame:turn_mixed_001",
          checkpointRef: "checkpoint:turn_mixed_001",
          turnId: "turn_mixed_001"
        }
      }
    });

    await expect(queries.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toMatchObject({
      turnId: "turn_mixed_001",
      pendingApprovalRef: "tool_call_bash_001",
      pendingDecision: expect.objectContaining({
        decisionId: "tool_call_bash_001",
        behavior: "ask",
        reasonCode: "tool_requires_approval"
      }),
      runtimeSelfAwareness: expect.objectContaining({
        replyPath: "blocked",
        constraints: [
          expect.objectContaining({
            code: "tool_requires_approval",
            metadata: expect.objectContaining({
              decisionId: "tool_call_bash_001"
            })
          })
        ]
      })
    });
  });

  it("projects a ready runtime-recovery turn into a recoverable operator-facing snapshot", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_runtime_pause",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "pause before the next tool batch",
      attachments: []
    });

    await store.markInflight({
      turnId: "turn_runtime_pause",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 2,
      toolCallCount: 3,
      checkpointRef: "checkpoint:turn_runtime_pause",
      frameRef: "frame:turn_runtime_pause",
      pendingExecution: {
        ...createBlockedPendingExecution(),
        pendingExecutionId: "pending:turn_runtime_pause",
        frameRef: "frame:turn_runtime_pause",
        checkpointRef: "checkpoint:turn_runtime_pause",
        status: "ready",
        frame: {
          ...createBlockedPendingExecution().frame,
          frameRef: "frame:turn_runtime_pause",
          checkpointRef: "checkpoint:turn_runtime_pause",
          turnId: "turn_runtime_pause",
          phase: "awaiting_operator",
          step: "tool_turn_limit",
          pendingToolCalls: [
            {
              toolCallId: "tool_call_resume_001",
              toolName: "read",
              arguments: { path: "README.md" }
            }
          ],
          pendingPermissionDecisions: [],
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              stopReason: "tool_turn_limit",
              requestedToolCallsInBatch: 1,
              toolCallCountBeforePausedBatch: 2,
              executedToolCalls: 0
            }
          }
        },
        runtimeSelfAwareness: {
          schemaVersion: 1,
          contractVersion: "ws5.runtime-self-awareness.v1",
          source: "cli",
          channel: "cli",
          mode: "chat",
          exposedToolNames: ["read", "bash"],
          replyPath: "continuation",
          constraints: []
        }
      }
    });

    await expect(queries.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toMatchObject({
      recoverable: true,
      waitingReason: "user_decision",
      state: "ready",
      allowedActions: ["resume", "cancel"],
      blockedBy: "user_decision",
      pendingExecutionId: "pending:turn_runtime_pause",
      frameRef: "frame:turn_runtime_pause",
      checkpointRef: "checkpoint:turn_runtime_pause",
      runtimeSelfAwareness: expect.objectContaining({
        replyPath: "continuation",
        constraints: []
      })
    });
  });

  it("loads focus-run and last-turn truth for status snapshots", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_status",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });
    await store.commitTurn({
      turnId: "turn_status_001",
      sessionId: "session_status",
      workspaceId: "workspace_local",
      source: "telegram",
      mode: "chat",
      status: "completed",
      createdAt: "2026-05-02T00:00:00.000Z",
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
        estimatedCost: 0.01,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        contextUsedTokens: 512,
        maxContextTokens: 128000
      },
      events: [{
        eventId: "turn_status_001:user",
        eventKind: "user_message",
        createdAt: "2026-05-02T00:00:00.000Z",
        summary: "status snapshot seed",
        text: "status snapshot seed"
      }]
    });
    await store.setFocusRun({
      sessionId: "session_status",
      taskId: "task_001",
      runId: "run_001",
      now: "2026-05-02T00:00:01.000Z"
    });

    await expect(queries.loadStatusSessionTruth({ sessionId: "session_status" })).resolves.toMatchObject({
      sessionId: "session_status",
      workspaceId: "workspace_local",
      focusTaskId: "task_001",
      focusRunId: "run_001",
      lastTurn: {
        turnId: "turn_status_001",
        status: "completed",
        createdAt: "2026-05-02T00:00:00.000Z",
        usage: {
          inputTokens: 8,
          outputTokens: 3,
          totalTokens: 11,
          estimatedCost: 0.01,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          contextUsedTokens: 512,
          maxContextTokens: 128000
        }
      }
    });
  });

  it("drops the recovery snapshot once the blocked turn is finalized", async () => {
    const db = createDbPath();
    cleanups.push(db.cleanup);
    const store = createSessionStore({ filename: db.filename });
    const queries = createSessionQueryStore({ filename: db.filename });

    await store.loadOrCreate({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: []
    });
    await store.markInflight({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      checkpointRef: "checkpoint:turn_001",
      frameRef: "frame:turn_001",
      pendingExecution: {
        ...createBlockedPendingExecution(),
        status: "ready",
        frame: {
          ...createBlockedPendingExecution().frame,
          pendingPermissionDecisions: [],
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {}
          }
        }
      }
    });

    expect(await queries.getRecoverySnapshot({ sessionId: "session_001" })).toMatchObject({
      recoverable: true,
      state: "ready",
      waitingReason: "user_decision",
      allowedActions: ["resume", "cancel"]
    });

    await store.finalize({
      turnId: "turn_001",
      sessionId: "session_001",
      status: "interrupted"
    });

    await expect(queries.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toBeNull();
  });
});
