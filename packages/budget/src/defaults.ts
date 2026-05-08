import type { Mode } from "@endec/domain";

export const APPROVED_MAX_TOOL_BATCH_REPAIR_ATTEMPTS_HARD_CAP = 3;
export const APPROVED_GLOBAL_MAX_TOOL_CALLS_PER_BATCH_HARD_CAP = 8;

export const DEFAULT_TOOL_LOOP_POLICY = {
  maxToolBatchRepairAttempts: 2,
  maxToolCallsPerBatchByMode: {
    chat: 4,
    plan: 4,
    task: 4,
    review: 2,
    act: 3
  },
  maxToolCallsPerTurnByMode: {
    chat: 8,
    plan: 8,
    task: 8,
    review: 2,
    act: 6
  }
} as const;

export type ToolLoopConfigOverride = Partial<{
  maxToolBatchRepairAttempts: number;
  maxToolBatchRepairAttemptsHardCap: number;
  globalMaxToolCallsPerBatchHardCap: number;
  maxToolCallsPerBatchByMode: Partial<Record<Mode, number>>;
  maxToolCallsPerTurnByMode: Partial<Record<Mode, number>>;
}>;

export const DEFAULT_MODE_BUDGETS = {
  chat: {
    inputTokenBudget: 6_000,
    outputTokenBudget: 900,
    memoryInjectionBudget: 600,
    toolResultInjectionBudget: 800,
    maxLoopCount: 4,
    maxToolCallsPerBatch: 4,
    maxToolCallsPerTurn: 8
  },
  plan: {
    inputTokenBudget: 8_000,
    outputTokenBudget: 1_400,
    memoryInjectionBudget: 900,
    toolResultInjectionBudget: 600,
    maxLoopCount: 2,
    maxToolCallsPerBatch: 4,
    maxToolCallsPerTurn: 8
  },
  act: {
    inputTokenBudget: 10_000,
    outputTokenBudget: 1_800,
    memoryInjectionBudget: 1_000,
    toolResultInjectionBudget: 1_400,
    maxLoopCount: 6,
    maxToolCallsPerBatch: 3,
    maxToolCallsPerTurn: 6
  },
  review: {
    inputTokenBudget: 12_000,
    outputTokenBudget: 2_200,
    memoryInjectionBudget: 700,
    toolResultInjectionBudget: 500,
    maxLoopCount: 2,
    maxToolCallsPerBatch: 2,
    maxToolCallsPerTurn: 2
  },
  task: {
    inputTokenBudget: 9_000,
    outputTokenBudget: 1_600,
    memoryInjectionBudget: 1_100,
    toolResultInjectionBudget: 1_000,
    maxLoopCount: 4,
    maxToolCallsPerBatch: 4,
    maxToolCallsPerTurn: 8
  }
} as const satisfies Record<Mode, {
  inputTokenBudget: number;
  outputTokenBudget: number;
  memoryInjectionBudget: number;
  toolResultInjectionBudget: number;
  maxLoopCount: number;
  maxToolCallsPerBatch: number;
  maxToolCallsPerTurn: number;
}>;

export type DefaultModeBudget = (typeof DEFAULT_MODE_BUDGETS)[Mode];
export const DEFAULT_SAFETY_RESERVE_TOKENS = 0;
