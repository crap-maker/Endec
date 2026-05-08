import { describe, expect, it, vi } from "vitest";
import * as ai from "./index";

function getFactory() {
  const createHttpProviderTransport = (ai as Record<string, unknown>).createHttpProviderTransport as
    | undefined
    | ((options?: { fetch?: typeof fetch }) => { stream(request: any): AsyncIterable<unknown> });

  expect(createHttpProviderTransport).toBeTypeOf("function");
  return createHttpProviderTransport!;
}

async function collect(stream: AsyncIterable<unknown>) {
  const items: unknown[] = [];

  for await (const item of stream) {
    items.push(item);
  }

  return items;
}

function createSseResponse(events: string[], init?: ResponseInit) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      }
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream"
      },
      ...init
    }
  );
}

describe("createHttpProviderTransport", () => {
  it("sends POST JSON requests to baseUrl + path", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );
    const transport = getFactory()({ fetch: fetchMock });

    const items = await collect(
      transport.stream({
        providerId: "openai",
        modelId: "gpt-4o-mini",
        protocolFamily: "chat_completions",
        baseUrl: "https://api.openai.com/v1",
        path: "/chat/completions",
        method: "POST",
        headers: {
          Authorization: "Bearer test-key"
        },
        body: {
          model: "gpt-4o-mini",
          stream: true
        }
      }) as AsyncIterable<unknown>
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: true
        })
      })
    );
    expect(items).toEqual([{ ok: true }]);
  });

  it("merges caller headers and adds a default JSON content-type", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );
    const transport = getFactory()({ fetch: fetchMock });

    await collect(
      transport.stream({
        providerId: "openai",
        modelId: "gpt-4o-mini",
        protocolFamily: "chat_completions",
        baseUrl: "https://api.openai.com/v1/",
        path: "chat/completions",
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "X-Trace-Id": "trace-123"
        },
        body: {
          ok: true
        }
      }) as AsyncIterable<unknown>
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "X-Trace-Id": "trace-123",
          "content-type": "application/json"
        })
      })
    );
  });

  it("parses SSE responses into multiple yielded JSON events", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createSseResponse([
        'data: {"type":"message_start"}\n\n',
        '\n',
        'data: {"type":"message_delta","delta":"hello"}\n\n',
        'data: [DONE]\n\n'
      ])
    );
    const transport = getFactory()({ fetch: fetchMock });

    const items = await collect(
      transport.stream({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        protocolFamily: "anthropic_messages",
        baseUrl: "https://api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": "test-key"
        },
        body: {
          stream: true
        }
      }) as AsyncIterable<unknown>
    );

    expect(items).toEqual([
      { type: "message_start" },
      { type: "message_delta", delta: "hello" }
    ]);
  });

  it("yields once for a JSON object response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "resp_1", status: "completed" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );
    const transport = getFactory()({ fetch: fetchMock });

    const items = await collect(
      transport.stream({
        providerId: "openai",
        modelId: "gpt-5-mini",
        protocolFamily: "responses",
        baseUrl: "https://api.openai.com/v1",
        path: "/responses",
        method: "POST",
        headers: {},
        body: {
          stream: false
        }
      }) as AsyncIterable<unknown>
    );

    expect(items).toEqual([{ id: "resp_1", status: "completed" }]);
  });

  it("yields each item for a JSON array response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ index: 0 }, { index: 1 }]), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      })
    );
    const transport = getFactory()({ fetch: fetchMock });

    const items = await collect(
      transport.stream({
        providerId: "openai",
        modelId: "gpt-5-mini",
        protocolFamily: "responses",
        baseUrl: "https://api.openai.com/v1",
        path: "/responses",
        method: "POST",
        headers: {},
        body: {
          stream: false
        }
      }) as AsyncIterable<unknown>
    );

    expect(items).toEqual([{ index: 0 }, { index: 1 }]);
  });

  it("throws a descriptive error for non-2xx responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "content-type": "application/json"
        }
      })
    );
    const transport = getFactory()({ fetch: fetchMock });

    await expect(
      collect(
        transport.stream({
          providerId: "openai",
          modelId: "gpt-4o-mini",
          protocolFamily: "chat_completions",
          baseUrl: "https://api.openai.com/v1",
          path: "/chat/completions",
          method: "POST",
          headers: {},
          body: {
            stream: true
          }
        }) as AsyncIterable<unknown>
      )
    ).rejects.toThrow(
      /openai[\s\S]*gpt-4o-mini[\s\S]*chat_completions[\s\S]*https:\/\/api\.openai\.com\/v1\/chat\/completions[\s\S]*429[\s\S]*Too Many Requests[\s\S]*rate limit exceeded/
    );
  });

  it("throws a descriptive error for invalid JSON SSE events", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createSseResponse(['data: {not-json}\n\n'])
    );
    const transport = getFactory()({ fetch: fetchMock });

    await expect(
      collect(
        transport.stream({
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          protocolFamily: "anthropic_messages",
          baseUrl: "https://api.anthropic.com",
          path: "/v1/messages",
          method: "POST",
          headers: {},
          body: {
            stream: true
          }
        }) as AsyncIterable<unknown>
      )
    ).rejects.toThrow(/Invalid JSON SSE event[\s\S]*\{not-json\}/);
  });
});
