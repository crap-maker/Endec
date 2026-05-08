import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthoritativeTurnTruth,
  ContextAssemblyObservability,
  DurableMemorySelectionItem,
  OperatorRecoverySnapshot
} from "@endec/domain";
import type { ProviderTransport, ProviderTransportRequest } from "@endec/ai";
import { createEndecApp } from "./index.ts";
import { createOperatorTurnInspector } from "./operator-inspection.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

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

async function createTempDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), "endec-app-operator-inspection-"));
  tempDirs.add(dataDir);
  return dataDir;
}

function createTurnRequest(overrides: Partial<{
  turnId: string;
  sessionId: string;
  workspaceId: string;
  source: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk";
  actorId: string;
  input: string;
  requestedMode: "chat" | "plan" | "act" | "review" | "task";
}> = {}) {
  return {
    turnId: "turn_operator_inspection",
    sessionId: "session_operator_inspection",
    workspaceId: "workspace_operator_inspection",
    source: "cli" as const,
    actorId: "actor_operator",
    input: "run a controlled bash command requiring approval",
    attachments: [],
    requestedMode: "act" as const,
    ...overrides
  };
}

function createOriginalTruth(overrides: Partial<AuthoritativeTurnTruth> = {}): AuthoritativeTurnTruth {
  return {
    schemaVersion: 1,
    contractVersion: "ws6.authoritative-turn-truth.v1",
    source: "cli",
    channel: "cli",
    mode: "act",
    replyPath: "normal",
    boundary: {
      workspace: {
        root: "workspace_operator_inspection",
        kind: "isolated_worktree",
        summary: "Original turn workspace boundary."
      }
    },
    capabilityTruth: {
      visibleToolNames: ["read", "glob"],
      guaranteedToolNames: ["read", "glob"],
      guaranteedCapabilities: ["workspace_read"],
      approvalRequiredCapabilities: [],
      notGuaranteedCapabilities: ["workspace_write", "workspace_local_routine_bash", "remote_git_push"],
      actionAuthorizations: [
        {
          actionClass: "workspace_read",
          toolName: "read",
          authorizationLevel: "guaranteed",
          boundaryReason: "The original assembled turn only exposed read access.",
          examples: ["read README.md"]
        }
      ]
    },
    constraints: [],
    antiDriftRules: ["Use the original assembled truth."],
    ...overrides
  };
}

function createOriginalObservability(truth: AuthoritativeTurnTruth, overrides: Partial<ContextAssemblyObservability> = {}): ContextAssemblyObservability {
  const observability: ContextAssemblyObservability = {
    authoritativeTruth: {
      packet: truth,
      summary: {
        replyPath: truth.replyPath,
        guaranteedToolNames: truth.capabilityTruth.guaranteedToolNames,
        approvalRequiredCapabilities: truth.capabilityTruth.approvalRequiredCapabilities,
        notGuaranteedCapabilities: truth.capabilityTruth.notGuaranteedCapabilities,
        actionAuthorizations: truth.capabilityTruth.actionAuthorizations,
        antiDriftRules: truth.antiDriftRules
      },
      consistency: {
        exposedToolsMatchSelection: false,
        replyPathMatchesSelfAwareness: false,
        constraintCodesMatch: false
      }
    },
    continuity: {
      route: "ordinary",
      blocks: {
        activeTask: {
          selectionStatus: "not-selected",
          injectionStatus: "not-requested",
          sourceRefs: [],
          carryForwardKinds: []
        },
        workingSet: {
          selectionStatus: "missing",
          injectionStatus: "skeleton",
          reason: "Preserved from original observability.",
          sourceRefs: ["working_set:original"],
          carryForwardKinds: []
        },
        recentHistory: {
          selectionStatus: "not-selected",
          injectionStatus: "not-requested",
          sourceRefs: [],
          carryForwardKinds: []
        }
      }
    },
    durableMemory: {
      route: "ordinary",
      preferredScopes: [],
      preferredFamilies: [],
      preferredBuckets: [],
      items: [],
      summary: "Original durable memory observability."
    },
    truncation: {
      memoryInjectionBudget: 64,
      memoryTokensUsed: 17,
      memoryTruncated: true,
      items: [
        {
          blockId: "memory:original:working_set",
          layer: "continuity_core",
          outcome: "skeleton",
          reason: "Original assembly preserved only a skeleton."
        }
      ]
    },
    driftDiagnostics: {
      issues: [
        {
          code: "original_drift_diagnostic",
          severity: "warning",
          message: "Original observability diagnostic.",
          evidence: {
            source: "original"
          }
        }
      ]
    },
    diagnostics: [],
    contextBudget: {
      budgetResolution: {
        mode: "act",
        budgetProfile: "balanced",
        budgetProfileSource: "profile_default",
        inputBudgetSource: "profile_default",
        memoryBudgetSource: "profile_default",
        providerId: "provider_local",
        modelId: "model_strong",
        protocolFamily: "chat_completions",
        maxContextTokens: 200000,
        maxContextTokensSource: "provider_capability",
        usableContext: 188000,
        outputReserveTokens: 8000,
        toolSchemaTokenEstimate: 1000,
        safetyReserveTokens: 3000,
        unestimatedComponents: [],
        effectiveInputTokenBudget: 50000,
        effectiveMemoryInjectionBudget: 5000,
        maxMemoryShareOfInput: 0.4,
        capHits: [],
        capReasons: [],
        overridesApplied: []
      },
      selectedMemoryCount: 2,
      injectedMemoryCount: 1,
      droppedMemoryCount: 1,
      selectedMemorySourceRefs: ["working_set:original", "task:original"],
      injectedMemorySourceRefs: ["working_set:original"],
      droppedMemorySourceRefs: ["task:original"],
      promptBlocks: [
        {
          blockId: "authoritative_turn_truth:turn_original_truth",
          kind: "instruction",
          layer: "authoritative_truth",
          estimatedTokens: 120,
          status: "included"
        },
        {
          blockId: "memory:original:working_set",
          kind: "task",
          layer: "continuity_core",
          estimatedTokens: 17,
          status: "partial",
          reason: "budget_preserve_continuity_core"
        }
      ],
      projectedInputTokensBeforeFitting: 6200,
      projectedInputTokensAfterFitting: 5100,
      projectedMemoryTokensBeforeFitting: 100,
      projectedMemoryTokensAfterFitting: 17,
      remainingHeadroomEstimate: 44883,
      toolSchemaAccounting: {
        status: "estimated",
        totalTokens: 1000,
        perTool: []
      }
    },
    humanSummary: "original-observability-summary",
    ...overrides
  };

  return {
    ...observability,
    diagnostics: overrides.diagnostics ?? observability.diagnostics
  };
}

function createRecoverySnapshotWithOriginals(input: {
  truth: AuthoritativeTurnTruth;
  observability: ContextAssemblyObservability;
}): OperatorRecoverySnapshot {
  return {
    schemaVersion: 1,
    contractVersion: "ws5.operator-recovery-snapshot.v1",
    runtimeAwarenessContractVersion: "ws5.runtime-self-awareness.v1",
    sessionId: "session_operator_inspection",
    workspaceId: "workspace_operator_inspection",
    recoverable: true,
    hasPendingExecution: true,
    turnId: "turn_original_truth",
    frameRef: "frame:turn_original_truth",
    pendingExecutionId: "pending:turn_original_truth",
    blockedBy: "permission",
    waitingReason: "permission",
    state: "awaiting_permission",
    allowedActions: ["approve", "deny", "cancel"],
    pendingApprovalRef: "decision_original",
    pendingDecision: {
      decisionId: "decision_original",
      behavior: "ask",
      scope: "once",
      reasonCode: "tool_requires_approval",
      reasonText: "original decision requires approval",
      issuedAt: "2026-04-10T10:00:00.000Z",
      requestedBy: "turn_original_truth"
    },
    checkpointRef: "checkpoint:turn_original_truth",
    contextSummary: {
      sessionId: "session_operator_inspection",
      workspaceId: "workspace_operator_inspection",
      source: "cli",
      mode: "act",
      currentGoal: "inspect original truth",
      activeTaskIds: [],
      recentTurnRefs: []
    },
    runtimeSelfAwareness: {
      schemaVersion: 1,
      contractVersion: "ws5.runtime-self-awareness.v1",
      source: "cli",
      channel: "cli",
      mode: "act",
      exposedToolNames: ["bash"],
      replyPath: "blocked",
      constraints: []
    },
    authoritativeTruth: input.truth,
    observability: input.observability
  };
}

describe("operator turn inspector original context projection", () => {
  it("uses original pending-turn truth and observability instead of current tool exposure", async () => {
    const truth = createOriginalTruth();
    const observability = createOriginalObservability(truth);
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    });

    expect(inspection?.truth).toEqual(truth);
    expect(inspection?.truth.capabilityTruth.visibleToolNames).toEqual(["read", "glob"]);
    expect(inspection?.truth.capabilityTruth.guaranteedToolNames).not.toContain("bash");
    expect(inspection?.context.observability.authoritativeTruth.consistency).toEqual({
      exposedToolsMatchSelection: false,
      replyPathMatchesSelfAwareness: false,
      constraintCodesMatch: false
    });
    expect(inspection?.context.observability.humanSummary).toBe("original-observability-summary");
    expect(inspection?.context.summary.truncationSummary).toContain("0 context item(s) dropped");
    expect(inspection?.context.summary.truncationSummary).toContain("profile=balanced");
    expect(inspection?.context.summary.truncationSummary).toContain("provider=provider_local/model_strong");
    expect(inspection?.context.summary.truncationSummary).toContain("maxContextTokens=200000");
    expect(inspection?.context.summary.truncationSummary).toContain("input=50000");
    expect(inspection?.context.summary.truncationSummary).toContain("memory=5000");
    expect(inspection?.context.summary.truncationSummary).toContain("usableContext=188000");
    expect(inspection?.context.summary.budgetSummary).toBe("profile=balanced; provider=provider_local/model_strong; maxContextTokens=200000; usableContext=188000; input=50000; memory=5000; caps=none; unestimated=none");
    expect(inspection?.context.observability.contextBudget?.selectedMemorySourceRefs).toEqual(["working_set:original", "task:original"]);
    expect(inspection?.context.observability.contextBudget?.injectedMemorySourceRefs).toEqual(["working_set:original"]);
    expect(inspection?.context.observability.contextBudget?.droppedMemorySourceRefs).toEqual(["task:original"]);
    expect(inspection?.context.observability.contextBudget?.promptBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ blockId: "memory:original:working_set", kind: "task", status: "partial" })
    ]));
    expect(inspection?.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "budget-profile",
        subjectRef: "context.observability.contextBudget",
        summary: expect.stringContaining("provider_local/model_strong"),
        detail: expect.stringContaining("outputReserveTokens=8000")
      })
    ]));
  });

  it("renders budget detail from shared context-budget truth when requested", async () => {
    const truth = createOriginalTruth();
    const observability = createOriginalObservability(truth);
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      },
      detail: {
        sections: ["budget"]
      }
    });

    expect(inspection?.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "budget-detail",
        subjectRef: "context.observability.contextBudget",
        summary: expect.stringContaining("usableContext=188000"),
        detail: expect.stringContaining("outputReserveTokens=8000")
      })
    ]));
  });

  it("renders shared budget refs, prompt blocks, and tool schema accounting in budget detail", async () => {
    const truth = createOriginalTruth();
    const observability = createOriginalObservability(truth, {
      contextBudget: {
        ...createOriginalObservability(truth).contextBudget!,
        selectedMemorySourceRefs: ["working_set:original", "task:original", "evidence:original"],
        injectedMemorySourceRefs: ["working_set:original"],
        droppedMemorySourceRefs: ["task:original", "evidence:original"],
        promptBlocks: [
          {
            blockId: "authoritative_turn_truth:turn_original_truth",
            kind: "instruction",
            layer: "authoritative_truth",
            title: "authoritative current-turn truth",
            estimatedTokens: 120,
            status: "included"
          },
          {
            blockId: "memory:original:working_set",
            kind: "task",
            layer: "continuity_core",
            title: "session working set",
            estimatedTokens: 17,
            status: "partial",
            reason: "budget_preserve_continuity_core"
          },
          {
            blockId: "memory:original:evidence:0",
            kind: "resource",
            layer: "evidence",
            title: "evidence",
            estimatedTokens: 24,
            status: "dropped",
            reason: "budget_reserved_for_higher_priority_context"
          },
          {
            blockId: "tool_schema:all",
            kind: "tool_schema",
            layer: "tool_schema",
            title: "tool schemas",
            estimatedTokens: 1000,
            status: "included"
          }
        ],
        toolSchemaAccounting: {
          status: "estimated",
          totalTokens: 1000,
          perTool: [
            {
              toolName: "read",
              estimatedTokens: 400
            },
            {
              toolName: "glob",
              estimatedTokens: 600
            }
          ]
        }
      }
    });
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      },
      detail: {
        verbosity: "full",
        sections: ["budget"]
      }
    });

    expect(inspection?.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "budget-detail",
        subjectRef: "context.observability.contextBudget",
        detail: expect.stringContaining("selectedMemorySourceRefs=working_set:original,task:original,evidence:original")
      }),
      expect.objectContaining({
        code: "budget-detail",
        detail: expect.stringContaining("injectedMemorySourceRefs=working_set:original")
      }),
      expect.objectContaining({
        code: "budget-detail",
        detail: expect.stringContaining("droppedMemorySourceRefs=task:original,evidence:original")
      }),
      expect.objectContaining({
        code: "budget-detail",
        detail: expect.stringContaining("promptBlocks=authoritative_turn_truth:turn_original_truth:authoritative_truth:included:120")
      }),
      expect.objectContaining({
        code: "budget-detail",
        detail: expect.stringContaining("memory:original:evidence:0:evidence:dropped:24:budget_reserved_for_higher_priority_context")
      }),
      expect.objectContaining({
        code: "budget-detail",
        detail: expect.stringContaining("toolSchemaAccounting=estimated:1000")
      }),
      expect.objectContaining({
        code: "budget-detail",
        detail: expect.stringContaining("perTool=read:400,glob:600")
      })
    ]));
  });

  it("enriches blocked pending continuation with recovery truth, constraints, authorization, observability summaries, and correction hints", async () => {
    const truth = createOriginalTruth({
      replyPath: "blocked",
      capabilityTruth: {
        visibleToolNames: ["bash", "read"],
        guaranteedToolNames: ["read"],
        guaranteedCapabilities: ["workspace_read"],
        approvalRequiredCapabilities: ["remote_git_push"],
        notGuaranteedCapabilities: ["deploy"],
        actionAuthorizations: [
          {
            actionClass: "remote_git_push",
            toolName: "bash",
            authorizationLevel: "approval-required",
            boundaryReason: "Remote git push changes remote branch state and requires operator approval.",
            approvalPath: "operator",
            examples: ["git push origin HEAD"]
          }
        ]
      },
      constraints: [
        {
          code: "remote_git_push_requires_approval",
          summary: "Remote git push is blocked until the pending approval decision is resolved.",
          blocking: true,
          metadata: {
            decisionId: "tool_call_push_001"
          }
        }
      ]
    });
    const workingSetTarget = {
      kind: "working_set" as const,
      sessionId: "session_operator_inspection",
      workspaceId: "workspace_operator_inspection",
      workingSetRef: "working_set:blocked:1"
    };
    const typedMemoryTarget = {
      kind: "typed_memory" as const,
      memoryId: "mem_stale_blocker",
      scope: "workspace" as const,
      workspaceId: "workspace_operator_inspection"
    };
    const observability = createOriginalObservability(truth, {
      continuity: {
        route: "active_task_preferred",
        blocks: {
          activeTask: {
            blockId: "active_task:operator_surface",
            title: "Ship operator continuation surface",
            selectionStatus: "selected",
            injectionStatus: "full",
            reason: "Requested task is the active blocked task.",
            sourceRefs: ["task:operator_surface"],
            carryForwardKinds: ["current_step"],
            selectedBy: "request_task"
          },
          workingSet: {
            blockId: "working_set:blocked:1",
            title: "Operator surface working set",
            selectionStatus: "selected",
            injectionStatus: "skeleton",
            reason: "Working set may be stale before approving the blocked push.",
            sourceRefs: ["working_set:blocked:1"],
            carryForwardKinds: ["objective", "blockers"],
            selectedBy: "request_task",
            correctionTarget: workingSetTarget
          },
          recentHistory: {
            selectionStatus: "selected",
            injectionStatus: "partial",
            sourceRefs: ["turn:previous"],
            carryForwardKinds: ["decision"]
          }
        }
      },
      durableMemory: {
        route: "active_task_preferred",
        preferredScopes: ["workspace"],
        preferredFamilies: ["continuity"],
        preferredBuckets: ["operator"],
        items: [
          {
            memoryId: typedMemoryTarget.memoryId,
            writeId: "write_stale_blocker",
            sourceTurnId: "turn_stale_blocker",
            scope: "workspace",
            memoryType: "continuity",
            family: "continuity",
            bucket: "operator",
            route: "active_task_preferred",
            rank: 1,
            taskMatch: true,
            selectionStatus: "selected",
            injectionStatus: "injected",
            reasons: ["selected but operator may need to stale it before continuation"],
            summary: "Stale blocker memory can be corrected before approval.",
            correctionTarget: typedMemoryTarget
          }
        ],
        summary: "one correction-capable continuity memory"
      }
    });
    const snapshot = {
      ...createRecoverySnapshotWithOriginals({ truth, observability }),
      allowedActions: ["approve", "deny", "resume", "cancel"] satisfies OperatorRecoverySnapshot["allowedActions"],
      pendingApprovalRef: "tool_call_push_001",
      pendingDecision: {
        decisionId: "tool_call_push_001",
        behavior: "ask" as const,
        scope: "once" as const,
        reasonCode: "tool_requires_approval",
        reasonText: "remote git push requires operator approval before it can run",
        issuedAt: "2026-04-10T10:00:00.000Z",
        requestedBy: "turn_original_truth"
      },
      runtimeSelfAwareness: {
        schemaVersion: 1 as const,
        contractVersion: "ws5.runtime-self-awareness.v1" as const,
        source: "cli" as const,
        channel: "cli" as const,
        mode: "act" as const,
        exposedToolNames: ["bash"],
        replyPath: "blocked" as const,
        constraints: [
          {
            code: "runtime_pending_decision",
            summary: "Runtime is waiting on the pending approval decision.",
            blocking: true,
            metadata: {
              decisionId: "tool_call_push_001"
            }
          }
        ]
      }
    };
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => snapshot)
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    });

    expect(inspection?.summary.state).toBe("blocked");
    expect(inspection?.continuation).toMatchObject({
      state: "blocked",
      replyPath: "blocked",
      blockedBy: "permission",
      waitingReason: "permission",
      pendingExecutionId: "pending:turn_original_truth",
      frameRef: "frame:turn_original_truth",
      checkpointRef: "checkpoint:turn_original_truth",
      pendingDecision: expect.objectContaining({
        decisionId: "tool_call_push_001",
        reasonText: expect.stringContaining("remote git push")
      }),
      actionAuthorization: expect.objectContaining({
        actionClass: "remote_git_push",
        authorizationLevel: "approval-required",
        boundaryReason: expect.stringContaining("requires operator approval")
      })
    });
    expect(inspection?.continuation?.allowedActions.map((action) => action.kind)).toEqual(["approve", "deny", "resume", "cancel"]);
    expect(inspection?.continuation?.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "remote_git_push_requires_approval", blocking: true }),
      expect.objectContaining({ code: "runtime_pending_decision", blocking: true })
    ]));
    expect(inspection?.continuation?.activeTaskSummary).toContain("activeTask selected/full");
    expect(inspection?.continuation?.activeTaskSummary).toContain("Ship operator continuation surface");
    expect(inspection?.continuation?.workingSetSummary).toContain("workingSet selected/skeleton");
    expect(inspection?.continuation?.workingSetSummary).toContain("Working set may be stale");
    expect(inspection?.continuation?.correctionHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "working_set:blocked:1", targetKind: "working_set" }),
      expect.objectContaining({ targetId: "mem_stale_blocker", targetKind: "typed_memory" })
    ]));
    expect(inspection?.explanation.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "approve-pending-decision", kind: "approve" }),
      expect.objectContaining({ code: "resume-pending-execution", kind: "resume" }),
      expect.objectContaining({ code: "cancel-pending-execution", kind: "cancel" }),
      expect.objectContaining({ code: "inspect-correction-targets", kind: "inspect" }),
      expect.objectContaining({ code: "apply-correction", kind: "correct" })
    ]));
    expect(inspection?.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "blocked-continuation", subjectRef: "continuation" }),
      expect.objectContaining({ code: "action-authorization", subjectRef: "truth.capabilityTruth.actionAuthorizations" })
    ]));
    expect(inspection?.context.summary.continuationSummary).toContain("blocked continuation via blocked");
    expect(inspection?.context.summary.continuationSummary).toContain("remote_git_push is approval-required");
    expect(inspection?.context.summary.continuationSummary).not.toContain("{\"");
  });

  it("returns null for recoverable targets that do not expose original assembled truth", async () => {
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => ({
          ...createRecoverySnapshotWithOriginals({
            truth: createOriginalTruth(),
            observability: createOriginalObservability(createOriginalTruth())
          }),
          authoritativeTruth: undefined,
          observability: undefined
        }))
      }
    });

    await expect(inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    })).resolves.toBeNull();
  });
  it("exposes working-set correction targets as operator recommendations", async () => {
    const truth = createOriginalTruth();
    const workingSetTarget = {
      kind: "working_set" as const,
      sessionId: "session_operator_inspection",
      workspaceId: "workspace_operator_inspection",
      workingSetRef: "working_set:session_operator_inspection:7"
    };
    const observability = createOriginalObservability(truth, {
      continuity: {
        route: "ordinary",
        blocks: {
          activeTask: {
            selectionStatus: "not-selected",
            injectionStatus: "not-requested",
            sourceRefs: [],
            carryForwardKinds: []
          },
          workingSet: {
            selectionStatus: "selected",
            injectionStatus: "skeleton",
            reason: "Working set is present but only skeleton fit in context.",
            sourceRefs: ["working_set:session_operator_inspection:7"],
            carryForwardKinds: ["objective"],
            correctionTarget: workingSetTarget
          },
          recentHistory: {
            selectionStatus: "not-selected",
            injectionStatus: "not-requested",
            sourceRefs: [],
            carryForwardKinds: []
          }
        }
      }
    });
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    });

    expect(inspection?.correction.available).toBe(true);
    expect(inspection?.correction.workingSetTarget).toEqual(workingSetTarget);
    expect(inspection?.correction.recommendedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: "working_set:session_operator_inspection:7",
        targetKind: "working_set",
        recommendedOperation: "refresh_working_set"
      })
    ]));
    expect(inspection?.context.summary.correctionSummary).toContain("working set correction");
  });

  it("exposes active typed-memory correction targets and ignores corrected-out targets", async () => {
    const truth = createOriginalTruth();
    const activeTarget = {
      kind: "typed_memory" as const,
      memoryId: "mem_active_preference",
      scope: "user" as const,
      workspaceId: "workspace_other",
      actorId: "actor_operator"
    };
    const staleTarget = {
      kind: "typed_memory" as const,
      memoryId: "mem_stale_preference",
      scope: "user" as const,
      workspaceId: "workspace_other",
      actorId: "actor_operator"
    };
    const supersededTarget = {
      kind: "typed_memory" as const,
      memoryId: "mem_superseded_preference",
      scope: "user" as const,
      workspaceId: "workspace_other",
      actorId: "actor_operator"
    };
    const disabledTarget = {
      kind: "typed_memory" as const,
      memoryId: "mem_disabled_preference",
      scope: "user" as const,
      workspaceId: "workspace_other",
      actorId: "actor_operator"
    };
    const durableItems: DurableMemorySelectionItem[] = [
      {
        memoryId: activeTarget.memoryId,
        writeId: "write_active_preference",
        sourceTurnId: "turn_active_preference",
        scope: "user",
        memoryType: "preference",
        family: "preference",
        bucket: "preference",
        route: "ordinary",
        rank: 1,
        taskMatch: false,
        selectionStatus: "selected",
        injectionStatus: "injected",
        reasons: ["selected for current context"],
        summary: "Active preference remains selectable.",
        correctionTarget: activeTarget
      },
      {
        memoryId: staleTarget.memoryId,
        writeId: "write_stale_preference",
        sourceTurnId: "turn_stale_preference",
        scope: "user",
        memoryType: "preference",
        family: "preference",
        bucket: "preference",
        route: "ordinary",
        taskMatch: false,
        selectionStatus: "corrected-out",
        injectionStatus: "not-applicable",
        reasons: ["stale"],
        summary: "Stale preference should not be re-recommended.",
        correctionTarget: staleTarget
      },
      {
        memoryId: supersededTarget.memoryId,
        writeId: "write_superseded_preference",
        sourceTurnId: "turn_superseded_preference",
        scope: "user",
        memoryType: "preference",
        family: "preference",
        bucket: "preference",
        route: "ordinary",
        taskMatch: false,
        selectionStatus: "corrected-out",
        injectionStatus: "not-applicable",
        reasons: ["superseded", "superseded_by:mem_active_preference"],
        summary: "Superseded preference should not be re-recommended.",
        correctionTarget: supersededTarget
      },
      {
        memoryId: disabledTarget.memoryId,
        writeId: "write_disabled_preference",
        sourceTurnId: "turn_disabled_preference",
        scope: "user",
        memoryType: "preference",
        family: "preference",
        bucket: "preference",
        route: "ordinary",
        taskMatch: false,
        selectionStatus: "corrected-out",
        injectionStatus: "not-applicable",
        reasons: ["disabled"],
        summary: "Disabled preference should not be re-recommended.",
        correctionTarget: disabledTarget
      }
    ];
    const observability = createOriginalObservability(truth, {
      durableMemory: {
        route: "ordinary",
        preferredScopes: ["user"],
        preferredFamilies: ["preference"],
        preferredBuckets: ["preference"],
        items: durableItems,
        summary: "durable memory with one active and one corrected-out target"
      }
    });
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    });

    expect(inspection?.correction.available).toBe(true);
    expect(inspection?.correction.typedMemoryTargetCount).toBe(1);
    expect(inspection?.correction.recommendedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: activeTarget.memoryId,
        targetKind: "typed_memory",
        recommendedOperation: "mark_memory_stale"
      })
    ]));
    expect(inspection?.correction.recommendedTargets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: staleTarget.memoryId
      })
    ]));
    expect(inspection?.correction.recommendedTargets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: supersededTarget.memoryId
      })
    ]));
    expect(inspection?.correction.recommendedTargets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: disabledTarget.memoryId
      })
    ]));
  });

  it("keeps correction unavailable and compact when observability has no correction targets", async () => {
    const truth = createOriginalTruth();
    const observability = createOriginalObservability(truth);
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    });

    expect(inspection?.correction.available).toBe(false);
    expect(inspection?.correction.recommendedTargets).toEqual([]);
    expect(inspection?.context.summary.correctionSummary).toBe("No correction targets are available.");
  });

  it("adds structured correction inspect/apply hints without CLI command strings", async () => {
    const truth = createOriginalTruth();
    const observability = createOriginalObservability(truth, {
      continuity: {
        route: "ordinary",
        blocks: {
          activeTask: {
            selectionStatus: "not-selected",
            injectionStatus: "not-requested",
            sourceRefs: [],
            carryForwardKinds: []
          },
          workingSet: {
            selectionStatus: "selected",
            injectionStatus: "skeleton",
            sourceRefs: ["working_set:session_operator_inspection:3"],
            carryForwardKinds: [],
            correctionTarget: {
              kind: "working_set",
              sessionId: "session_operator_inspection",
              workspaceId: "workspace_operator_inspection",
              workingSetRef: "working_set:session_operator_inspection:3"
            }
          },
          recentHistory: {
            selectionStatus: "not-selected",
            injectionStatus: "not-requested",
            sourceRefs: [],
            carryForwardKinds: []
          }
        }
      }
    });
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const inspection = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    });

    expect(inspection?.explanation.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "inspect-correction-targets",
        kind: "inspect",
        targetRef: "correction"
      }),
      expect.objectContaining({
        code: "apply-correction",
        kind: "correct",
        targetRef: "working_set:session_operator_inspection:3"
      })
    ]));
    expect(JSON.stringify(inspection?.explanation.nextActions)).not.toMatch(/endec .*correction|pnpm|cli/i);
  });

  it("explains correction availability and detail requests without changing next action conclusions", async () => {
    const truth = createOriginalTruth();
    const observability = createOriginalObservability(truth, {
      durableMemory: {
        route: "ordinary",
        preferredScopes: ["workspace"],
        preferredFamilies: ["fact"],
        preferredBuckets: ["project"],
        items: [
          {
            memoryId: "mem_project_fact",
            writeId: "write_project_fact",
            sourceTurnId: "turn_project_fact",
            scope: "workspace",
            memoryType: "fact",
            family: "fact",
            bucket: "project",
            route: "ordinary",
            rank: 1,
            taskMatch: false,
            selectionStatus: "selected",
            injectionStatus: "injected",
            reasons: ["selected for workspace"],
            correctionTarget: {
              kind: "typed_memory",
              memoryId: "mem_project_fact",
              scope: "workspace",
              workspaceId: "workspace_operator_inspection"
            }
          }
        ]
      }
    });
    const inspector = createOperatorTurnInspector({
      recoveryStore: {
        getRecoverySnapshot: vi.fn(async () => createRecoverySnapshotWithOriginals({ truth, observability }))
      }
    });

    const compact = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      }
    });
    const detailed = await inspector({
      target: {
        sessionId: "session_operator_inspection",
        workspaceId: "workspace_operator_inspection",
        turnId: "turn_original_truth"
      },
      detail: {
        sections: ["correction"]
      }
    });

    expect(compact?.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "correction-available",
        subjectRef: "correction"
      })
    ]));
    expect(detailed?.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "correction-detail",
        subjectRef: "correction"
      })
    ]));
    expect(detailed?.truth).toEqual(compact?.truth);
    expect(detailed?.correction).toEqual(compact?.correction);
    expect(detailed?.explanation.nextActions).toEqual(compact?.explanation.nextActions);
  });

});

type InspectOperatorTurn = NonNullable<ReturnType<typeof createEndecApp>["operator"]["inspectOperatorTurn"]>;

async function createBlockedInspection(detail?: Parameters<InspectOperatorTurn>[0]["detail"]) {
  const dataDir = await createTempDataDir();
  const capturedRequests: ProviderTransportRequest[] = [];
  const app = createEndecApp({
    dataDir,
    providerTransport: createChatCompletionTransport([
      [
        {
          choices: [
            {
              delta: {
                content: "requesting approval for remote git operation"
              }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool_call_push_001",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({ command: "git push --dry-run . HEAD:refs/heads/operator-inspection" })
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 18,
            total_tokens: 48
          }
        }
      ]
    ], (request) => capturedRequests.push(request))
  });

  const turn = createTurnRequest();
  const blocked = await app.shell.executeTurn(turn);
  const inspectOperatorTurn = app.operator.inspectOperatorTurn;
  expect(inspectOperatorTurn).toBeDefined();
  if (!inspectOperatorTurn) {
    throw new Error("inspectOperatorTurn is not available");
  }
  const inspection = await inspectOperatorTurn({
    target: {
      sessionId: turn.sessionId,
      workspaceId: turn.workspaceId,
      actorId: turn.actorId,
      turnId: turn.turnId
    },
    detail
  });

  return { app, blocked, capturedRequests, inspection, turn };
}

describe("operator turn inspection", () => {
  it("returns null when the target has no recoverable or inspectable truth", async () => {
    const dataDir = await createTempDataDir();
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const inspectOperatorTurn = app.operator.inspectOperatorTurn;
    expect(inspectOperatorTurn).toBeDefined();
    if (!inspectOperatorTurn) {
      throw new Error("inspectOperatorTurn is not available");
    }
    await expect(inspectOperatorTurn({
      target: {
        sessionId: "missing_session",
        workspaceId: "workspace_operator_inspection"
      }
    })).resolves.toBeNull();
  });

  it("returns a compact operator-facing inspection for a recoverable pending target", async () => {
    const { blocked, inspection, turn } = await createBlockedInspection();

    expect(blocked.status).toBe("blocked");
    expect(inspection).not.toBeNull();
    expect(inspection).toMatchObject({
      target: {
        sessionId: turn.sessionId,
        workspaceId: turn.workspaceId,
        actorId: turn.actorId,
        turnId: turn.turnId
      },
      summary: {
        state: "blocked"
      },
      truth: {
        replyPath: "normal",
        capabilityTruth: {
          guaranteedToolNames: expect.arrayContaining(["bash"]),
          approvalRequiredCapabilities: expect.arrayContaining(["remote_git_push"]),
          actionAuthorizations: expect.arrayContaining([
            expect.objectContaining({
              actionClass: "remote_git_push",
              authorizationLevel: "approval-required"
            })
          ])
        }
      },
      context: {
        summary: {
          headline: expect.any(String),
          truthSummary: expect.stringContaining("guaranteed"),
          continuitySummary: expect.any(String),
          durableMemorySummary: expect.any(String),
          truncationSummary: expect.any(String),
          driftDiagnosticsSummary: expect.any(String),
          correctionSummary: expect.any(String)
        }
      },
      correction: {
        available: expect.any(Boolean),
        typedMemoryTargetCount: expect.any(Number),
        recommendedTargets: expect.any(Array)
      }
    });
  });

  it("builds explanation and next actions from structured OperatorActionHint data", async () => {
    const { inspection } = await createBlockedInspection();

    expect(inspection?.explanation).toMatchObject({
      headline: expect.any(String),
      summary: expect.stringContaining("approval"),
      explanations: expect.arrayContaining([
        expect.objectContaining({
          code: "truth-source",
          summary: expect.any(String)
        })
      ])
    });
    expect(inspection?.explanation.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "approve-pending-decision",
          kind: "approve",
          summary: expect.any(String),
          targetRef: "tool_call_push_001",
          requiresApproval: true
        }),
        expect.objectContaining({
          code: "cancel-pending-execution",
          kind: "cancel",
          summary: expect.any(String)
        })
      ])
    );
  });

  it("uses compact summaries by default instead of making explanation consumers parse raw observability JSON", async () => {
    const { inspection } = await createBlockedInspection();

    expect(inspection?.context.summary.headline).toContain("normal");
    expect(inspection?.explanation.summary).not.toContain("{\"");
    expect(inspection?.context.summary.continuitySummary).not.toContain("selectionStatus");
    expect(inspection?.context.summary.durableMemorySummary).not.toContain("correctionTarget");
    expect(inspection?.context.observability).toBeDefined();
  });

  it("accepts detail sections without changing truth or next action conclusions", async () => {
    const compact = await createBlockedInspection();
    const detailed = await createBlockedInspection({
      verbosity: "compact",
      sections: ["continuation", "correction"]
    });

    expect(detailed.inspection?.truth).toEqual(compact.inspection?.truth);
    expect(detailed.inspection?.explanation.nextActions).toEqual(compact.inspection?.explanation.nextActions);
    expect(detailed.inspection?.explanation.explanations.length ?? 0).toBeGreaterThan(
      compact.inspection?.explanation.explanations.length ?? 0
    );
  });

  it("does not explain capability from old mode-era assumptions", async () => {
    const { inspection } = await createBlockedInspection();
    const operatorFacingText = JSON.stringify({
      summary: inspection?.summary,
      explanation: inspection?.explanation,
      contextSummary: inspection?.context.summary
    });

    expect(operatorFacingText).not.toMatch(/because chat mode has no bash/i);
    expect(operatorFacingText).not.toMatch(/resolvedMode === chat/i);
    expect(operatorFacingText).not.toMatch(/chat mode has no bash/i);
    expect(operatorFacingText).not.toMatch(/mode-derived/i);
  });
});
