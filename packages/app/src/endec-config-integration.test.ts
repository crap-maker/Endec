import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnRequest } from "@endec/domain";
import { createEndecApp } from "./index.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";

const tempDirs = new Set<string>();

async function tempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "endec-config-integration-"));
  tempDirs.add(dir);
  return dir;
}

async function createChatCompletionTransport() {
  return {
    async *stream() {
      yield {
        choices: [{ delta: { content: "ok" } }]
      };
      yield {
        choices: [{ finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      };
    }
  };
}

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "telegram",
    actorId: "owner_user",
    input: "/provider",
    attachments: [],
    ...overrides
  };
}

async function primeOwnerBinding(app: ReturnType<typeof createEndecApp>) {
  const conversationRef = {
    source: "telegram" as const,
    accountId: "acct_bot",
    conversationId: "private:owner",
    peerId: "owner_user",
    peerKind: "dm" as const
  };

  await app.im.evaluateInboundAdmission({
    source: "telegram",
    workspaceId: "workspace_local",
    accountId: "acct_bot",
    senderId: "owner_user",
    conversationRef,
    conversationScope: "direct",
    activationHint: {
      pairRequested: true,
      explicitActivation: true,
      mentionMatched: true
    }
  });

  const claims = await app.operator.listPairClaims({
    source: "telegram",
    accountId: "acct_bot",
    includeInactive: true
  });
  await app.operator.approvePairClaim({
    source: "telegram",
    accountId: "acct_bot",
    claimId: claims.claims[0]?.claimId,
    operatorActorId: "operator_alpha"
  });

  const ownerActorId = await app.im.resolveActorId({
    source: "telegram",
    workspaceId: "workspace_local",
    accountId: "acct_bot",
    senderId: "owner_user",
    conversationRef
  });

  return {
    conversationRef,
    ownerActorId
  };
}

function createProviderCommandIntent() {
  return {
    name: "provider" as const,
    subcommand: "show",
    args: [],
    options: {},
    rawText: "/provider",
    helpRequested: false
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...tempDirs].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    tempDirs.delete(directory);
  }));
});

describe("owner config integration", () => {
  it("writes provider edits into endec.json and keeps the reply masked", async () => {
    const dataDir = await tempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4"
      },
      providerTransport: await createChatCompletionTransport()
    });
    const { conversationRef, ownerActorId } = await primeOwnerBinding(app);
    const paths = ensureEndecDataLayout(dataDir);

    const reply = await app.im.executeCommand({
      turnRequest: createTurnRequest({
        turnId: "turn_provider_masked",
        actorId: ownerActorId,
        input: "/provider key set sk-config-secret-1234",
        conversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:owner",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      }),
      commandIntent: {
        name: "provider",
        subcommand: "key",
        args: ["set", "sk-config-secret-1234"],
        options: {},
        rawText: "/provider key set sk-config-secret-1234",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(reply).toMatchObject({
      kind: "reply_text"
    });
    if (reply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${reply.kind}`);
    }
    expect(reply.replyText).toContain("key: sk-****1234");
    expect(reply.replyText).not.toContain("sk-config-secret-1234");
    expect(await readFile(paths.endecConfigPath, "utf8")).toContain("sk-config-secret-1234");
  });

  it("reloads config state in-process after an external config edit", async () => {
    const dataDir = await tempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4"
      },
      providerTransport: await createChatCompletionTransport()
    });
    const { conversationRef, ownerActorId } = await primeOwnerBinding(app);
    const paths = ensureEndecDataLayout(dataDir);

    const before = await app.operator.getStatus();
    await writeFile(paths.endecConfigPath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-05-03T12:00:00.000Z",
      ownerSelected: true,
      provider: {
        providerId: "openai",
        modelId: "gpt-5.5",
        baseUrl: "https://custom.openai.example/v1",
        apiKey: "sk-reloaded-secret-9999"
      },
      embeddings: {
        enabled: false,
        providerId: "openai",
        modelId: "gpt-5.5",
        baseUrl: "https://custom.openai.example/v1",
        apiKey: "sk-reloaded-secret-9999",
        indexBackend: "sqlite_vec",
        allowedKinds: ["chat_summary", "typed_memory", "evidence", "memory_md", "user_memory_doc"],
        chunking: {
          maxDocumentChars: 12000,
          maxChunkChars: 2400,
          overlapChars: 200
        }
      }
    }, null, 2), "utf8");

    const reply = await app.im.executeCommand({
      turnRequest: createTurnRequest({
        turnId: "turn_reload_001",
        actorId: ownerActorId,
        input: "/reload",
        conversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:owner",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      }),
      commandIntent: {
        name: "reload" as never,
        args: [],
        options: {},
        rawText: "/reload",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    const after = await app.operator.getStatus();

    expect(before.currentModel.modelId).toBe("gpt-5.4");
    expect(reply).toMatchObject({ kind: "reply_text" });
    if (reply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${reply.kind}`);
    }
    expect(reply.replyText).toContain("loadedAt:");
    expect(reply.replyText).toContain("schemaVersion: 1");
    expect(after.currentModel.modelId).toBe("gpt-5.5");
    expect(after.currentModel.baseUrl).toBe("https://custom.openai.example/v1");
  });

  it("only requests graceful self-exit after the restart acknowledgement is ready to send", async () => {
    const dataDir = await tempDataDir();
    tempDirs.add(dataDir);
    const requestExit = vi.fn();
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4"
      },
      providerTransport: await createChatCompletionTransport(),
      requestExit
    });
    const { conversationRef, ownerActorId } = await primeOwnerBinding(app);

    const reply = await app.im.executeCommand({
      turnRequest: createTurnRequest({
        turnId: "turn_restart_001",
        actorId: ownerActorId,
        input: "/restart",
        conversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:owner",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      }),
      commandIntent: {
        name: "restart" as never,
        args: [],
        options: {},
        rawText: "/restart",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(reply).toMatchObject({ kind: "reply_text" });
    if (reply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${reply.kind}`);
    }
    expect(reply.replyText).toContain("Graceful restart requested");
    expect(requestExit).not.toHaveBeenCalled();
    await reply.afterReplyDelivered?.();
    expect(requestExit).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining("restart") }));
  });

  it("reports /restart as unavailable when this runtime has no restart callback", async () => {
    const dataDir = await tempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4"
      },
      providerTransport: await createChatCompletionTransport()
    });
    const { conversationRef, ownerActorId } = await primeOwnerBinding(app);

    const reply = await app.im.executeCommand({
      turnRequest: createTurnRequest({
        turnId: "turn_restart_unconfigured_001",
        actorId: ownerActorId,
        input: "/restart",
        conversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:owner",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      }),
      commandIntent: {
        name: "restart" as never,
        args: [],
        options: {},
        rawText: "/restart",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(reply).toMatchObject({
      kind: "reply_text",
      replyText: "/restart is not configured for this runtime."
    });
  });
});
