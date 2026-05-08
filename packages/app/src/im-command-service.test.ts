import { describe, expect, it, vi } from "vitest";
import type { TurnRequest } from "@endec/domain";
import { createImCommandService } from "./im-command-service.ts";

const ownerBinding = {
  ownerBindingId: "owner_001",
  source: "telegram" as const,
  accountId: "acct_bot",
  ownerGeneration: 1,
  ownerSubjectRef: "owner_user",
  ownerActorId: "actor_owner",
  pairedConversationRef: {
    accountId: "acct_bot",
    conversationId: "private:42",
    peerId: "42",
    peerKind: "dm" as const
  },
  consumedClaimId: "claim_001",
  status: "active" as const,
  boundAt: "2026-05-01T09:00:00.000Z"
};

function createCurrentModel(overrides?: Partial<{
  providerId: string;
  modelId: string;
  baseUrl?: string;
  selectionSource: "persisted_current_model" | "models_config_default" | "env" | "catalog";
}>) {
  return {
    providerId: "openai",
    modelId: "gpt-5.4",
    baseUrl: "https://api.openai.com/v1",
    selectionSource: "persisted_current_model" as const,
    ...overrides
  };
}

function createStatusSnapshot(overrides?: Partial<{
  currentModel: Partial<{
    providerId: string;
    modelId: string;
    baseUrl?: string;
    selectionSource: "persisted_current_model" | "models_config_default" | "env" | "catalog";
    providerConfigured: boolean;
    modelConfigured: boolean;
    modelCapability: "chat" | "embedding";
    executeCapable: boolean;
  }>;
  config: Partial<{
    source: string;
    loadedAt: string;
    schemaVersion: number;
  }>;
  warningDetails: Array<{ code: string; message: string; providerId: string; modelId?: string }>;
  warnings: string[];
  activeRun: unknown;
  lastTurn: unknown;
}>) {
  return {
    productName: "endec",
    dataDir: "/tmp/endec",
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
      selectionSource: "persisted_current_model" as const,
      providerConfigured: true,
      modelConfigured: true,
      modelCapability: "chat" as const,
      executeCapable: true,
      ...overrides?.currentModel
    },
    config: {
      source: "endec_json",
      loadedAt: "2026-05-03T00:00:00.000Z",
      schemaVersion: 1,
      ...overrides?.config
    },
    warningDetails: overrides?.warningDetails ?? [],
    warnings: overrides?.warnings ?? [],
    activeRun: overrides?.activeRun ?? { state: "none" },
    lastTurn: overrides?.lastTurn ?? { state: "none" }
  } as const;
}

function createOwnerDmTurnRequest(overrides?: Partial<{
  turnId: string;
  sessionId: string;
  actorId: string;
  input: string;
}>): TurnRequest {
  return {
    turnId: overrides?.turnId ?? "turn_owner_dm_001",
    sessionId: overrides?.sessionId ?? "session_owner_dm",
    workspaceId: "workspace_local",
    source: "telegram" as const,
    actorId: overrides?.actorId ?? "actor_owner",
    input: overrides?.input ?? "/model",
    attachments: [],
    conversationRef: {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    },
    imContext: {
      activationKind: "command_execution" as const,
      boundary: {
        boundaryKey: "private:42",
        conversationScope: "direct" as const,
        disclosureMode: "local_only" as const,
        targetConversationKeys: [],
        borrowedConversationKeys: [],
        transientBorrowed: false
      }
    }
  };
}

function createSharedTurnRequest(overrides?: Partial<{
  turnId: string;
  sessionId: string;
  actorId: string;
  input: string;
  conversationId: string;
}>): TurnRequest {
  const conversationId = overrides?.conversationId ?? "supergroup:-100123";
  return {
    turnId: overrides?.turnId ?? "turn_shared_001",
    sessionId: overrides?.sessionId ?? "session_group_a",
    workspaceId: "workspace_local",
    source: "telegram" as const,
    actorId: overrides?.actorId ?? "actor_member",
    input: overrides?.input ?? "/status",
    attachments: [],
    conversationRef: {
      accountId: "acct_bot",
      conversationId,
      peerId: "-100123",
      peerKind: "group" as const,
      baseConversationId: "supergroup:-100123"
    },
    imContext: {
      activationKind: "command_execution" as const,
      boundary: {
        boundaryKey: conversationId,
        conversationScope: "shared" as const,
        disclosureMode: "local_only" as const,
        targetConversationKeys: [],
        borrowedConversationKeys: [],
        transientBorrowed: false
      }
    }
  };
}

describe("createImCommandService", () => {
  it("renders shared-chat /status with truthful safe observability", async () => {
    const resolveCurrentModel = vi.fn(async () => createCurrentModel());
    const getStatusSnapshot = vi.fn(async () => createStatusSnapshot({
      warnings: ["shared-safe warning"],
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
        pendingControlCount: 3,
        usage: {
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
          cache: {
            state: "not_reported"
          },
          context: {
            state: "estimated",
            usedTokens: 14000,
            maxTokens: 128000
          }
        }
      },
      lastTurn: {
        state: "available",
        turnId: "turn_shared_001",
        status: "completed",
        usage: {
          inputTokens: 8,
          outputTokens: 2,
          totalTokens: 10,
          cache: {
            state: "available",
            readTokens: 5
          },
          context: {
            state: "available",
            usedTokens: 512,
            maxTokens: 128000
          }
        }
      }
    }));
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel,
      getStatusSnapshot
    } as never);

    const reply = await service.execute({
      turnRequest: createSharedTurnRequest(),
      commandIntent: {
        name: "status",
        args: [],
        options: {},
        rawText: "/status",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(reply.kind).toBe("reply_text");
    if (reply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${reply.kind}`);
    }
    expect(reply.replyText).toContain("conversation: supergroup:-100123");
    expect(reply.replyText).toContain("scope: shared");
    expect(reply.replyText).toContain("disclosureMode: local_only");
    expect(reply.replyText).toContain("personaScopeKind: none");
    expect(reply.replyText).toContain("trusted: yes");
    expect(reply.replyText).toContain("model: openai/gpt-5.4");
    expect(reply.replyText).toContain("config: source=endec_json version=1 loadedAt=2026-05-03T00:00:00.000Z");
    expect(reply.replyText).toContain("modelState: capability=chat execute=yes");
    expect(reply.replyText).toContain("warning: shared-safe warning");
    expect(reply.replyText).toContain("activeRun: status=queued");
    expect(reply.replyText).toContain("lastTurn: status=completed");
    expect(reply.replyText).toContain("usage: active run");
    expect(reply.replyText).toContain("tokens: in=20 out=4 total=24");
    expect(reply.replyText).toContain("cache: not reported");
    expect(reply.replyText).toContain("context: estimated 14000/128000");
    expect(reply.replyText).not.toContain("lastTurnTokens: in=8 out=2 total=10");
    expect(reply.replyText).not.toContain("lastTurnCache: read=5");
    expect(reply.replyText).not.toContain("lastTurnContext: 512/128000");
    expect(reply.replyText).not.toContain("baseUrl:");
    expect(reply.replyText).not.toContain("source=persisted_current_model");
    expect(reply.replyText).not.toContain("taskId=");
    expect(reply.replyText).not.toContain("runId=");
    expect(reply.replyText).not.toContain("turnId=");
    expect(resolveCurrentModel).not.toHaveBeenCalled();
    expect(getStatusSnapshot).toHaveBeenCalledWith({
      sessionId: "session_group_a",
      source: "telegram",
      accountId: "acct_bot",
      suppressSessionTruth: false
    });
  });

  it("renders owner-private /status with richer runtime detail", async () => {
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => undefined)
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel()),
      getStatusSnapshot: vi.fn(async () => createStatusSnapshot({
        currentModel: {
          providerId: "anthropic",
          modelId: "claude-sonnet-4.5",
          baseUrl: "https://api.anthropic.com",
          selectionSource: "env"
        },
        warningDetails: [
          {
            code: "provider_model_capability_mismatch",
            message: "configured model is not execute capable",
            providerId: "anthropic",
            modelId: "claude-sonnet-4.5"
          }
        ],
        activeRun: {
          state: "active",
          taskId: "task_owner_001",
          runId: "run_owner_001",
          runStatus: "running",
          attentionMode: "foreground_attached",
          latestSlice: {
            sliceId: "slice_owner_001",
            status: "running"
          },
          pendingControlCount: 2,
          lastHumanInputAt: "2026-05-02T12:00:00.000Z",
          usage: {
            inputTokens: 12,
            outputTokens: 5,
            totalTokens: 17,
            cache: {
              state: "available",
              readTokens: 3,
              writeTokens: 2
            },
            context: {
              state: "available",
              usedTokens: 2048,
              maxTokens: 200000
            }
          }
        },
        lastTurn: {
          state: "available",
          turnId: "turn_owner_001",
          status: "blocked",
          blockedBy: "permission"
        }
      }))
    } as never);

    const reply = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ input: "/status" }),
      commandIntent: {
        name: "status",
        args: [],
        options: {},
        rawText: "/status",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(reply).toMatchObject({ kind: "reply_text" });
    if (reply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${reply.kind}`);
    }
    expect(reply.replyText).toContain("conversation: private:42");
    expect(reply.replyText).toContain("scope: direct");
    expect(reply.replyText).toContain("disclosureMode: local_only");
    expect(reply.replyText).toContain("personaScopeKind: none");
    expect(reply.replyText).toContain("trusted: no");
    expect(reply.replyText).toContain("model: anthropic/claude-sonnet-4.5");
    expect(reply.replyText).toContain("config: source=endec_json version=1 loadedAt=2026-05-03T00:00:00.000Z");
    expect(reply.replyText).toContain("modelState: capability=chat execute=yes source=env providerConfigured=yes modelConfigured=yes");
    expect(reply.replyText).toContain("baseUrl: https://api.anthropic.com");
    expect(reply.replyText).toContain("warning[provider_model_capability_mismatch]: configured model is not execute capable");
    expect(reply.replyText).toContain("activeRun: status=running taskId=task_owner_001 runId=run_owner_001 attention=foreground_attached");
    expect(reply.replyText).toContain("activeRunSlice: sliceId=slice_owner_001 status=running");
    expect(reply.replyText).toContain("activeRunPendingControls: 2");
    expect(reply.replyText).toContain("activeRunLastHumanInputAt: 2026-05-02T12:00:00.000Z");
    expect(reply.replyText).toContain("lastTurn: status=blocked turnId=turn_owner_001 blockedBy=permission");
    expect(reply.replyText).toContain("usage: active run");
    expect(reply.replyText).toContain("tokens: in=12 out=5 total=17");
    expect(reply.replyText).toContain("cache: read=3 write=2");
    expect(reply.replyText).toContain("context: 2048/200000");
    expect(reply.replyText).not.toContain("lastTurnTokens: unavailable");
  });

  it("marks /status --all session metrics unknown instead of borrowing the owner DM session truth", async () => {
    const getStatusSnapshot = vi.fn(async () => createStatusSnapshot({
      activeRun: { state: "unknown" },
      lastTurn: { state: "unknown" }
    }));
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => undefined),
        listTrustedConversations: vi.fn(async () => [
          { conversationKey: "supergroup:-100123" },
          { conversationKey: "supergroup:-100456" }
        ])
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel()),
      getStatusSnapshot
    } as never);

    const reply = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ input: "/status --all" }),
      commandIntent: {
        name: "status",
        args: [],
        options: { all: true },
        rawText: "/status --all",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(reply).toMatchObject({ kind: "reply_text" });
    if (reply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${reply.kind}`);
    }
    expect(reply.replyText).toContain("scope: shared (borrowed)");
    expect(reply.replyText).toContain("disclosureMode: owner_cross_group");
    expect(reply.replyText).toContain("personaScopeKind: unknown");
    expect(reply.replyText).toContain("borrowedConversationKeys: supergroup:-100123, supergroup:-100456");
    expect(reply.replyText).toContain("activeRun: unknown");
    expect(reply.replyText).toContain("lastTurn: unknown");
    expect(reply.replyText).toContain("usage: unknown");
    expect(getStatusSnapshot).toHaveBeenCalledWith({
      sessionId: undefined,
      source: "telegram",
      accountId: "acct_bot",
      suppressSessionTruth: true
    });
  });

  it("marks borrowed /status --chat session metrics unknown when the target has no known session", async () => {
    const getStatusSnapshot = vi.fn(async () => createStatusSnapshot({
      activeRun: { state: "unknown" },
      lastTurn: { state: "unknown" }
    }));
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => undefined),
        listTrustedConversations: vi.fn(async () => [{ conversationKey: "supergroup:-100123", coverage: "descendants" }])
      } as never,
      resolveConversationTarget: vi.fn(async () => ({
        conversationKey: "supergroup:-100123:topic:77",
        conversationLabel: "release-room"
      })),
      resolveCurrentModel: vi.fn(async () => createCurrentModel()),
      getStatusSnapshot
    } as never);

    const reply = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ input: "/status --chat release-room" }),
      commandIntent: {
        name: "status",
        args: [],
        options: { chat: "release-room" },
        rawText: "/status --chat release-room",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(reply).toMatchObject({ kind: "reply_text" });
    if (reply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${reply.kind}`);
    }
    expect(reply.replyText).toContain("conversation: release-room");
    expect(reply.replyText).toContain("scope: shared (borrowed)");
    expect(reply.replyText).toContain("disclosureMode: owner_targeted");
    expect(reply.replyText).toContain("personaScopeKind: unknown");
    expect(reply.replyText).toContain("borrowedConversationKeys: supergroup:-100123:topic:77");
    expect(reply.replyText).toContain("activeRun: unknown");
    expect(reply.replyText).toContain("lastTurn: unknown");
    expect(reply.replyText).toContain("usage: unknown");
    expect(getStatusSnapshot).toHaveBeenCalledWith({
      sessionId: undefined,
      source: "telegram",
      accountId: "acct_bot",
      suppressSessionTruth: true
    });
  });

  it("allows owner-DM targeted recall but rejects cross-chat commands in shared conversations", async () => {
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" })),
        listTrustedConversations: vi.fn(async () => [{ conversationKey: "supergroup:-100123" }])
      } as never,
      resolveConversationTarget: vi.fn(async () => ({
        conversationKey: "supergroup:-100123",
        latestSessionId: "session_group_a",
        conversationLabel: "alpha"
      })),
      resolveCurrentModel: vi.fn(async () => createCurrentModel())
    } as never);

    const ownerDmTurnRequest = createOwnerDmTurnRequest({
      turnId: "turn_recall_001",
      input: "/recall --chat alpha what changed"
    });

    const allowed = await service.execute({
      turnRequest: ownerDmTurnRequest,
      commandIntent: {
        name: "recall",
        args: ["what", "changed"],
        options: { chat: "alpha" },
        rawText: "/recall --chat alpha what changed",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(allowed.kind).toBe("dispatch_turn");
    if (allowed.kind !== "dispatch_turn") {
      throw new Error(`expected dispatch_turn, received ${allowed.kind}`);
    }
    expect(allowed.turnRequest.input).toBe("what changed");
    expect(allowed.turnRequest.imContext?.boundary.disclosureMode).toBe("owner_targeted");
    expect(allowed.turnRequest.imContext?.boundary.targetConversationKeys).toEqual(["supergroup:-100123"]);

    await expect(service.execute({
      turnRequest: createSharedTurnRequest({
        turnId: "turn_recall_shared_001",
        input: "/recall --chat alpha what changed"
      }),
      commandIntent: {
        name: "recall",
        args: ["what", "changed"],
        options: { chat: "alpha" },
        rawText: "/recall --chat alpha what changed",
        helpRequested: false
      },
      conversationScope: "shared"
    })).resolves.toMatchObject({ kind: "reply_text", replyText: expect.stringContaining("owner private chat") });
  });

  it("uses /model as the owner-visible model and connection summary", async () => {
    const renderKey = vi.fn(async () => "key: sk-****9999 (source: persisted)");
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel({
        providerId: "anthropic",
        modelId: "claude-sonnet-4.5",
        baseUrl: "https://api.anthropic.com"
      })),
      providerControlService: {
        renderKey
      } as never
    } as never);

    const result = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_model_read_001", input: "/model" }),
      commandIntent: {
        name: "model",
        args: [],
        options: {},
        rawText: "/model",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(result).toMatchObject({ kind: "reply_text" });
    if (result.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${result.kind}`);
    }
    expect(result.replyText).toContain("model: claude-sonnet-4.5");
    expect(result.replyText).toContain("baseUrl: https://api.anthropic.com");
    expect(result.replyText).toContain("key: sk-****9999 (source: persisted)");
    expect(result.replyText).not.toContain("provider:");
    expect(result.replyText).not.toContain("anthropic/claude-sonnet-4.5");
    expect(renderKey).toHaveBeenCalledWith(false);
  });

  it("keeps /model read-only while showing masked connection detail in shared chats", async () => {
    const renderKey = vi.fn(async () => "key: sk-****9876 (source: env)");
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel({
        providerId: "local-default",
        modelId: "strong-default",
        baseUrl: "http://127.0.0.1:11434/v1"
      })),
      providerControlService: {
        renderKey
      } as never
    } as never);

    const result = await service.execute({
      turnRequest: createSharedTurnRequest({ turnId: "turn_model_shared_001", input: "/model" }),
      commandIntent: {
        name: "model",
        args: [],
        options: {},
        rawText: "/model",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(result).toMatchObject({
      kind: "reply_text",
      replyText: [
        "model: default",
        "baseUrl: http://127.0.0.1:11434/v1",
        "key: sk-****9876 (source: env)"
      ].join("\n")
    });
    if (result.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${result.kind}`);
    }
    expect(result.replyText).not.toContain("provider:");
    expect(result.replyText).not.toContain("strong-default");
    expect(result.replyText).not.toContain("cheap-default");
    expect(renderKey).toHaveBeenCalledWith(false);
  });

  it("renders /models only from runtime models.json entries and persists selections into provider control", async () => {
    const getProviderControl = vi.fn(async () => undefined);
    const upsertProviderControl = vi.fn(async () => undefined);
    const clearProviderSecret = vi.fn(async () => "already_missing" as const);
    const listSelectableModels = vi.fn(async () => [
      { providerId: "local-default", modelId: "strong-default", label: "local-default/default" },
      { providerId: "openai", modelId: "gpt-5.4", label: "GPT 5.4" }
    ]);
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" })),
        getProviderControl,
        upsertProviderControl,
        clearProviderSecret
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel()),
      listSelectableModels
    } as never);

    const picker = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_models_001", input: "/models" }),
      commandIntent: {
        name: "models" as never,
        args: [],
        options: {},
        rawText: "/models",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(picker).toMatchObject({
      kind: "reply_model_picker",
      replyText: expect.stringContaining("Choose the active model"),
      options: [
        { providerId: "local-default", modelId: "strong-default", label: "local-default/default" },
        { providerId: "openai", modelId: "gpt-5.4", label: "GPT 5.4" }
      ]
    });
    if (picker.kind !== "reply_model_picker") {
      throw new Error(`expected reply_model_picker, received ${picker.kind}`);
    }
    expect(picker.options.map((option) => option.label.toLowerCase())).not.toContain("strong default");
    expect(picker.options.map((option) => option.label.toLowerCase())).not.toContain("cheap default");

    const selection = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_models_002", input: "/models select openai/gpt-5.4" }),
      commandIntent: {
        name: "models" as never,
        subcommand: "select",
        args: ["openai/gpt-5.4"],
        options: {},
        rawText: "/models select openai/gpt-5.4",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(selection).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("openai/gpt-5.4")
    });
    expect(listSelectableModels).toHaveBeenCalledTimes(2);
    expect(getProviderControl).toHaveBeenCalledTimes(1);
    expect(upsertProviderControl).toHaveBeenCalledTimes(1);
    expect(upsertProviderControl).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot",
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrlOverride: undefined,
      updatedByActorId: "actor_owner"
    });
    expect(clearProviderSecret).not.toHaveBeenCalled();
  });

  it("clears provider-specific base URLs and secrets when /models select changes provider", async () => {
    const getProviderControl = vi.fn(async () => ({
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrlOverride: "https://custom.openai.example/v1"
    }));
    const upsertProviderControl = vi.fn(async () => undefined);
    const clearProviderSecret = vi.fn(async () => "cleared" as const);
    const resolveCurrentModel = vi.fn(async () => createCurrentModel());
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" })),
        getProviderControl,
        upsertProviderControl,
        clearProviderSecret
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel,
      listSelectableModels: vi.fn(async () => [
        { providerId: "anthropic", modelId: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" }
      ])
    } as never);

    await expect(service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_models_003", input: "/models select anthropic/claude-sonnet-4.5" }),
      commandIntent: {
        name: "models" as never,
        subcommand: "select",
        args: ["anthropic/claude-sonnet-4.5"],
        options: {},
        rawText: "/models select anthropic/claude-sonnet-4.5",
        helpRequested: false
      },
      conversationScope: "direct"
    })).resolves.toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("anthropic/claude-sonnet-4.5")
    });

    expect(resolveCurrentModel).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot"
    });
    expect(getProviderControl).toHaveBeenCalledTimes(1);
    expect(upsertProviderControl).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot",
      providerId: "anthropic",
      modelId: "claude-sonnet-4.5",
      baseUrlOverride: undefined,
      updatedByActorId: "actor_owner"
    });
    expect(clearProviderSecret).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot"
    });
  });

  it("treats env-derived providers as provider changes when only partial provider control is persisted", async () => {
    const getProviderControl = vi.fn(async () => ({
      baseUrlOverride: "https://custom.openai.example/v1"
    }));
    const upsertProviderControl = vi.fn(async () => undefined);
    const clearProviderSecret = vi.fn(async () => "cleared" as const);
    const resolveCurrentModel = vi.fn(async () => createCurrentModel({
      providerId: "openai",
      modelId: "gpt-5.4",
      selectionSource: "env"
    }));
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" })),
        getProviderControl,
        upsertProviderControl,
        clearProviderSecret
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel,
      listSelectableModels: vi.fn(async () => [
        { providerId: "anthropic", modelId: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" }
      ])
    } as never);

    await expect(service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_models_004", input: "/models select anthropic/claude-sonnet-4.5" }),
      commandIntent: {
        name: "models" as never,
        subcommand: "select",
        args: ["anthropic/claude-sonnet-4.5"],
        options: {},
        rawText: "/models select anthropic/claude-sonnet-4.5",
        helpRequested: false
      },
      conversationScope: "direct"
    })).resolves.toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("anthropic/claude-sonnet-4.5")
    });

    expect(resolveCurrentModel).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot"
    });
    expect(upsertProviderControl).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot",
      providerId: "anthropic",
      modelId: "claude-sonnet-4.5",
      baseUrlOverride: undefined,
      updatedByActorId: "actor_owner"
    });
    expect(clearProviderSecret).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot"
    });
  });

  it("keeps /models read-only outside the owner private chat", async () => {
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel()),
      listSelectableModels: vi.fn(async () => [
        { providerId: "openai", modelId: "gpt-5.4", label: "GPT 5.4" }
      ])
    } as never);

    const result = await service.execute({
      turnRequest: createSharedTurnRequest({ turnId: "turn_models_shared_001", input: "/models" }),
      commandIntent: {
        name: "models" as never,
        args: [],
        options: {},
        rawText: "/models",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(result).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("owner private chat")
    });
    if (result.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${result.kind}`);
    }
    expect(result.replyText).toContain("/model");
  });

  it("keeps /trust here scoped to the current thread boundary and reports thread-local status", async () => {
    const ensureTrustedConversation = vi.fn(async () => undefined);
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" })),
        ensureTrustedConversation,
        listTrustedConversations: vi.fn(async () => [])
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel())
    } as never);

    const turnRequest = createSharedTurnRequest({
      turnId: "turn_topic_001",
      sessionId: "session_topic_001",
      actorId: "actor_owner",
      input: "/trust here",
      conversationId: "supergroup:-100123:topic:77"
    });
    turnRequest.conversationRef!.parentConversationId = "supergroup:-100123";
    turnRequest.conversationRef!.threadId = "77";
    turnRequest.conversationRef!.topicId = "77";
    turnRequest.imContext!.boundary.boundaryKey = "supergroup:-100123:topic:77";

    const trustResult = await service.execute({
      turnRequest,
      commandIntent: {
        name: "trust",
        subcommand: "here",
        args: [],
        options: {},
        rawText: "/trust here",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    const statusResult = await service.execute({
      turnRequest: {
        ...turnRequest,
        input: "/status"
      },
      commandIntent: {
        name: "status",
        args: [],
        options: {},
        rawText: "/status",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(ensureTrustedConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationRef: expect.objectContaining({
        conversationId: "supergroup:-100123:topic:77"
      }),
      coverage: "exact"
    }));
    expect(trustResult).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("supergroup:-100123:topic:77")
    });
    expect(statusResult).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("conversation: supergroup:-100123:topic:77")
    });
  });

  it("rejects cross-conversation borrowing when the resolved target is not trusted", async () => {
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" })),
        listTrustedConversations: vi.fn(async () => [{ conversationKey: "supergroup:-100999", coverage: "descendants" }])
      } as never,
      resolveConversationTarget: vi.fn(async () => ({
        conversationKey: "supergroup:-100123",
        latestSessionId: "session_group_a",
        conversationLabel: "alpha"
      })),
      resolveCurrentModel: vi.fn(async () => createCurrentModel())
    } as never);

    const result = await service.execute({
      turnRequest: createOwnerDmTurnRequest({
        turnId: "turn_recall_untrusted_001",
        input: "/recall --chat alpha what changed"
      }),
      commandIntent: {
        name: "recall",
        args: ["what", "changed"],
        options: { chat: "alpha" },
        rawText: "/recall --chat alpha what changed",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(result).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("trusted shared conversation")
    });
  });

  it("does not widen exact trust coverage to descendant topics during targeted borrowing", async () => {
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" })),
        listTrustedConversations: vi.fn(async () => [{ conversationKey: "supergroup:-100123", coverage: "exact" }])
      } as never,
      resolveConversationTarget: vi.fn(async () => ({
        conversationKey: "supergroup:-100123:topic:77",
        latestSessionId: "session_group_topic_77",
        conversationLabel: "release-room"
      })),
      resolveCurrentModel: vi.fn(async () => createCurrentModel())
    } as never);

    const result = await service.execute({
      turnRequest: createOwnerDmTurnRequest({
        turnId: "turn_recall_exact_coverage_001",
        input: "/recall --chat release-room what changed"
      }),
      commandIntent: {
        name: "recall",
        args: ["what", "changed"],
        options: { chat: "release-room" },
        rawText: "/recall --chat release-room what changed",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(result).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("trusted shared conversation")
    });
  });

  it("hides /provider and /inspect from the visible help surfaces", async () => {
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel())
    } as never);

    const ownerHelp = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_help_owner_dm_001", input: "/help" }),
      commandIntent: {
        name: "help",
        args: [],
        options: {},
        rawText: "/help",
        helpRequested: false
      },
      conversationScope: "direct"
    });
    const sharedHelp = await service.execute({
      turnRequest: createSharedTurnRequest({ turnId: "turn_help_shared_001", input: "/help" }),
      commandIntent: {
        name: "help",
        args: [],
        options: {},
        rawText: "/help",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(ownerHelp).toMatchObject({ kind: "reply_text" });
    if (ownerHelp.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${ownerHelp.kind}`);
    }
    expect(ownerHelp.replyText).toContain("/model");
    expect(ownerHelp.replyText).toContain("/models");
    expect(ownerHelp.replyText).toContain("/reload");
    expect(ownerHelp.replyText).toContain("/restart");
    expect(ownerHelp.replyText).not.toContain("/provider");
    expect(ownerHelp.replyText).not.toContain("/inspect");
    expect(sharedHelp).toMatchObject({ kind: "reply_text" });
    if (sharedHelp.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${sharedHelp.kind}`);
    }
    expect(sharedHelp.replyText).not.toContain("/provider");
    expect(sharedHelp.replyText).not.toContain("/inspect");
    expect(sharedHelp.replyText).not.toContain("/models");
  });

  it("keeps targeted /help inspect owner-private while steering owners to natural language", async () => {
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel())
    } as never);

    await expect(service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_help_inspect_owner_dm_001", input: "/help inspect" }),
      commandIntent: {
        name: "help",
        args: ["inspect"],
        options: {},
        rawText: "/help inspect",
        helpRequested: false
      },
      conversationScope: "direct"
    })).resolves.toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("直接告诉我你想检查什么")
    });

    await expect(service.execute({
      turnRequest: createSharedTurnRequest({ turnId: "turn_help_inspect_shared_001", input: "/help inspect" }),
      commandIntent: {
        name: "help",
        args: ["inspect"],
        options: {},
        rawText: "/help inspect",
        helpRequested: false
      },
      conversationScope: "shared"
    })).resolves.toMatchObject({
      kind: "reply_text",
      replyText: "/inspect is only available in the owner private chat."
    });
  });

  it("keeps /inspect owner-private, but deprecates the root command in favor of natural language", async () => {
    const inspect = vi.fn(async () => "config: masked");
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel()),
      selfInspectionService: {
        inspect
      }
    } as never);

    const guidance = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_inspect_owner_dm_001", input: "/inspect" }),
      commandIntent: {
        name: "inspect" as never,
        args: [],
        options: {},
        rawText: "/inspect",
        helpRequested: false
      },
      conversationScope: "direct"
    });
    const allowed = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_inspect_owner_dm_002", input: "/inspect config" }),
      commandIntent: {
        name: "inspect" as never,
        subcommand: "config",
        args: [],
        options: {},
        rawText: "/inspect config",
        helpRequested: false
      },
      conversationScope: "direct"
    });
    const revealed = await service.execute({
      turnRequest: createOwnerDmTurnRequest({
        turnId: "turn_inspect_reveal_owner_dm_001",
        input: "/inspect config --reveal"
      }),
      commandIntent: {
        name: "inspect" as never,
        subcommand: "config",
        args: [],
        options: { reveal: true },
        rawText: "/inspect config --reveal",
        helpRequested: false
      },
      conversationScope: "direct"
    });
    const rejected = await service.execute({
      turnRequest: createSharedTurnRequest({ turnId: "turn_inspect_shared_001", input: "/inspect docs PRODUCT.md" }),
      commandIntent: {
        name: "inspect" as never,
        subcommand: "docs",
        args: ["PRODUCT.md"],
        options: {},
        rawText: "/inspect docs PRODUCT.md",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(guidance).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("直接告诉我你想检查什么")
    });
    expect(allowed).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("config: masked")
    });
    expect(revealed).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("config: masked")
    });
    expect(rejected).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("owner private chat")
    });
    expect(inspect).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: "telegram",
      accountId: "acct_bot",
      subcommand: "config",
      args: []
    }));
    expect(inspect).toHaveBeenNthCalledWith(2, expect.objectContaining({
      subcommand: "config",
      args: ["--reveal"]
    }));
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("keeps /provider owner-DM-only while deprecating the root summary in favor of /model", async () => {
    const executeProviderCommand = vi.fn(async ({ allowReveal }: { allowReveal: boolean }) =>
      allowReveal ? "key: sk-owner-secret-1234" : "baseUrl: https://api.openai.com/v1"
    );
    const renderKey = vi.fn(async () => "key: sk-****1234 (source: persisted)");
    const service = createImCommandService({
      accessStore: {
        inspectOwnerBinding: vi.fn(async () => ownerBinding),
        matchTrustedConversation: vi.fn(async () => ({ trustId: "trust_001" }))
      } as never,
      resolveConversationTarget: vi.fn(),
      resolveCurrentModel: vi.fn(async () => createCurrentModel()),
      providerControlService: {
        execute: executeProviderCommand,
        renderKey
      } as never
    } as never);

    const allowed = await service.execute({
      turnRequest: createOwnerDmTurnRequest({ turnId: "turn_provider_owner_dm", input: "/provider" }),
      commandIntent: {
        name: "provider" as never,
        args: [],
        options: {},
        rawText: "/provider",
        helpRequested: false
      },
      conversationScope: "direct"
    });
    const revealed = await service.execute({
      turnRequest: createOwnerDmTurnRequest({
        turnId: "turn_provider_owner_dm_reveal",
        input: "/provider key show --reveal"
      }),
      commandIntent: {
        name: "provider" as never,
        subcommand: "key",
        args: ["show"],
        options: { reveal: true },
        rawText: "/provider key show --reveal",
        helpRequested: false
      },
      conversationScope: "direct"
    });
    const rejectedShared = await service.execute({
      turnRequest: createSharedTurnRequest({ turnId: "turn_provider_shared_reject", input: "/provider" }),
      commandIntent: {
        name: "provider" as never,
        args: [],
        options: {},
        rawText: "/provider",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    expect(allowed).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("已合并到 /model")
    });
    if (allowed.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${allowed.kind}`);
    }
    expect(allowed.replyText).toContain("model: gpt-5.4");
    expect(allowed.replyText).toContain("baseUrl: https://api.openai.com/v1");
    expect(allowed.replyText).toContain("key: sk-****1234 (source: persisted)");
    expect(revealed).toMatchObject({
      kind: "reply_text",
      replyText: "key: sk-owner-secret-1234"
    });
    expect(rejectedShared).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("owner private chat")
    });
    expect(executeProviderCommand).toHaveBeenCalledTimes(1);
    expect(executeProviderCommand).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      accountId: "acct_bot",
      updatedByActorId: "actor_owner",
      allowReveal: true,
      commandIntent: expect.objectContaining({
        subcommand: "key",
        options: { reveal: true }
      })
    }));
    expect(renderKey).toHaveBeenCalledWith(false);
  });
});
