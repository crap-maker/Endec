import { describe, expect, it } from "vitest";
import { resolveImRequestedMode } from "./requested-mode.ts";

describe("resolveImRequestedMode", () => {
  it("routes explicit review asks to review", () => {
    expect(resolveImRequestedMode({
      text: "@endec review this patch and call out the risky parts"
    })).toBe("review");

    expect(resolveImRequestedMode({
      text: "@endec inspect this patch and call out the risky parts"
    })).toBe("review");

    expect(resolveImRequestedMode({
      text: "@endec 请审查这个 PR 并指出高风险改动"
    })).toBe("review");
  });

  it("routes explicit execute asks to act even when review-ish words overlap", () => {
    expect(resolveImRequestedMode({
      text: "@endec inspect this repo and fix the failing tests"
    })).toBe("act");

    expect(resolveImRequestedMode({
      text: "@endec audit this repo and run the failing tests"
    })).toBe("act");

    expect(resolveImRequestedMode({
      text: "@endec 请检查这个仓库并排查失败测试"
    })).toBe("act");
  });

  it("keeps lightweight conversational traffic on chat", () => {
    expect(resolveImRequestedMode({
      text: "@endec summarize this topic"
    })).toBe("chat");

    expect(resolveImRequestedMode({
      text: "@endec 你能看见你自己的代码文件吗"
    })).toBe("chat");
  });

  it("preserves explicit requestedMode overrides", () => {
    expect(resolveImRequestedMode({
      text: "@endec keep this in review mode",
      requestedMode: "review"
    })).toBe("review");
  });
});
