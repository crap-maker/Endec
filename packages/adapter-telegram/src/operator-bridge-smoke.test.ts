import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEndecApp } from "@endec/app";
import {
  createInMemoryTelegramAdapterStateStore,
  createTelegramAdapter,
  createTelegramReplyFallbackText,
  type TelegramBotClient
} from "./index.ts";

type JsonObject = Record<string, unknown>;
type EndecProviderTransport = NonNullable<Parameters<typeof createEndecApp>[0]["providerTransport"]>;
type PairApprovalApp = {
  operator: {
    listPairClaims(input: {
      source: "telegram";
      accountId: string;
      includeInactive: boolean;
    }): Promise<{ claims: Array<{ claimId?: string }> }>;
    approvePairClaim(input: {
      source: "telegram";
      accountId: string;
      claimId?: string;
      operatorActorId: string;
    }): Promise<{ outcome: string }>;
  };
};

const tempDirs = new Set<string>();

async function createTempDataDir() {
  const directory = await mkdtemp(join(tmpdir(), "endec-tg-operator-smoke-"));
  tempDirs.add(directory);
  return directory;
}

function createChatCompletionTransport(
  responses: Array<Array<JsonObject>>,
  onRequest?: (request: unknown) => void
): EndecProviderTransport {
  let index = 0;

  return {
    async *stream(request) {
      onRequest?.(request);
      const response = responses[index] ?? responses[responses.length - 1] ?? [];
      index += 1;

      for (const chunk of response) {
        yield chunk;
      }
    }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

async function approveLatestPairClaim(app: PairApprovalApp) {
  const claims = await app.operator.listPairClaims({
    source: "telegram",
    accountId: "acct_bot",
    includeInactive: true
  });

  expect(claims.claims).toHaveLength(1);

  const approved = await app.operator.approvePairClaim({
    source: "telegram",
    accountId: "acct_bot",
    claimId: claims.claims[0]?.claimId,
    operatorActorId: "operator_alpha"
  });

  expect(approved.outcome).toBe("approved");
}

describe("telegram operator blocked bridge smoke", () => {
  it("auto-pairs the first ordinary private DM, then bridges a later blocked turn while preserving operator inspection", async () => {
    const dataDir = await createTempDataDir();
    const capturedProviderRequests: unknown[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "requesting operator approval for bash"
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
                      id: "tool_call_tg_bash_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command: "printf telegram-operator-smoke; git push --dry-run . HEAD:refs/heads/endec-test-dry-run"
                        })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 18,
              total_tokens: 48
            }
          }
        ]
      ], (request) => capturedProviderRequests.push(request))
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const getUpdates: TelegramBotClient["getUpdates"] = vi.fn(async () => []);

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app: {
        shell: {
          executeTurn: app.shell.executeTurn
        },
        im: {
          resolveSessionId: app.im.resolveSessionId,
          resolveActorId: app.im.resolveActorId,
          recordPassiveIngress: app.im.recordPassiveIngress,
          executeCommand: app.im.executeCommand,
          evaluateInboundAdmission: app.im.evaluateInboundAdmission,
          applyConversationLifecycleEvent: app.im.applyConversationLifecycleEvent,
          evaluateOutboundConversationLegality: app.im.evaluateOutboundConversationLegality
        }
      },
      client: {
        sendMessage,
        getUpdates,
        sendChatAction: async () => undefined,
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    const firstHandled = await adapter.handleUpdate({
      update_id: 700,
      message: {
        message_id: 100,
        date: 1_712_002_000,
        text: "hello there",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(firstHandled).toMatchObject({
      status: "direct_replied",
      admissionDecision: {
        outcome: "reply_direct"
      }
    });
    expect(capturedProviderRequests).toHaveLength(0);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      chatId: "42",
      text: expect.stringMatching(/pair code/i),
      messageThreadId: undefined,
      replyToMessageId: 100
    });

    await approveLatestPairClaim(app);

    const handled = await adapter.handleUpdate({
      update_id: 701,
      message: {
        message_id: 101,
        date: 1_712_002_001,
        text: "请执行需要审批的 bash 操作",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(handled.status).toBe("dispatched");
    if (handled.status !== "dispatched") {
      throw new Error(`expected telegram update to dispatch, got ${handled.status}`);
    }

    const { turnRequest, turnResult } = handled;
    expect(turnRequest).toMatchObject({
      source: "telegram",
      workspaceId: "workspace_local",
      actorId: expect.stringMatching(/^actor_im_/),
      input: "请执行需要审批的 bash 操作"
    });
    expect(turnResult).toMatchObject({
      turnId: turnRequest.turnId,
      sessionId: turnRequest.sessionId,
      status: "blocked",
      blockedBy: "permission",
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_tg_bash_001",
          toolName: "bash",
          state: "ask",
          permissionDecision: expect.objectContaining({
            decisionId: "tool_call_tg_bash_001",
            behavior: "ask"
          })
        })
      ]
    });
    expect(capturedProviderRequests).toHaveLength(1);
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      chatId: "42",
      text: createTelegramReplyFallbackText({
        status: "blocked",
        blockedBy: "permission",
        warnings: []
      }),
      messageThreadId: undefined,
      replyToMessageId: 101
    });

    const sentText = vi.mocked(sendMessage).mock.calls[1]?.[0].text ?? "";
    expect(sentText).toContain("Endec operator / CLI");
    expect(sentText).toContain("审批");
    expect(sentText).toContain("Telegram 聊天内暂不支持审批");
    expect(sentText).not.toContain("tool_call_tg_bash_001");
    expect(sentText).not.toContain("truth");
    expect(sentText).not.toContain("authoritativeTruth");
    expect(sentText).not.toContain("observability");
    expect(sentText).not.toContain("{");
    expect(sentText).not.toContain("}");

    const inspection = await app.operator.inspectOperatorTurn({
      target: {
        sessionId: turnResult.sessionId,
        workspaceId: turnRequest.workspaceId,
        actorId: turnRequest.actorId,
        turnId: turnResult.turnId
      }
    });

    expect(inspection).not.toBeNull();
    expect(inspection).toMatchObject({
      target: {
        sessionId: turnResult.sessionId,
        workspaceId: turnRequest.workspaceId,
        actorId: turnRequest.actorId,
        turnId: turnResult.turnId
      },
      summary: {
        state: "blocked"
      },
      continuation: {
        state: "blocked",
        replyPath: "blocked",
        blockedBy: "permission",
        pendingDecision: expect.objectContaining({
          decisionId: "tool_call_tg_bash_001",
          behavior: "ask"
        }),
        actionAuthorization: expect.objectContaining({
          toolName: "bash"
        })
      },
      truth: {
        capabilityTruth: {
          visibleToolNames: expect.arrayContaining(["bash"]),
          approvalRequiredCapabilities: expect.arrayContaining(["remote_git_push"]),
          actionAuthorizations: expect.arrayContaining([
            expect.objectContaining({
              toolName: "bash",
              authorizationLevel: "approval-required"
            })
          ])
        }
      },
      context: {
        observability: {
          authoritativeTruth: expect.objectContaining({
            packet: expect.any(Object),
            summary: expect.any(Object),
            consistency: expect.any(Object)
          })
        }
      },
      explanation: {
        nextActions: expect.arrayContaining([
          expect.objectContaining({ code: "approve-pending-decision", kind: "approve", requiresApproval: true }),
          expect.objectContaining({ code: "cancel-pending-execution", kind: "cancel" })
        ])
      }
    });
    expect(inspection?.continuation?.allowedActions.map((action) => action.kind)).toEqual(["approve", "deny", "cancel"]);
    expect(inspection?.continuation?.pendingDecision?.reasonText).toContain("git push");
    expect(inspection?.context.summary.truthSummary).toContain("approval-required");
    expect(JSON.stringify(inspection?.explanation.nextActions)).not.toMatch(/because chat mode has no bash|resolvedMode === chat|mode-derived/i);
  });

  it("passively ingests trusted shared traffic and answers /status locally in the same trusted group", async () => {
    const dataDir = await createTempDataDir();
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const sendMessage: TelegramBotClient["sendMessage"] = vi.fn(async (input) => ({
      messageId: `sent_${input.chatId}`,
      chatId: input.chatId
    }));
    const sendChatAction: TelegramBotClient["sendChatAction"] = vi.fn(async () => undefined);

    const adapter = createTelegramAdapter({
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      app: {
        shell: {
          executeTurn: app.shell.executeTurn
        },
        im: {
          resolveSessionId: app.im.resolveSessionId,
          resolveActorId: app.im.resolveActorId,
          recordPassiveIngress: app.im.recordPassiveIngress,
          executeCommand: app.im.executeCommand,
          evaluateInboundAdmission: app.im.evaluateInboundAdmission,
          applyConversationLifecycleEvent: app.im.applyConversationLifecycleEvent,
          evaluateOutboundConversationLegality: app.im.evaluateOutboundConversationLegality
        }
      },
      client: {
        sendMessage,
        sendChatAction,
        getUpdates: async () => [],
        getMe: async () => ({
          id: 999,
          is_bot: true,
          username: "endec"
        })
      },
      stateStore
    });

    const firstHandled = await adapter.handleUpdate({
      update_id: 710,
      message: {
        message_id: 110,
        date: 1_714_100_000,
        text: "hello there",
        chat: {
          id: 42,
          type: "private"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        }
      }
    });

    expect(firstHandled).toMatchObject({ status: "direct_replied" });
    await approveLatestPairClaim(app);

    const lifecycleHandled = await adapter.handleUpdate({
      update_id: 711,
      my_chat_member: {
        date: 1_714_100_000,
        chat: {
          id: -100123,
          type: "supergroup"
        },
        from: {
          id: 7,
          is_bot: false,
          username: "owner"
        },
        old_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "left"
        },
        new_chat_member: {
          user: { id: 999, is_bot: true, username: "endec" },
          status: "member"
        }
      }
    });

    expect(lifecycleHandled).toMatchObject({ status: "lifecycle_applied" });

    const chatActionCallsBeforePassive = vi.mocked(sendChatAction).mock.calls.length;
    const messageCallsBeforePassive = vi.mocked(sendMessage).mock.calls.length;
    const passiveHandled = await adapter.handleUpdate({
      update_id: 712,
      message: {
        message_id: 111,
        date: 1_714_100_001,
        text: "release slipped by one day",
        chat: {
          id: -100123,
          type: "supergroup"
        },
        from: {
          id: 9,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(passiveHandled).toMatchObject({ status: "passive_ingested" });
    expect(vi.mocked(sendChatAction).mock.calls).toHaveLength(chatActionCallsBeforePassive);
    expect(vi.mocked(sendMessage).mock.calls).toHaveLength(messageCallsBeforePassive);

    const statusHandled = await adapter.handleUpdate({
      update_id: 713,
      message: {
        message_id: 112,
        date: 1_714_100_002,
        text: "/status",
        chat: {
          id: -100123,
          type: "supergroup"
        },
        from: {
          id: 9,
          is_bot: false,
          username: "alice"
        }
      }
    });

    expect(statusHandled).toMatchObject({ status: "command_replied" });
    expect(vi.mocked(sendMessage).mock.calls.at(-1)?.[0]).toMatchObject({
      chatId: "-100123",
      replyToMessageId: 112,
      text: expect.stringContaining("scope: shared")
    });
  });
});
