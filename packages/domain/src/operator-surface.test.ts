import { describe, expect, it } from "vitest";
import {
  InspectOperatorTurnRequestSchema,
  OperatorActionHintSchema,
  OperatorActiveRunStatusSchema,
  OperatorContinuationInspectionSchema,
  OperatorCorrectionTargetHintSchema,
  OperatorLastTurnStatusSchema,
  OperatorTurnInspectionSchema,
  type OperatorTurnInspection
} from "./index.ts";

const truthPacket = {
  source: "cli",
  channel: "cli",
  mode: "chat",
  replyPath: "normal",
  boundary: {
    workspace: {
      root: "/workspace",
      kind: "isolated_worktree",
      summary: "isolated workspace"
    }
  },
  capabilityTruth: {
    visibleToolNames: ["read", "bash"],
    guaranteedToolNames: ["read"],
    guaranteedCapabilities: ["inspect"],
    approvalRequiredCapabilities: ["write"],
    notGuaranteedCapabilities: ["deploy"],
    actionAuthorizations: [
      {
        actionClass: "inspect",
        toolName: "read",
        authorizationLevel: "guaranteed",
        boundaryReason: "read-only inspection is available"
      }
    ]
  },
  constraints: [],
  antiDriftRules: ["Use capabilityTruth, not mode, for operator capability conclusions."]
} as const;

const observability = {
  authoritativeTruth: {
    packet: truthPacket,
    summary: {
      replyPath: "normal",
      guaranteedToolNames: ["read"],
      approvalRequiredCapabilities: ["write"],
      notGuaranteedCapabilities: ["deploy"],
      actionAuthorizations: truthPacket.capabilityTruth.actionAuthorizations,
      antiDriftRules: truthPacket.antiDriftRules
    },
    consistency: {
      exposedToolsMatchSelection: true,
      replyPathMatchesSelfAwareness: true,
      constraintCodesMatch: true
    }
  },
  continuity: {
    route: "ordinary",
    blocks: {
      activeTask: {
        selectionStatus: "selected",
        injectionStatus: "full",
        reason: "active task selected",
        sourceRefs: ["task:1"],
        selectedBy: "latest_active_task"
      },
      workingSet: {
        selectionStatus: "selected",
        injectionStatus: "skeleton",
        reason: "budget kept working-set skeleton",
        sourceRefs: ["working-set:1"],
        correctionTarget: {
          kind: "working_set",
          sessionId: "session_001",
          workspaceId: "workspace_001",
          workingSetRef: "working-set:1"
        }
      },
      recentHistory: {
        selectionStatus: "selected",
        injectionStatus: "partial",
        reason: "recent anchors carried forward",
        sourceRefs: ["turn:prev"],
        carryForwardKinds: ["decision"]
      }
    }
  },
  durableMemory: {
    route: "ordinary",
    preferredScopes: ["workspace"],
    preferredFamilies: ["fact"],
    items: [
      {
        memoryId: "memory_001",
        scope: "workspace",
        memoryType: "fact",
        family: "fact",
        bucket: "project",
        route: "ordinary",
        rank: 1,
        taskMatch: true,
        selectionStatus: "selected",
        injectionStatus: "injected",
        reasons: ["task match"],
        summary: "Project fact",
        correctionTarget: {
          kind: "typed_memory",
          memoryId: "memory_001",
          scope: "workspace",
          workspaceId: "workspace_001",
          actorId: "actor_001"
        }
      }
    ]
  },
  truncation: {
    memoryInjectionBudget: 1000,
    memoryTokensUsed: 450,
    memoryTruncated: false,
    items: []
  },
  driftDiagnostics: {
    issues: []
  },
  humanSummary: "Truth and context assembled for operator inspection."
} as const;

const minimalInspection = {
  target: {
    sessionId: "session_001",
    workspaceId: "workspace_001"
  },
  summary: {
    state: "normal",
    headline: "Turn is inspectable"
  },
  explanation: {
    headline: "Truth is available",
    summary: "Operator inspection separates truth from explanation.",
    nextActions: [
      {
        code: "inspect-context",
        kind: "inspect",
        summary: "Inspect compact context summary"
      }
    ],
    explanations: [
      {
        code: "truth-source",
        summary: "Facts come from AuthoritativeTurnTruth."
      }
    ]
  },
  truth: truthPacket,
  context: {
    observability,
    summary: {
      headline: "Compact context ready",
      truthSummary: "1 guaranteed tool; 1 approval-required capability.",
      continuitySummary: "Active task full; working set skeleton.",
      durableMemorySummary: "1 durable memory item selected.",
      truncationSummary: "No memory truncation.",
      driftDiagnosticsSummary: "No drift diagnostics.",
      budgetSummary: "profile=balanced; maxContextTokens=200000; usableContext=188000; memory=5000",
      selectedBy: ["latest_active_task"]
    }
  },
  correction: {
    available: true,
    workingSetTarget: {
      kind: "working_set",
      sessionId: "session_001",
      workspaceId: "workspace_001",
      workingSetRef: "working-set:1"
    },
    typedMemoryTargetCount: 1,
    recommendedTargets: []
  }
} as const;

describe("operator surface domain contract", () => {
  it("parses a minimal compact inspection", () => {
    const parsed = OperatorTurnInspectionSchema.parse(minimalInspection);

    expect(parsed.summary.state).toBe("normal");
    expect(parsed.context.summary.headline).toBe("Compact context ready");
    expect(parsed.correction.typedMemoryTargetCount).toBe(1);
  });

  it("parses a full detail request", () => {
    const request = InspectOperatorTurnRequestSchema.parse({
      target: {
        sessionId: "session_001",
        workspaceId: "workspace_001",
        actorId: "actor_001",
        turnId: "turn_001",
        frameRef: "frame:turn_001"
      },
      detail: {
        verbosity: "full",
        sections: [
          "continuity",
          "durableMemory",
          "truncation",
          "driftDiagnostics",
          "continuation",
          "correction"
        ]
      }
    });

    expect(request.detail?.verbosity).toBe("full");
    expect(request.detail?.sections).toContain("correction");
  });

  it("nextActions uses OperatorActionHint", () => {
    const actionHint = OperatorActionHintSchema.parse({
      code: "approve-decision",
      kind: "approve",
      summary: "Approve the pending decision",
      targetRef: "decision_001",
      relatedRefs: ["frame:turn_001"],
      riskLevel: "medium",
      requiresApproval: true
    });

    const parsed = OperatorTurnInspectionSchema.parse({
      ...minimalInspection,
      explanation: {
        ...minimalInspection.explanation,
        nextActions: [actionHint]
      }
    });

    expect(parsed.explanation.nextActions[0]).toEqual(actionHint);
  });

  it("explanation is separate from truth", () => {
    const parsed: OperatorTurnInspection = OperatorTurnInspectionSchema.parse({
      ...minimalInspection,
      explanation: {
        headline: "Human-facing explanation",
        summary: "This text explains but does not define capability truth.",
        nextActions: [],
        explanations: [
          {
            code: "boundary",
            summary: "Boundary reason is explained for the operator.",
            subjectRef: "truth.capabilityTruth.actionAuthorizations[0]",
            severity: "info"
          }
        ]
      }
    });

    expect(parsed.truth.capabilityTruth.guaranteedToolNames).toEqual(["read"]);
    expect(parsed.explanation.summary).not.toEqual(parsed.context.summary.truthSummary);
  });

  it("correction target hint parses for working set and typed memory", () => {
    const workingSetHint = OperatorCorrectionTargetHintSchema.parse({
      targetId: "working-set:1",
      targetKind: "working_set",
      summary: "Working set may need refresh.",
      reason: "Working set was injected as skeleton.",
      detailRef: "correction.workingSet",
      sourceRefs: ["working-set:1"],
      recommendedOperation: "refresh_working_set"
    });

    const typedMemoryHint = OperatorCorrectionTargetHintSchema.parse({
      targetId: "memory_001",
      targetKind: "typed_memory",
      summary: "Memory may be stale.",
      reason: "Selected typed memory has stale evidence.",
      status: "active",
      detailRef: "correction.typedMemory[0]",
      sourceRefs: ["memory_001"],
      recommendedOperation: "mark_memory_stale"
    });

    expect(workingSetHint.targetKind).toBe("working_set");
    expect(typedMemoryHint.targetKind).toBe("typed_memory");
  });

  it("parses truthful active-run and last-turn status surfaces", () => {
    const activeRun = OperatorActiveRunStatusSchema.parse({
      state: "none"
    });
    const lastTurn = OperatorLastTurnStatusSchema.parse({
      state: "available",
      turnId: "turn_123",
      status: "completed",
      completedAt: "2026-05-02T00:00:00.000Z",
      usage: {
        inputTokens: 1200,
        outputTokens: 320,
        totalTokens: 1520,
        estimatedCost: 0.08,
        cache: {
          state: "not_reported"
        },
        context: {
          state: "estimated",
          usedTokens: 14000,
          maxTokens: 128000
        }
      }
    });

    expect(activeRun.state).toBe("none");
    expect(lastTurn.usage?.cache?.state).toBe("not_reported");
    expect(lastTurn.usage?.context?.maxTokens).toBe(128000);
  });

  it("continuation inspection can carry blocked state and allowed actions", () => {
    const continuation = OperatorContinuationInspectionSchema.parse({
      state: "blocked",
      replyPath: "blocked",
      allowedActions: [
        {
          code: "approve-decision",
          kind: "approve",
          summary: "Approve decision decision_001",
          targetRef: "decision_001",
          requiresApproval: true
        },
        {
          code: "cancel-execution",
          kind: "cancel",
          summary: "Cancel pending execution",
          riskLevel: "medium"
        }
      ],
      blockedBy: "permission",
      waitingReason: "permission",
      pendingExecutionId: "pending:turn_001",
      frameRef: "frame:turn_001",
      checkpointRef: "checkpoint:turn_001",
      pendingDecision: {
        decisionId: "decision_001",
        behavior: "ask",
        scope: "once",
        reasonCode: "tool_requires_approval",
        reasonText: "write_file requires approval",
        issuedAt: new Date().toISOString(),
        requestedBy: "turn_001"
      },
      constraints: [
        {
          code: "approval_required",
          summary: "Approval is required.",
          blocking: true
        }
      ],
      actionAuthorization: truthPacket.capabilityTruth.actionAuthorizations[0],
      activeTaskSummary: "Freeze operator contract",
      workingSetSummary: "Domain contract worktree",
      correctionHints: []
    });

    expect(continuation.state).toBe("blocked");
    expect(continuation.allowedActions.map((action) => action.kind)).toEqual(["approve", "cancel"]);
  });

  it("invalid detail section fails", () => {
    expect(() =>
      InspectOperatorTurnRequestSchema.parse({
        target: {
          sessionId: "session_001",
          workspaceId: "workspace_001"
        },
        detail: {
          sections: ["mode"]
        }
      })
    ).toThrow();
  });

  it("does not require a mode-as-capability shortcut", () => {
    const parsed = OperatorTurnInspectionSchema.parse({
      ...minimalInspection,
      truth: {
        ...truthPacket,
        mode: "chat",
        capabilityTruth: {
          ...truthPacket.capabilityTruth,
          guaranteedToolNames: ["bash"]
        }
      }
    });

    expect(parsed.truth.mode).toBe("chat");
    expect(parsed.truth.capabilityTruth.guaranteedToolNames).toEqual(["bash"]);
  });
});
