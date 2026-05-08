import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createCostLedger } from "@endec/budget";
import { createSessionQueryStore, createSessionStore } from "@endec/sessions";
import { createRunControlStore, createRuntimeSliceStore, createTaskRunStore } from "@endec/tasks";
import { buildAppStatusSnapshot, formatStatusSnapshotLines } from "./status.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }));
});

async function tempDbPaths() {
  const dir = await mkdtemp(join(tmpdir(), "endec-status-"));
  tempDirs.add(dir);
  return {
    dir,
    tasks: join(dir, "tasks.sqlite"),
    sessions: join(dir, "sessions.sqlite")
  };
}

describe("app status snapshot", () => {
  it("surfaces a blocked focus run instead of dropping it from status", async () => {
    const paths = await tempDbPaths();
    const sessionStore = createSessionStore({ filename: paths.sessions });
    const sessionQueryStore = createSessionQueryStore({ filename: paths.sessions });
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_blocked_focus",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_blocked_focus",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_focus",
      actorId: "actor_owner",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      title: "Investigate blocked focus",
      description: "Status should still surface blocked runs",
      sourceTurnId: "turn_seed",
      now: "2026-05-02T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_blocked_focus",
      taskId: "task_blocked_focus",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_focus",
      actorId: "actor_owner",
      attentionMode: "foreground_attached",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      now: "2026-05-02T00:00:00.100Z"
    });
    await runStore.claimNextRun({
      workerId: "worker_blocked_focus",
      leaseDurationMs: 60_000,
      now: "2026-05-02T00:00:00.150Z"
    });
    await runStore.suspendRun({
      runId: "run_blocked_focus",
      pendingControlRef: "frame:blocked_focus",
      blockedBy: "permission",
      resultSummary: "waiting for approval",
      now: "2026-05-02T00:00:00.200Z"
    });
    await sessionStore.setFocusRun({
      sessionId: "session_blocked_focus",
      taskId: "task_blocked_focus",
      runId: "run_blocked_focus",
      now: "2026-05-02T00:00:00.300Z"
    });

    const status = await buildAppStatusSnapshot({
      productName: "endec",
      dataDir: "/tmp/endec-status",
      currentModel: {
        providerId: "local-default",
        modelId: "cheap-default",
        baseUrl: "http://127.0.0.1:11434/v1",
        selectionSource: "catalog",
        providerConfigured: false,
        modelConfigured: false,
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: [],
      capabilities: {
        execute: true,
        history: true,
        artifactRead: true,
        evidenceRead: true
      },
      sessionId: "session_blocked_focus",
      sessionQueryStore,
      runStore,
      sliceStore,
      controlStore
    });

    expect(status.activeRun).toMatchObject({
      state: "active",
      taskId: "task_blocked_focus",
      runId: "run_blocked_focus",
      runStatus: "blocked"
    });
  });

  it("returns truthful active-run status without inventing cache numbers", async () => {
    const paths = await tempDbPaths();
    const sessionStore = createSessionStore({ filename: paths.sessions });
    const sessionQueryStore = createSessionQueryStore({ filename: paths.sessions });
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });

    await runStore.createBackgroundTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_owner",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      title: "Investigate runtime drift",
      description: "Inspect the active run status surface",
      sourceTurnId: "turn_seed",
      now: "2026-05-02T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_001",
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_owner",
      attentionMode: "foreground_attached",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      now: "2026-05-02T00:00:00.100Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_001",
      runId: "run_001",
      taskId: "task_001",
      lane: "foreground",
      now: "2026-05-02T00:00:00.200Z"
    });
    await controlStore.appendControlInput({
      controlId: "control_001",
      taskId: "task_001",
      runId: "run_001",
      kind: "steer",
      payload: { text: "narrow scope" },
      createdAt: "2026-05-02T00:00:00.250Z"
    });
    await sessionStore.setFocusRun({
      sessionId: "session_001",
      taskId: "task_001",
      runId: "run_001",
      now: "2026-05-02T00:00:00.300Z"
    });
    await sliceStore.claimNextRunnableSlice({
      workerId: "worker_001",
      lane: "foreground",
      leaseDurationMs: 60_000,
      now: "2026-05-02T00:00:00.400Z"
    });
    await sliceStore.finalizeSlice({
      sliceId: "slice_001",
      status: "yielded",
      usageSummary: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        estimatedCost: 0.1,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
        contextUsedTokens: 2048,
        maxContextTokens: 200000
      },
      continuationPayload: {
        checkpointRef: "checkpoint:run_001"
      },
      finishedAt: "2026-05-02T00:00:01.000Z"
    });

    const status = await buildAppStatusSnapshot({
      productName: "endec",
      dataDir: "/tmp/endec-status",
      currentModel: {
        providerId: "local-default",
        modelId: "cheap-default",
        baseUrl: "http://127.0.0.1:11434/v1",
        selectionSource: "catalog",
        providerConfigured: false,
        modelConfigured: false,
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: [],
      capabilities: {
        execute: true,
        history: true,
        artifactRead: true,
        evidenceRead: true
      },
      sessionId: "session_001",
      sessionQueryStore,
      runStore,
      sliceStore,
      controlStore
    });

    expect(status.activeRun).toMatchObject({
      state: "active",
      taskId: "task_001",
      runId: "run_001",
      runStatus: "queued",
      latestSlice: {
        sliceId: "slice_001",
        status: "yielded"
      },
      pendingControlCount: 1,
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        estimatedCost: 0.1,
        cache: {
          state: "available",
          readTokens: 4,
          writeTokens: 1
        },
        context: {
          state: "available",
          usedTokens: 2048,
          maxTokens: 200000
        }
      }
    });
    expect(status.lastTurn).toMatchObject({ state: "none" });
  });

  it("hydrates committed last-turn usage from stored turn usage before formatting status", async () => {
    const paths = await tempDbPaths();
    const sessionStore = createSessionStore({ filename: paths.sessions });
    const sessionQueryStore = createSessionQueryStore({ filename: paths.sessions });

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_usage",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });
    await sessionStore.commitTurn({
      turnId: "turn_usage_001",
      sessionId: "session_usage",
      workspaceId: "workspace_local",
      source: "telegram",
      mode: "chat",
      status: "completed",
      createdAt: "2026-05-02T01:00:00.000Z",
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
        eventId: "turn_usage_001:user",
        eventKind: "user_message",
        createdAt: "2026-05-02T01:00:00.000Z",
        summary: "seed",
        text: "seed"
      }]
    });

    const status = await buildAppStatusSnapshot({
      productName: "endec",
      dataDir: "/tmp/endec-status",
      currentModel: {
        providerId: "local-default",
        modelId: "cheap-default",
        baseUrl: "http://127.0.0.1:11434/v1",
        selectionSource: "catalog",
        providerConfigured: false,
        modelConfigured: false,
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: [],
      capabilities: {
        execute: true,
        history: true,
        artifactRead: true,
        evidenceRead: true
      },
      sessionId: "session_usage",
      sessionQueryStore,
      runStore: { loadRunById: async () => undefined },
      sliceStore: { loadLatestSliceByRun: async () => undefined },
      controlStore: { listPendingControls: async () => [] }
    });

    expect(status.lastTurn).toMatchObject({
      state: "available",
      turnId: "turn_usage_001",
      status: "completed",
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        totalTokens: 11,
        estimatedCost: 0.01,
        cache: {
          state: "available",
          readTokens: 2,
          writeTokens: 1
        },
        context: {
          state: "available",
          usedTokens: 512,
          maxTokens: 128000
        }
      }
    });
  });

  it("hydrates committed last-turn token and cache usage from the cost ledger when turn usage is absent", async () => {
    const paths = await tempDbPaths();
    const sessionStore = createSessionStore({ filename: paths.sessions });
    const sessionQueryStore = createSessionQueryStore({ filename: paths.sessions });
    const costLedger = createCostLedger({ filename: join(paths.dir, "fallback-cost-ledger.sqlite") });

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_cost_fallback",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });
    await sessionStore.commitTurn({
      turnId: "turn_cost_fallback_001",
      sessionId: "session_cost_fallback",
      workspaceId: "workspace_local",
      source: "telegram",
      mode: "chat",
      status: "completed",
      createdAt: "2026-05-02T02:00:00.000Z",
      events: [{
        eventId: "turn_cost_fallback_001:user",
        eventKind: "user_message",
        createdAt: "2026-05-02T02:00:00.000Z",
        summary: "seed",
        text: "seed"
      }]
    });
    await costLedger.record({
      ledgerId: "ledger:turn_cost_fallback_001",
      turnId: "turn_cost_fallback_001",
      sessionId: "session_cost_fallback",
      workspaceId: "workspace_local",
      mode: "chat",
      providerId: "openai",
      modelId: "gpt-5.4",
      inputTokens: 21,
      outputTokens: 13,
      cacheReadTokens: 5,
      totalTokens: 34,
      estimatedCost: 0.02,
      memoryInjectedTokens: 0,
      toolResultInjectedTokens: 0,
      toolCallCount: 1,
      loopCount: 1,
      stopReason: "completed",
      startedAt: "2026-05-02T02:00:00.000Z",
      endedAt: "2026-05-02T02:00:01.000Z"
    });

    const status = await buildAppStatusSnapshot({
      productName: "endec",
      dataDir: "/tmp/endec-status",
      currentModel: {
        providerId: "local-default",
        modelId: "cheap-default",
        baseUrl: "http://127.0.0.1:11434/v1",
        selectionSource: "catalog",
        providerConfigured: false,
        modelConfigured: false,
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: [],
      capabilities: {
        execute: true,
        history: true,
        artifactRead: true,
        evidenceRead: true
      },
      sessionId: "session_cost_fallback",
      sessionQueryStore,
      runStore: { loadRunById: async () => undefined },
      sliceStore: { loadLatestSliceByRun: async () => undefined },
      controlStore: { listPendingControls: async () => [] },
      costLedger
    });

    expect(status.lastTurn).toMatchObject({
      state: "available",
      turnId: "turn_cost_fallback_001",
      status: "completed",
      usage: {
        inputTokens: 21,
        outputTokens: 13,
        totalTokens: 34,
        estimatedCost: 0.02,
        cache: {
          state: "available",
          readTokens: 5
        },
        context: {
          state: "not_reported"
        }
      }
    });
  });

  it("returns explicit none states when the session has no active run or committed turn truth", async () => {
    const paths = await tempDbPaths();
    const sessionStore = createSessionStore({ filename: paths.sessions });
    const sessionQueryStore = createSessionQueryStore({ filename: paths.sessions });
    const runStore = createTaskRunStore({ filename: paths.tasks });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasks });
    const controlStore = createRunControlStore({ filename: paths.tasks });

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_empty",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });

    await expect(buildAppStatusSnapshot({
      productName: "endec",
      dataDir: "/tmp/endec-status",
      currentModel: {
        providerId: "local-default",
        modelId: "cheap-default",
        baseUrl: "http://127.0.0.1:11434/v1",
        selectionSource: "catalog",
        providerConfigured: false,
        modelConfigured: false,
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: [],
      capabilities: {
        execute: true,
        history: true,
        artifactRead: true,
        evidenceRead: true
      },
      sessionId: "session_empty",
      sessionQueryStore,
      runStore,
      sliceStore,
      controlStore
    })).resolves.toMatchObject({
      activeRun: { state: "none" },
      lastTurn: { state: "none" }
    });
  });

  it("formats owner-private status with truthful metrics and a concise usage summary", () => {
    const lines = formatStatusSnapshotLines({
      audience: "owner_private",
      status: {
        productName: "endec",
        dataDir: "/tmp/endec-status",
        defaultProviderId: "openai",
        defaultModelId: "gpt-5.4",
        capabilities: {
          execute: true,
          history: true,
          artifactRead: true,
          evidenceRead: true
        },
        currentModel: {
          providerId: "openai",
          modelId: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
          selectionSource: "persisted_current_model",
          providerConfigured: true,
          modelConfigured: true,
          modelCapability: "chat",
          executeCapable: true
        },
        config: {
          source: "endec_json",
          loadedAt: "2026-05-03T00:00:00.000Z",
          schemaVersion: 1
        },
        warningDetails: [
          {
            code: "default_model_unconfigured",
            message: "set ENDEC_PROVIDER_MODEL",
            providerId: "openai",
            modelId: "gpt-5.4"
          }
        ],
        warnings: [],
        activeRun: {
          state: "active",
          taskId: "task_001",
          runId: "run_001",
          runStatus: "running",
          attentionMode: "foreground_attached",
          latestSlice: {
            sliceId: "slice_001",
            status: "running"
          },
          pendingControlCount: 2,
          usage: {
            inputTokens: 12,
            outputTokens: 5,
            totalTokens: 17,
            cache: {
              state: "not_reported"
            },
            context: {
              state: "not_reported"
            }
          }
        },
        lastTurn: {
          state: "available",
          turnId: "turn_123",
          status: "blocked",
          blockedBy: "permission"
        }
      } as never
    });

    expect(lines).toContain("model: openai/gpt-5.4");
    expect(lines).toContain("config: source=endec_json version=1 loadedAt=2026-05-03T00:00:00.000Z");
    expect(lines).toContain("modelState: capability=chat execute=yes source=persisted_current_model providerConfigured=yes modelConfigured=yes");
    expect(lines).toContain("baseUrl: https://api.openai.com/v1");
    expect(lines).toContain("warning[default_model_unconfigured]: set ENDEC_PROVIDER_MODEL");
    expect(lines).toContain("activeRun: status=running taskId=task_001 runId=run_001 attention=foreground_attached");
    expect(lines).toContain("activeRunSlice: sliceId=slice_001 status=running");
    expect(lines).toContain("activeRunPendingControls: 2");
    expect(lines).toContain("lastTurn: status=blocked turnId=turn_123 blockedBy=permission");
    expect(lines).toContain("usage: active run");
    expect(lines).toContain("tokens: in=12 out=5 total=17");
    expect(lines).toContain("cache: not reported");
    expect(lines).toContain("context: not reported");
    expect(lines).not.toContain("lastTurnTokens: unavailable");
    expect(lines).not.toContain("lastTurnCache: unavailable");
    expect(lines).not.toContain("lastTurnContext: unavailable");
  });

  it("formats clean not-reported usage when a truthful snapshot lacks metrics", () => {
    const lines = formatStatusSnapshotLines({
      audience: "owner_private",
      status: {
        productName: "endec",
        dataDir: "/tmp/endec-status",
        defaultProviderId: "openai",
        defaultModelId: "gpt-5.4",
        capabilities: {
          execute: true,
          history: true,
          artifactRead: true,
          evidenceRead: true
        },
        currentModel: {
          providerId: "openai",
          modelId: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
          selectionSource: "persisted_current_model",
          providerConfigured: true,
          modelConfigured: true,
          modelCapability: "chat",
          executeCapable: true
        },
        config: {
          source: "endec_json",
          loadedAt: "2026-05-03T00:00:00.000Z",
          schemaVersion: 1
        },
        warningDetails: [],
        warnings: [],
        activeRun: {
          state: "none"
        },
        lastTurn: {
          state: "available",
          turnId: "turn_456",
          status: "completed"
        }
      } as never
    });

    expect(lines).toContain("config: source=endec_json version=1 loadedAt=2026-05-03T00:00:00.000Z");
    expect(lines).toContain("lastTurn: status=completed turnId=turn_456");
    expect(lines).toContain("usage: last turn (not reported)");
    expect(lines).not.toContain("tokens:");
    expect(lines).not.toContain("cache:");
    expect(lines).not.toContain("context:");
  });

  it("formats clean no-usage status before any session usage exists", () => {
    const lines = formatStatusSnapshotLines({
      audience: "shared",
      status: {
        productName: "endec",
        dataDir: "/tmp/endec-status",
        defaultProviderId: "openai",
        defaultModelId: "gpt-5.4",
        capabilities: {
          execute: true,
          history: true,
          artifactRead: true,
          evidenceRead: true
        },
        currentModel: {
          providerId: "openai",
          modelId: "gpt-5.4",
          selectionSource: "persisted_current_model",
          providerConfigured: true,
          modelConfigured: true,
          modelCapability: "chat",
          executeCapable: true
        },
        config: {
          source: "endec_json",
          loadedAt: "2026-05-03T00:00:00.000Z",
          schemaVersion: 1
        },
        warningDetails: [],
        warnings: [],
        activeRun: {
          state: "none"
        },
        lastTurn: {
          state: "none"
        }
      } as never
    });

    expect(lines).toContain("config: source=endec_json version=1 loadedAt=2026-05-03T00:00:00.000Z");
    expect(lines).toContain("activeRun: none");
    expect(lines).toContain("lastTurn: none");
    expect(lines).toContain("usage: no usage yet");
  });

  it("formats shared status without exposing owner-private runtime internals", () => {
    const lines = formatStatusSnapshotLines({
      audience: "shared",
      status: {
        productName: "endec",
        dataDir: "/tmp/endec-status",
        defaultProviderId: "local-default",
        defaultModelId: "strong-default",
        capabilities: {
          execute: true,
          history: true,
          artifactRead: true,
          evidenceRead: true
        },
        currentModel: {
          providerId: "local-default",
          modelId: "strong-default",
          baseUrl: "http://127.0.0.1:11434/v1",
          selectionSource: "env",
          providerConfigured: true,
          modelConfigured: true,
          modelCapability: "chat",
          executeCapable: true
        },
        config: {
          source: "seeded_endec_json",
          loadedAt: "2026-05-03T00:00:00.000Z",
          schemaVersion: 1
        },
        warningDetails: [
          {
            code: "provider_model_capability_mismatch",
            message: "provider anthropic at https://api.anthropic.com only exposes embedding models",
            providerId: "anthropic",
            modelId: "embed-only"
          }
        ],
        warnings: [],
        activeRun: {
          state: "active",
          taskId: "task_shared_001",
          runId: "run_shared_001",
          runStatus: "queued",
          attentionMode: "foreground_attached",
          latestSlice: {
            sliceId: "slice_shared_001",
            status: "yielded"
          },
          pendingControlCount: 4,
          usage: {
            inputTokens: 20,
            totalTokens: 20,
            cache: {
              state: "available",
              readTokens: 7
            },
            context: {
              state: "estimated",
              usedTokens: 14000,
              maxTokens: 200000
            }
          }
        },
        lastTurn: {
          state: "available",
          turnId: "turn_shared_001",
          status: "completed",
          usage: {
            inputTokens: 8,
            outputTokens: 3,
            totalTokens: 11,
            cache: {
              state: "available",
              readTokens: 4,
              writeTokens: 2
            },
            context: {
              state: "available",
              usedTokens: 512,
              maxTokens: 128000
            }
          }
        }
      } as never
    });
    const rendered = lines.join("\n");

    expect(lines).toContain("model: local-default/strong-default");
    expect(lines).toContain("config: source=seeded_endec_json version=1 loadedAt=2026-05-03T00:00:00.000Z");
    expect(lines).toContain("modelState: capability=chat execute=yes");
    expect(lines).toContain("warning: current model is not ready for execution");
    expect(lines).toContain("activeRun: status=queued");
    expect(lines).toContain("activeRunSlice: status=yielded");
    expect(lines).toContain("lastTurn: status=completed");
    expect(lines).toContain("usage: active run");
    expect(lines).toContain("tokens: in=20 total=20");
    expect(lines).toContain("cache: read=7");
    expect(lines).toContain("context: estimated 14000/200000");
    expect(lines).not.toContain("lastTurnTokens: in=8 out=3 total=11");
    expect(lines).not.toContain("lastTurnCache: read=4 write=2");
    expect(lines).not.toContain("lastTurnContext: 512/128000");
    expect(rendered).not.toContain("baseUrl:");
    expect(rendered).not.toContain("source=env");
    expect(rendered).not.toContain("taskId=");
    expect(rendered).not.toContain("runId=");
    expect(rendered).not.toContain("turnId=");
  });
});
