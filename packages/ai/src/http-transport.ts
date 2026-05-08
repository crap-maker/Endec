import type { ProviderTransport, ProviderTransportRequest } from "./provider-adapter";

export interface HttpProviderTransportOptions {
  fetch?: typeof fetch;
}

function resolveFetch(fetchImplementation?: typeof fetch) {
  const resolvedFetch = fetchImplementation ?? globalThis.fetch;

  if (typeof resolvedFetch !== "function") {
    throw new Error("HTTP provider transport requires a fetch implementation");
  }

  return resolvedFetch;
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function withJsonContentType(headers: Record<string, string>) {
  if (Object.keys(headers).some((header) => header.toLowerCase() === "content-type")) {
    return { ...headers };
  }

  return {
    ...headers,
    "content-type": "application/json"
  };
}

async function readResponseText(response: Response) {
  try {
    return await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `<failed to read response body: ${reason}>`;
  }
}

async function parseJsonBody(response: Response) {
  const bodyText = await response.text();

  try {
    return JSON.parse(bodyText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON provider response: ${reason}\nBody: ${bodyText}`);
  }
}

function isEventStream(response: Response) {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

async function* readStreamChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) {
    return;
  }

  const asyncIterable = body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
  if (typeof asyncIterable[Symbol.asyncIterator] === "function") {
    for await (const chunk of asyncIterable) {
      yield chunk;
    }
    return;
  }

  const reader = body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(dataLines: string[]) {
  if (dataLines.length === 0) {
    return null;
  }

  const data = dataLines.join("\n");
  if (!data.trim() || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON SSE event: ${reason}\nData: ${data}`);
  }
}

async function* parseSseResponse(response: Response) {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flushEvent = function* () {
    const parsed = parseSseEvent(dataLines);
    dataLines = [];

    if (parsed !== null) {
      yield parsed;
    }
  };

  const processLine = function* (line: string) {
    if (!line) {
      yield* flushEvent();
      return;
    }

    if (line.startsWith(":")) {
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  };

  for await (const chunk of readStreamChunks(response.body)) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      yield* processLine(line);
    }
  }

  buffer += decoder.decode();

  if (buffer.length > 0) {
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    yield* processLine(line);
  }

  yield* flushEvent();
}

async function* parseJsonResponse(response: Response) {
  const parsed = await parseJsonBody(response);

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      yield item;
    }
    return;
  }

  yield parsed;
}

function extractErrorMessage(bodyText: string) {
  try {
    const parsed = JSON.parse(bodyText);
    const providerMessage = parsed?.error?.message;
    if (typeof providerMessage === "string" && providerMessage.length > 0) {
      return providerMessage;
    }
  } catch {
    // fall through to raw body
  }

  return bodyText;
}

function formatTransportError(request: ProviderTransportRequest, url: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Provider transport failed for ${request.providerId}/${request.modelId} via ${request.protocolFamily}\nURL: ${url}\n${message}`
  );
}

export function createHttpProviderTransport(options: HttpProviderTransportOptions = {}): ProviderTransport {
  const fetchImplementation = resolveFetch(options.fetch);

  return {
    async *stream(request: ProviderTransportRequest) {
      const url = joinUrl(request.baseUrl, request.path);
      const response = await fetchImplementation(url, {
        method: request.method,
        headers: withJsonContentType(request.headers),
        body: JSON.stringify(request.body)
      });

      if (!response.ok) {
        const bodyText = extractErrorMessage(await readResponseText(response));
        throw new Error(
          `Provider HTTP request failed for ${request.providerId}/${request.modelId} via ${request.protocolFamily}\nURL: ${url}\nStatus: ${response.status} ${response.statusText}\nBody: ${bodyText}`
        );
      }

      try {
        if (isEventStream(response)) {
          yield* parseSseResponse(response);
          return;
        }

        yield* parseJsonResponse(response);
      } catch (error) {
        throw formatTransportError(request, url, error);
      }
    }
  };
}
