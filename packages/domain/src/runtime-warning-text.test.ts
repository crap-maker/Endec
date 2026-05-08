import { describe, expect, it } from "vitest";
import {
  renderRuntimeErrorText,
  renderRuntimeWarningText,
  resolveErrorExposureMode
} from "./runtime-warning-text.ts";

describe("error exposure rendering", () => {
  it("renders passthrough root-cause text and keeps sanitized mode friendly", () => {
    expect(resolveErrorExposureMode(undefined)).toBe("passthrough");

    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error("outer wrapper", { cause: new Error("deep upstream failure") })
    })).toBe("deep upstream failure");

    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error("模型响应流提前结束，本轮已安全停止，请重试。")
    })).toBe("请求失败，请重试。");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "Provider stream ended without a completed event"
    }, "sanitized")).toBe("模型响应流提前结束，本轮已安全停止，请重试。");
  });

  it("prefers provider root-cause metadata over the local synthetic incomplete-stream text in passthrough mode", () => {
    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "Provider stream ended before emitting its required terminal completion event.",
      metadata: {
        rootCauseMessage: "upstream provider timeout"
      }
    }, "passthrough")).toBe("upstream provider timeout");
  });

  it("uses canonical passthrough warning text instead of friendly wrappers when the warning message is empty or already sanitized", () => {
    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "   "
    }, "passthrough")).toBe("Provider stream ended without a completed event");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "模型响应流提前结束，本轮已安全停止，请重试。"
    }, "passthrough")).toBe("Provider stream ended without a completed event");
  });

  it("falls back to the local synthetic incomplete-stream text when no usable root-cause metadata exists", () => {
    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "Provider stream ended before emitting its required terminal completion event."
    }, "passthrough")).toBe("Provider stream ended before emitting its required terminal completion event.");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "Provider stream ended before emitting its required terminal completion event.",
      metadata: {
        rootCauseMessage: "https://internal.example.com/debug/turn/123"
      }
    }, "passthrough")).toBe("Provider stream ended before emitting its required terminal completion event.");
  });

  it("skips already-sanitized wrapper text in passthrough error chains", () => {
    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error("upstream provider timeout", {
        cause: new Error("模型或运行时暂时异常，本轮已安全停止，请稍后重试。")
      })
    })).toBe("upstream provider timeout");
  });

  it("filters unsafe passthrough warning message content before rendering", () => {
    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "TypeError: boom\n    at run (/srv/endec/runtime.ts:42:9)"
    }, "passthrough")).toBe("Provider stream ended without a completed event");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "SELECT * FROM sessions WHERE session_id = 1"
    }, "passthrough")).toBe("Provider stream ended without a completed event");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "https://internal.example.com/debug/turn/123"
    }, "passthrough")).toBe("Provider stream ended without a completed event");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: '{"error":"oops","path":"/srv/endec/runtime.ts"}'
    }, "passthrough")).toBe("Provider stream ended without a completed event");
  });

  it("withholds credential-bearing passthrough warning and error text", () => {
    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "Authorization: Bearer sk-secret-value"
    }, "passthrough")).toBe("Provider stream ended without a completed event");

    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error("upstream request failed: OPENAI_API_KEY=top-secret")
    })).toBe("upstream request failed: [redacted credential]");

    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error("OPENAI_API_KEY=top-secret")
    })).toBe("请求失败，请重试。");
  });

  it("redacts lowercase and colon-delimited credential-bearing passthrough text", () => {
    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: "api_key=top-secret"
    }, "passthrough")).toBe("Provider stream ended without a completed event");

    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error("upstream request failed: access_token: top-secret")
    })).toBe("upstream request failed: [redacted credential]");

    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error("token=top-secret")
    })).toBe("请求失败，请重试。");
  });

  it("redacts quoted json credential fragments in passthrough messages", () => {
    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error('upstream request failed: {"api_key":"top-secret"}')
    })).toBe("upstream request failed: [redacted credential]");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: 'provider error: {"Authorization":"Bearer sk-secret"}'
    }, "passthrough")).toBe("provider error: [redacted credential]");
  });

  it("withholds prefixed structured passthrough payloads that embed file paths or urls", () => {
    expect(renderRuntimeErrorText({
      mode: "passthrough",
      error: new Error('provider error: {"error":"oops","path":"/srv/endec/runtime.ts"}')
    })).toBe("provider error");

    expect(renderRuntimeWarningText({
      code: "provider_stream_incomplete",
      message: 'provider error: {"error":"oops","url":"https://internal.example.com/debug/turn/123"}'
    }, "passthrough")).toBe("provider error");
  });
});
