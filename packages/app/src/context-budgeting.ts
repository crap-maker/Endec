import type {
  ContextAssemblyBudget,
  RuntimeContextBlock,
  RuntimeToolDefinition,
  ToolSchemaAccounting
} from "@endec/domain";

const MIN_PARTIAL_TOKENS = 8;

export function estimateTextTokens(text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function truncateTextToTokenBudget(text: string, tokenBudget: number) {
  if (tokenBudget <= 0) {
    return "";
  }

  const estimated = estimateTextTokens(text);
  if (estimated <= tokenBudget) {
    return text;
  }

  const maxChars = Math.max(1, tokenBudget * 4 - 1);
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

export function fitBlocksToBudget<T extends RuntimeContextBlock>(input: {
  blocks: T[];
  budget: number;
}): {
  blocks: T[];
  tokenCount: number;
  truncated: boolean;
} {
  const selected: T[] = [];
  let used = 0;
  let truncated = false;

  for (const block of input.blocks) {
    const blockTokens = block.tokenCount ?? estimateTextTokens(block.content);
    if (blockTokens <= 0) {
      continue;
    }

    if (used + blockTokens <= input.budget) {
      selected.push({
        ...block,
        tokenCount: blockTokens
      });
      used += blockTokens;
      continue;
    }

    const remaining = input.budget - used;
    if (remaining >= MIN_PARTIAL_TOKENS) {
      const content = truncateTextToTokenBudget(block.content, remaining);
      const tokenCount = estimateTextTokens(content);
      if (tokenCount > 0) {
        selected.push({
          ...block,
          content,
          tokenCount
        });
        used += tokenCount;
      }
    }

    truncated = true;
    break;
  }

  if (selected.length < input.blocks.length) {
    truncated = true;
  }

  return {
    blocks: selected,
    tokenCount: used,
    truncated
  };
}

export function estimateToolSchemaAccounting(toolSchemas: RuntimeToolDefinition[] | undefined): ToolSchemaAccounting {
  if (!toolSchemas) {
    return {
      status: "unestimated",
      perTool: []
    };
  }

  const perTool = toolSchemas.map((tool) => {
    const serialized = JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      metadata: tool.metadata
    });

    return {
      toolName: tool.name,
      estimatedTokens: estimateTextTokens(serialized)
    };
  });

  return {
    status: "estimated",
    totalTokens: perTool.reduce((total, tool) => total + tool.estimatedTokens, 0),
    perTool
  };
}

export function createContextAssemblyBudget(input: {
  inputTokenBudget: number;
  projectedInputTokens: number;
  historyBudget: number;
  historyTokensUsed: number;
  historyTruncated: boolean;
  memoryInjectionBudget: number;
  memoryTokensUsed: number;
  memoryTruncated: boolean;
  toolResultInjectionBudget: number;
  toolResultTokensUsed?: number;
}): ContextAssemblyBudget {
  return {
    inputTokenBudget: input.inputTokenBudget,
    projectedInputTokens: input.projectedInputTokens,
    historyBudget: input.historyBudget,
    historyTokensUsed: input.historyTokensUsed,
    historyTruncated: input.historyTruncated,
    memoryInjectionBudget: input.memoryInjectionBudget,
    memoryTokensUsed: input.memoryTokensUsed,
    memoryTruncated: input.memoryTruncated,
    toolResultInjectionBudget: input.toolResultInjectionBudget,
    toolResultTokensUsed: input.toolResultTokensUsed ?? 0
  };
}
