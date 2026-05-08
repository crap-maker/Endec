import type { CostLedger } from "@endec/domain";
import { describe, expect, it, vi } from "vitest";
import { createBudgetService, resolveEffectiveToolLoopLimits } from "./budget-service";
import {
  APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP,
  APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP,
  DEFAULT_MODE_BUDGETS,
  DEFAULT_TOOL_LOOP_POLICY
} from "./defaults";

describe("createBudgetService", () => {
  it("keeps legacy resolve(request) fallback behavior when provider capability is not supplied", async () => {
    const service = createBudgetService();

    const result = await service.resolve({
      turnId: "turn_chat_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "can you inspect your own code files",
      attachments: [],
      requestedMode: "chat"
    });

    expect(result.inputTokenBudget).toBe(DEFAULT_MODE_BUDGETS.chat.inputTokenBudget);
    expect(result.memoryInjectionBudget).toBe(DEFAULT_MODE_BUDGETS.chat.memoryInjectionBudget);
    expect(result.budgetDebug?.fallbackReason).toBe("model_context_unknown");
  });

  it("resolves chat mode to separate per-batch, per-turn, and loop budgets", async () => {
    const service = createBudgetService();

    const result = await service.resolve({
      turnId: "turn_chat_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "can you inspect your own code files",
      attachments: [],
      requestedMode: "chat"
    });

    expect(result.resolvedMode).toBe("chat");
    expect(result.inputTokenBudget).toBe(6_000);
    expect((result as Record<string, unknown>).maxToolCallsPerBatch).toBe(4);
    expect((result as Record<string, unknown>).maxToolCallsPerTurn).toBe(8);
    expect(result.maxLoopCount).toBe(4);
    expect((result as Record<string, unknown>).maxToolCallCount).toBeUndefined();
  });

  it("resolves act mode to the canonical budgets without selecting model identity", async () => {
    const service = createBudgetService();

    const result = await service.resolve({
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "fix this",
      attachments: [],
      requestedMode: "act"
    });

    expect(result.resolvedMode).toBe("act");
    expect(result.inputTokenBudget).toBe(10_000);
    expect((result as Record<string, unknown>).modelTier).toBeUndefined();
    expect((result as Record<string, unknown>).modelId).toBeUndefined();
    expect((result as Record<string, unknown>).providerId).toBeUndefined();
    expect((result as Record<string, unknown>).maxToolCallsPerBatch).toBe(3);
    expect((result as Record<string, unknown>).maxToolCallsPerTurn).toBe(6);
    expect(result.maxLoopCount).toBe(6);
  });

  it("records canonical cost rows through the ledger", async () => {
    const record = vi.fn(async (_input: CostLedger) => undefined);
    const service = createBudgetService({
      ledger: {
        record,
        list: async () => [],
        loadByTurnId: async () => undefined
      }
    });

    const ledgerId = await service.recordCost({
      ledgerId: "ledger_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      mode: "act",
      modelId: "strong-default",
      providerId: "local-default",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      estimatedCost: 0.01,
      memoryInjectedTokens: 20,
      toolResultInjectedTokens: 5,
      toolCallCount: 1,
      loopCount: 1,
      stopReason: "stop",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString()
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "strong-default",
        providerId: "local-default",
        toolCallCount: 1,
        loopCount: 1
      })
    );
    expect(ledgerId).toBe("ledger_001");
  });

  it("passes through missing cache metrics without inventing zero values", async () => {
    const record = vi.fn(async (_input: CostLedger) => undefined);
    const service = createBudgetService({
      ledger: {
        record,
        list: async () => [],
        loadByTurnId: async () => undefined
      }
    });

    await service.recordCost({
      ledgerId: "ledger_002",
      turnId: "turn_002",
      sessionId: "session_002",
      workspaceId: "workspace_local",
      mode: "act",
      modelId: "strong-default",
      providerId: "local-default",
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      estimatedCost: 0.001,
      memoryInjectedTokens: 0,
      toolResultInjectedTokens: 0,
      toolCallCount: 0,
      loopCount: 1,
      stopReason: "stop",
      startedAt: new Date(2).toISOString(),
      endedAt: new Date(3).toISOString()
    });

    const input = record.mock.calls[0]?.[0];
    expect(input?.cacheReadTokens).toBeUndefined();
    expect(input?.cacheWriteTokens).toBeUndefined();
  });
});

describe("tool-loop policy resolution", () => {
  describe("approved defaults", () => {
    it("resolves default repair attempts to 2", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8
      });
      expect(result.maxToolBatchRepairAttempts).toBe(2);
    });

    it("resolves default repair hard cap to 3", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8
      });
      expect(result.maxToolBatchRepairAttemptsHardCap).toBe(3);
    });

    it("resolves default global batch hard cap to 8", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8
      });
      expect(result.globalMaxToolCallsPerBatchHardCap).toBe(8);
    });

    const modeBatchDefaults: Record<string, number> = DEFAULT_TOOL_LOOP_POLICY.maxToolCallsPerBatchByMode;
    for (const [mode, expected] of Object.entries(modeBatchDefaults)) {
      it(`resolves ${mode} batch limit to ${expected}`, async () => {
        const service = createBudgetService();
        const result = await service.resolve({
          turnId: "turn_001",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          source: "cli",
          actorId: "actor_user",
          input: "test",
          attachments: [],
          requestedMode: mode as "chat" | "plan" | "act" | "review" | "task"
        });
        expect(result.maxToolCallsPerBatch).toBe(expected);
      });
    }

    const modeTurnDefaults: Record<string, number> = DEFAULT_TOOL_LOOP_POLICY.maxToolCallsPerTurnByMode;
    for (const [mode, expected] of Object.entries(modeTurnDefaults)) {
      it(`resolves ${mode} turn limit to ${expected}`, async () => {
        const service = createBudgetService();
        const result = await service.resolve({
          turnId: "turn_001",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          source: "cli",
          actorId: "actor_user",
          input: "test",
          attachments: [],
          requestedMode: mode as "chat" | "plan" | "act" | "review" | "task"
        });
        expect(result.maxToolCallsPerTurn).toBe(expected);
      });
    }
  });

  describe("turn compatibility", () => {
    it("every mode default satisfies maxToolCallsPerTurn >= maxToolCallsPerBatch", async () => {
      const service = createBudgetService();
      for (const mode of ["chat", "plan", "act", "review", "task"] as const) {
        const result = await service.resolve({
          turnId: "turn_001",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          source: "cli",
          actorId: "actor_user",
          input: "test",
          attachments: [],
          requestedMode: mode
        });
        expect(result.maxToolCallsPerTurn).toBeGreaterThanOrEqual(result.maxToolCallsPerBatch);
      }
    });
  });

  describe("hard caps non-raiseable", () => {
    it("configured repair hard cap above 3 resolves to 3", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          maxToolBatchRepairAttemptsHardCap: 99
        }
      });
      expect(result.maxToolBatchRepairAttemptsHardCap).toBe(APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP);
    });

    it("configured global batch hard cap above 8 resolves to 8", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          globalMaxToolCallsPerBatchHardCap: 99
        }
      });
      expect(result.globalMaxToolCallsPerBatchHardCap).toBe(APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP);
    });
  });

  describe("lowering hard caps", () => {
    it("configured repair hard cap 1 lowers effective cap to 1", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          maxToolBatchRepairAttemptsHardCap: 1
        }
      });
      expect(result.maxToolBatchRepairAttemptsHardCap).toBe(1);
      expect(result.maxToolBatchRepairAttempts).toBe(1);
    });

    it("configured global batch hard cap 2 lowers effective cap to 2", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          globalMaxToolCallsPerBatchHardCap: 2
        }
      });
      expect(result.globalMaxToolCallsPerBatchHardCap).toBe(2);
      expect(result.effectiveMaxToolCallsPerBatch).toBe(2);
    });
  });

  describe("override clamping", () => {
    it("repair attempts 99 clamps to 3", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          maxToolBatchRepairAttempts: 99
        }
      });
      expect(result.maxToolBatchRepairAttempts).toBe(3);
    });

    it("batch override 99 clamps to 8 via hard cap", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 99,
        configuredTurnLimit: 99,
        toolLoopOverride: {
          maxToolCallsPerBatchByMode: { chat: 99 }
        }
      });
      expect(result.effectiveMaxToolCallsPerBatch).toBe(8);
    });

    it("lowering hard cap affects clamp result", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          globalMaxToolCallsPerBatchHardCap: 2
        }
      });
      expect(result.effectiveMaxToolCallsPerBatch).toBe(2);
    });
  });

  describe("low and fractional override normalization", () => {
    it("normalizes zero and negative hard-cap overrides to valid effective limits", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          globalMaxToolCallsPerBatchHardCap: 0,
          maxToolBatchRepairAttemptsHardCap: -1,
          maxToolBatchRepairAttempts: 2
        }
      });

      expect(result.globalMaxToolCallsPerBatchHardCap).toBe(1);
      expect(result.effectiveMaxToolCallsPerBatch).toBe(1);
      expect(result.maxToolBatchRepairAttemptsHardCap).toBe(0);
      expect(result.maxToolBatchRepairAttempts).toBe(0);
      expect(result.effectiveMaxToolCallsPerTurn).toBeGreaterThanOrEqual(result.effectiveMaxToolCallsPerBatch);
    });

    it("normalizes zero and negative per-mode overrides to positive effective limits", async () => {
      const service = createBudgetService({
        toolLoop: {
          maxToolCallsPerBatchByMode: { chat: 0 },
          maxToolCallsPerTurnByMode: { chat: -4 }
        }
      });

      const result = await service.resolve({
        turnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        actorId: "actor_user",
        input: "test",
        attachments: [],
        requestedMode: "chat"
      });

      expect(result.toolLoop.configuredMaxToolCallsPerBatch).toBe(1);
      expect(result.maxToolCallsPerBatch).toBe(1);
      expect(result.maxToolCallsPerTurn).toBe(1);
      expect(result.maxToolCallsPerTurn).toBeGreaterThanOrEqual(result.maxToolCallsPerBatch);
    });

    it("floors non-integer overrides before applying effective caps", async () => {
      const service = createBudgetService({
        toolLoop: {
          globalMaxToolCallsPerBatchHardCap: 5.9,
          maxToolBatchRepairAttemptsHardCap: 2.9,
          maxToolBatchRepairAttempts: 1.9,
          maxToolCallsPerBatchByMode: { chat: 5.7 },
          maxToolCallsPerTurnByMode: { chat: 12.8 }
        }
      });

      const result = await service.resolve({
        turnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        actorId: "actor_user",
        input: "test",
        attachments: [],
        requestedMode: "chat"
      });

      expect(result.toolLoop.configuredMaxToolCallsPerBatch).toBe(5);
      expect(result.toolLoop.globalMaxToolCallsPerBatchHardCap).toBe(5);
      expect(result.maxToolCallsPerBatch).toBe(5);
      expect(result.maxToolCallsPerTurn).toBe(12);
      expect(result.toolLoop.maxToolBatchRepairAttemptsHardCap).toBe(2);
      expect(result.toolLoop.maxToolBatchRepairAttempts).toBe(1);
    });

    it("does not apply an implicit turn cap tied to the batch hard cap", async () => {
      const service = createBudgetService({
        toolLoop: {
          globalMaxToolCallsPerBatchHardCap: 2,
          maxToolCallsPerTurnByMode: { chat: 99 }
        }
      });

      const result = await service.resolve({
        turnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        actorId: "actor_user",
        input: "test",
        attachments: [],
        requestedMode: "chat"
      });

      expect(result.maxToolCallsPerBatch).toBe(2);
      expect(result.maxToolCallsPerTurn).toBe(99);
    });
  });

  describe("source attribution", () => {
    it("mode default source is mode_default", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8
      });
      expect(result.maxToolCallsPerBatchLimitSources).toContain("mode_default");
    });

    it("config override source is config_override", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 4,
        configuredTurnLimit: 8,
        toolLoopOverride: {
          maxToolCallsPerBatchByMode: { chat: 4 }
        }
      });
      expect(result.maxToolCallsPerBatchLimitSources).toContain("config_override");
    });

    it("global_hard_cap appears when clamping", () => {
      const result = resolveEffectiveToolLoopLimits({
        mode: "chat",
        configuredBatchLimit: 99,
        configuredTurnLimit: 99,
        toolLoopOverride: {
          maxToolCallsPerBatchByMode: { chat: 99 }
        }
      });
      expect(result.maxToolCallsPerBatchLimitSources).toContain("global_hard_cap");
    });
  });

  describe("toolLoop in budget resolve output", () => {
    it("includes toolLoop with source attribution and safety metadata", async () => {
      const service = createBudgetService();
      const result = await service.resolve({
        turnId: "turn_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        actorId: "actor_user",
        input: "test",
        attachments: [],
        requestedMode: "chat"
      });
      expect(result.toolLoop).toBeDefined();
      expect(result.toolLoop.toolSafetyClassification).toBe("unavailable");
      expect(result.toolLoop.toolSafetyCapApplied).toBe(false);
      expect(result.toolLoop.maxToolCallsPerBatchLimitSources).toContain("mode_default");
    });
  });
});
