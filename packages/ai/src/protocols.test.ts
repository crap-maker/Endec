import { describe, expect, it } from "vitest";
import { ProviderEventSchema, sanitizeRuntimeErrorForUser } from "@endec/domain";
import {
  buildAnthropicMessagesRequest,
  normalizeAnthropicMessagesStream
} from "./protocols/anthropic-messages.ts";
import {
  buildChatCompletionsRequest,
  normalizeChatCompletionsStream
} from "./protocols/chat-completions.ts";
import { buildResponsesRequest, normalizeResponsesStream } from "./protocols/responses.ts";

function createInvocation(protocolFamily: "chat_completions" | "responses" | "anthropic_messages") {
  return {
    invocationId: `invoke_${protocolFamily}`,
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    mode: "act" as const,
    model: {
      providerId: protocolFamily === "anthropic_messages" ? "anthropic" : "openai",
      modelId:
        protocolFamily === "responses"
          ? "gpt-5-mini"
          : protocolFamily === "anthropic_messages"
            ? "claude-sonnet-4-5"
            : "gpt-4o-mini"
    },
    contextBlocks: [
      {
        blockId: "ctx_system",
        kind: "system" as const,
        content: "Follow the tool contract exactly.",
        sourceRefs: ["policy:system"]
      },
      {
        blockId: "ctx_memory",
        kind: "memory" as const,
        title: "working set",
        content: "The repository uses pnpm workspaces.",
        sourceRefs: ["working_set:1"]
      },
      {
        blockId: "ctx_user",
        kind: "user_input" as const,
        content: "Inspect package.json and report what changed.",
        sourceRefs: ["turn_001"]
      }
    ],
    tools: [
      {
        name: "read",
        description: "Read a file from disk.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    ],
    outputTokenBudget: 512
  };
}

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) {
    events.push(ProviderEventSchema.parse(event));
  }
  return events;
}

describe("protocol mapping", () => {
  it("maps chat completions requests and normalizes streamed chunks", async () => {
    const invocation = {
      ...createInvocation("chat_completions"),
      contextBlocks: [
        ...createInvocation("chat_completions").contextBlocks,
        {
          blockId: "ctx_history_assistant",
          kind: "history" as const,
          content: "I already inspected the repository root.",
          sourceRefs: ["turn_000"],
          metadata: {
            role: "assistant"
          }
        },
        {
          blockId: "ctx_tool_result",
          kind: "tool_result" as const,
          title: "read(package.json)",
          content: '{"name":"endec"}',
          sourceRefs: ["tool:call_read_0"],
          metadata: {
            toolCallId: "call_read_0",
            toolName: "read"
          }
        }
      ]
    };

    const request = buildChatCompletionsRequest({
      invocation,
      baseUrl: "https://api.openai.com/v1",
      headers: {
        Authorization: "Bearer test-key"
      }
    });

    expect(request.body).toMatchObject({
      model: "gpt-4o-mini",
      stream: true,
      max_tokens: 512,
      tools: [
        {
          type: "function",
          function: {
            name: "read"
          }
        }
      ]
    });
    expect(request.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "I already inspected the repository root."
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_read_0",
          content: '{"name":"endec"}'
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Inspect package.json")
        })
      ])
    );

    const events = await collect(
      normalizeChatCompletionsStream(
        [
          {
            choices: [
              {
                delta: {
                  content: "I should inspect the file first."
                }
              }
            ]
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read_1",
                      function: {
                        name: "read",
                        arguments: '{"path":"package.json"}'
                      }
                    }
                  ]
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 18,
              total_tokens: 138,
              prompt_tokens_details: {
                cached_tokens: 24
              }
            }
          }
        ],
        { invocationId: "invoke_chat", timestamp: "2026-04-09T00:00:00.000Z" }
      )
    );

    expect(events.map((event) => event.kind)).toEqual([
      "message_delta",
      "tool_call",
      "usage",
      "completed"
    ]);
    expect(events[1]?.toolCall).toEqual({
      toolCallId: "call_read_1",
      toolName: "read",
      arguments: {
        path: "package.json"
      }
    });
    expect(events[2]?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 18,
      totalTokens: 138,
      estimatedCost: 0,
      cacheReadTokens: 24
    });
    expect(events[3]?.completion).toMatchObject({
      finishReason: "tool_calls",
      usage: {
        inputTokens: 120,
        outputTokens: 18,
        totalTokens: 138,
        estimatedCost: 0,
        cacheReadTokens: 24
      },
      messages: [
        {
          role: "assistant",
          content: "I should inspect the file first."
        }
      ]
    });
  });

  it("maps responses requests and normalizes responses events", async () => {
    const invocation = {
      ...createInvocation("responses"),
      contextBlocks: [
        ...createInvocation("responses").contextBlocks,
        {
          blockId: "ctx_history_assistant",
          kind: "history" as const,
          content: "I already inspected the repository root.",
          sourceRefs: ["turn_000"],
          metadata: {
            role: "assistant"
          }
        },
        {
          blockId: "ctx_tool_result",
          kind: "tool_result" as const,
          title: "read(package.json)",
          content: '{"name":"endec"}',
          sourceRefs: ["tool:call_read_0"],
          metadata: {
            toolCallId: "call_read_0",
            toolName: "read"
          }
        }
      ]
    };

    const request = buildResponsesRequest({
      invocation,
      baseUrl: "https://api.openai.com/v1",
      headers: {
        Authorization: "Bearer test-key"
      }
    });

    expect(request.body).toMatchObject({
      model: "gpt-5-mini",
      max_output_tokens: 512,
      tools: [
        {
          type: "function",
          name: "read"
        }
      ]
    });
    expect(request.body.instructions).toContain("Follow the tool contract exactly.");
    expect(request.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant"
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_read_0",
          output: '{"name":"endec"}'
        }),
        expect.objectContaining({
          role: "user"
        })
      ])
    );

    const events = await collect(
      normalizeResponsesStream(
        [
          {
            type: "response.output_text.delta",
            delta: "I can explain the change after reading the file."
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_read_2",
              name: "read",
              arguments: '{"path":"package.json"}'
            }
          },
          {
            type: "response.completed",
            response: {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "I can explain the change after reading the file."
                    }
                  ]
                },
                {
                  type: "function_call",
                  call_id: "call_read_2",
                  name: "read",
                  arguments: '{"path":"package.json"}'
                }
              ],
              usage: {
                input_tokens: 90,
                output_tokens: 20,
                total_tokens: 110
              }
            }
          }
        ],
        { invocationId: "invoke_responses", timestamp: "2026-04-09T00:00:00.000Z" }
      )
    );

    expect(events.map((event) => event.kind)).toEqual([
      "message_delta",
      "tool_call",
      "usage",
      "completed"
    ]);
    expect(events[2]?.usage).toEqual({
      inputTokens: 90,
      outputTokens: 20,
      totalTokens: 110,
      estimatedCost: 0
    });
    expect(events[3]?.completion?.finishReason).toBe("tool_calls");
    expect(events[3]?.completion?.toolCalls[0]).toEqual({
      toolCallId: "call_read_2",
      toolName: "read",
      arguments: {
        path: "package.json"
      }
    });
  });

  it("maps anthropic messages requests and normalizes anthropic events", async () => {
    const invocation = {
      ...createInvocation("anthropic_messages"),
      contextBlocks: [
        ...createInvocation("anthropic_messages").contextBlocks,
        {
          blockId: "ctx_history_assistant",
          kind: "history" as const,
          content: "I already inspected the repository root.",
          sourceRefs: ["turn_000"],
          metadata: {
            role: "assistant"
          }
        },
        {
          blockId: "ctx_tool_result",
          kind: "tool_result" as const,
          title: "read(package.json)",
          content: '{"name":"endec"}',
          sourceRefs: ["tool:call_read_0"],
          metadata: {
            toolCallId: "call_read_0",
            toolName: "read"
          }
        }
      ]
    };

    const request = buildAnthropicMessagesRequest({
      invocation,
      baseUrl: "https://api.anthropic.com",
      headers: {
        "x-api-key": "test-key"
      }
    });

    expect(request.body).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      tools: [
        {
          name: "read"
        }
      ]
    });
    expect(request.body.system).toContain("Follow the tool contract exactly.");
    expect(request.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "I already inspected the repository root."
        }),
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "call_read_0"
            })
          ])
        }),
        expect.objectContaining({
          role: "user"
        })
      ])
    );

    const events = await collect(
      normalizeAnthropicMessagesStream(
        [
          {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "I need the file contents before I can summarize the change."
            }
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "toolu_01",
              name: "read",
              input: {}
            }
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"package.'
            }
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: 'json"}'
            }
          },
          {
            type: "message_delta",
            delta: {
              stop_reason: "tool_use"
            },
            usage: {
              input_tokens: 70,
              output_tokens: 16
            }
          },
          {
            type: "message_stop"
          }
        ],
        { invocationId: "invoke_anthropic", timestamp: "2026-04-09T00:00:00.000Z" }
      )
    );

    expect(events.map((event) => event.kind)).toEqual([
      "message_delta",
      "tool_call",
      "usage",
      "completed"
    ]);
    expect(events[1]?.toolCall).toEqual({
      toolCallId: "toolu_01",
      toolName: "read",
      arguments: {
        path: "package.json"
      }
    });
    expect(events[2]?.usage).toEqual({
      inputTokens: 70,
      outputTokens: 16,
      totalTokens: 86,
      estimatedCost: 0
    });
    expect(events[3]?.completion).toMatchObject({
      finishReason: "tool_calls",
      usage: {
        inputTokens: 70,
        outputTokens: 16,
        totalTokens: 86,
        estimatedCost: 0
      }
    });
  });

  it("renders runtime_repair as high-priority chat-completions instruction context", () => {
    const invocation = {
      ...createInvocation("chat_completions"),
      contextBlocks: [
        {
          blockId: "runtime_repair:1:tool_batch_limit",
          kind: "runtime_repair" as const,
          title: "Tool-call batch limit repair",
          content: "RUNTIME REPAIR: previous assistant response requested 3 tool calls; retry with at most 2.",
          tokenCount: 20,
          sourceRefs: ["turn_protocol_repair"],
          metadata: {
            code: "tool_batch_limit_repair",
            requestedToolCallsInBatch: 3,
            maxToolCallsPerBatch: 2,
            repairAttempt: 1,
            executedToolCalls: 0
          }
        },
        {
          blockId: "ctx_memory",
          kind: "memory" as const,
          title: "ordinary memory",
          content: "ordinary memory text",
          sourceRefs: ["memory:ordinary"]
        },
        {
          blockId: "ctx_user",
          kind: "user_input" as const,
          content: "ordinary user request",
          sourceRefs: ["turn_001"]
        }
      ]
    };

    const request = buildChatCompletionsRequest({
      invocation,
      baseUrl: "https://api.openai.com/v1",
      headers: {}
    });

    const serialized = JSON.stringify(request.body);
    expect(serialized).toContain("RUNTIME REPAIR");
    expect(serialized.indexOf("RUNTIME REPAIR")).toBeLessThan(serialized.indexOf("ordinary user request"));
    expect(serialized.indexOf("RUNTIME REPAIR")).toBeLessThan(serialized.indexOf("ordinary memory text"));
    expect(request.body.messages[0]).toEqual(expect.objectContaining({ role: expect.stringMatching(/system|developer/) }));
    expect(JSON.stringify(request.body.messages[0])).toContain("RUNTIME REPAIR");
  });

  it("renders runtime_repair as high-priority responses instruction context", () => {
    const invocation = {
      ...createInvocation("responses"),
      contextBlocks: [
        {
          blockId: "runtime_repair:1:tool_batch_limit",
          kind: "runtime_repair" as const,
          title: "Tool-call batch limit repair",
          content: "RUNTIME REPAIR: previous assistant response requested 3 tool calls; retry with at most 2.",
          tokenCount: 20,
          sourceRefs: ["turn_protocol_repair"]
        },
        {
          blockId: "ctx_memory",
          kind: "memory" as const,
          title: "ordinary memory",
          content: "ordinary memory text",
          sourceRefs: ["memory:ordinary"]
        },
        {
          blockId: "ctx_user",
          kind: "user_input" as const,
          content: "ordinary user request",
          sourceRefs: ["turn_001"]
        }
      ]
    };

    const request = buildResponsesRequest({
      invocation,
      baseUrl: "https://api.openai.com/v1",
      headers: {}
    });

    const serialized = JSON.stringify(request.body);
    expect(serialized).toContain("RUNTIME REPAIR");
    expect(serialized.indexOf("RUNTIME REPAIR")).toBeLessThan(serialized.indexOf("ordinary user request"));
    expect(serialized.indexOf("RUNTIME REPAIR")).toBeLessThan(serialized.indexOf("ordinary memory text"));
    expect(request.body.instructions).toContain("RUNTIME REPAIR");
  });

  it("renders runtime_repair as high-priority anthropic system instruction context", () => {
    const invocation = {
      ...createInvocation("anthropic_messages"),
      contextBlocks: [
        {
          blockId: "runtime_repair:1:tool_batch_limit",
          kind: "runtime_repair" as const,
          title: "Tool-call batch limit repair",
          content: "RUNTIME REPAIR: previous assistant response requested 3 tool calls; retry with at most 2.",
          tokenCount: 20,
          sourceRefs: ["turn_protocol_repair"]
        },
        {
          blockId: "ctx_memory",
          kind: "memory" as const,
          title: "ordinary memory",
          content: "ordinary memory text",
          sourceRefs: ["memory:ordinary"]
        },
        {
          blockId: "ctx_user",
          kind: "user_input" as const,
          content: "ordinary user request",
          sourceRefs: ["turn_001"]
        }
      ]
    };

    const request = buildAnthropicMessagesRequest({
      invocation,
      baseUrl: "https://api.anthropic.com",
      headers: {}
    });

    const serialized = JSON.stringify(request.body);
    expect(serialized).toContain("RUNTIME REPAIR");
    expect(serialized.indexOf("RUNTIME REPAIR")).toBeLessThan(serialized.indexOf("ordinary user request"));
    expect(serialized.indexOf("RUNTIME REPAIR")).toBeLessThan(serialized.indexOf("ordinary memory text"));
    expect(request.body.system).toContain("RUNTIME REPAIR");
  });

  it("does not over-sanitize explicit non-provider business errors", () => {
    expect(sanitizeRuntimeErrorForUser(new Error("工作区不存在或无权访问。"))).toBe("工作区不存在或无权访问。");
  });

  it("normalizes responses EOF without response.completed into a failed incomplete completion", async () => {
    const events = await collect(
      normalizeResponsesStream(
        [
          {
            type: "response.output_text.delta",
            delta: "partial answer that must not become final"
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_partial_1",
              name: "read",
              arguments: '{"path":"README.md"}'
            }
          }
        ],
        { invocationId: "invoke_responses_incomplete", timestamp: "2026-04-28T00:00:00.000Z" }
      )
    );

    expect(events.map((event) => event.kind)).toEqual([
      "message_delta",
      "tool_call",
      "warning",
      "completed"
    ]);
    expect(events[2]?.warning).toMatchObject({
      code: "provider_stream_incomplete",
      metadata: expect.objectContaining({
        invocationId: "invoke_responses_incomplete",
        protocolFamily: "responses",
        observedEventCount: 2
      })
    });
    expect(events[3]?.completion).toMatchObject({
      invocationId: "invoke_responses_incomplete",
      finishReason: "failed",
      messages: [],
      toolCalls: [],
      warnings: [expect.objectContaining({ code: "provider_stream_incomplete" })]
    });
  });

  it("captures responses provider error text for synthetic incomplete warnings", async () => {
    const events = await collect(
      normalizeResponsesStream(
        [
          {
            type: "response.failed",
            response: {
              error: {
                message: "upstream provider timeout"
              }
            }
          }
        ],
        { invocationId: "invoke_responses_failed", timestamp: "2026-04-28T00:00:00.000Z" }
      )
    );

    expect(events.map((event) => event.kind)).toEqual([
      "warning",
      "completed"
    ]);
    expect(events[0]?.warning).toMatchObject({
      code: "provider_stream_incomplete",
      message: "Provider stream ended before emitting its required terminal completion event.",
      metadata: expect.objectContaining({
        invocationId: "invoke_responses_failed",
        protocolFamily: "responses",
        observedEventCount: 1,
        rootCauseMessage: "upstream provider timeout"
      })
    });
  });

  it("normalizes anthropic EOF without message_stop into a failed incomplete completion", async () => {
    const events = await collect(
      normalizeAnthropicMessagesStream(
        [
          {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "partial anthropic text"
            }
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "toolu_partial_1",
              name: "read",
              input: { path: "README.md" }
            }
          }
        ],
        { invocationId: "invoke_anthropic_incomplete", timestamp: "2026-04-28T00:00:00.000Z" }
      )
    );

    expect(events.map((event) => event.kind)).toEqual([
      "message_delta",
      "tool_call",
      "warning",
      "completed"
    ]);
    expect(events[2]?.warning).toMatchObject({
      code: "provider_stream_incomplete",
      metadata: expect.objectContaining({
        invocationId: "invoke_anthropic_incomplete",
        protocolFamily: "anthropic_messages",
        observedEventCount: 2
      })
    });
    expect(events[3]?.completion).toMatchObject({
      invocationId: "invoke_anthropic_incomplete",
      finishReason: "failed",
      messages: [],
      toolCalls: [],
      warnings: [expect.objectContaining({ code: "provider_stream_incomplete" })]
    });
  });

  it("captures anthropic provider error text for synthetic incomplete warnings", async () => {
    const events = await collect(
      normalizeAnthropicMessagesStream(
        [
          {
            type: "error",
            error: {
              message: "anthropic overloaded"
            }
          }
        ],
        { invocationId: "invoke_anthropic_failed", timestamp: "2026-04-28T00:00:00.000Z" }
      )
    );

    expect(events.map((event) => event.kind)).toEqual([
      "warning",
      "completed"
    ]);
    expect(events[0]?.warning).toMatchObject({
      code: "provider_stream_incomplete",
      message: "Provider stream ended before emitting its required terminal completion event.",
      metadata: expect.objectContaining({
        invocationId: "invoke_anthropic_failed",
        protocolFamily: "anthropic_messages",
        observedEventCount: 1,
        rootCauseMessage: "anthropic overloaded"
      })
    });
  });
});
