import type {
  BudgetCapHit,
  BudgetFieldSource,
  BudgetProfile,
  BudgetProfileSource,
  BudgetResolutionDebug,
  BudgetUnestimatedComponent,
  MaxContextTokensSource,
  Mode,
  ProviderCapability
} from "@endec/domain";
import { DEFAULT_MODE_BUDGETS } from "./defaults.ts";

export const DEFAULT_BUDGET_PROFILE = "balanced" as const satisfies BudgetProfile;
export const DEFAULT_MAX_MEMORY_SHARE_OF_INPUT = 0.4;

export type BudgetProfileTable = Record<Mode, {
  percent: number;
  min: number;
  max: number;
}>;

export interface BudgetOverrideValues {
  inputTokenBudget?: number;
  memoryInjectionBudget?: number;
  maxMemoryShareOfInput?: number;
}

export interface BudgetResolverOverrides {
  providerModel?: BudgetOverrideValues;
  mode?: Partial<Record<Mode, BudgetOverrideValues>>;
  profile?: Partial<Record<BudgetProfile, BudgetOverrideValues>>;
  deployment?: BudgetOverrideValues;
  user?: BudgetOverrideValues;
}

export interface BudgetProfilesDefinition {
  input: BudgetProfileTable;
  memory: BudgetProfileTable;
}

function createBudgetProfileTable(rows: BudgetProfileTable): BudgetProfileTable {
  return rows;
}

export const BUDGET_PROFILES: Record<BudgetProfile, BudgetProfilesDefinition> = {
  conservative: {
    memory: createBudgetProfileTable({
      chat: { percent: 0.015, min: 2_000, max: 12_000 },
      plan: { percent: 0.02, min: 3_000, max: 18_000 },
      act: { percent: 0.025, min: 4_000, max: 24_000 },
      review: { percent: 0.015, min: 2_000, max: 12_000 },
      task: { percent: 0.03, min: 4_000, max: 32_000 }
    }),
    input: createBudgetProfileTable({
      chat: { percent: 0.1, min: 12_000, max: 64_000 },
      plan: { percent: 0.15, min: 16_000, max: 96_000 },
      act: { percent: 0.18, min: 20_000, max: 128_000 },
      review: { percent: 0.15, min: 16_000, max: 96_000 },
      task: { percent: 0.18, min: 20_000, max: 128_000 }
    })
  },
  balanced: {
    memory: createBudgetProfileTable({
      chat: { percent: 0.025, min: 3_000, max: 20_000 },
      plan: { percent: 0.035, min: 4_000, max: 32_000 },
      act: { percent: 0.04, min: 5_000, max: 48_000 },
      review: { percent: 0.025, min: 3_000, max: 20_000 },
      task: { percent: 0.05, min: 6_000, max: 64_000 }
    }),
    input: createBudgetProfileTable({
      chat: { percent: 0.15, min: 16_000, max: 96_000 },
      plan: { percent: 0.2, min: 20_000, max: 128_000 },
      act: { percent: 0.25, min: 24_000, max: 160_000 },
      review: { percent: 0.2, min: 20_000, max: 128_000 },
      task: { percent: 0.25, min: 24_000, max: 160_000 }
    })
  },
  "high-memory": {
    memory: createBudgetProfileTable({
      chat: { percent: 0.04, min: 5_000, max: 32_000 },
      plan: { percent: 0.05, min: 6_000, max: 48_000 },
      act: { percent: 0.06, min: 8_000, max: 64_000 },
      review: { percent: 0.04, min: 5_000, max: 32_000 },
      task: { percent: 0.08, min: 10_000, max: 96_000 }
    }),
    input: createBudgetProfileTable({
      chat: { percent: 0.2, min: 20_000, max: 128_000 },
      plan: { percent: 0.3, min: 24_000, max: 192_000 },
      act: { percent: 0.35, min: 32_000, max: 256_000 },
      review: { percent: 0.3, min: 24_000, max: 192_000 },
      task: { percent: 0.35, min: 32_000, max: 256_000 }
    })
  }
};

export function resolveBudgetProfile(input: {
  budgetProfile?: BudgetProfile;
}): { budgetProfile: BudgetProfile; budgetProfileSource: BudgetProfileSource } {
  if (input.budgetProfile) {
    return {
      budgetProfile: input.budgetProfile,
      budgetProfileSource: "user_override"
    };
  }

  return {
    budgetProfile: DEFAULT_BUDGET_PROFILE,
    budgetProfileSource: "profile_default"
  };
}

export function hasKnownMaxContextTokens(capability: Pick<ProviderCapability, "maxContextTokens"> | undefined): capability is Pick<ProviderCapability, "maxContextTokens"> & { maxContextTokens: number } {
  return typeof capability?.maxContextTokens === "number" && Number.isFinite(capability.maxContextTokens) && capability.maxContextTokens > 0;
}

export function createHistoricalFallbackDebug(input: {
  mode: Mode;
  budgetProfile: BudgetProfile;
  budgetProfileSource: BudgetProfileSource;
  providerCapability?: Pick<ProviderCapability, "maxContextTokens">;
}): BudgetResolutionDebug {
  const defaults = DEFAULT_MODE_BUDGETS[input.mode];
  return {
    mode: input.mode,
    budgetProfile: input.budgetProfile,
    budgetProfileSource: input.budgetProfileSource,
    inputBudgetSource: "historical_fallback",
    memoryBudgetSource: "historical_fallback",
    maxContextTokens: hasKnownMaxContextTokens(input.providerCapability) ? input.providerCapability.maxContextTokens : undefined,
    maxContextTokensSource: hasKnownMaxContextTokens(input.providerCapability) ? "provider_capability" : "unknown",
    unestimatedComponents: [],
    effectiveInputTokenBudget: defaults.inputTokenBudget,
    effectiveMemoryInjectionBudget: defaults.memoryInjectionBudget,
    maxMemoryShareOfInput: DEFAULT_MAX_MEMORY_SHARE_OF_INPUT,
    capHits: [],
    capReasons: [],
    fallbackReason: "model_context_unknown",
    overridesApplied: []
  };
}

export const BUDGET_OVERRIDE_PRECEDENCE: Array<{
  source: BudgetFieldSource;
  pick: (overrides: BudgetResolverOverrides | undefined, mode: Mode, profile: BudgetProfile) => BudgetOverrideValues | undefined;
}> = [
  {
    source: "provider_model_override",
    pick: (overrides) => overrides?.providerModel
  },
  {
    source: "mode_override",
    pick: (overrides, mode) => overrides?.mode?.[mode]
  },
  {
    source: "profile_override",
    pick: (overrides, _mode, profile) => overrides?.profile?.[profile]
  },
  {
    source: "deployment_override",
    pick: (overrides) => overrides?.deployment
  },
  {
    source: "user_override",
    pick: (overrides) => overrides?.user
  }
];

export function applyBudgetOverride(input: {
  baseValue: number;
  defaultSource: BudgetFieldSource;
  field: keyof BudgetOverrideValues;
  mode: Mode;
  profile: BudgetProfile;
  overrides?: BudgetResolverOverrides;
  overridesApplied: BudgetResolutionDebug["overridesApplied"];
}): { value: number; source: BudgetFieldSource } {
  let value = input.baseValue;
  let source = input.defaultSource;

  for (const entry of BUDGET_OVERRIDE_PRECEDENCE) {
    const overrideSet = entry.pick(input.overrides, input.mode, input.profile);
    const overrideValue = overrideSet?.[input.field];
    if (typeof overrideValue !== "number" || !Number.isFinite(overrideValue)) {
      continue;
    }

    value = Math.floor(overrideValue);
    source = entry.source;
    input.overridesApplied.push({
      source: entry.source,
      field: String(input.field),
      value: overrideValue
    });
  }

  return { value, source };
}

export function resolveMaxMemoryShareOfInput(input: {
  mode: Mode;
  profile: BudgetProfile;
  overrides?: BudgetResolverOverrides;
  overridesApplied: BudgetResolutionDebug["overridesApplied"];
}) {
  let value = DEFAULT_MAX_MEMORY_SHARE_OF_INPUT;

  for (const entry of BUDGET_OVERRIDE_PRECEDENCE) {
    const overrideSet = entry.pick(input.overrides, input.mode, input.profile);
    const overrideValue = overrideSet?.maxMemoryShareOfInput;
    if (typeof overrideValue !== "number" || !Number.isFinite(overrideValue)) {
      continue;
    }

    value = overrideValue;
    input.overridesApplied.push({
      source: entry.source,
      field: "maxMemoryShareOfInput",
      value: overrideValue
    });
  }

  return value;
}

export function mapKnownMaxContextTokensSource(capability: Pick<ProviderCapability, "maxContextTokens"> | undefined): MaxContextTokensSource {
  return hasKnownMaxContextTokens(capability) ? "provider_capability" : "unknown";
}

export function createUnestimatedComponents(input: {
  outputReserveTokens?: number;
  toolSchemaTokenEstimate?: number;
  safetyReserveTokens?: number;
}): BudgetUnestimatedComponent[] {
  const missing: BudgetUnestimatedComponent[] = [];

  if (typeof input.outputReserveTokens !== "number") {
    missing.push("outputReserveTokens");
  }
  if (typeof input.toolSchemaTokenEstimate !== "number") {
    missing.push("toolSchemaTokenEstimate");
  }
  if (typeof input.safetyReserveTokens !== "number") {
    missing.push("safetyReserveTokens");
  }

  return missing;
}
