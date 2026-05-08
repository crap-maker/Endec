import type {
  BudgetCapHit,
  BudgetCapReason,
  BudgetFieldSource,
  BudgetProfile,
  BudgetResolutionDebug,
  Mode,
  ProviderCapability
} from "@endec/domain";
import { DEFAULT_MODE_BUDGETS } from "./defaults.ts";
import {
  applyBudgetOverride,
  BUDGET_PROFILES,
  createHistoricalFallbackDebug,
  createUnestimatedComponents,
  DEFAULT_BUDGET_PROFILE,
  DEFAULT_MAX_MEMORY_SHARE_OF_INPUT,
  hasKnownMaxContextTokens,
  mapKnownMaxContextTokensSource,
  resolveBudgetProfile,
  resolveMaxMemoryShareOfInput,
  type BudgetResolverOverrides
} from "./budget-profiles.ts";

export interface ResolveBudgetInput {
  mode: Mode;
  budgetProfile?: BudgetProfile;
  providerCapability?: ProviderCapability;
  providerId?: string;
  modelId?: string;
  protocolFamily?: string;
  outputReserveTokens?: number;
  toolSchemaTokenEstimate?: number;
  safetyReserveTokens?: number;
  overrides?: BudgetResolverOverrides;
}

export interface ResolveBudgetResult {
  effectiveInputTokenBudget: number;
  effectiveMemoryInjectionBudget: number;
  outputTokenBudget: number;
  debug: BudgetResolutionDebug;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeReserve(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function pushUnique<T>(items: T[], value: T) {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function classifyUsableContextCap(input: {
  maxContextTokens: number;
  usableContext: number;
  fallbackInputBudget: number;
  capHits: BudgetCapHit[];
  capReasons: BudgetCapReason[];
}) {
  if (input.usableContext >= input.fallbackInputBudget) {
    pushUnique(input.capHits, "input_usable_context");
    pushUnique(input.capReasons, "usable_context_cap");
    return;
  }

  if (input.maxContextTokens <= input.fallbackInputBudget) {
    pushUnique(input.capHits, "input_usable_context");
    pushUnique(input.capReasons, "small_model_context_cap");
    return;
  }

  pushUnique(input.capHits, "input_usable_context");
  pushUnique(input.capReasons, "usable_context_cap");
}

export function resolveBudget(input: ResolveBudgetInput): ResolveBudgetResult {
  const modeDefaults = DEFAULT_MODE_BUDGETS[input.mode];
  const profileSelection = resolveBudgetProfile({ budgetProfile: input.budgetProfile });

  if (!hasKnownMaxContextTokens(input.providerCapability)) {
    const debug = createHistoricalFallbackDebug({
      mode: input.mode,
      budgetProfile: profileSelection.budgetProfile,
      budgetProfileSource: profileSelection.budgetProfileSource,
      providerCapability: input.providerCapability
    });
    return {
      effectiveInputTokenBudget: modeDefaults.inputTokenBudget,
      effectiveMemoryInjectionBudget: modeDefaults.memoryInjectionBudget,
      outputTokenBudget: modeDefaults.outputTokenBudget,
      debug
    };
  }

  const maxContextTokens = input.providerCapability.maxContextTokens;
  const profile = BUDGET_PROFILES[profileSelection.budgetProfile];
  const inputProfile = profile.input[input.mode];
  const memoryProfile = profile.memory[input.mode];
  const outputReserveTokens = normalizeReserve(input.outputReserveTokens);
  const toolSchemaTokenEstimate = normalizeReserve(input.toolSchemaTokenEstimate);
  const safetyReserveTokens = normalizeReserve(input.safetyReserveTokens);
  const unestimatedComponents = createUnestimatedComponents({
    outputReserveTokens: input.outputReserveTokens,
    toolSchemaTokenEstimate: input.toolSchemaTokenEstimate,
    safetyReserveTokens: input.safetyReserveTokens
  });
  const usableContext = Math.max(0, maxContextTokens - outputReserveTokens - toolSchemaTokenEstimate - safetyReserveTokens);
  const overridesApplied: BudgetResolutionDebug["overridesApplied"] = [];
  const capHits: BudgetCapHit[] = [];
  const capReasons: BudgetCapReason[] = [];
  const rawInputFromPercent = Math.floor(usableContext * inputProfile.percent);
  const canUseHistoricalSmallContextFallback =
    usableContext < inputProfile.min &&
    modeDefaults.inputTokenBudget <= usableContext;

  let computedInput = canUseHistoricalSmallContextFallback
    ? modeDefaults.inputTokenBudget
    : clamp(rawInputFromPercent, inputProfile.min, inputProfile.max);
  if (!canUseHistoricalSmallContextFallback && computedInput === inputProfile.min && rawInputFromPercent < inputProfile.min) {
    pushUnique(capHits, "input_min");
  }
  if (!canUseHistoricalSmallContextFallback && computedInput === inputProfile.max && rawInputFromPercent > inputProfile.max) {
    pushUnique(capHits, "input_max");
    pushUnique(capReasons, "input_max");
  }

  const overriddenInput = applyBudgetOverride({
    baseValue: computedInput,
    defaultSource: canUseHistoricalSmallContextFallback ? "historical_fallback" : "profile_default",
    field: "inputTokenBudget",
    mode: input.mode,
    profile: profileSelection.budgetProfile,
    overrides: input.overrides,
    overridesApplied
  });
  let effectiveInputTokenBudget = overriddenInput.value;
  let inputBudgetSource: BudgetFieldSource = overriddenInput.source;

  if (effectiveInputTokenBudget > usableContext) {
    effectiveInputTokenBudget = usableContext;
    classifyUsableContextCap({
      maxContextTokens,
      usableContext,
      fallbackInputBudget: modeDefaults.inputTokenBudget,
      capHits,
      capReasons
    });
  }

  let rawMemoryBudget = clamp(
    Math.floor(maxContextTokens * memoryProfile.percent),
    memoryProfile.min,
    memoryProfile.max
  );
  if (rawMemoryBudget === memoryProfile.min && Math.floor(maxContextTokens * memoryProfile.percent) < memoryProfile.min) {
    pushUnique(capHits, "memory_min");
  }
  if (rawMemoryBudget === memoryProfile.max && Math.floor(maxContextTokens * memoryProfile.percent) > memoryProfile.max) {
    pushUnique(capHits, "memory_max");
    pushUnique(capReasons, "memory_max");
  }

  const overriddenMemory = applyBudgetOverride({
    baseValue: rawMemoryBudget,
    defaultSource: "profile_default",
    field: "memoryInjectionBudget",
    mode: input.mode,
    profile: profileSelection.budgetProfile,
    overrides: input.overrides,
    overridesApplied
  });
  let effectiveMemoryInjectionBudget = overriddenMemory.value;
  let memoryBudgetSource: BudgetFieldSource = overriddenMemory.source;

  const maxMemoryShareOfInput = resolveMaxMemoryShareOfInput({
    mode: input.mode,
    profile: profileSelection.budgetProfile,
    overrides: input.overrides,
    overridesApplied
  });
  const shareCap = Math.max(0, Math.floor(effectiveInputTokenBudget * maxMemoryShareOfInput));
  if (effectiveMemoryInjectionBudget > shareCap) {
    effectiveMemoryInjectionBudget = shareCap;
    pushUnique(capHits, "memory_share_of_input");
    pushUnique(capReasons, "memory_share_of_input");
  }

  const debug: BudgetResolutionDebug = {
    mode: input.mode,
    budgetProfile: profileSelection.budgetProfile,
    budgetProfileSource: input.budgetProfile ? profileSelection.budgetProfileSource : DEFAULT_BUDGET_PROFILE === profileSelection.budgetProfile ? "profile_default" : profileSelection.budgetProfileSource,
    inputBudgetSource,
    memoryBudgetSource,
    providerId: input.providerId,
    modelId: input.modelId,
    protocolFamily: input.protocolFamily,
    maxContextTokens,
    maxContextTokensSource: mapKnownMaxContextTokensSource(input.providerCapability),
    usableContext,
    outputReserveTokens: typeof input.outputReserveTokens === "number" ? outputReserveTokens : undefined,
    toolSchemaTokenEstimate: typeof input.toolSchemaTokenEstimate === "number" ? toolSchemaTokenEstimate : undefined,
    safetyReserveTokens: typeof input.safetyReserveTokens === "number" ? safetyReserveTokens : undefined,
    unestimatedComponents,
    effectiveInputTokenBudget,
    effectiveMemoryInjectionBudget,
    maxMemoryShareOfInput: typeof maxMemoryShareOfInput === "number" ? maxMemoryShareOfInput : DEFAULT_MAX_MEMORY_SHARE_OF_INPUT,
    capHits,
    capReasons,
    overridesApplied
  };

  return {
    effectiveInputTokenBudget,
    effectiveMemoryInjectionBudget,
    outputTokenBudget: outputReserveTokens || modeDefaults.outputTokenBudget,
    debug
  };
}
