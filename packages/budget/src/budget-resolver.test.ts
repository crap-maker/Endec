import { describe, expect, it } from "vitest";
import { resolveBudget } from "./budget-resolver.ts";
import {
  BUDGET_PROFILES,
  DEFAULT_BUDGET_PROFILE,
  DEFAULT_MAX_MEMORY_SHARE_OF_INPUT
} from "./budget-profiles.ts";

describe("resolveBudget", () => {
  it("uses historical fallback budgets when model context is unknown", () => {
    const result = resolveBudget({
      mode: "chat",
      providerCapability: { supportsTools: true, supportsStreaming: true },
      outputReserveTokens: 12_000,
      toolSchemaTokenEstimate: 3_000,
      safetyReserveTokens: 5_000
    });

    expect(result.effectiveInputTokenBudget).toBe(6_000);
    expect(result.effectiveMemoryInjectionBudget).toBe(600);
    expect(result.debug.fallbackReason).toBe("model_context_unknown");
    expect(result.debug.inputBudgetSource).toBe("historical_fallback");
    expect(result.debug.memoryBudgetSource).toBe("historical_fallback");
  });

  it("defaults to balanced profile for known model contexts", () => {
    const result = resolveBudget({
      mode: "chat",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 200_000 },
      outputReserveTokens: 12_000,
      toolSchemaTokenEstimate: 3_000,
      safetyReserveTokens: 5_000
    });

    expect(result.debug.budgetProfile).toBe(DEFAULT_BUDGET_PROFILE);
    expect(result.debug.budgetProfileSource).toBe("profile_default");
    expect(result.effectiveInputTokenBudget).toBe(27_000);
    expect(result.effectiveMemoryInjectionBudget).toBe(5_000);
  });

  it("resolves conservative, balanced, and high-memory as distinct ceilings", () => {
    const base = {
      mode: "chat" as const,
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 200_000 },
      outputReserveTokens: 12_000,
      toolSchemaTokenEstimate: 3_000,
      safetyReserveTokens: 5_000
    };

    const conservative = resolveBudget({ ...base, budgetProfile: "conservative" });
    const balanced = resolveBudget({ ...base, budgetProfile: "balanced" });
    const highMemory = resolveBudget({ ...base, budgetProfile: "high-memory" });

    expect(conservative.effectiveInputTokenBudget).toBe(
      Math.floor(180_000 * BUDGET_PROFILES.conservative.input.chat.percent)
    );
    expect(balanced.effectiveInputTokenBudget).toBe(
      Math.floor(180_000 * BUDGET_PROFILES.balanced.input.chat.percent)
    );
    expect(highMemory.effectiveInputTokenBudget).toBe(
      Math.floor(180_000 * BUDGET_PROFILES["high-memory"].input.chat.percent)
    );
    expect(conservative.effectiveMemoryInjectionBudget).toBeLessThan(balanced.effectiveMemoryInjectionBudget);
    expect(balanced.effectiveMemoryInjectionBudget).toBeLessThan(highMemory.effectiveMemoryInjectionBudget);
    expect(conservative.effectiveInputTokenBudget).toBeLessThan(balanced.effectiveInputTokenBudget);
    expect(balanced.effectiveInputTokenBudget).toBeLessThan(highMemory.effectiveInputTokenBudget);
  });

  it("uses usable context reserves for input budget", () => {
    const result = resolveBudget({
      mode: "chat",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 200_000 },
      outputReserveTokens: 12_000,
      toolSchemaTokenEstimate: 3_000,
      safetyReserveTokens: 5_000
    });

    expect(result.debug.usableContext).toBe(180_000);
    expect(result.effectiveInputTokenBudget).toBe(27_000);
  });

  it("marks missing reserve estimates as unestimated components", () => {
    const result = resolveBudget({
      mode: "plan",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 200_000 }
    });

    expect(result.debug.unestimatedComponents).toEqual(expect.arrayContaining([
      "outputReserveTokens",
      "toolSchemaTokenEstimate",
      "safetyReserveTokens"
    ]));
  });

  it("caps high-memory 1M task budget by absolute max and reports cap hits", () => {
    const result = resolveBudget({
      mode: "task",
      budgetProfile: "high-memory",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 1_000_000 },
      outputReserveTokens: 64_000,
      toolSchemaTokenEstimate: 10_000,
      safetyReserveTokens: 26_000
    });

    expect(result.effectiveInputTokenBudget).toBe(256_000);
    expect(result.debug.capHits).toContain("input_max");
    expect(result.effectiveMemoryInjectionBudget).toBeLessThanOrEqual(
      Math.floor(result.effectiveInputTokenBudget * DEFAULT_MAX_MEMORY_SHARE_OF_INPUT)
    );
  });

  it("applies maxMemoryShareOfInput and reports when it binds", () => {
    const result = resolveBudget({
      mode: "task",
      budgetProfile: "high-memory",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 1_000_000 },
      outputReserveTokens: 990_000,
      toolSchemaTokenEstimate: 0,
      safetyReserveTokens: 0
    });

    expect(result.effectiveInputTokenBudget).toBeGreaterThan(0);
    expect(result.effectiveMemoryInjectionBudget).toBe(
      Math.floor(result.effectiveInputTokenBudget * DEFAULT_MAX_MEMORY_SHARE_OF_INPUT)
    );
    expect(result.debug.capHits).toContain("memory_share_of_input");
  });

  it("uses historical small-model fallback when a known 8k model has enough usable context", () => {
    const result = resolveBudget({
      mode: "chat",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 8_000 },
      outputReserveTokens: 1_000,
      toolSchemaTokenEstimate: 500,
      safetyReserveTokens: 500
    });

    expect(result.debug.usableContext).toBe(6_000);
    expect(result.effectiveInputTokenBudget).toBe(6_000);
    expect(result.debug.inputBudgetSource).toBe("historical_fallback");
    expect(result.debug.capReasons).not.toContain("small_model_context_cap");
    expect(result.debug.capReasons).not.toContain("usable_context_cap");
  });


  it("caps high-reserve 1M model input budget to usable context", () => {
    const result = resolveBudget({
      mode: "chat",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 1_000_000 },
      outputReserveTokens: 994_000,
      toolSchemaTokenEstimate: 1_000,
      safetyReserveTokens: 1_000
    });

    expect(result.debug.usableContext).toBe(4_000);
    expect(result.effectiveInputTokenBudget).toBeLessThanOrEqual(4_000);
    expect(result.debug.capReasons).toEqual(expect.arrayContaining(["usable_context_cap"]));
  });

  it("does not let profile minimum inflate input beyond usable context", () => {
    const result = resolveBudget({
      mode: "act",
      budgetProfile: "high-memory",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 32_000 },
      outputReserveTokens: 28_000,
      toolSchemaTokenEstimate: 0,
      safetyReserveTokens: 0
    });

    expect(result.debug.usableContext).toBe(4_000);
    expect(result.effectiveInputTokenBudget).toBe(4_000);
    expect(result.debug.capReasons).toEqual(expect.arrayContaining(["usable_context_cap"]));
  });

  it("keeps known 200k and 1M models above historical tiny defaults when usable context allows", () => {
    const known200k = resolveBudget({
      mode: "chat",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 200_000 },
      outputReserveTokens: 12_000,
      toolSchemaTokenEstimate: 3_000,
      safetyReserveTokens: 5_000
    });
    const known1m = resolveBudget({
      mode: "task",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 1_000_000 },
      outputReserveTokens: 64_000,
      toolSchemaTokenEstimate: 10_000,
      safetyReserveTokens: 26_000
    });

    expect(known200k.effectiveMemoryInjectionBudget).toBeGreaterThan(600);
    expect(known1m.effectiveMemoryInjectionBudget).toBeGreaterThan(1_100);
  });

  it("caps to usable context with small_model_context_cap when historical small-model fallback does not fit", () => {
    const result = resolveBudget({
      mode: "chat",
      budgetProfile: "conservative",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 1_200 },
      outputReserveTokens: 500,
      toolSchemaTokenEstimate: 0,
      safetyReserveTokens: 100
    });

    expect(result.debug.usableContext).toBe(600);
    expect(result.effectiveInputTokenBudget).toBe(600);
    expect(result.debug.capReasons).toEqual(expect.arrayContaining(["small_model_context_cap"]));
  });

  it("reports zero usable context when reserves fully consume the model window", () => {
    const result = resolveBudget({
      mode: "chat",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 32_000 },
      outputReserveTokens: 20_000,
      toolSchemaTokenEstimate: 8_000,
      safetyReserveTokens: 4_000
    });

    expect(result.debug.usableContext).toBe(0);
    expect(result.effectiveInputTokenBudget).toBe(0);
    expect(result.effectiveMemoryInjectionBudget).toBe(0);
    expect(result.debug.capHits).toEqual(expect.arrayContaining(["input_usable_context", "memory_share_of_input"]));
    expect(result.debug.capReasons).toEqual(expect.arrayContaining(["usable_context_cap", "memory_share_of_input"]));
  });

  it("keeps effective budgets at zero when reserves exceed the model window", () => {
    const result = resolveBudget({
      mode: "task",
      budgetProfile: "high-memory",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 32_000 },
      outputReserveTokens: 24_000,
      toolSchemaTokenEstimate: 12_000,
      safetyReserveTokens: 4_000
    });

    expect(result.debug.usableContext).toBe(0);
    expect(result.effectiveInputTokenBudget).toBe(0);
    expect(result.effectiveMemoryInjectionBudget).toBe(0);
    expect(result.effectiveInputTokenBudget).toBeGreaterThanOrEqual(0);
    expect(result.effectiveMemoryInjectionBudget).toBeGreaterThanOrEqual(0);
  });



  it("applies deployment and user overrides with visible source fields", () => {
    const result = resolveBudget({
      mode: "chat",
      budgetProfile: "balanced",
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 200_000 },
      outputReserveTokens: 12_000,
      toolSchemaTokenEstimate: 3_000,
      safetyReserveTokens: 5_000,
      overrides: {
        deployment: {
          maxMemoryShareOfInput: 0.25
        },
        user: {
          memoryInjectionBudget: 4_000
        }
      }
    });

    expect(result.effectiveMemoryInjectionBudget).toBe(4_000);
    expect(result.debug.memoryBudgetSource).toBe("user_override");
    expect(result.debug.overridesApplied).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "deployment_override", field: "maxMemoryShareOfInput", value: 0.25 }),
      expect.objectContaining({ source: "user_override", field: "memoryInjectionBudget", value: 4_000 })
    ]));
  });

  it("reports the winning override source across the supported precedence chain", () => {
    const base = {
      mode: "chat" as const,
      budgetProfile: "balanced" as const,
      providerCapability: { supportsTools: true, supportsStreaming: true, maxContextTokens: 200_000 },
      outputReserveTokens: 12_000,
      toolSchemaTokenEstimate: 3_000,
      safetyReserveTokens: 5_000
    };

    const providerModelResult = resolveBudget({
      ...base,
      overrides: {
        providerModel: {
          inputTokenBudget: 19_000
        }
      }
    });
    const modeResult = resolveBudget({
      ...base,
      overrides: {
        providerModel: {
          memoryInjectionBudget: 4_000
        },
        mode: {
          chat: {
            memoryInjectionBudget: 4_500
          }
        }
      }
    });
    const profileResult = resolveBudget({
      ...base,
      overrides: {
        mode: {
          chat: {
            inputTokenBudget: 22_000
          }
        },
        profile: {
          balanced: {
            inputTokenBudget: 23_000
          }
        }
      }
    });
    const deploymentResult = resolveBudget({
      ...base,
      overrides: {
        profile: {
          balanced: {
            memoryInjectionBudget: 4_700
          }
        },
        deployment: {
          memoryInjectionBudget: 4_800
        }
      }
    });
    const userResult = resolveBudget({
      ...base,
      overrides: {
        deployment: {
          memoryInjectionBudget: 4_800
        },
        user: {
          memoryInjectionBudget: 4_900
        }
      }
    });

    expect(providerModelResult.debug.inputBudgetSource).toBe("provider_model_override");
    expect(providerModelResult.effectiveInputTokenBudget).toBe(19_000);
    expect(modeResult.debug.memoryBudgetSource).toBe("mode_override");
    expect(modeResult.effectiveMemoryInjectionBudget).toBe(4_500);
    expect(profileResult.debug.inputBudgetSource).toBe("profile_override");
    expect(profileResult.effectiveInputTokenBudget).toBe(23_000);
    expect(deploymentResult.debug.memoryBudgetSource).toBe("deployment_override");
    expect(deploymentResult.effectiveMemoryInjectionBudget).toBe(4_800);
    expect(userResult.debug.memoryBudgetSource).toBe("user_override");
    expect(userResult.effectiveMemoryInjectionBudget).toBe(4_900);
  });
});
