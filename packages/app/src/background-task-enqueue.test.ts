import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderTransport, ProviderTransportRequest } from "@endec/ai";
import { createRuntimeSliceStore, createTaskEventStore, createTaskRunStore, createTaskStore } from "@endec/tasks";
import { createEndecApp } from "./index.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";
import { parseBackgroundIntent } from "./background-intent.ts";

type JsonObject = Record<string, unknown>;

function createChatCompletionTransport(
  responses: Array<Array<JsonObject>>,
  onRequest?: (request: ProviderTransportRequest) => void
): ProviderTransport {
  let index = 0;

  return {
    async *stream(request) {
      onRequest?.(request);
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
  };
}

function createTurnRequest(overrides: Partial<{
  turnId: string;
  sessionId: string;
  workspaceId: string;
  source: "telegram" | "feishu" | "cli" | "tui" | "web" | "sdk";
  actorId: string;
  input: string;
  channelContext: Record<string, unknown>;
}> = {}) {
  return {
    turnId: "turn_bg_001",
    sessionId: "session_bg_001",
    workspaceId: "workspace_local",
    source: "telegram" as const,
    actorId: "actor_telegram_001",
    input: "/background investigate flaky test",
    attachments: [],
    conversationRef: {
      accountId: "telegram_bot",
      conversationId: "group:100:thread:200",
      peerId: "100",
      peerKind: "group" as const,
      threadId: "200"
    },
    channelContext: {
      messageId: "msg_001",
      chatType: "group"
    },
    ...overrides
  };
}

function extractTaskIdFromAckMessage(content: unknown) {
  if (typeof content !== "string") {
    return null;
  }

  const match = content.match(/任务 ID：([^\n]+)/);
  return match?.[1]?.trim() ?? null;
}

function getFirstMessageContent(messages: unknown[]) {
  const first = messages[0];
  if (!first || typeof first !== "object") {
    return null;
  }

  const content = (first as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function createDeterministicBackgroundEntityId(input: {
  prefix: "task_bg" | "run_bg";
  scope: "task" | "run";
  idempotencyKey: string;
}) {
  const digest = createHash("sha256")
    .update(`${input.scope}\u001f${input.idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `${input.prefix}_${digest}`;
}

function deriveBackgroundDeterministicIds(request: ReturnType<typeof createTurnRequest>) {
  const intent = parseBackgroundIntent(request);
  if (!intent) {
    throw new Error("request does not contain background intent");
  }

  const conversationId = request.conversationRef?.conversationId ?? "no_conversation";
  const idempotencyKey = [
    "bg_enqueue",
    request.sessionId,
    request.turnId,
    conversationId,
    intent.normalizedIntent
  ].join(":");

  return {
    idempotencyKey,
    taskId: createDeterministicBackgroundEntityId({
      prefix: "task_bg",
      scope: "task",
      idempotencyKey
    }),
    runId: createDeterministicBackgroundEntityId({
      prefix: "run_bg",
      scope: "run",
      idempotencyKey
    }),
    intent
  };
}

function countEventType(events: Array<{ eventType: string }>, eventType: string) {
  return events.filter((event) => event.eventType === eventType).length;
}

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-app-bg-enqueue-"));
}

const tempDirs = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("background task enqueue", () => {
  it("explicit /background command creates task run and returns synchronous ack", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([], (request) => transportRequests.push(request))
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      input: "/background investigate recent failures"
    }));

    expect(result.status).toBe("completed");
    expect(result.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("已排队")
      })
    ]);
    expect(transportRequests).toHaveLength(0);

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: paths.tasksDbPath });

    const active = await legacyTaskStore.listActiveBySession("session_bg_001");
    expect(active).toHaveLength(1);
    const taskId = active[0]?.taskId;
    expect(taskId).toBeTruthy();

    const task = await runStore.loadBackgroundTask(taskId!);
    expect(task).toMatchObject({
      taskId,
      agentStatus: "queued",
      sessionId: "session_bg_001",
      workspaceId: "workspace_local"
    });

    const runs = await runStore.listRunsByTask(taskId!);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      taskId,
      status: "queued",
      runKind: "normal",
      attemptNo: 1
    });

    const seededSlices = await sliceStore.listSlicesByRun(runs[0]!.runId);
    expect(seededSlices).toMatchObject([
      {
        sliceNo: 1,
        triggerKind: "initial",
        lane: "background",
        status: "queued"
      }
    ]);

    const events = await eventStore.listEventsByTask({ taskId: taskId! });
    expect(events.map((event) => event.eventType)).toEqual(["task_created", "run_queued"]);
  });

  it("explicit /bg alias creates a queued background task and ack", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bg_alias_001",
      sessionId: "session_bg_alias_001",
      input: "/bg investigate flaky integration test"
    }));

    expect(result.status).toBe("completed");
    expect(result.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("已排队")
      })
    ]);

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const active = await legacyTaskStore.listActiveBySession("session_bg_alias_001");
    expect(active).toHaveLength(1);

    const runs = await runStore.listRunsByTask(active[0]!.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
  });

  it("normal text 我去调查一下 does not enqueue and still executes normal turn path", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "好的，我先看一下。"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 7,
              total_tokens: 19
            }
          }
        ]
      ], (request) => transportRequests.push(request))
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_normal_001",
      sessionId: "session_normal_001",
      input: "我去调查一下"
    }));

    expect(result.status).toBe("completed");
    expect(transportRequests.length).toBeGreaterThan(0);

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const active = await legacyTaskStore.listActiveBySession("session_normal_001");
    expect(active).toHaveLength(0);
  });

  it("worker marker executionRole=background_worker bypasses enqueue classification", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "normal execution for background worker turn"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 9,
              completion_tokens: 9,
              total_tokens: 18
            }
          }
        ]
      ], (request) => transportRequests.push(request))
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_worker_marker_001",
      sessionId: "session_worker_marker_001",
      input: "/background should not enqueue because marker exists",
      channelContext: {
        backgroundTask: {
          schemaVersion: 1,
          contractVersion: "im.background-turn.v1",
          taskId: "task_existing",
          runId: "run_existing",
          attemptNo: 1,
          originTurnId: "turn_origin",
          executionRole: "background_worker"
        }
      }
    }));

    expect(result.status).toBe("completed");
    expect(transportRequests.length).toBeGreaterThan(0);

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const active = await legacyTaskStore.listActiveBySession("session_worker_marker_001");
    expect(active).toHaveLength(0);
  });

  it("background_control marker bypasses enqueue classification", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "normal execution for background control turn"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 9,
              completion_tokens: 9,
              total_tokens: 18
            }
          }
        ]
      ], (request) => transportRequests.push(request))
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_control_marker_001",
      sessionId: "session_control_marker_001",
      input: "/background should not enqueue because control marker exists",
      channelContext: {
        backgroundTask: {
          schemaVersion: 1,
          contractVersion: "im.background-turn.v1",
          taskId: "task_existing",
          runId: "run_existing",
          attemptNo: 1,
          originTurnId: "turn_origin",
          executionRole: "background_control"
        }
      }
    }));

    expect(result.status).toBe("completed");
    expect(transportRequests.length).toBeGreaterThan(0);

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const active = await legacyTaskStore.listActiveBySession("session_control_marker_001");
    expect(active).toHaveLength(0);
  });

  it("concurrent same inbound enqueue creates exactly one task and one queued run", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([], (request) => transportRequests.push(request))
    });

    const request = createTurnRequest({
      turnId: "turn_concurrent_dup_001",
      sessionId: "session_concurrent_dup_001",
      input: "/background investigate concurrent duplicate enqueue"
    });

    const [first, second] = await Promise.all([
      app.shell.executeTurn(request),
      app.shell.executeTurn(request)
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("已排队")
      })
    ]);
    expect(second.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("已排队")
      })
    ]);
    expect(transportRequests).toHaveLength(0);

    const firstTaskId = extractTaskIdFromAckMessage(getFirstMessageContent(first.messages));
    const secondTaskId = extractTaskIdFromAckMessage(getFirstMessageContent(second.messages));
    expect(firstTaskId).toBeTruthy();
    expect(secondTaskId).toBe(firstTaskId);

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: paths.tasksDbPath });

    const active = await legacyTaskStore.listActiveBySession("session_concurrent_dup_001");
    expect(active).toHaveLength(1);

    const taskId = active[0]!.taskId;
    expect(taskId).toBe(firstTaskId);

    const runs = await runStore.listRunsByTask(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      taskId,
      status: "queued",
      runKind: "normal",
      attemptNo: 1
    });

    const events = await eventStore.listEventsByTask({ taskId });
    expect(events.map((event) => event.eventType)).toEqual(["task_created", "run_queued"]);
  });

  it("valid structured backgroundTaskIntent enqueues background task and returns ack", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([], (request) => transportRequests.push(request))
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_structured_valid_001",
      sessionId: "session_structured_valid_001",
      input: "请帮我处理这个问题",
      channelContext: {
        backgroundTaskIntent: {
          kind: "enqueue",
          description: "investigate flaky integration test",
          input: "collect logs and identify likely root cause"
        }
      }
    }));

    expect(result.status).toBe("completed");
    expect(result.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("已排队")
      })
    ]);
    expect(transportRequests).toHaveLength(0);

    const taskId = extractTaskIdFromAckMessage(getFirstMessageContent(result.messages));
    expect(taskId).toBeTruthy();

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const active = await legacyTaskStore.listActiveBySession("session_structured_valid_001");
    expect(active).toHaveLength(1);
    expect(active[0]!.taskId).toBe(taskId);

    const runs = await runStore.listRunsByTask(taskId!);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
  });

  it("invalid structured backgroundTaskIntent falls back to normal execution path", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const transportRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "好的，我按普通路径继续处理。"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 9,
              total_tokens: 20
            }
          }
        ]
      ], (request) => transportRequests.push(request))
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_structured_invalid_001",
      sessionId: "session_structured_invalid_001",
      input: "请帮我处理这个问题",
      channelContext: {
        backgroundTaskIntent: {
          kind: "enqueue",
          title: "missing description and input"
        }
      }
    }));

    expect(result.status).toBe("completed");
    expect(transportRequests.length).toBeGreaterThan(0);

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const active = await legacyTaskStore.listActiveBySession("session_structured_invalid_001");
    expect(active).toHaveLength(0);
  });

  it("existing task/run retry leaves missing task_created/run_queued event filled", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const request = createTurnRequest({
      turnId: "turn_partial_retry_001",
      sessionId: "session_partial_retry_001",
      input: "/background investigate partial retry convergence"
    });
    const derived = deriveBackgroundDeterministicIds(request);
    const now = new Date().toISOString();

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: derived.taskId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      conversationRef: request.conversationRef,
      title: derived.intent.title,
      description: derived.intent.description,
      sourceTurnId: request.turnId,
      now
    });

    await runStore.enqueueRun({
      runId: derived.runId,
      taskId: derived.taskId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      conversationRef: request.conversationRef,
      idempotencyKey: derived.idempotencyKey,
      turnRequest: {
        turnId: request.turnId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        source: request.source,
        input: derived.intent.input,
        conversationRef: request.conversationRef,
        requestedMode: undefined,
        originTurnId: request.turnId
      },
      sourceTurnId: request.turnId,
      maxAttempts: 1,
      now
    });

    const result = await app.shell.executeTurn(request);

    expect(result.status).toBe("completed");
    expect(extractTaskIdFromAckMessage(getFirstMessageContent(result.messages))).toBe(derived.taskId);

    const active = await legacyTaskStore.listActiveBySession("session_partial_retry_001");
    expect(active).toHaveLength(1);
    expect(active[0]!.taskId).toBe(derived.taskId);

    const runs = await runStore.listRunsByTask(derived.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe(derived.runId);

    const events = await eventStore.listEventsByTask({ taskId: derived.taskId });
    expect(countEventType(events, "task_created")).toBe(1);
    expect(countEventType(events, "run_queued")).toBe(1);
    expect(events).toHaveLength(2);
  });

  it("retry fills run_queued when only task_created exists without duplicating task_created", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const request = createTurnRequest({
      turnId: "turn_partial_retry_002",
      sessionId: "session_partial_retry_002",
      input: "/background investigate partial retry run queued gap"
    });
    const derived = deriveBackgroundDeterministicIds(request);
    const now = new Date().toISOString();

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: derived.taskId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      conversationRef: request.conversationRef,
      title: derived.intent.title,
      description: derived.intent.description,
      sourceTurnId: request.turnId,
      now
    });

    await runStore.enqueueRun({
      runId: derived.runId,
      taskId: derived.taskId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      actorId: request.actorId,
      conversationRef: request.conversationRef,
      idempotencyKey: derived.idempotencyKey,
      turnRequest: {
        turnId: request.turnId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        source: request.source,
        input: derived.intent.input,
        conversationRef: request.conversationRef,
        requestedMode: undefined,
        originTurnId: request.turnId
      },
      sourceTurnId: request.turnId,
      maxAttempts: 1,
      now
    });

    await eventStore.appendTaskEvent({
      taskId: derived.taskId,
      runId: derived.runId,
      workspaceId: request.workspaceId,
      eventType: "task_created",
      severity: "info",
      message: `background task created: ${derived.intent.title}`,
      idempotencyKey: `${derived.idempotencyKey}:task_created`,
      now: new Date(now)
    });

    const result = await app.shell.executeTurn(request);

    expect(result.status).toBe("completed");
    expect(extractTaskIdFromAckMessage(getFirstMessageContent(result.messages))).toBe(derived.taskId);

    const active = await legacyTaskStore.listActiveBySession("session_partial_retry_002");
    expect(active).toHaveLength(1);
    expect(active[0]!.taskId).toBe(derived.taskId);

    const runs = await runStore.listRunsByTask(derived.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe(derived.runId);

    const events = await eventStore.listEventsByTask({ taskId: derived.taskId });
    expect(countEventType(events, "task_created")).toBe(1);
    expect(countEventType(events, "run_queued")).toBe(1);
    expect(events).toHaveLength(2);
  });

  it("duplicate explicit enqueue is idempotent for task/run/events", async () => {

    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const request = createTurnRequest({
      turnId: "turn_dup_001",
      sessionId: "session_dup_001",
      input: "/background investigate duplicate enqueue"
    });

    const first = await app.shell.executeTurn(request);
    const second = await app.shell.executeTurn(request);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");

    const paths = ensureEndecDataLayout(dataDir);
    const legacyTaskStore = createTaskStore({ filename: paths.tasksDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const eventStore = createTaskEventStore({ filename: paths.tasksDbPath });

    const active = await legacyTaskStore.listActiveBySession("session_dup_001");
    expect(active).toHaveLength(1);

    const taskId = active[0]!.taskId;
    const runs = await runStore.listRunsByTask(taskId);
    expect(runs).toHaveLength(1);

    const events = await eventStore.listEventsByTask({ taskId });
    expect(events.map((event) => event.eventType)).toEqual(["task_created", "run_queued"]);
  });
});
