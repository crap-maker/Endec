import type { TurnRequest } from "@endec/domain";
import type { NormalizedInboundMessage } from "./types.ts";

const ENGLISH_REVIEW_VERB = /\b(review|audit|critique|inspect)\b/i;
const ENGLISH_WORK_OBJECT = /\b(patch|diff|pr|pull request|changes?|code|repo|repository|file|files|test|tests|bug|issue|log|logs)\b/i;
const ENGLISH_ACTION_VERB = /\b(fix|debug|investigate|analyze|inspect|check|read|search|grep|glob|edit|write|update|modify|implement|run|execute)\b/i;
const ENGLISH_EXPLICIT_ACTION_VERB = /\b(fix|debug|investigate|read|search|grep|glob|edit|write|update|modify|implement|run|execute)\b/i;
const ENGLISH_DIRECT_TOOL = /\b(grep|glob|edit|write|bash)\b/i;
const CHINESE_REVIEW_VERB = /(审查|评审|review)/i;
const CHINESE_WORK_OBJECT = /(补丁|差异|diff|pr|代码|仓库|文件|测试|报错|错误|日志|问题)/i;
const CHINESE_ACTION_VERB = /(修复|排查|分析|检查|读取|搜索|查看|修改|更新|实现|调试|运行|执行)/i;
const CHINESE_EXPLICIT_ACTION_VERB = /(修复|排查|读取|搜索|查看|修改|更新|实现|调试|运行|执行)/i;
const CHINESE_DIRECT_TOOL = /(修改文件|运行命令|执行命令)/i;

export function resolveImRequestedMode(input: Pick<NormalizedInboundMessage, "text" | "requestedMode">): TurnRequest["requestedMode"] {
  if (input.requestedMode) {
    return input.requestedMode;
  }

  const normalizedText = normalizeRoutingText(input.text);
  if (looksLikeExplicitExecutionRequest(normalizedText)) {
    return "act";
  }

  if (looksLikeReviewRequest(normalizedText)) {
    return "review";
  }

  if (looksLikeExecutionRequest(normalizedText)) {
    return "act";
  }

  return "chat";
}

function looksLikeReviewRequest(text: string) {
  return (ENGLISH_REVIEW_VERB.test(text) && ENGLISH_WORK_OBJECT.test(text))
    || (CHINESE_REVIEW_VERB.test(text) && CHINESE_WORK_OBJECT.test(text));
}

function looksLikeExplicitExecutionRequest(text: string) {
  return ENGLISH_DIRECT_TOOL.test(text)
    || CHINESE_DIRECT_TOOL.test(text)
    || ((ENGLISH_EXPLICIT_ACTION_VERB.test(text) || CHINESE_EXPLICIT_ACTION_VERB.test(text))
      && (ENGLISH_WORK_OBJECT.test(text) || CHINESE_WORK_OBJECT.test(text)));
}

function looksLikeExecutionRequest(text: string) {
  return looksLikeExplicitExecutionRequest(text)
    || ((ENGLISH_ACTION_VERB.test(text) || CHINESE_ACTION_VERB.test(text))
      && (ENGLISH_WORK_OBJECT.test(text) || CHINESE_WORK_OBJECT.test(text)));
}

function normalizeRoutingText(text: string) {
  return text
    .replace(/@[\w_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
