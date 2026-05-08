import type { TurnRequest } from "@endec/domain";

export type SelfAwarenessExposurePolicy =
  | "canonical"
  | "none"
  | "owner_private_self_awareness"
  | "owner_private_self_awareness_mutating";

const OWNER_PRIVATE_SELF_AWARENESS_TARGET_NEEDLES = [
  "provider key",
  "provider api key",
  "provider secret",
  "your own",
  "your code",
  "your source",
  "your docs",
  "your config",
  "your repo",
  "this repo",
  "source code",
  "configuration",
  "api key",
  "secret",
  ".env",
  "models.json",
  "readme.md",
  "architecture.md",
  "product.md",
  "docker-compose",
  "repo",
  "docs",
  "config",
  "source",
  "workspace",
  "package.json",
  "packages/",
  "docs/",
  "dist/",
  "data/config",
  "endec",
  "你自己的",
  "你的源码",
  "你的代码",
  "你的文档",
  "你的配置",
  "这个仓库",
  "源码",
  "文档",
  "配置",
  "密钥",
  "仓库"
];

const OWNER_PRIVATE_SELF_AWARENESS_VERB_NEEDLES = [
  "read",
  "show",
  "open",
  "search",
  "grep",
  "find",
  "list",
  "glob",
  "inspect",
  "look at",
  "scan",
  "查看",
  "读取",
  "打开",
  "搜索",
  "查找",
  "列出",
  "看看",
  "检索"
];

const OWNER_PRIVATE_SECRET_TARGET_NEEDLES = [
  "api key",
  "provider key",
  "provider api key",
  "provider secret",
  "secret",
  "密钥"
];

const OWNER_PRIVATE_REVEAL_NEEDLES = [
  "show full",
  "full api key",
  "full provider key",
  "reveal",
  "raw secret",
  "full secret",
  "without masking",
  "without mask",
  "完整",
  "原样",
  "不要掩码",
  "不脱敏"
];

const OWNER_PRIVATE_MUTATION_NEEDLES = [
  "edit",
  "modify",
  "change",
  "update",
  "rewrite",
  "fix",
  "patch",
  "写",
  "修改",
  "更新",
  "编辑",
  "改写",
  "修复"
];

function isImConversationSource(source: TurnRequest["source"]) {
  return source === "telegram" || source === "feishu";
}

function isOwnerPrivateConversation(request: Pick<TurnRequest, "source" | "conversationRef" | "imContext">) {
  return isImConversationSource(request.source)
    && !!request.conversationRef?.accountId
    && request.imContext?.boundary.conversationScope === "direct";
}

function normalizeIntentText(input: string) {
  return input.toLowerCase();
}

function hasAnyNeedle(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function hasRepoPathHint(text: string) {
  return /(?:^|[\s`'"(])(?:packages|docs|dist|data\/config)\/[\w./-]+/iu.test(text)
    || /\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|ya?ml)\b/iu.test(text);
}

export function inspectSelfAwarenessIntent(request: Pick<TurnRequest, "input">) {
  const normalized = normalizeIntentText(request.input);
  const mentionsTarget = hasAnyNeedle(normalized, OWNER_PRIVATE_SELF_AWARENESS_TARGET_NEEDLES) || hasRepoPathHint(normalized);
  const mentionsInspectionAction = hasAnyNeedle(normalized, OWNER_PRIVATE_SELF_AWARENESS_VERB_NEEDLES);

  if (!mentionsTarget && !(mentionsInspectionAction && hasRepoPathHint(normalized))) {
    return {
      kind: "none" as const,
      explicitMutation: false,
      explicitReveal: false
    };
  }

  const explicitMutation = hasAnyNeedle(normalized, OWNER_PRIVATE_MUTATION_NEEDLES);
  const mentionsSecretTarget = hasAnyNeedle(normalized, OWNER_PRIVATE_SECRET_TARGET_NEEDLES)
    || (/\bkey\b/iu.test(normalized) && /\b(?:provider|api)\b/iu.test(normalized));
  const explicitReveal = mentionsSecretTarget && hasAnyNeedle(normalized, OWNER_PRIVATE_REVEAL_NEEDLES);

  return {
    kind: "self_awareness" as const,
    explicitMutation,
    explicitReveal
  };
}

export function resolveSelfAwarenessPolicy(
  request: Pick<TurnRequest, "source" | "conversationRef" | "imContext" | "input">,
  options: { ownerValidated: boolean }
): {
  policy: SelfAwarenessExposurePolicy;
  accountId?: string;
} {
  const intent = inspectSelfAwarenessIntent(request);
  if (intent.kind === "none" || !isImConversationSource(request.source)) {
    return { policy: "canonical" };
  }

  const accountId = request.conversationRef?.accountId;
  if (!accountId || !isOwnerPrivateConversation(request) || options.ownerValidated !== true) {
    return {
      policy: "none",
      accountId
    };
  }

  return {
    policy: intent.explicitMutation ? "owner_private_self_awareness_mutating" : "owner_private_self_awareness",
    accountId
  };
}
