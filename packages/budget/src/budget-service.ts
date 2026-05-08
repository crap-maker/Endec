import type { CostLedger, Mode, ProviderCapability, RuntimeToolLoopLimits, TurnRequest } from "@endec/domain";
import { createCostLedger } from "./cost-ledger.ts";
import {
  APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP,
  APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP,
  DEFAULT_MODE_BUDGETS,
  DEFAULT_SAFETY_RESERVE_TOKENS,
  DEFAULT_TOOL_LOOP_POLICY,
  type ToolLoopConfigOverride
} from "./defaults.ts";
import { resolveBudget, type ResolveBudgetInput } from "./budget-resolver.ts";

export type CostLedgerStore = ReturnType<typeof createCostLedger>;

function normalizeInteger(input: number | undefined, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) ? Math.floor(input) : fallback;
}

function normalizePositiveInteger(input: number | undefined, fallback: number): number {
  return Math.max(1, normalizeInteger(input, fallback));
}

function normalizeNonNegativeInteger(input: number | undefined, fallback: number): number {
  return Math.max(0, normalizeInteger(input, fallback));
}

export function resolveEffectiveToolLoopLimits(input: {
  mode: Mode;
  configuredBatchLimit: number;
  configuredTurnLimit: number;
  toolLoopOverride?: ToolLoopConfigOverride;
}): RuntimeToolLoopLimits & { effectiveMaxToolCallsPerTurn: number } {
  const configuredRepairHardCap = normalizeNonNegativeInteger(
    input.toolLoopOverride?.maxToolBatchRepairAttemptsHardCap,
    APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP
  );
  const effectiveRepairHardCap = Math.min(
    configuredRepairHardCap,
    APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP
  );

  const configuredGlobalBatchHardCap = normalizePositiveInteger(
    input.toolLoopOverride?.globalMaxToolCallsPerBatchHardCap,
    APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP
  );
  const effectiveGlobalBatchHardCap = Math.min(
    configuredGlobalBatchHardCap,
    APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP
  );

  const configuredRepairAttempts = normalizeNonNegativeInteger(
    input.toolLoopOverride?.maxToolBatchRepairAttempts,
    DEFAULT_TOOL_LOOP_POLICY.maxToolBatchRepairAttempts
  );

  const effectiveMaxRepairAttempts = Math.min(configuredRepairAttempts, effectiveRepairHardCap);

  const normalizedConfiguredBatchLimit = normalizePositiveInteger(input.configuredBatchLimit, DEFAULT_TOOL_LOOP_POLICY.maxToolCallsPerBatchByMode[input.mode]);
  const normalizedConfiguredTurnLimit = normalizePositiveInteger(input.configuredTurnLimit, DEFAULT_TOOL_LOOP_POLICY.maxToolCallsPerTurnByMode[input.mode]);

  const sources: RuntimeToolLoopLimits["maxToolCallsPerBatchLimitSources"] = [];
  const hasBatchOverride = input.toolLoopOverride?.maxToolCallsPerBatchByMode?.[input.mode] !== undefined;
  if (hasBatchOverride) {
    sources.push("config_override");
  } else {
    sources.push("mode_default");
  }

  const effectiveMaxToolCallsPerBatch = Math.min(
    normalizedConfiguredBatchLimit,
    effectiveGlobalBatchHardCap
  );

  if (effectiveMaxToolCallsPerBatch < normalizedConfiguredBatchLimit) {
    if (!sources.includes("global_hard_cap")) {
      sources.push("global_hard_cap");
    }
  }

  const effectiveMaxToolCallsPerTurn = Math.max(
    normalizedConfiguredTurnLimit,
    effectiveMaxToolCallsPerBatch
  );

  return {
    configuredMaxToolCallsPerBatch: normalizedConfiguredBatchLimit,
    effectiveMaxToolCallsPerBatch,
    maxToolCallsPerBatchLimitSources: sources,
    globalMaxToolCallsPerBatchHardCap: effectiveGlobalBatchHardCap,
    maxToolBatchRepairAttempts: effectiveMaxRepairAttempts,
    maxToolBatchRepairAttemptsHardCap: effectiveRepairHardCap,
    toolSafetyClassification: "unavailable",
    toolSafetyCapApplied: false,
    effectiveMaxToolCallsPerTurn
  };
}

export function createBudgetService(options?: {
  ledger?: CostLedgerStore;
  ledgerFilename?: string;
  toolLoop?: ToolLoopConfigOverride;
}) {
  const ledger = options?.ledger ?? createCostLedger({ filename: options?.ledgerFilename ?? ":memory:" });
  const toolLoopOverride = options?.toolLoop;

  return {
    async resolve(
      request: TurnRequest,
      runtimeContext?: Pick<ResolveBudgetInput, "providerCapability" | "providerId" | "modelId" | "protocolFamily" | "outputReserveTokens" | "toolSchemaTokenEstimate" | "safetyReserveTokens" | "budgetProfile" | "overrides">
    ) {
      const resolvedMode = request.requestedMode ?? "chat";
      const config = DEFAULT_MODE_BUDGETS[resolvedMode];

      const batchOverride = toolLoopOverride?.maxToolCallsPerBatchByMode?.[resolvedMode];
      const turnOverride = toolLoopOverride?.maxToolCallsPerTurnByMode?.[resolvedMode];

      const configuredMaxToolCallsPerBatch = normalizePositiveInteger(batchOverride, config.maxToolCallsPerBatch);
      const configuredMaxToolCallsPerTurn = normalizePositiveInteger(turnOverride, config.maxToolCallsPerTurn);

      const toolLoop = resolveEffectiveToolLoopLimits({
        mode: resolvedMode,
        configuredBatchLimit: configuredMaxToolCallsPerBatch,
        configuredTurnLimit: configuredMaxToolCallsPerTurn,
        toolLoopOverride
      });

      const effectiveMaxToolCallsPerBatch = toolLoop.effectiveMaxToolCallsPerBatch;
      const effectiveMaxToolCallsPerTurn = toolLoop.effectiveMaxToolCallsPerTurn;

      const budgetResolution = resolveBudget({
        mode: resolvedMode,
        budgetProfile: runtimeContext?.budgetProfile,
        providerCapability: runtimeContext?.providerCapability,
        providerId: runtimeContext?.providerId,
        modelId: runtimeContext?.modelId,
        protocolFamily: runtimeContext?.protocolFamily,
        outputReserveTokens: runtimeContext?.outputReserveTokens,
        toolSchemaTokenEstimate: runtimeContext?.toolSchemaTokenEstimate,
        safetyReserveTokens: runtimeContext?.safetyReserveTokens ?? DEFAULT_SAFETY_RESERVE_TOKENS,
        overrides: runtimeContext?.overrides
      });

      return {
        resolvedMode,
        inputTokenBudget: budgetResolution.effectiveInputTokenBudget,
        outputTokenBudget: config.outputTokenBudget,
        memoryInjectionBudget: budgetResolution.effectiveMemoryInjectionBudget,
        toolResultInjectionBudget: config.toolResultInjectionBudget,
        maxLoopCount: config.maxLoopCount,
        maxToolCallsPerBatch: effectiveMaxToolCallsPerBatch,
        maxToolCallsPerTurn: effectiveMaxToolCallsPerTurn,
        toolLoop,
        budgetDebug: budgetResolution.debug
      };
    },
    evaluateBudget(input: {
      resolvedMode: keyof typeof DEFAULT_MODE_BUDGETS;
      projectedTotalTokens: number;
      hardLimitTokens: number;
    }) {
      const softLimitTokens = DEFAULT_MODE_BUDGETS[input.resolvedMode].inputTokenBudget;

      if (input.projectedTotalTokens > input.hardLimitTokens) {
        return {
          kind: "hard_stop" as const,
          status: "interrupted" as const,
          stopReason: "hard_limit"
        };
      }

      if (input.projectedTotalTokens > softLimitTokens) {
        return {
          kind: "ask_continue" as const,
          status: "blocked" as const,
          stopReason: "soft_limit"
        };
      }

      return {
        kind: "ok" as const,
        status: "completed" as const,
        stopReason: "none"
      };
    },
    async recordCost(input: CostLedger) {
      await ledger.record(input);
      return input.ledgerId;
    }
  };
}
