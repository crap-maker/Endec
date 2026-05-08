import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { EndecApp } from "@endec/app";
import { createDefaultApp, runCli } from "./main";

const execFileAsync = promisify(execFile);

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(fullPath);
      }
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [fullPath] : [];
    })
  );

  return files.flat();
}

async function withWorkingDirectory<T>(cwd: string, run: () => Promise<T>) {
  const previousCwd = process.cwd();
  process.chdir(cwd);

  try {
    return await run();
  } finally {
    process.chdir(previousCwd);
  }
}

async function withEnvValue<T>(key: string, value: string | undefined, run: () => Promise<T>) {
  const previousValue = process.env[key];

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }
}

async function createCliRootFixture(input: {
  packageJsonName?: string;
  createDataDir?: boolean;
  composeBody?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "endec-cli-root-"));

  if (input.packageJsonName) {
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: input.packageJsonName }, null, 2)}\n`);
  }

  if (input.createDataDir) {
    await mkdir(join(root, "data"), { recursive: true });
  }

  if (input.composeBody) {
    await writeFile(join(root, "docker-compose.yml"), input.composeBody);
  }

  return root;
}

type TurnResult = Awaited<ReturnType<EndecApp["shell"]["executeTurn"]>>;
type StatusResult = Awaited<ReturnType<EndecApp["operator"]["getStatus"]>>;
type RecoverySnapshotResult = NonNullable<Awaited<ReturnType<EndecApp["operator"]["getRecoverySnapshot"]>>>;
type SessionListResult = Awaited<ReturnType<EndecApp["operator"]["listSessions"]>>;
type SessionBrowseResult = Awaited<ReturnType<EndecApp["operator"]["browseSessionHistory"]>>;
type SessionSearchResult = Awaited<ReturnType<EndecApp["operator"]["searchSessionEvents"]>>;
type SessionLookupResult = Awaited<ReturnType<EndecApp["operator"]["lookupSessionEvent"]>>;
type CorrectionInspectionResult = Awaited<ReturnType<EndecApp["operator"]["inspectCorrectionSurface"]>>;
type CorrectionApplyResult = Awaited<ReturnType<EndecApp["operator"]["applyCorrection"]>>;
type OperatorTurnInspectionResult = NonNullable<Awaited<ReturnType<EndecApp["operator"]["inspectOperatorTurn"]>>>;
type InspectOwnerBindingResult = Awaited<ReturnType<EndecApp["operator"]["inspectOwnerBinding"]>>;
type ListPairClaimsResult = Awaited<ReturnType<EndecApp["operator"]["listPairClaims"]>>;
type ApprovePairClaimResult = Awaited<ReturnType<EndecApp["operator"]["approvePairClaim"]>>;
type ResetOwnerBindingResult = Awaited<ReturnType<EndecApp["operator"]["resetOwnerBinding"]>>;
type ListTrustedConversationsResult = Awaited<ReturnType<EndecApp["operator"]["listTrustedConversations"]>>;
type RevokeTrustedConversationResult = Awaited<ReturnType<EndecApp["operator"]["revokeTrustedConversation"]>>;

function createTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
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
    checkpointRef: "checkpoint_001",
    ...overrides
  };
}

function createStatusResult(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    productName: "endec",
    dataDir: "/tmp/endec",
    defaultProviderId: "provider.default",
    defaultModelId: "model.default",
    capabilities: {
      execute: true,
      history: true,
      artifactRead: true,
      evidenceRead: true
    },
    currentModel: {
      providerId: "provider.default",
      modelId: "model.default",
      baseUrl: "http://provider.default/v1",
      modelCapability: "chat",
      executeCapable: true,
      selectionSource: "catalog",
      providerConfigured: false,
      modelConfigured: false
    },
    config: {
      source: "endec_json",
      loadedAt: "2026-05-03T00:00:00.000Z",
      schemaVersion: 1
    },
    warningDetails: [],
    warnings: [],
    activeRun: { state: "none" },
    lastTurn: { state: "none" },
    ...overrides
  };
}

function createCorrectionInspectionResult(overrides: Partial<CorrectionInspectionResult> = {}): CorrectionInspectionResult {
  return {
    sessionId: "session_001",
    workspaceId: "workspace_local",
    typedMemory: [],
    ...overrides
  };
}

function createCorrectionApplyResult(overrides: Partial<CorrectionApplyResult> = {}): CorrectionApplyResult {
  return {
    correctionId: "correction_001",
    target: {
      kind: "working_set",
      sessionId: "session_001",
      workspaceId: "workspace_local"
    },
    applied: true,
    appliedAt: "2026-04-10T10:00:00.000Z",
    summary: "correction applied",
    ...overrides
  };
}

function createOperatorTurnInspectionResult(overrides: Partial<OperatorTurnInspectionResult> = {}): OperatorTurnInspectionResult {
  return {
    target: {
      sessionId: "session_001",
      workspaceId: "workspace_local",
      actorId: "actor_001",
      turnId: "turn_001",
      frameRef: "frame:turn_001"
    },
    summary: {
      state: "blocked",
      headline: "Turn turn_001 is blocked by permission."
    },
    explanation: {
      headline: "Permission approval is required before continuation.",
      summary: "The shared operator contract reports an approval-required continuation with correction context.",
      nextActions: [
        {
          code: "approve-pending-decision",
          kind: "approve",
          summary: "Approve pending decision decision_001.",
          targetRef: "decision_001",
          riskLevel: "medium",
          requiresApproval: true
        },
        {
          code: "inspect-correction-targets",
          kind: "inspect",
          summary: "Inspect 1 correction target before resuming.",
          targetRef: "correction",
          relatedRefs: ["ws_001"]
        }
      ],
      explanations: [
        {
          code: "truth-source",
          summary: "Capability facts come from AuthoritativeTurnTruth.",
          subjectRef: "truth"
        }
      ]
    },
    truth: {
      schemaVersion: 1,
      contractVersion: "ws6.authoritative-turn-truth.v1",
      source: "cli",
      channel: "cli",
      mode: "act",
      replyPath: "blocked",
      capabilityTruth: {
        visibleToolNames: ["read", "write_file"],
        guaranteedToolNames: ["read"],
        guaranteedCapabilities: ["read_files"],
        approvalRequiredCapabilities: ["write_file"],
        notGuaranteedCapabilities: ["deploy"],
        actionAuthorizations: [
          {
            actionClass: "write_file",
            toolName: "write_file",
            authorizationLevel: "approval-required",
            boundaryReason: "write_file requires approval",
            examples: ["edit files"]
          }
        ]
      },
      constraints: [],
      boundary: {
        workspace: {
          root: "/workspace",
          kind: "workspace_root",
          summary: "workspace_local at /workspace"
        }
      },
      antiDriftRules: []
    },
    context: {
      observability: {} as OperatorTurnInspectionResult["context"]["observability"],
      summary: {
        headline: "Operator context is blocked.",
        truthSummary: "1 guaranteed tool; 1 approval-required capability; 1 not-guaranteed capability.",
        continuitySummary: "activeTask=full; workingSet=skeleton; recentHistory=partial.",
        durableMemorySummary: "2/3 durable memory items selected.",
        truncationSummary: "1 context item dropped by budget.",
        driftDiagnosticsSummary: "No drift diagnostics reported.",
        continuationSummary: "blocked continuation via blocked; allowed actions: approve, deny.",
        correctionSummary: "working set correction target available.",
        selectedBy: ["active_task", "working_set"]
      }
    },
    continuation: {
      state: "blocked",
      replyPath: "blocked",
      allowedActions: [
        {
          code: "approve-pending-decision",
          kind: "approve",
          summary: "Approve pending decision decision_001.",
          targetRef: "decision_001"
        }
      ],
      blockedBy: "permission",
      waitingReason: "write_file requires approval",
      pendingExecutionId: "pending_001",
      frameRef: "frame:turn_001",
      checkpointRef: "checkpoint:turn_001"
    },
    correction: {
      available: true,
      typedMemoryTargetCount: 0,
      recommendedTargets: [
        {
          targetId: "ws_001",
          targetKind: "working_set",
          summary: "Working set can be refreshed.",
          reason: "Continuity observability exposed a stale working set.",
          recommendedOperation: "refresh_working_set"
        }
      ]
    },
    ...overrides
  };
}

function createDirectConversationRef() {
  return {
    accountId: "acct_bot",
    conversationId: "dm:owner_user",
    peerId: "owner_user",
    peerKind: "dm" as const
  };
}

function createSharedConversationRef() {
  return {
    accountId: "acct_bot",
    conversationId: "group:chat_100:thread:thread_1",
    peerId: "chat_100",
    peerKind: "group" as const,
    baseConversationId: "group:chat_100",
    parentConversationId: "group:chat_100",
    threadId: "thread_1"
  };
}

function createInspectOwnerBindingResult(overrides: Partial<InspectOwnerBindingResult> = {}): InspectOwnerBindingResult {
  return {
    state: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerBindingId: "owner_binding_001",
      status: "bound",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:01:00.000Z"
    },
    ownerBinding: {
      ownerBindingId: "owner_binding_001",
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerSubjectRef: "telegram-user:42",
      ownerActorId: "actor_owner_001",
      pairedConversationRef: createDirectConversationRef(),
      consumedClaimId: "claim_001",
      status: "active",
      boundAt: "2026-04-29T00:01:00.000Z",
      approvedByOperatorId: "operator_alpha"
    },
    ownerPreferences: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerBindingId: "owner_binding_001",
      ownerActorId: "actor_owner_001",
      ownerDisplayName: "Chiyo",
      assistantDisplayName: "Momo",
      timezone: "Asia/Shanghai",
      createdAt: "2026-04-29T00:02:00.000Z",
      updatedAt: "2026-04-29T00:02:30.000Z"
    },
    resolvedOwnerPreferences: {
      ownerDisplayName: "Chiyo",
      assistantDisplayName: "Momo",
      timezone: "Asia/Shanghai",
      timezoneSource: "owner_preference"
    },
    ownerInitState: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerBindingId: "owner_binding_001",
      status: "completed",
      promptVersion: 1,
      promptSentAt: "2026-04-29T00:02:00.000Z",
      completionReason: "fields_captured",
      completedAt: "2026-04-29T00:03:00.000Z",
      updatedAt: "2026-04-29T00:03:00.000Z"
    },
    ...overrides
  };
}

function createListPairClaimsResult(overrides: Partial<ListPairClaimsResult> = {}): ListPairClaimsResult {
  return {
    state: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      status: "unbound",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:30.000Z"
    },
    claims: [
      {
        claimId: "claim_001",
        source: "telegram",
        accountId: "acct_bot",
        ownerGeneration: 0,
        requesterSubjectRef: "telegram-user:42",
        requesterActorId: "actor_owner_001",
        requestWorkspaceId: "workspace_local",
        requestSessionId: "session_pair_001",
        requestConversationRef: createDirectConversationRef(),
        pairCode: "ABCD1234",
        status: "pending",
        expiresAt: "2026-04-29T00:10:00.000Z",
        createdAt: "2026-04-29T00:00:00.000Z"
      }
    ],
    ...overrides
  };
}

function createApprovePairClaimResult(overrides: Partial<ApprovePairClaimResult> = {}): ApprovePairClaimResult {
  return {
    outcome: "approved",
    state: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerBindingId: "owner_binding_001",
      status: "bound",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:01:00.000Z"
    },
    ownerBinding: createInspectOwnerBindingResult().ownerBinding,
    consumedClaim: {
      ...createListPairClaimsResult().claims[0]!,
      status: "consumed",
      consumedAt: "2026-04-29T00:01:00.000Z",
      approvedByOperatorId: "operator_alpha"
    },
    supersededClaimCount: 0,
    pairingSuccessNoticeStatus: "enqueued",
    ...overrides
  };
}

function createResetOwnerBindingResult(overrides: Partial<ResetOwnerBindingResult> = {}): ResetOwnerBindingResult {
  return {
    outcome: "reset",
    state: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 1,
      status: "unbound",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:02:00.000Z"
    },
    revokedOwnerBinding: {
      ...createInspectOwnerBindingResult().ownerBinding!,
      status: "revoked",
      revokedAt: "2026-04-29T00:02:00.000Z",
      revokedReason: "owner reset",
      revokedByOperatorId: "operator_alpha"
    },
    revokedTrustCount: 1,
    supersededClaimCount: 2,
    newOwnerGeneration: 1,
    ...overrides
  };
}

function createListTrustedConversationsResult(
  overrides: Partial<ListTrustedConversationsResult> = {}
): ListTrustedConversationsResult {
  return {
    state: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerBindingId: "owner_binding_001",
      status: "bound",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:01:30.000Z"
    },
    bindings: [
      {
        trustId: "trust_001",
        source: "telegram",
        accountId: "acct_bot",
        ownerGeneration: 0,
        conversationRef: createSharedConversationRef(),
        conversationKey: "group:chat_100",
        coverage: "descendants",
        grantKind: "owner_auto",
        grantedByOwnerBindingId: "owner_binding_001",
        status: "active",
        grantedAt: "2026-04-29T00:01:30.000Z"
      }
    ],
    ...overrides
  };
}

function createRevokeTrustedConversationResult(
  overrides: Partial<RevokeTrustedConversationResult> = {}
): RevokeTrustedConversationResult {
  return {
    outcome: "revoked",
    state: {
      source: "telegram",
      accountId: "acct_bot",
      ownerGeneration: 0,
      ownerBindingId: "owner_binding_001",
      status: "bound",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:02:00.000Z"
    },
    revokedBinding: {
      ...createListTrustedConversationsResult().bindings[0]!,
      status: "revoked",
      revokedAt: "2026-04-29T00:02:00.000Z",
      revokedReason: "manual revoke",
      revokedByOperatorId: "operator_alpha"
    },
    affectedOutboundLegality: true,
    ...overrides
  };
}

function createSessionListResult(overrides: Partial<SessionListResult> = {}): SessionListResult {
  return {
    items: [
      {
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "chat",
        status: "active",
        currentGoal: "recover the latest blocked turn",
        lastTurnAt: "2026-04-10T10:00:00.000Z",
        createdAt: "2026-04-10T09:00:00.000Z"
      }
    ],
    ...overrides
  };
}

function createSessionBrowseResult(overrides: Partial<SessionBrowseResult> = {}): SessionBrowseResult {
  return {
    items: [
      {
        sessionId: "session_001",
        turnId: "turn_001",
        eventId: "event_002",
        eventKind: "assistant_message",
        createdAt: "2026-04-10T10:00:05.000Z",
        summary: "Assistant located the blocked turn.",
        sourceRefs: ["memory:write-001"]
      }
    ],
    ...overrides
  };
}

function createSessionSearchResult(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    hits: [
      {
        sessionId: "session_001",
        turnId: "turn_001",
        eventId: "event_002",
        eventKind: "assistant_message",
        createdAt: "2026-04-10T10:00:05.000Z",
        summary: "Assistant located the blocked turn.",
        snippet: "...located the blocked turn and recovery checkpoint...",
        sourceRefs: ["memory:write-001"]
      }
    ],
    ...overrides
  };
}

function createSessionLookupResult(overrides: Partial<SessionLookupResult> = {}): SessionLookupResult {
  return {
    entry: {
      sessionId: "session_001",
      turnId: "turn_001",
      eventId: "event_002",
      eventKind: "assistant_message",
      createdAt: "2026-04-10T10:00:05.000Z",
      summary: "Assistant located the blocked turn.",
      sourceRefs: ["memory:write-001"]
    },
    ...overrides
  };
}

function createRecoverySnapshotResult(overrides: Partial<RecoverySnapshotResult> = {}): RecoverySnapshotResult {
  return {
    schemaVersion: 1,
    contractVersion: "ws5.operator-recovery-snapshot.v1",
    runtimeAwarenessContractVersion: "ws5.runtime-self-awareness.v1",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    recoverable: true,
    hasPendingExecution: true,
    turnId: "turn_001",
    frameRef: "frame:turn_001",
    pendingExecutionId: "pending:turn_001",
    blockedBy: "permission",
    waitingReason: "permission",
    state: "awaiting_permission",
    allowedActions: ["approve", "deny", "resume", "cancel"],
    pendingApprovalRef: "decision_001",
    pendingDecision: {
      decisionId: "decision_001",
      behavior: "ask",
      scope: "once",
      reasonCode: "tool_requires_approval",
      reasonText: "write_file requires approval",
      issuedAt: "2026-04-10T10:00:00.000Z",
      requestedBy: "turn_001"
    },
    checkpointRef: "checkpoint:turn_001",
    contextSummary: {
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      mode: "act",
      currentGoal: "recover the blocked turn",
      activeTaskIds: ["task_001"],
      recentTurnRefs: ["turn_prev", "turn_001"]
    },
    runtimeSelfAwareness: {
      schemaVersion: 1,
      contractVersion: "ws5.runtime-self-awareness.v1",
      source: "cli",
      channel: "cli",
      mode: "act",
      exposedToolNames: ["read", "bash"],
      replyPath: "blocked",
      constraints: []
    },
    ...overrides
  };
}

function createAppStub(input?: {
  shell?: Partial<EndecApp["shell"]>;
  operator?: Partial<EndecApp["operator"]>;
}): EndecApp {
  return {
    shell: {
      executeTurn: vi.fn(async () => createTurnResult()),
      resumeTurn: vi.fn(async () => createTurnResult()),
      resolveApproval: vi.fn(async () => createTurnResult()),
      cancelInflightTurn: vi.fn(async () => createTurnResult()),
      submitExecutionControl: vi.fn(async () => createTurnResult()),
      ...input?.shell
    },
    operator: {
      getStatus: vi.fn(async () => createStatusResult()),
      inspectOwnerBinding: vi.fn(async () => createInspectOwnerBindingResult()),
      listPairClaims: vi.fn(async () => createListPairClaimsResult()),
      approvePairClaim: vi.fn(async () => createApprovePairClaimResult()),
      resetOwnerBinding: vi.fn(async () => createResetOwnerBindingResult()),
      listTrustedConversations: vi.fn(async () => createListTrustedConversationsResult()),
      revokeTrustedConversation: vi.fn(async () => createRevokeTrustedConversationResult()),
      getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotResult()),
      getRuntimeSelfAwareness: vi.fn(async () => createRecoverySnapshotResult().runtimeSelfAwareness ?? null),
      inspectOperatorTurn: vi.fn(async () => null),
      listBackgroundTasks: vi.fn(async () => []),
      inspectBackgroundTask: vi.fn(async () => null),
      listBackgroundOutbox: vi.fn(async () => []),
      cancelBackgroundTask: vi.fn(async () => ({ taskId: "task_001", status: "not_found" as const })),
      inspectCorrectionSurface: vi.fn(async () => createCorrectionInspectionResult()),
      applyCorrection: vi.fn(async () => createCorrectionApplyResult()),
      listSessions: vi.fn(async () => createSessionListResult()),
      browseSessionHistory: vi.fn(async () => createSessionBrowseResult()),
      searchSessionEvents: vi.fn(async () => createSessionSearchResult()),
      lookupSessionEvent: vi.fn(async () => createSessionLookupResult()),
      getArtifactPreview: vi.fn(),
      readArtifact: vi.fn(),
      searchEvidence: vi.fn(),
      ...input?.operator
    },
    im: {
      resolveSessionId: vi.fn(async () => "session_001"),
      resolveActorId: vi.fn(async () => "actor_001"),
      executeCommand: vi.fn(async () => ({ kind: "reply_text" as const, replyText: "ok" })),
      recordPassiveIngress: vi.fn(async () => undefined),
      recordConversationActivity: vi.fn(async () => ({
        source: "telegram" as const,
        accountId: "acct_bot",
        conversationKey: "conversation_001",
        observedAt: "2026-05-01T00:00:00.000Z",
        conversationLabel: "conversation_001",
        latestSessionId: "session_001"
      })),
      evaluateInboundAdmission: vi.fn(async () => ({
        outcome: "dispatch_turn" as const,
        expectsUserVisibleReply: true
      })),
      applyConversationLifecycleEvent: vi.fn(async () => undefined),
      evaluateOutboundConversationLegality: vi.fn(async () => ({
        status: "allowed" as const,
        reason: "owner_direct" as const,
        ownerGeneration: 0,
        ownerBindingId: "owner_binding_001"
      }))
    },
    background: {
      runWorkerOnce: vi.fn(async () => ({ status: "idle" as const }))
    }
  };
}

describe("createDefaultApp", () => {
  it("uses the shared repo-root data directory by default when cwd is an endec checkout", async () => {
    const root = await createCliRootFixture({
      packageJsonName: "endec",
      createDataDir: true
    });
    const app = createAppStub();
    const createEndecApp = vi.fn(() => app);

    const result = await withEnvValue("ENDEC_DATA_DIR", undefined, () =>
      withWorkingDirectory(root, () =>
        createDefaultApp({
          loadCreateEndecApp: async () => ({ createEndecApp })
        })
      )
    );

    expect(result).toBe(app);
    expect(createEndecApp).toHaveBeenCalledWith({
      dataDir: join(root, "data"),
      env: process.env
    });
  });

  it("uses the shared deployment data directory when compose maps ./data:/data", async () => {
    const root = await createCliRootFixture({
      composeBody: [
        "services:",
        "  telegram:",
        "    environment:",
        "      ENDEC_DATA_DIR: /data",
        "    volumes:",
        "      - ./data:/data"
      ].join("\n")
    });
    const app = createAppStub();
    const createEndecApp = vi.fn(() => app);

    const result = await withEnvValue("ENDEC_DATA_DIR", undefined, () =>
      withWorkingDirectory(root, () =>
        createDefaultApp({
          loadCreateEndecApp: async () => ({ createEndecApp })
        })
      )
    );

    expect(result).toBe(app);
    expect(createEndecApp).toHaveBeenCalledWith({
      dataDir: join(root, "data"),
      env: process.env
    });
  });

  it("uses the repo-root data directory even when it does not exist yet", async () => {
    const root = await createCliRootFixture({
      packageJsonName: "endec"
    });
    const app = createAppStub();
    const createEndecApp = vi.fn(() => app);

    const result = await withEnvValue("ENDEC_DATA_DIR", undefined, () =>
      withWorkingDirectory(root, () =>
        createDefaultApp({
          loadCreateEndecApp: async () => ({ createEndecApp })
        })
      )
    );

    expect(result).toBe(app);
    expect(createEndecApp).toHaveBeenCalledWith({
      dataDir: join(root, "data"),
      env: process.env
    });
  });

  it("prefers ENDEC_DATA_DIR over deployment-root data detection", async () => {
    const root = await createCliRootFixture({
      packageJsonName: "endec",
      createDataDir: true
    });
    const explicitDataDir = join(root, "override-data");
    const app = createAppStub();
    const createEndecApp = vi.fn(() => app);

    const result = await withEnvValue("ENDEC_DATA_DIR", explicitDataDir, () =>
      withWorkingDirectory(root, () =>
        createDefaultApp({
          loadCreateEndecApp: async () => ({ createEndecApp })
        })
      )
    );

    expect(result).toBe(app);
    expect(createEndecApp).toHaveBeenCalledWith({
      dataDir: explicitDataDir,
      env: process.env
    });
  });

  it("falls back to cwd/.endec outside deployment roots", async () => {
    const root = await createCliRootFixture({});
    const app = createAppStub();
    const createEndecApp = vi.fn(() => app);

    const result = await withEnvValue("ENDEC_DATA_DIR", undefined, () =>
      withWorkingDirectory(root, () =>
        createDefaultApp({
          loadCreateEndecApp: async () => ({ createEndecApp })
        })
      )
    );

    expect(result).toBe(app);
    expect(createEndecApp).toHaveBeenCalledWith({
      dataDir: join(root, ".endec"),
      env: process.env
    });
  });

  it("loads and creates the real app through @endec/app", async () => {
    const app = createAppStub();
    const createEndecApp = vi.fn(() => app);

    const result = await createDefaultApp({
      dataDir: "/data/endec",
      loadCreateEndecApp: async () => ({ createEndecApp })
    });

    expect(result).toBe(app);
    expect(createEndecApp).toHaveBeenCalledWith({
      dataDir: "/data/endec",
      env: process.env
    });
  });
});

describe("runCli", () => {
  it("returns non-zero and prints a clear error when default app loading fails", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runCli({
      argv: ["node", "endec", "status"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: () =>
        createDefaultApp({
          dataDir: "/data/endec",
          loadCreateEndecApp: async () => {
            throw new Error("import exploded");
          }
        }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: failed to initialize the application for this CLI command.\n");
    expect(stderr).toHaveBeenCalledWith("The real @endec/app runtime could not be loaded, so status cannot run.\n");
    expect(stderr).toHaveBeenCalledWith("dataDir: /data/endec\n");
    expect(stderr).toHaveBeenCalledWith("cause: import exploded\n");
  });

  it("returns non-zero and prints a clear error when default app creation fails", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runCli({
      argv: ["node", "endec", "execute", "hello"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: () =>
        createDefaultApp({
          dataDir: "/data/endec",
          loadCreateEndecApp: async () => ({
            createEndecApp() {
              throw new Error("create exploded");
            }
          })
        }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: failed to initialize the application for this CLI command.\n");
    expect(stderr).toHaveBeenCalledWith("The real @endec/app runtime could not be created, so execute cannot run.\n");
    expect(stderr).toHaveBeenCalledWith("dataDir: /data/endec\n");
    expect(stderr).toHaveBeenCalledWith("cause: create exploded\n");
  });

  it("reads status from app.operator.getStatus", async () => {
    const stdout = vi.fn();
    const app = createAppStub({
      operator: {
        getStatus: vi.fn(async () =>
          createStatusResult({
            dataDir: "/data/endec",
            defaultProviderId: "provider.stub",
            defaultModelId: "model.stub",
            currentModel: {
              providerId: "provider.stub",
              modelId: "model.stub",
              baseUrl: "http://provider.stub/v1",
              modelCapability: "chat",
              executeCapable: true,
              selectionSource: "catalog",
              providerConfigured: false,
              modelConfigured: false
            },
            warningDetails: [
              {
                code: "default_model_unconfigured",
                message: "set ENDEC_PROVIDER_MODEL to avoid placeholder defaults",
                providerId: "provider.stub",
                modelId: "model.stub"
              }
            ],
            warnings: ["set ENDEC_PROVIDER_MODEL to avoid placeholder defaults"],
            activeRun: {
              state: "active",
              taskId: "task_cli_001",
              runId: "run_cli_001",
              runStatus: "running",
              attentionMode: "background_detached",
              latestSlice: {
                sliceId: "slice_cli_001",
                runId: "run_cli_001",
                taskId: "task_cli_001",
                sliceNo: 1,
                triggerKind: "initial",
                lane: "foreground",
                status: "running",
                createdAt: "2026-05-03T00:00:00.000Z",
                updatedAt: "2026-05-03T00:00:01.000Z"
              },
              pendingControlCount: 1,
              usage: {
                inputTokens: 12,
                outputTokens: 5,
                totalTokens: 17,
                cache: {
                  state: "not_reported"
                },
                context: {
                  state: "estimated",
                  usedTokens: 4096,
                  maxTokens: 128000
                }
              }
            },
            lastTurn: {
              state: "available",
              turnId: "turn_cli_001",
              status: "blocked",
              blockedBy: "permission"
            }
          }))
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "status"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(app.operator.getStatus).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith("product: endec\n");
    expect(stdout).toHaveBeenCalledWith("dataDir: /data/endec\n");
    expect(stdout).toHaveBeenCalledWith("capabilities:\n");
    expect(stdout).toHaveBeenCalledWith("- execute: yes\n");
    expect(stdout).toHaveBeenCalledWith("- history: yes\n");
    expect(stdout).toHaveBeenCalledWith("- artifactRead: yes\n");
    expect(stdout).toHaveBeenCalledWith("- evidenceRead: yes\n");
    expect(stdout).toHaveBeenCalledWith("model: provider.stub/model.stub\n");
    expect(stdout).toHaveBeenCalledWith(
      "config: source=endec_json version=1 loadedAt=2026-05-03T00:00:00.000Z\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "modelState: capability=chat execute=yes source=catalog providerConfigured=no modelConfigured=no\n"
    );
    expect(stdout).toHaveBeenCalledWith("baseUrl: http://provider.stub/v1\n");
    expect(stdout).toHaveBeenCalledWith(
      "warning[default_model_unconfigured]: set ENDEC_PROVIDER_MODEL to avoid placeholder defaults\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "activeRun: status=running taskId=task_cli_001 runId=run_cli_001 attention=background_detached\n"
    );
    expect(stdout).toHaveBeenCalledWith("activeRunSlice: sliceId=slice_cli_001 status=running\n");
    expect(stdout).toHaveBeenCalledWith("activeRunPendingControls: 1\n");
    expect(stdout).toHaveBeenCalledWith("lastTurn: status=blocked turnId=turn_cli_001 blockedBy=permission\n");
    expect(stdout).toHaveBeenCalledWith("usage: active run\n");
    expect(stdout).toHaveBeenCalledWith("tokens: in=12 out=5 total=17\n");
    expect(stdout).toHaveBeenCalledWith("cache: not reported\n");
    expect(stdout).toHaveBeenCalledWith("context: estimated 4096/128000\n");
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("cheap:"));
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("strong:"));
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("defaultProvider:"));
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("defaultModel:"));
  });

  it("reads recoverable pending state from app.operator.getRecoverySnapshot", async () => {
    const stdout = vi.fn();
    const getRecoverySnapshot = vi.fn(async () =>
      createRecoverySnapshotResult({
        sessionId: "session_pending",
        workspaceId: "workspace_cli",
        turnId: "turn_pending",
        frameRef: "frame:pending",
        pendingExecutionId: "pending:turn_pending",
        pendingApprovalRef: "decision_pending",
        pendingDecision: {
          decisionId: "decision_pending",
          behavior: "ask",
          scope: "once",
          reasonCode: "tool_requires_approval",
          reasonText: "write_file requires approval",
          issuedAt: "2026-04-10T10:00:00.000Z",
          requestedBy: "turn_pending"
        }
      })
    );
    const getRuntimeSelfAwareness = vi.fn(async () => null);
    const app = createAppStub({
      operator: {
        getRecoverySnapshot,
        getRuntimeSelfAwareness
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "pending", "--session", "session_pending", "--turn", "turn_pending", "--frame", "frame:pending"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(getRecoverySnapshot).toHaveBeenCalledWith({
      sessionId: "session_pending",
      turnId: "turn_pending",
      frameRef: "frame:pending"
    });
    expect(getRuntimeSelfAwareness).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("sessionId: session_pending\n");
    expect(stdout).toHaveBeenCalledWith("workspaceId: workspace_cli\n");
    expect(stdout).toHaveBeenCalledWith("recoverable: yes\n");
    expect(stdout).toHaveBeenCalledWith("pending: yes\n");
    expect(stdout).toHaveBeenCalledWith("state: awaiting_permission\n");
    expect(stdout).toHaveBeenCalledWith("blockedBy: permission\n");
    expect(stdout).toHaveBeenCalledWith("turnId: turn_pending\n");
    expect(stdout).toHaveBeenCalledWith("frameRef: frame:pending\n");
    expect(stdout).toHaveBeenCalledWith("allowedActions: approve, deny, resume, cancel\n");
    expect(stdout).toHaveBeenCalledWith("decisionId: decision_pending\n");
    expect(stdout).toHaveBeenCalledWith("decisionReason: write_file requires approval\n");
    expect(stdout).toHaveBeenCalledWith("next:\n");
    expect(stdout).toHaveBeenCalledWith(
      "- approve: endec approve --session session_pending --decision decision_pending --turn turn_pending\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "- deny: endec approve --session session_pending --decision decision_pending --deny --turn turn_pending\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "- resume: endec resume --session session_pending --turn turn_pending [message...]\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "- cancel: endec cancel --session session_pending --workspace workspace_cli --turn turn_pending [--reason <text>]\n"
    );
  });

  it("surfaces pending bash approvals through the pending command", async () => {
    const stdout = vi.fn();
    const getRecoverySnapshot = vi.fn(async () =>
      createRecoverySnapshotResult({
        sessionId: "session_bash_pending",
        turnId: "turn_bash_pending",
        pendingApprovalRef: "tool_call_bash_001",
        pendingDecision: {
          decisionId: "tool_call_bash_001",
          behavior: "ask",
          scope: "once",
          reasonCode: "tool_requires_approval",
          reasonText: "bash requires operator approval before it can run",
          issuedAt: "2026-04-10T10:00:00.000Z",
          requestedBy: "turn_bash_pending"
        }
      })
    );
    const app = createAppStub({
      operator: {
        getRecoverySnapshot,
        getRuntimeSelfAwareness: vi.fn(async () => null)
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "pending", "--session", "session_bash_pending"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith("sessionId: session_bash_pending\n");
    expect(stdout).toHaveBeenCalledWith("decisionId: tool_call_bash_001\n");
    expect(stdout).toHaveBeenCalledWith("decisionReason: bash requires operator approval before it can run\n");
    expect(stdout).toHaveBeenCalledWith(
      "- approve: endec approve --session session_bash_pending --decision tool_call_bash_001 --turn turn_bash_pending\n"
    );
  });

  it("renders unrecoverable pending queries without misleading recovery guidance", async () => {
    const stdout = vi.fn();
    const getRecoverySnapshot = vi.fn(async () => null);
    const getRuntimeSelfAwareness = vi.fn(async () => null);
    const app = createAppStub({
      operator: {
        getRecoverySnapshot,
        getRuntimeSelfAwareness
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "pending", "--session", "session_hidden_deny"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(getRecoverySnapshot).toHaveBeenCalledWith({
      sessionId: "session_hidden_deny",
      turnId: undefined,
      frameRef: undefined
    });
    expect(getRuntimeSelfAwareness).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("sessionId: session_hidden_deny\n");
    expect(stdout).toHaveBeenCalledWith("recoverable: no\n");
    expect(stdout).toHaveBeenCalledWith("pending: no\n");
    expect(stdout).toHaveBeenCalledWith("next: none\n");
    expect(stdout).toHaveBeenCalledWith(
      "hint: no recoverable turn is currently exposed through the operator snapshot.\n"
    );
  });

  it("shows pending command help without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "pending", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      "usage: endec pending --session <id> [--turn <id>] [--frame <ref>]\n"
    );
  });

  it("returns usage help when pending is selected without a session", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "pending"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: missing required option: --session\n");
    expect(stderr).toHaveBeenCalledWith(
      "usage: endec pending --session <id> [--turn <id>] [--frame <ref>]\n"
    );
  });

  it("shows operator help without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      "usage: endec operator <inspect|owner|pair-claims|pair-approve|owner-reset|trusted-list|trusted-revoke> ...\n"
    );
  });

  it("shows operator pair-approve help without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "pair-approve", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      "usage: endec operator pair-approve --source <cli|tui|telegram|feishu|web|sdk> --account <id> --code <code> [--operator-actor <id>]\n"
    );
  });

  it("renders operator owner state from app.operator.inspectOwnerBinding", async () => {
    const stdout = vi.fn();
    const inspectOwnerBinding = vi.fn(async () => createInspectOwnerBindingResult());
    const app = createAppStub({
      operator: {
        inspectOwnerBinding
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "owner", "--source", "telegram", "--account", "acct_bot"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(inspectOwnerBinding).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot"
    });

    const output = stdout.mock.calls.map(([line]) => line).join("");
    expect(output).toContain("source: telegram\n");
    expect(output).toContain("accountId: acct_bot\n");
    expect(output).toContain("authorityStatus: bound\n");
    expect(output).toContain("ownerGeneration: 0\n");
    expect(output).toContain("ownerBindingId: owner_binding_001\n");
    expect(output).toContain("owner: active\n");
    expect(output).toContain("ownerSubjectRef: telegram-user:42\n");
    expect(output).toContain("pairedConversation: dm:owner_user peerKind=dm peerId=owner_user\n");
    expect(output).toContain("storedOwnerDisplayName: Chiyo\n");
    expect(output).toContain("storedAssistantDisplayName: Momo\n");
    expect(output).toContain("storedTimezone: Asia/Shanghai\n");
    expect(output).toContain("resolvedAssistantDisplayName: Momo\n");
    expect(output).toContain("resolvedTimezone: Asia/Shanghai\n");
    expect(output).toContain("timezoneSource: owner_preference\n");
    expect(output).toContain("ownerInitStatus: completed\n");
    expect(output).toContain("ownerInitPromptVersion: 1\n");
    expect(output).toContain("ownerInitPromptSentAt: 2026-04-29T00:02:00.000Z\n");
    expect(output).toContain("ownerInitCompletionReason: fields_captured\n");
    expect(output).toContain("ownerInitCompletedAt: 2026-04-29T00:03:00.000Z\n");
  });

  it("renders sparse owner state with resolved defaults and without absent stored fields", async () => {
    const stdout = vi.fn();
    const inspectOwnerBinding = vi.fn(async () =>
      createInspectOwnerBindingResult({
        ownerPreferences: undefined,
        resolvedOwnerPreferences: {
          assistantDisplayName: "Endec",
          timezone: "UTC",
          timezoneSource: "server_default"
        },
        ownerInitState: {
          source: "telegram",
          accountId: "acct_bot",
          ownerGeneration: 0,
          ownerBindingId: "owner_binding_001",
          status: "prompted",
          promptVersion: 1,
          promptSentAt: "2026-04-29T00:02:00.000Z",
          updatedAt: "2026-04-29T00:02:00.000Z"
        }
      })
    );
    const app = createAppStub({
      operator: {
        inspectOwnerBinding
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "owner", "--source", "telegram", "--account", "acct_bot"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);

    const output = stdout.mock.calls.map(([line]) => line).join("");
    expect(output).toContain("owner: active\n");
    expect(output).not.toContain("storedOwnerDisplayName:");
    expect(output).not.toContain("storedAssistantDisplayName:");
    expect(output).not.toContain("storedTimezone:");
    expect(output).toContain("resolvedAssistantDisplayName: Endec\n");
    expect(output).toContain("resolvedTimezone: UTC\n");
    expect(output).toContain("timezoneSource: server_default\n");
    expect(output).toContain("ownerInitStatus: prompted\n");
    expect(output).toContain("ownerInitPromptVersion: 1\n");
    expect(output).toContain("ownerInitPromptSentAt: 2026-04-29T00:02:00.000Z\n");
    expect(output).not.toContain("ownerInitCompletionReason:");
    expect(output).not.toContain("ownerInitCompletedAt:");
  });

  it("lists pair claims from app.operator.listPairClaims", async () => {
    const stdout = vi.fn();
    const listPairClaims = vi.fn(async () => createListPairClaimsResult());
    const app = createAppStub({
      operator: {
        listPairClaims
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "pair-claims", "--source", "telegram", "--account", "acct_bot"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(listPairClaims).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot"
    });
    expect(stdout).toHaveBeenCalledWith("claim: claim_001 status=pending code=ABCD1234 subject=telegram-user:42 actor=actor_owner_001 generation=0\n");
    expect(stdout).toHaveBeenCalledWith("  requestWorkspaceId: workspace_local\n");
    expect(stdout).toHaveBeenCalledWith("  requestSessionId: session_pair_001\n");
  });

  it("approves pair claims with explicit operator actor", async () => {
    const stdout = vi.fn();
    const approvePairClaim = vi.fn(async () => createApprovePairClaimResult());
    const app = createAppStub({
      operator: {
        approvePairClaim
      }
    });

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "pair-approve",
        "--source",
        "telegram",
        "--account",
        "acct_bot",
        "--code",
        "ABCD1234",
        "--operator-actor",
        "operator_delta"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(approvePairClaim).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot",
      pairCode: "ABCD1234",
      operatorActorId: "operator_delta"
    });
    expect(stdout).toHaveBeenCalledWith("outcome: approved\n");
    expect(stdout).toHaveBeenCalledWith("pairingSuccessNoticeStatus: enqueued\n");
    expect(stdout).toHaveBeenCalledWith("claimId: claim_001\n");
  });

  it("approves pair claims with cli default operator actor fallback", async () => {
    const stdout = vi.fn();
    const approvePairClaim = vi.fn(async () => createApprovePairClaimResult());
    const app = createAppStub({
      operator: {
        approvePairClaim
      }
    });

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "pair-approve",
        "--source",
        "telegram",
        "--account",
        "acct_bot",
        "--code",
        "ABCD1234"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(approvePairClaim).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot",
      pairCode: "ABCD1234",
      operatorActorId: "actor_cli_user"
    });
  });

  it("resets owner bindings from app.operator.resetOwnerBinding", async () => {
    const stdout = vi.fn();
    const resetOwnerBinding = vi.fn(async () => createResetOwnerBindingResult());
    const app = createAppStub({
      operator: {
        resetOwnerBinding
      }
    });

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "owner-reset",
        "--source",
        "telegram",
        "--account",
        "acct_bot",
        "--reason",
        "rotate owner"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(resetOwnerBinding).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot",
      operatorActorId: "actor_cli_user",
      reason: "rotate owner"
    });
    expect(stdout).toHaveBeenCalledWith("outcome: reset\n");
    expect(stdout).toHaveBeenCalledWith("newOwnerGeneration: 1\n");
    expect(stdout).toHaveBeenCalledWith("revokedTrustCount: 1\n");
  });

  it("lists trusted conversations from app.operator.listTrustedConversations", async () => {
    const stdout = vi.fn();
    const listTrustedConversations = vi.fn(async () => createListTrustedConversationsResult());
    const app = createAppStub({
      operator: {
        listTrustedConversations
      }
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "trusted-list", "--source", "telegram", "--account", "acct_bot"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(listTrustedConversations).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot"
    });
    expect(stdout).toHaveBeenCalledWith("trust: trust_001 status=active key=group:chat_100 coverage=descendants grantKind=owner_auto generation=0\n");
    expect(stdout).toHaveBeenCalledWith("  conversation: group:chat_100:thread:thread_1 peerKind=group peerId=chat_100\n");
  });

  it("revokes trusted conversations with operator actor fallback", async () => {
    const stdout = vi.fn();
    const revokeTrustedConversation = vi.fn(async () => createRevokeTrustedConversationResult());
    const app = createAppStub({
      operator: {
        revokeTrustedConversation
      }
    });

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "trusted-revoke",
        "--source",
        "telegram",
        "--account",
        "acct_bot",
        "--trust",
        "trust_001",
        "--reason",
        "manual revoke"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(revokeTrustedConversation).toHaveBeenCalledWith({
      source: "telegram",
      accountId: "acct_bot",
      trustId: "trust_001",
      operatorActorId: "actor_cli_user",
      reason: "manual revoke"
    });
    expect(stdout).toHaveBeenCalledWith("outcome: revoked\n");
    expect(stdout).toHaveBeenCalledWith("affectedOutboundLegality: yes\n");
    expect(stdout).toHaveBeenCalledWith("revokedByOperatorId: operator_alpha\n");
  });

  it("routes operator inspect through app.operator.inspectOperatorTurn with target and detail options", async () => {
    const stdout = vi.fn();
    const inspectOperatorTurn = vi.fn(async () => createOperatorTurnInspectionResult());
    const app = createAppStub({
      operator: {
        inspectOperatorTurn
      }
    });

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "inspect",
        "--session",
        "session_target",
        "--workspace",
        "workspace_target",
        "--actor",
        "actor_target",
        "--turn",
        "turn_target",
        "--frame",
        "frame:target",
        "--full",
        "--section",
        "continuation",
        "--section",
        "correction"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(inspectOperatorTurn).toHaveBeenCalledWith({
      target: {
        sessionId: "session_target",
        workspaceId: "workspace_target",
        actorId: "actor_target",
        turnId: "turn_target",
        frameRef: "frame:target"
      },
      detail: {
        verbosity: "full",
        sections: ["continuation", "correction"]
      }
    });
  });

  it("accepts budget as a shared operator inspect section", async () => {
    const stdout = vi.fn();
    const inspectOperatorTurn = vi.fn(async () => createOperatorTurnInspectionResult());
    const app = createAppStub({
      operator: {
        inspectOperatorTurn
      }
    });

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "inspect",
        "--session",
        "session_target",
        "--workspace",
        "workspace_target",
        "--actor",
        "actor_target",
        "--turn",
        "turn_target",
        "--frame",
        "frame:target",
        "--section",
        "budget"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(inspectOperatorTurn).toHaveBeenCalledWith({
      target: {
        sessionId: "session_target",
        workspaceId: "workspace_target",
        actorId: "actor_target",
        turnId: "turn_target",
        frameRef: "frame:target"
      },
      detail: {
        sections: ["budget"]
      }
    });
  });

  it("renders compact operator inspection output from the shared contract", async () => {
    const stdout = vi.fn();
    const inspection = createOperatorTurnInspectionResult();
    const getRecoverySnapshot = vi.fn(async () => createRecoverySnapshotResult());
    const getRuntimeSelfAwareness = vi.fn(async () => createRecoverySnapshotResult().runtimeSelfAwareness ?? null);
    const inspectCorrectionSurface = vi.fn(async () => createCorrectionInspectionResult());
    const listSessions = vi.fn(async () => createSessionListResult());
    const browseSessionHistory = vi.fn(async () => createSessionBrowseResult());
    const searchSessionEvents = vi.fn(async () => createSessionSearchResult());
    const inspectOperatorTurn = vi.fn(async () => inspection);

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "inspect", "--session", "session_001"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          inspectOperatorTurn,
          getRecoverySnapshot,
          getRuntimeSelfAwareness,
          inspectCorrectionSurface,
          listSessions,
          browseSessionHistory,
          searchSessionEvents
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(inspectOperatorTurn).toHaveBeenCalledWith({
      target: {
        sessionId: "session_001",
        workspaceId: "workspace_local"
      }
    });
    expect(getRecoverySnapshot).not.toHaveBeenCalled();
    expect(getRuntimeSelfAwareness).not.toHaveBeenCalled();
    expect(inspectCorrectionSurface).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(browseSessionHistory).not.toHaveBeenCalled();
    expect(searchSessionEvents).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("headline: Turn turn_001 is blocked by permission.\n");
    expect(stdout).toHaveBeenCalledWith("summary: The shared operator contract reports an approval-required continuation with correction context.\n");
    expect(stdout).toHaveBeenCalledWith("state: blocked\n");
    expect(stdout).toHaveBeenCalledWith("truth: 1 guaranteed tool; 1 approval-required capability; 1 not-guaranteed capability.\n");
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("capability:"));
    expect(stdout).toHaveBeenCalledWith("context: Operator context is blocked.\n");
    expect(stdout).toHaveBeenCalledWith("continuity: activeTask=full; workingSet=skeleton; recentHistory=partial.\n");
    expect(stdout).toHaveBeenCalledWith("durableMemory: 2/3 durable memory items selected.\n");
    expect(stdout).toHaveBeenCalledWith("truncation: 1 context item dropped by budget.\n");
    expect(stdout).toHaveBeenCalledWith("driftDiagnostics: No drift diagnostics reported.\n");
    expect(stdout).toHaveBeenCalledWith("continuation: blocked continuation via blocked; allowed actions: approve, deny.\n");
    expect(stdout).toHaveBeenCalledWith("correction: working set correction target available.\n");
    expect(stdout).toHaveBeenCalledWith("nextActions:\n");
    expect(stdout).toHaveBeenCalledWith("- approve-pending-decision [approve]: Approve pending decision decision_001. target=decision_001 risk=medium approval=yes\n");
    expect(stdout).toHaveBeenCalledWith("- inspect-correction-targets [inspect]: Inspect 1 correction target before resuming. target=correction refs=ws_001\n");
    expect(stdout).toHaveBeenCalledWith("explanations:\n");
    expect(stdout).toHaveBeenCalledWith("- truth-source: Capability facts come from AuthoritativeTurnTruth.\n");
  });

  it("renders budget debug from the shared operator inspection contract", async () => {
    const stdout = vi.fn();
    const inspection = createOperatorTurnInspectionResult({
      context: {
        summary: {
          headline: "Operator context is normal.",
          truthSummary: "truth summary",
          continuitySummary: "continuity summary",
          durableMemorySummary: "durable summary",
          truncationSummary: "truncation summary",
          driftDiagnosticsSummary: "drift summary",
          budgetSummary: "profile=balanced; maxContextTokens=200000; usableContext=180000; input=27000; memory=5000; toolSchema=estimated"
        },
        observability: createOperatorTurnInspectionResult().context.observability
      }
    });
    const inspectOperatorTurn = vi.fn(async () => inspection);

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "inspect", "--session", "session_cli_budget"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          inspectOperatorTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      "budget: profile=balanced; maxContextTokens=200000; usableContext=180000; input=27000; memory=5000; toolSchema=estimated\n"
    );
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("runtimeContextBlocks"));
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("full prompt"));
  });

  it("renders an unavailable operator inspection without fallback reads", async () => {
    const stdout = vi.fn();
    const inspectOperatorTurn = vi.fn(async () => null);
    const getRecoverySnapshot = vi.fn(async () => createRecoverySnapshotResult());
    const getRuntimeSelfAwareness = vi.fn(async () => createRecoverySnapshotResult().runtimeSelfAwareness ?? null);
    const inspectCorrectionSurface = vi.fn(async () => createCorrectionInspectionResult());
    const searchEvidence = vi.fn(async () => ({ items: [] }));

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "inspect", "--session", "session_missing"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          inspectOperatorTurn,
          getRecoverySnapshot,
          getRuntimeSelfAwareness,
          inspectCorrectionSurface,
          searchEvidence
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith("operator inspection unavailable for session session_missing.\n");
    expect(stdout).toHaveBeenCalledWith("hint: shared operator turn inspection returned no result; no fallback truth was computed.\n");
    expect(getRecoverySnapshot).not.toHaveBeenCalled();
    expect(getRuntimeSelfAwareness).not.toHaveBeenCalled();
    expect(inspectCorrectionSurface).not.toHaveBeenCalled();
    expect(searchEvidence).not.toHaveBeenCalled();
  });

  it("rejects unsupported operator inspect sections before bootstrapping the app", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "inspect", "--session", "session_001", "--section", "unknown"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: unsupported value for --section: unknown (supported: continuity, durableMemory, truncation, driftDiagnostics, budget, continuation, correction)\n");
    expect(stderr).toHaveBeenCalledWith("usage: endec operator inspect --session <id> [--workspace <id>] [--actor <id>] [--turn <id>] [--frame <ref>] [--full] [--section <name>...]\n");
  });

  it("returns operator access usage when owner is missing required scope options", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "operator", "owner"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: missing required option: --source\n");
    expect(stderr).toHaveBeenCalledWith(
      "usage: endec operator owner --source <cli|tui|telegram|feishu|web|sdk> --account <id>\n"
    );
  });

  it("does not ship mode-era operator inspect explanations", async () => {
    const files = await listTypeScriptFiles(new URL(".", import.meta.url).pathname);
    const sources = await Promise.all(files.map(async (file) => readFile(file, "utf8")));
    const combined = sources.join("\n");

    expect(combined).not.toContain("because chat mode has no bash");
    expect(combined).not.toContain("resolvedMode === chat");
  });

  it("routes artifact preview through app.operator.getArtifactPreview", async () => {
    const stdout = vi.fn();
    const getArtifactPreview = vi.fn(async () => ({
      artifactId: "artifact_001",
      ref: {
        artifactId: "artifact_001",
        sessionId: "session_001",
        turnId: "turn_001",
        kind: "runtime_output" as const,
        storageKey: "artifacts/session_001/turn_001/artifact_001.txt",
        mimeType: "text/plain",
        byteLength: 512,
        createdAt: "2026-04-10T00:00:00.000Z"
      },
      previewText: "artifact preview text",
      truncated: true,
      byteLength: 512,
      sourceRange: {
        offset: 0,
        length: 128
      }
    }));

    const exitCode = await runCli({
      argv: ["node", "endec", "artifact", "preview", "--artifact", "artifact_001"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          getArtifactPreview
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(getArtifactPreview).toHaveBeenCalledWith({ artifactId: "artifact_001" });
    expect(stdout).toHaveBeenCalledWith("artifactId: artifact_001\n");
    expect(stdout).toHaveBeenCalledWith("sessionId: session_001\n");
    expect(stdout).toHaveBeenCalledWith("turnId: turn_001\n");
    expect(stdout).toHaveBeenCalledWith("kind: runtime_output\n");
    expect(stdout).toHaveBeenCalledWith("mimeType: text/plain\n");
    expect(stdout).toHaveBeenCalledWith("byteLength: 512\n");
    expect(stdout).toHaveBeenCalledWith("truncated: yes\n");
    expect(stdout).toHaveBeenCalledWith("preview:\n");
    expect(stdout).toHaveBeenCalledWith("artifact preview text\n");
  });

  it("routes artifact read through app.operator.readArtifact", async () => {
    const stdout = vi.fn();
    const readArtifact = vi.fn(async () => ({
      artifact: {
        artifactId: "artifact_001",
        sessionId: "session_001",
        turnId: "turn_001",
        kind: "runtime_output" as const,
        storageKey: "artifacts/session_001/turn_001/artifact_001.txt",
        mimeType: "text/plain",
        byteLength: 512,
        createdAt: "2026-04-10T00:00:00.000Z"
      },
      preview: {
        artifactId: "artifact_001",
        ref: {
          artifactId: "artifact_001",
          sessionId: "session_001",
          turnId: "turn_001",
          kind: "runtime_output" as const,
          storageKey: "artifacts/session_001/turn_001/artifact_001.txt",
          mimeType: "text/plain",
          byteLength: 512,
          createdAt: "2026-04-10T00:00:00.000Z"
        },
        previewText: "artifact preview text",
        truncated: true,
        byteLength: 512
      },
      content: "hello world",
      range: {
        offset: 10,
        limit: 16,
        returned: 11
      },
      eof: false,
      nextCursor: "cursor_002"
    }));

    const exitCode = await runCli({
      argv: ["node", "endec", "artifact", "read", "--artifact", "artifact_001", "--offset", "10", "--limit", "16"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          readArtifact
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(readArtifact).toHaveBeenCalledWith({
      artifactId: "artifact_001",
      offset: 10,
      limit: 16,
      cursor: undefined
    });
    expect(stdout).toHaveBeenCalledWith("artifactId: artifact_001\n");
    expect(stdout).toHaveBeenCalledWith("range: offset=10 limit=16 returned=11\n");
    expect(stdout).toHaveBeenCalledWith("eof: no\n");
    expect(stdout).toHaveBeenCalledWith("nextCursor: cursor_002\n");
    expect(stdout).toHaveBeenCalledWith("content:\n");
    expect(stdout).toHaveBeenCalledWith("hello world\n");
  });

  it("prints a clean not-found error when artifact read misses", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const readArtifact = vi.fn(async () => null);

    const exitCode = await runCli({
      argv: ["node", "endec", "artifact", "read", "--artifact", "artifact_missing"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: createAppStub({
        operator: {
          readArtifact
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(readArtifact).toHaveBeenCalledWith({ artifactId: "artifact_missing", offset: undefined, limit: undefined, cursor: undefined });
    expect(stderr).toHaveBeenCalledWith("endec: artifact not found: artifact_missing\n");
  });

  it("routes evidence search through app.operator.searchEvidence", async () => {
    const stdout = vi.fn();
    const searchEvidence = vi.fn(async () => ({
      items: [
        {
          evidenceId: "evidence_001",
          sessionId: "session_001",
          topic: "auth",
          content: "auth migration decision",
          createdAt: "2026-04-10T00:00:00.000Z"
        },
        {
          evidenceId: "evidence_002",
          sessionId: "session_002",
          topic: "billing",
          content: "billing migration follow-up",
          createdAt: "2026-04-10T01:00:00.000Z"
        }
      ]
    }));

    const exitCode = await runCli({
      argv: ["node", "endec", "evidence", "search", "--workspace", "workspace_local", "--limit", "2", "migration"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          searchEvidence
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(searchEvidence).toHaveBeenCalledWith({
      workspaceId: "workspace_local",
      queryText: "migration",
      maxItems: 2
    });
    expect(stdout).toHaveBeenCalledWith("items: 2\n");
    expect(stdout).toHaveBeenCalledWith("- evidenceId: evidence_001\n");
    expect(stdout).toHaveBeenCalledWith("  sessionId: session_001\n");
    expect(stdout).toHaveBeenCalledWith("  topic: auth\n");
    expect(stdout).toHaveBeenCalledWith("  createdAt: 2026-04-10T00:00:00.000Z\n");
    expect(stdout).toHaveBeenCalledWith("  content: auth migration decision\n");
  });

  it("prints execute warnings from the real app result when default model selection fails", async () => {
    const stdout = vi.fn();
    const executeTurn = vi.fn(async () =>
      createTurnResult({
        status: "failed",
        messages: [],
        warnings: ["Endec could not align its default model with the reachable provider."]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "execute", "hello"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          executeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith("status: failed\n");
    expect(stdout).toHaveBeenCalledWith(
      "warning: Endec could not align its default model with the reachable provider.\n"
    );
  });

  it("renders blocked execute results with approval guidance and next steps", async () => {
    const stdout = vi.fn();
    const executeTurn = vi.fn(async () =>
      createTurnResult({
        turnId: "turn_1700000000000",
        sessionId: "session_cli_default",
        status: "blocked",
        messages: [{ role: "assistant", content: "waiting for approval before editing files" }],
        warnings: ["permission required"],
        blockedBy: "permission",
        approvals: [
          {
            decisionId: "decision_123",
            behavior: "ask",
            scope: "once",
            reasonText: "write_file requires approval before execution"
          }
        ]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "execute", "please", "edit", "the", "file"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          executeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith("waiting for approval before editing files\n");
    expect(stdout).toHaveBeenCalledWith("status: blocked\n");
    expect(stdout).toHaveBeenCalledWith("reason: waiting for approval before continuing\n");
    expect(stdout).toHaveBeenCalledWith("pending approvals:\n");
    expect(stdout).toHaveBeenCalledWith("- decision_123 [once]: write_file requires approval before execution\n");
    expect(stdout).toHaveBeenCalledWith("next:\n");
    expect(stdout).toHaveBeenCalledWith(
      "- approve: endec approve --session session_cli_default --decision decision_123 --turn turn_1700000000000\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "- deny: endec approve --session session_cli_default --decision decision_123 --deny --turn turn_1700000000000\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "- cancel: endec cancel --session session_cli_default --turn turn_1700000000000\n"
    );
    expect(stdout).toHaveBeenCalledWith("warning: permission required\n");
  });

  it("renders blocked execute results with recovery guidance for operator decision", async () => {
    const stdout = vi.fn();
    const executeTurn = vi.fn(async () =>
      createTurnResult({
        turnId: "turn_1700000000000",
        sessionId: "session_cli_default",
        status: "blocked",
        messages: [{ role: "assistant", content: "I reached the loop limit and need confirmation" }],
        warnings: ["loop limit reached; operator decision required"],
        blockedBy: "user_decision"
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "execute", "keep", "going"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          executeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith("I reached the loop limit and need confirmation\n");
    expect(stdout).toHaveBeenCalledWith("status: blocked\n");
    expect(stdout).toHaveBeenCalledWith("reason: waiting for operator decision before continuing\n");
    expect(stdout).toHaveBeenCalledWith("next:\n");
    expect(stdout).toHaveBeenCalledWith(
      "- resume: endec resume --session session_cli_default --turn turn_1700000000000 [message...]\n"
    );
    expect(stdout).toHaveBeenCalledWith(
      "- cancel: endec cancel --session session_cli_default --turn turn_1700000000000 [--reason <text>]\n"
    );
    expect(stdout).toHaveBeenCalledWith("warning: loop limit reached; operator decision required\n");
  });

  it("prints a clear resume summary before the resumed turn output", async () => {
    const stdout = vi.fn();
    const resumeTurn = vi.fn(async () =>
      createTurnResult({
        messages: [{ role: "assistant", content: "resumed successfully" }]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "resume", "--session", "session_001", "continue"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          resumeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(resumeTurn).toHaveBeenCalledWith({
      turnId: undefined,
      sessionId: "session_001",
      workspaceId: "workspace_local",
      input: "continue"
    });
    expect(stdout).toHaveBeenCalledWith("resume: continuing session session_001\n");
    expect(stdout).toHaveBeenCalledWith("resumed successfully\n");
  });

  it("prints a clear approval summary before the resumed turn output", async () => {
    const stdout = vi.fn();
    const resolveApproval = vi.fn(async () =>
      createTurnResult({
        messages: [{ role: "assistant", content: "approval applied and execution resumed" }]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "approve", "--session", "session_001", "--decision", "decision_123"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          resolveApproval
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(resolveApproval).toHaveBeenCalledWith({
      turnId: undefined,
      sessionId: "session_001",
      decisionId: "decision_123",
      approved: true,
      scope: undefined,
      approverId: undefined
    });
    expect(stdout).toHaveBeenCalledWith("approval: approved decision_123 for session session_001\n");
    expect(stdout).toHaveBeenCalledWith("approval applied and execution resumed\n");
  });

  it("forwards supported once|turn approval scopes", async () => {
    const stdout = vi.fn();
    const resolveApproval = vi.fn(async () => createTurnResult({}));

    const exitCode = await runCli({
      argv: ["node", "endec", "approve", "--session", "session_001", "--decision", "decision_123", "--scope", "turn"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          resolveApproval
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(resolveApproval).toHaveBeenCalledWith({
      turnId: undefined,
      sessionId: "session_001",
      decisionId: "decision_123",
      approved: true,
      scope: "turn",
      approverId: undefined
    });
  });

  it("rejects session as an unsupported approval scope before dispatching to the app", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "approve", "--session", "session_001", "--decision", "decision_123", "--scope", "session"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: unsupported value for --scope: session (supported: once, turn)\n");
    expect(stderr).toHaveBeenCalledWith(
      "usage: endec approve --session <id> --decision <id> [--deny] [--turn <id>] [--scope <once|turn>] [--approver <id>]\n"
    );
  });

  it("rejects workspace as an unsupported approval scope before dispatching to the app", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "approve", "--session", "session_001", "--decision", "decision_123", "--scope", "workspace"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: unsupported value for --scope: workspace (supported: once, turn)\n");
    expect(stderr).toHaveBeenCalledWith(
      "usage: endec approve --session <id> --decision <id> [--deny] [--turn <id>] [--scope <once|turn>] [--approver <id>]\n"
    );
  });

  it("prints a clear error when approval targets the wrong pending decision", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const resolveApproval = vi.fn(async () => {
      throw new Error(
        "Session session_001 is waiting on approval decision decision_right, not decision_wrong. Retry with --decision decision_right."
      );
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "approve", "--session", "session_001", "--decision", "decision_wrong"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: createAppStub({
        shell: {
          resolveApproval
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      "endec: Session session_001 is waiting on approval decision decision_right, not decision_wrong. Retry with --decision decision_right.\n"
    );
  });

  it("prints a clear cancel summary before the interrupted turn output", async () => {
    const stdout = vi.fn();
    const cancelInflightTurn = vi.fn(async () =>
      createTurnResult({
        status: "interrupted",
        warnings: ["operator cancelled"]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "cancel", "--session", "session_001", "--reason", "operator cancelled"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          cancelInflightTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(cancelInflightTurn).toHaveBeenCalledWith({
      turnId: undefined,
      sessionId: "session_001",
      workspaceId: "workspace_local",
      reason: "operator cancelled"
    });
    expect(stdout).toHaveBeenCalledWith("cancel: interrupted recoverable work in session session_001\n");
    expect(stdout).toHaveBeenCalledWith("status: interrupted\n");
    expect(stdout).toHaveBeenCalledWith("warning: operator cancelled\n");
  });

  it("prints a recovery-oriented error when resume cannot find an inflight turn", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const resumeTurn = vi.fn(async () => {
      throw new Error("No recoverable turn is open for session session_001.");
    });

    const exitCode = await runCli({
      argv: ["node", "endec", "resume", "--session", "session_001"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: createAppStub({
        shell: {
          resumeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: No recoverable turn is open for session session_001.\n");
  });

  it("routes execute through app.shell.executeTurn", async () => {
    const stdout = vi.fn();
    const executeTurn = vi.fn(async () =>
      createTurnResult({
        turnId: "turn_002",
        sessionId: "session_cli_custom",
        messages: [{ role: "assistant", content: "planned" }]
      })
    );

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "execute",
        "--session",
        "session_cli_custom",
        "--workspace",
        "workspace_proj",
        "--actor",
        "actor_worker",
        "--turn",
        "turn_explicit",
        "--mode",
        "plan",
        "--task",
        "task_001",
        "draft",
        "a",
        "plan"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          executeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(executeTurn).toHaveBeenCalledWith({
      turnId: "turn_explicit",
      sessionId: "session_cli_custom",
      workspaceId: "workspace_proj",
      source: "cli",
      actorId: "actor_worker",
      input: "draft a plan",
      attachments: [],
      requestedMode: "plan",
      taskId: "task_001"
    });
    expect(stdout).toHaveBeenCalledWith("planned\n");
  });

  it("treats a bare prompt as execute through the app shell", async () => {
    const stdout = vi.fn();
    const executeTurn = vi.fn(async () =>
      createTurnResult({
        messages: [{ role: "assistant", content: "hi" }]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "say", "hi"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          executeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(executeTurn).toHaveBeenCalledWith({
      turnId: "turn_1700000000000",
      sessionId: "session_cli_default",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_cli_user",
      input: "say hi",
      attachments: []
    });
    expect(stdout).toHaveBeenCalledWith("hi\n");
  });

  it("lists sessions through app.operator.listSessions", async () => {
    const stdout = vi.fn();
    const listSessions = vi.fn(async () =>
      createSessionListResult({
        items: [
          {
            sessionId: "session_beta",
            workspaceId: "workspace_local",
            source: "telegram",
            mode: "chat",
            status: "waiting_input",
            currentGoal: "Review latest artifact",
            lastTurnAt: "2026-04-09T11:00:00.000Z",
            createdAt: "2026-04-09T10:30:00.000Z"
          }
        ],
        nextCursor: "cursor:sessions:next"
      })
    );

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "sessions",
        "--workspace",
        "workspace_local",
        "--source",
        "telegram",
        "--status",
        "waiting_input",
        "--mode",
        "chat",
        "--limit",
        "5",
        "--cursor",
        "cursor:sessions:start"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          listSessions
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(listSessions).toHaveBeenCalledWith({
      workspaceId: "workspace_local",
      source: "telegram",
      status: "waiting_input",
      mode: "chat",
      limit: 5,
      cursor: "cursor:sessions:start"
    });
    expect(stdout).toHaveBeenCalledWith(
      "session: session_beta workspace=workspace_local source=telegram mode=chat status=waiting_input lastTurnAt=2026-04-09T11:00:00.000Z createdAt=2026-04-09T10:30:00.000Z\n"
    );
    expect(stdout).toHaveBeenCalledWith("  goal: Review latest artifact\n");
    expect(stdout).toHaveBeenCalledWith("nextCursor: cursor:sessions:next\n");
  });

  it("browses a session history through app.operator.browseSessionHistory", async () => {
    const stdout = vi.fn();
    const browseSessionHistory = vi.fn(async () =>
      createSessionBrowseResult({
        items: [
          {
            sessionId: "session_alpha",
            turnId: "turn_001",
            eventId: "event_002",
            eventKind: "assistant_message",
            createdAt: "2026-04-09T10:00:05.000Z",
            summary: "Assistant located the blocked turn.",
            sourceRefs: ["memory:write-001"]
          }
        ],
        nextCursor: "cursor:history:next"
      })
    );

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "history",
        "--session",
        "session_alpha",
        "--limit",
        "3",
        "--cursor",
        "cursor:history:start",
        "--before-turn",
        "turn_999"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          browseSessionHistory
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(browseSessionHistory).toHaveBeenCalledWith({
      sessionId: "session_alpha",
      limit: 3,
      cursor: "cursor:history:start",
      beforeTurnId: "turn_999"
    });
    expect(stdout).toHaveBeenCalledWith(
      "event: event_002 session=session_alpha turn=turn_001 kind=assistant_message at=2026-04-09T10:00:05.000Z\n"
    );
    expect(stdout).toHaveBeenCalledWith("  summary: Assistant located the blocked turn.\n");
    expect(stdout).toHaveBeenCalledWith("  sourceRefs: memory:write-001\n");
    expect(stdout).toHaveBeenCalledWith("nextCursor: cursor:history:next\n");
  });

  it("searches session events through app.operator.searchSessionEvents", async () => {
    const stdout = vi.fn();
    const searchSessionEvents = vi.fn(async () =>
      createSessionSearchResult({
        hits: [
          {
            sessionId: "session_alpha",
            turnId: "turn_001",
            eventId: "event_002",
            eventKind: "assistant_message",
            createdAt: "2026-04-09T10:00:05.000Z",
            summary: "Assistant located the blocked turn.",
            snippet: "...blocked turn and recovery checkpoint...",
            sourceRefs: ["memory:write-001"]
          }
        ],
        nextCursor: "cursor:events:next"
      })
    );

    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "events",
        "--workspace",
        "workspace_local",
        "--session",
        "session_alpha",
        "--kind",
        "assistant_message",
        "--limit",
        "10",
        "--cursor",
        "cursor:events:start",
        "blocked",
        "turn"
      ],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          searchSessionEvents
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(searchSessionEvents).toHaveBeenCalledWith({
      workspaceId: "workspace_local",
      sessionId: "session_alpha",
      queryText: "blocked turn",
      eventKinds: ["assistant_message"],
      limit: 10,
      cursor: "cursor:events:start"
    });
    expect(stdout).toHaveBeenCalledWith(
      "event: event_002 session=session_alpha turn=turn_001 kind=assistant_message at=2026-04-09T10:00:05.000Z\n"
    );
    expect(stdout).toHaveBeenCalledWith("  summary: Assistant located the blocked turn.\n");
    expect(stdout).toHaveBeenCalledWith("  snippet: ...blocked turn and recovery checkpoint...\n");
    expect(stdout).toHaveBeenCalledWith("  sourceRefs: memory:write-001\n");
    expect(stdout).toHaveBeenCalledWith("nextCursor: cursor:events:next\n");
  });

  it("looks up a single session event through app.operator.lookupSessionEvent", async () => {
    const stdout = vi.fn();
    const lookupSessionEvent = vi.fn(async () =>
      createSessionLookupResult({
        entry: {
          sessionId: "session_alpha",
          turnId: "turn_001",
          eventId: "event_002",
          eventKind: "assistant_message",
          createdAt: "2026-04-09T10:00:05.000Z",
          summary: "Assistant located the blocked turn.",
          sourceRefs: ["memory:write-001"]
        }
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "event", "--session", "session_alpha", "--event", "event_002"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: createAppStub({
        operator: {
          lookupSessionEvent
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(lookupSessionEvent).toHaveBeenCalledWith({
      sessionId: "session_alpha",
      eventId: "event_002",
      turnId: undefined
    });
    expect(stdout).toHaveBeenCalledWith(
      "event: event_002 session=session_alpha turn=turn_001 kind=assistant_message at=2026-04-09T10:00:05.000Z\n"
    );
    expect(stdout).toHaveBeenCalledWith("  summary: Assistant located the blocked turn.\n");
    expect(stdout).toHaveBeenCalledWith("  sourceRefs: memory:write-001\n");
  });

  it("shows root help without bootstrapping the app when no prompt or command is provided", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("usage: endec <prompt...>\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec execute <prompt...> [--session <id>] [--workspace <id>] [--actor <id>] [--turn <id>] [--mode <chat|plan|act|review|task>] [--task <id>] [--resume-from <ref>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec status\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec pending --session <id> [--turn <id>] [--frame <ref>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec operator inspect --session <id> [--workspace <id>] [--actor <id>] [--turn <id>] [--frame <ref>] [--full] [--section <name>...]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec operator owner --source <cli|tui|telegram|feishu|web|sdk> --account <id>\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec operator pair-claims --source <cli|tui|telegram|feishu|web|sdk> --account <id>\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec operator pair-approve --source <cli|tui|telegram|feishu|web|sdk> --account <id> --code <code> [--operator-actor <id>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec operator owner-reset --source <cli|tui|telegram|feishu|web|sdk> --account <id> [--reason <text>] [--operator-actor <id>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec operator trusted-list --source <cli|tui|telegram|feishu|web|sdk> --account <id>\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec operator trusted-revoke --source <cli|tui|telegram|feishu|web|sdk> --account <id> --trust <id> [--reason <text>] [--operator-actor <id>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec sessions [--workspace <id>] [--source <cli|tui|telegram|feishu|web|sdk>] [--status <active|waiting_input|waiting_approval|paused|ended>] [--mode <chat|plan|act|review|task>] [--limit <n>] [--cursor <cursor>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec history --session <id> [--limit <n>] [--cursor <cursor>] [--before-turn <id>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec events --workspace <id> <query...> [--session <id>] [--kind <eventKind>] [--limit <n>] [--cursor <cursor>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec event --session <id> [--event <id> | --turn <id>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec artifact preview --artifact <id>\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec artifact read --artifact <id> [--offset <n>] [--limit <n>] [--cursor <token>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec evidence search --workspace <id> [--limit <n>] <query...>\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec resume --session <id> [--workspace <id>] [--turn <id>] [message...]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec approve --session <id> --decision <id> [--deny] [--turn <id>] [--scope <once|turn>] [--approver <id>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec cancel --session <id> [--workspace <id>] [--turn <id>] [--reason <text>]\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec provider\n");
    expect(stdout).toHaveBeenCalledWith("   or: endec model\n");
    expect(stdout).toHaveBeenCalledWith("\n");
    expect(stdout).toHaveBeenCalledWith("tip: bare prompts are shorthand for 'endec execute <prompt...>'; use '--' to stop option parsing inside prompt text.\n");
  });

  it("shows root help flags without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("usage: endec <prompt...>\n");
  });

  it("shows subcommand help without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "execute", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      "usage: endec execute <prompt...> [--session <id>] [--workspace <id>] [--actor <id>] [--turn <id>] [--mode <chat|plan|act|review|task>] [--task <id>] [--resume-from <ref>]\n"
    );
  });

  it("shows approve help with once|turn only without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "approve", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      "usage: endec approve --session <id> --decision <id> [--deny] [--turn <id>] [--scope <once|turn>] [--approver <id>]\n"
    );
  });

  it("shows artifact command help without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "artifact", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("usage: endec artifact <preview|read> ...\n");
  });

  it("shows evidence command help without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "evidence", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("usage: endec evidence search --workspace <id> [--limit <n>] <query...>\n");
  });

  it("shows event help without bootstrapping the app", async () => {
    const stdout = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "event", "--help"],
      stdout: { write: stdout },
      stderr: { write: vi.fn() },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("usage: endec event --session <id> [--event <id> | --turn <id>]\n");
  });

  it("returns usage help when execute is selected without a prompt", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const appFactory = vi.fn(async () => createAppStub());

    const exitCode = await runCli({
      argv: ["node", "endec", "execute"],
      stdout: { write: stdout },
      stderr: { write: stderr },
      app: appFactory,
      now: () => 1700000000000
    });

    expect(exitCode).toBe(1);
    expect(appFactory).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("endec: missing prompt for execute\n");
    expect(stderr).toHaveBeenCalledWith(
      "usage: endec execute <prompt...> [--session <id>] [--workspace <id>] [--actor <id>] [--turn <id>] [--mode <chat|plan|act|review|task>] [--task <id>] [--resume-from <ref>]\n"
    );
  });

  it("accepts a bare prompt after -- so prompt text can contain option-like tokens", async () => {
    const executeTurn = vi.fn(async () =>
      createTurnResult({
        messages: [{ role: "assistant", content: "ok" }]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "--", "--mode", "plan"],
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          executeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(executeTurn).toHaveBeenCalledWith({
      turnId: "turn_1700000000000",
      sessionId: "session_cli_default",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_cli_user",
      input: "--mode plan",
      attachments: []
    });
  });

  it("accepts execute prompt text after -- so prompt text can contain option-like tokens", async () => {
    const executeTurn = vi.fn(async () =>
      createTurnResult({
        messages: [{ role: "assistant", content: "ok" }]
      })
    );

    const exitCode = await runCli({
      argv: ["node", "endec", "execute", "--session", "session_123", "--", "--mode", "plan"],
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      app: createAppStub({
        shell: {
          executeTurn
        }
      }),
      now: () => 1700000000000
    });

    expect(exitCode).toBe(0);
    expect(executeTurn).toHaveBeenCalledWith({
      turnId: "turn_1700000000000",
      sessionId: "session_123",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_cli_user",
      input: "--mode plan",
      attachments: []
    });
  });

  it("renders usage errors from the executable wrapper instead of a stack trace", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [new URL("../bin/endec.js", import.meta.url).pathname, "resume"],
      {
        cwd: new URL("../../..", import.meta.url).pathname,
        env: process.env
      }
    ).catch((error: { stdout: string; stderr: string; code: number }) => error);

    expect(stdout).toBe("");
    expect(stderr).toContain("endec: missing required option: --session\n");
    expect(stderr).toContain(
      "usage: endec resume --session <id> [--workspace <id>] [--turn <id>] [message...]\n"
    );
    expect(stderr).not.toContain("CliUsageError");
    expect(stderr).not.toContain("file://");
  });

  it("declares the app dependency and executable entry in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      dependencies?: Record<string, string>;
      bin?: string | Record<string, string>;
    };

    expect(packageJson.dependencies?.["@endec/app"]).toBe("workspace:*");
    expect(packageJson.bin).toEqual({ endec: "bin/endec.js" });
  });

  it("ships a runnable executable wrapper for the app-backed status command", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "endec-cli-smoke-"));
    const { stdout } = await execFileAsync(
      process.execPath,
      [new URL("../bin/endec.js", import.meta.url).pathname, "status"],
      {
        cwd: new URL("../../..", import.meta.url).pathname,
        env: {
          ...process.env,
          ENDEC_DATA_DIR: dataDir
        }
      }
    );

    expect(stdout).toContain("product: endec");
    expect(stdout).toContain(`dataDir: ${dataDir}`);
  });

  it("accepts --data-dir as a global executable override", async () => {
    const cwd = await createCliRootFixture({
      packageJsonName: "endec",
      createDataDir: true
    });
    const dataDir = await mkdtemp(join(tmpdir(), "endec-cli-override-"));
    const env = { ...process.env };
    delete env.ENDEC_DATA_DIR;

    const { stdout } = await execFileAsync(
      process.execPath,
      [new URL("../bin/endec.js", import.meta.url).pathname, "--data-dir", dataDir, "status"],
      {
        cwd,
        env
      }
    );

    expect(stdout).toContain("product: endec");
    expect(stdout).toContain(`dataDir: ${dataDir}`);
  });

  it("uses @endec/app in the CLI entrypoint and avoids the shell-only fallback strings", async () => {
    const files = await listTypeScriptFiles(new URL(".", import.meta.url).pathname);
    const sources = await Promise.all(files.map(async (file) => readFile(file, "utf8")));
    const combined = sources.join("\n");

    expect(combined).toContain('"@endec/app"');
    expect(combined).not.toContain("endec cli shell");
    expect(combined).not.toContain("shell facade is not wired into this build");
  });
});
