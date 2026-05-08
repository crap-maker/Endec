import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEndecApp, type EndecAppOptions } from "@endec/app";
import { runCli } from "./main.ts";

type JsonObject = Record<string, unknown>;

const tempDirs = new Set<string>();

function createChatCompletionTransport(responses: Array<Array<JsonObject>>): NonNullable<EndecAppOptions["providerTransport"]> {
  let index = 0;

  return {
    async *stream() {
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
  };
}

async function createTempDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), "endec-cli-operator-access-smoke-"));
  tempDirs.add(dataDir);
  return dataDir;
}

function createBufferedWriter() {
  let buffer = "";

  return {
    writer: {
      write(text: string) {
        buffer += text;
      }
    },
    read() {
      return buffer;
    }
  };
}

function createPairingTransport() {
  return createChatCompletionTransport([
    [
      {
        choices: [
          {
            delta: {
              content: "pairing requested"
            }
          }
        ]
      }
    ]
  ]);
}

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("operator access CLI real app smoke", () => {
  it("renders owner, claims, approval, trusted list, revoke, and reset from shared operator contracts", async () => {
    const dataDir = await createTempDataDir();
    const app = createEndecApp({
      dataDir,
      providerTransport: createPairingTransport()
    });

    const source = "telegram" as const;
    const accountId = "acct_bot";
    const workspaceId = "workspace_pair_cli";
    const senderId = "owner_user";
    const ownerConversationRef = {
      accountId,
      conversationId: "dm:owner_user",
      peerId: senderId,
      peerKind: "dm" as const
    };
    const trustedConversationRef = {
      accountId,
      conversationId: "group:chat_100:thread:thread_1",
      peerId: "chat_100",
      peerKind: "group" as const,
      baseConversationId: "group:chat_100",
      parentConversationId: "group:chat_100",
      threadId: "thread_1"
    };

    const pairingDecision = await app.im.evaluateInboundAdmission({
      source,
      workspaceId,
      accountId,
      senderId,
      conversationRef: ownerConversationRef,
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });

    expect(pairingDecision.outcome).toBe("reply_direct");
    const pairCode = pairingDecision.directReply?.text.match(/[A-Z0-9]{8}/)?.[0];
    expect(pairCode).toBeTruthy();

    const ownerBefore = createBufferedWriter();
    const ownerBeforeExit = await runCli({
      argv: ["node", "endec", "operator", "owner", "--source", source, "--account", accountId],
      stdout: ownerBefore.writer,
      stderr: createBufferedWriter().writer,
      app,
      now: () => 1700000000000
    });
    expect(ownerBeforeExit).toBe(0);
    expect(ownerBefore.read()).toContain("owner: none");

    const claimsBefore = createBufferedWriter();
    const claimsBeforeExit = await runCli({
      argv: ["node", "endec", "operator", "pair-claims", "--source", source, "--account", accountId],
      stdout: claimsBefore.writer,
      stderr: createBufferedWriter().writer,
      app,
      now: () => 1700000000000
    });
    const claimsBeforeOutput = claimsBefore.read();
    expect(claimsBeforeExit).toBe(0);
    expect(claimsBeforeOutput).toContain("claim:");
    expect(claimsBeforeOutput).toContain(`code=${pairCode}`);

    const approveOut = createBufferedWriter();
    const approveErr = createBufferedWriter();
    const approveExit = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "pair-approve",
        "--source",
        source,
        "--account",
        accountId,
        "--code",
        pairCode!,
        "--operator-actor",
        "operator_alpha"
      ],
      stdout: approveOut.writer,
      stderr: approveErr.writer,
      app,
      now: () => 1700000000000
    });
    const approveOutput = approveOut.read();
    expect(approveExit).toBe(0);
    expect(approveErr.read()).toBe("");
    expect(approveOutput).toContain("outcome: approved");
    expect(approveOutput).toContain("pairingSuccessNoticeStatus: enqueued");
    expect(approveOutput).toContain("approvedByOperatorId: operator_alpha");

    await app.im.applyConversationLifecycleEvent({
      source,
      accountId,
      conversationRef: trustedConversationRef,
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: senderId
    });

    const ownerAfter = createBufferedWriter();
    const ownerAfterExit = await runCli({
      argv: ["node", "endec", "operator", "owner", "--source", source, "--account", accountId],
      stdout: ownerAfter.writer,
      stderr: createBufferedWriter().writer,
      app,
      now: () => 1700000000000
    });
    const ownerAfterOutput = ownerAfter.read();
    expect(ownerAfterExit).toBe(0);
    expect(ownerAfterOutput).toContain("owner: active");
    expect(ownerAfterOutput).toContain("ownerActorId:");
    expect(ownerAfterOutput).toContain("pairedConversation: dm:owner_user");
    expect(ownerAfterOutput).toContain("resolvedAssistantDisplayName: Endec");
    expect(ownerAfterOutput).toContain("resolvedTimezone: Asia/Shanghai");
    expect(ownerAfterOutput).toContain("timezoneSource: server_default");
    expect(ownerAfterOutput).toContain("ownerInitStatus: prompted");
    expect(ownerAfterOutput).toContain("ownerInitPromptVersion: 1");
    expect(ownerAfterOutput).toContain("ownerInitPromptSentAt:");
    expect(ownerAfterOutput).not.toContain("storedOwnerDisplayName:");
    expect(ownerAfterOutput).not.toContain("storedAssistantDisplayName:");
    expect(ownerAfterOutput).not.toContain("storedTimezone:");

    const trustedList = createBufferedWriter();
    const trustedListExit = await runCli({
      argv: ["node", "endec", "operator", "trusted-list", "--source", source, "--account", accountId],
      stdout: trustedList.writer,
      stderr: createBufferedWriter().writer,
      app,
      now: () => 1700000000000
    });
    const trustedListOutput = trustedList.read();
    expect(trustedListExit).toBe(0);
    expect(trustedListOutput).toContain("trust:");
    expect(trustedListOutput).toContain("coverage=descendants");
    expect(trustedListOutput).toContain("conversation: group:chat_100:thread:thread_1");

    const trustId = trustedListOutput.match(/trust: (\S+)/)?.[1];
    expect(trustId).toBeTruthy();

    const revokeOut = createBufferedWriter();
    const revokeErr = createBufferedWriter();
    const revokeExit = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "trusted-revoke",
        "--source",
        source,
        "--account",
        accountId,
        "--trust",
        trustId!,
        "--operator-actor",
        "operator_bravo",
        "--reason",
        "manual revoke"
      ],
      stdout: revokeOut.writer,
      stderr: revokeErr.writer,
      app,
      now: () => 1700000000000
    });
    const revokeOutput = revokeOut.read();
    expect(revokeExit).toBe(0);
    expect(revokeErr.read()).toBe("");
    expect(revokeOutput).toContain("outcome: revoked");
    expect(revokeOutput).toContain("revokedReason: manual revoke");
    expect(revokeOutput).toContain("revokedByOperatorId: operator_bravo");

    const resetOut = createBufferedWriter();
    const resetErr = createBufferedWriter();
    const resetExit = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "owner-reset",
        "--source",
        source,
        "--account",
        accountId,
        "--operator-actor",
        "operator_charlie",
        "--reason",
        "owner reset"
      ],
      stdout: resetOut.writer,
      stderr: resetErr.writer,
      app,
      now: () => 1700000000000
    });
    const resetOutput = resetOut.read();
    expect(resetExit).toBe(0);
    expect(resetErr.read()).toBe("");
    expect(resetOutput).toContain("outcome: reset");
    expect(resetOutput).toContain("newOwnerGeneration: 1");
    expect(resetOutput).toContain("revokedReason: owner reset");
    expect(resetOutput).toContain("revokedByOperatorId: operator_charlie");
  });

  it("renders stored owner preferences and completed init state after owner-init capture", async () => {
    const dataDir = await createTempDataDir();
    const app = createEndecApp({
      dataDir,
      providerTransport: createPairingTransport()
    });

    const source = "telegram" as const;
    const accountId = "acct_bot";
    const workspaceId = "workspace_pair_cli";
    const senderId = "owner_user";
    const ownerConversationRef = {
      accountId,
      conversationId: "dm:owner_user",
      peerId: senderId,
      peerKind: "dm" as const
    };

    const pairingDecision = await app.im.evaluateInboundAdmission({
      source,
      workspaceId,
      accountId,
      senderId,
      conversationRef: ownerConversationRef,
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });
    const pairCode = pairingDecision.directReply?.text.match(/[A-Z0-9]{8}/)?.[0];
    expect(pairCode).toBeTruthy();

    const approveExit = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "pair-approve",
        "--source",
        source,
        "--account",
        accountId,
        "--code",
        pairCode!,
        "--operator-actor",
        "operator_alpha"
      ],
      stdout: createBufferedWriter().writer,
      stderr: createBufferedWriter().writer,
      app,
      now: () => 1700000000000
    });
    expect(approveExit).toBe(0);

    const sessionId = await app.im.resolveSessionId({
      source,
      workspaceId,
      accountId,
      conversationRef: ownerConversationRef
    });
    const actorId = await app.im.resolveActorId({
      source,
      workspaceId,
      accountId,
      senderId,
      conversationRef: ownerConversationRef
    });

    const preflight = await app.im.preflightOwnerInit?.({
      turnRequest: {
        turnId: "turn_owner_init_cli_smoke",
        sessionId,
        workspaceId,
        source,
        actorId,
        input: "my name is Chiyo and call yourself Momo and timezone is Beijing time",
        attachments: [],
        requestedMode: "chat",
        conversationRef: ownerConversationRef,
        channelContext: {
          messageId: "msg_owner_init_cli_smoke"
        }
      },
      conversationScope: "direct"
    });
    expect(preflight).toMatchObject({
      outcome: "consumed",
      completionReason: "fields_captured"
    });

    const ownerOut = createBufferedWriter();
    const ownerExit = await runCli({
      argv: ["node", "endec", "operator", "owner", "--source", source, "--account", accountId],
      stdout: ownerOut.writer,
      stderr: createBufferedWriter().writer,
      app,
      now: () => 1700000000000
    });
    const ownerOutput = ownerOut.read();
    expect(ownerExit).toBe(0);
    expect(ownerOutput).toContain("storedOwnerDisplayName: Chiyo");
    expect(ownerOutput).toContain("storedAssistantDisplayName: Momo");
    expect(ownerOutput).toContain("storedTimezone: Asia/Shanghai");
    expect(ownerOutput).toContain("resolvedAssistantDisplayName: Momo");
    expect(ownerOutput).toContain("resolvedTimezone: Asia/Shanghai");
    expect(ownerOutput).toContain("timezoneSource: owner_preference");
    expect(ownerOutput).toContain("ownerInitStatus: completed");
    expect(ownerOutput).toContain("ownerInitPromptVersion: 1");
    expect(ownerOutput).toContain("ownerInitPromptSentAt:");
    expect(ownerOutput).toContain("ownerInitCompletionReason: fields_captured");
    expect(ownerOutput).toContain("ownerInitCompletedAt:");
  });
});
