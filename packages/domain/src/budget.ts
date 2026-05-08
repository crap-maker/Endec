import { z } from "zod";
import { ModeSchema } from "./turn.ts";

export const CostLedgerSchema = z.object({
  ledgerId: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  mode: ModeSchema,
  modelId: z.string(),
  providerId: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative(),
  memoryInjectedTokens: z.number().int().nonnegative(),
  toolResultInjectedTokens: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  loopCount: z.number().int().nonnegative(),
  stopReason: z.string(),
  startedAt: z.string(),
  endedAt: z.string()
});

export type CostLedger = z.infer<typeof CostLedgerSchema>;
