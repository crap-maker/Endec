import { describe, expect, it, vi } from "vitest";
import { ProviderEventSchema } from "@endec/domain";
import { createProviderAdapter } from "./provider-adapter.ts";
import { createProviderCatalog } from "./provider-catalog.ts";

describe("ProviderAdapter", () => {
  it("routes invocations through the catalog, request-scoped auth overrides, and protocol normalizer", async () => {
    const transport = {
      stream: vi.fn(async function* (request: {
        protocolFamily: string;
        baseUrl: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
      }) {
        expect(request.protocolFamily).toBe("chat_completions");
        expect(request.baseUrl).toBe("https://metadata.example.com/v1");
        expect(request.headers.Authorization).toBe("Bearer metadata-override-key");
        expect(request.headers["X-Static"]).toBe("catalog-header");
        expect(request.headers["X-Metadata-Only"]).toBe("metadata-header");
        expect(request.body.tools).toMatchObject([
          {
            type: "function",
            function: {
              name: "read"
            }
          }
        ]);

        yield {
          choices: [
            {
              delta: {
                content: "I should inspect package.json before answering."
              }
            }
          ]
        };
        yield {
          choices: [
            {
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 12,
            total_tokens: 52,
            prompt_tokens_details: {
              cached_tokens: 16
            }
          }
        };
      })
    };

    const catalog = createProviderCatalog([
      {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        auth: {
          type: "bearer",
          token: "OPENAI_API_KEY"
        },
        headers: {
          "X-Static": "catalog-header"
        },
        models: [
          {
            modelId: "gpt-4o-mini",
            displayName: "GPT-4o mini",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: true,
              maxContextTokens: 128000,
              maxOutputTokens: 16384
            }
          }
        ]
      }
    ]);

    const adapter = createProviderAdapter({
      catalog,
      transport,
      env: {
        OPENAI_API_KEY: "env-openai-key"
      },
      clock: {
        now: () => "2026-04-09T00:00:00.000Z"
      }
    });

    const events = [];
    for await (const event of adapter.invoke({
      invocationId: "invoke_001",
      turnId: "turn_001",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      mode: "act",
      model: {
        providerId: "openai",
        modelId: "gpt-4o-mini"
      },
      contextBlocks: [
        {
          blockId: "ctx_system",
          kind: "system",
          content: "Stay inside the frozen provider seam.",
          sourceRefs: ["policy:system"]
        },
        {
          blockId: "ctx_user",
          kind: "user_input",
          content: "Inspect package.json.",
          sourceRefs: ["turn_001"]
        }
      ],
      tools: [
        {
          name: "read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"]
          }
        }
      ],
      outputTokenBudget: 256,
      metadata: {
        apiKey: "metadata-override-key",
        baseUrl: "https://metadata.example.com/v1",
        headers: {
          "X-Metadata-Only": "metadata-header"
        }
      }
    })) {
      events.push(ProviderEventSchema.parse(event));
    }

    expect(transport.stream).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.kind)).toEqual(["message_delta", "usage", "completed"]);
    expect(events[1]?.usage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      totalTokens: 52,
      estimatedCost: 0,
      cacheReadTokens: 16
    });
    expect(events[2]?.completion).toMatchObject({
      finishReason: "stop",
      messages: [
        {
          role: "assistant",
          content: "I should inspect package.json before answering."
        }
      ],
      usage: {
        inputTokens: 40,
        outputTokens: 12,
        totalTokens: 52,
        estimatedCost: 0,
        cacheReadTokens: 16
      }
    });

    await expect(
      adapter.describeModel?.({
        providerId: "openai",
        modelId: "gpt-4o-mini"
      })
    ).resolves.toMatchObject({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      protocolFamily: "chat_completions",
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsImages: true
      }
    });
  });

  it("omits tools and emits a normalized warning when the model metadata disables tool support", async () => {
    const transport = {
      stream: vi.fn(async function* (request: { body: Record<string, unknown> }) {
        expect(request.body.tools).toBeUndefined();

        yield {
          choices: [
            {
              delta: {
                content: "I cannot call tools on this model."
              }
            }
          ]
        };
        yield {
          choices: [
            {
              finish_reason: "stop"
            }
          ]
        };
      })
    };

    const catalog = createProviderCatalog([
      {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        auth: {
          type: "bearer",
          token: "OPENAI_API_KEY"
        },
        models: [
          {
            modelId: "gpt-no-tools",
            displayName: "GPT No Tools",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: false,
              supportsStreaming: true,
              maxContextTokens: 128000,
              maxOutputTokens: 4096
            }
          }
        ]
      }
    ]);

    const adapter = createProviderAdapter({
      catalog,
      transport,
      env: {
        OPENAI_API_KEY: "env-openai-key"
      },
      clock: {
        now: () => "2026-04-09T00:00:00.000Z"
      }
    });

    const events = [];
    for await (const event of adapter.invoke({
      invocationId: "invoke_002",
      turnId: "turn_002",
      sessionId: "session_002",
      workspaceId: "workspace_local",
      mode: "act",
      model: {
        providerId: "openai",
        modelId: "gpt-no-tools"
      },
      contextBlocks: [
        {
          blockId: "ctx_user",
          kind: "user_input",
          content: "Read package.json.",
          sourceRefs: ["turn_002"]
        }
      ],
      tools: [
        {
          name: "read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"]
          }
        }
      ],
      outputTokenBudget: 256
    })) {
      events.push(ProviderEventSchema.parse(event));
    }

    expect(events.map((event) => event.kind)).toEqual(["warning", "message_delta", "completed"]);
    expect(events[0]?.warning).toMatchObject({
      code: "provider_tools_unsupported"
    });
    expect(events[2]?.completion?.warnings).toEqual([
      expect.objectContaining({
        code: "provider_tools_unsupported"
      })
    ]);
  });

  it("wraps transport failures with provider, model, and protocol context", async () => {
    const transport = {
      stream: vi.fn(async function* () {
        throw new Error("upstream timeout");
      })
    };

    const adapter = createProviderAdapter({
      catalog: createProviderCatalog([
        {
          providerId: "anthropic",
          baseUrl: "https://api.anthropic.com",
          auth: {
            type: "api-key",
            token: "ANTHROPIC_API_KEY",
            headerName: "x-api-key"
          },
          models: [
            {
              modelId: "claude-sonnet-4-5",
              protocolFamily: "anthropic_messages",
              capabilities: {
                supportsTools: true,
                supportsStreaming: true,
                maxContextTokens: 200000,
                maxOutputTokens: 64000
              }
            }
          ]
        }
      ]),
      transport,
      env: {
        ANTHROPIC_API_KEY: "anthropic-key"
      }
    });

    await expect(async () => {
      for await (const _event of adapter.invoke({
        invocationId: "invoke_003",
        turnId: "turn_003",
        sessionId: "session_003",
        workspaceId: "workspace_local",
        mode: "chat",
        model: {
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5"
        },
        contextBlocks: [
          {
            blockId: "ctx_user",
            kind: "user_input",
            content: "Hello",
            sourceRefs: ["turn_003"]
          }
        ],
        tools: []
      })) {
        // consume
      }
    }).rejects.toThrow(/anthropic[\s\S]*claude-sonnet-4-5[\s\S]*anthropic_messages[\s\S]*upstream timeout/);
  });
});
