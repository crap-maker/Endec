import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnRequest, TurnResult } from "@endec/domain";
import type { ProviderRegistration, ProviderTransport, ProviderTransportRequest } from "@endec/ai";
import { createMemoryStore } from "@endec/memory";
import { createSessionStore } from "@endec/sessions";
import { createAccessStore } from "@endec/access";
import { createRunControlStore, createTaskRunStore, createTaskStore, createRuntimeSliceStore } from "@endec/tasks";
import { createAgentCore } from "@endec/core";
import { createContextAssembler } from "./context-assembler.ts";
import { createEndecApp } from "./index.ts";
import { ensureEndecDataLayout } from "./data-paths.ts";
import { ensureEndecConfig } from "./endec-config-store.ts";

type JsonObject = Record<string, unknown>;

function createTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: "turn_001",
    sessionId: "session_001",
    workspaceId: "workspace_local",
    source: "cli" as const,
    actorId: "actor_cli",
    input: "hello from app",
    attachments: [],
    ...overrides
  };
}

function createChatCompletionTransport(
  responses: Array<Array<JsonObject>>,
  onRequest?: (request: ProviderTransportRequest) => void
): ProviderTransport {
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

function createCompletedTransportResponse(text: string): Array<JsonObject> {
  return [
    {
      choices: [
        {
          delta: {
            content: text
          }
        }
      ]
    },
    {
      choices: [
        {
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18
      }
    }
  ];
}

async function createTempDataDir() {
  return mkdtemp(join(tmpdir(), "endec-app-"));
}

async function createTempToolWorkspace(prefix: string) {
  return mkdtemp(join(process.cwd(), prefix));
}

const tempDirs = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();

  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("createEndecApp", () => {
  it("executes a real turn and commits session truth that operator history can browse and search", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "hello from the real app"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 12,
              total_tokens: 36
            }
          }
        ]
      ])
    });

    const result = await app.shell.executeTurn(createTurnRequest());
    const history = await app.operator.browseSessionHistory({
      sessionId: "session_001",
      limit: 10
    });
    const search = await app.operator.searchSessionEvents({
      workspaceId: "workspace_local",
      sessionId: "session_001",
      queryText: "real app",
      limit: 10
    });
    const lookedUp = await app.operator.lookupSessionEvent({
      sessionId: "session_001",
      eventId: history.items[0]?.eventId
    });
    const sessions = await app.operator.listSessions({
      workspaceId: "workspace_local",
      limit: 10
    });

    expect(result).toMatchObject({
      turnId: "turn_001",
      sessionId: "session_001",
      status: "completed",
      resolvedMode: "chat",
      messages: [
        {
          role: "assistant",
          content: "hello from the real app"
        }
      ],
      usage: {
        inputTokens: 24,
        outputTokens: 12,
        totalTokens: 36,
        estimatedCost: 0
      }
    });
    expect(history.items.map((item) => item.eventKind)).toEqual(
      expect.arrayContaining(["assistant_message", "user_message"])
    );
    expect(search.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: "assistant_message",
          summary: expect.stringContaining("hello from the real app")
        })
      ])
    );
    expect(lookedUp.entry).toEqual(history.items[0]);
    expect(sessions.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session_001",
          workspaceId: "workspace_local",
          status: "active",
          mode: "chat"
        })
      ])
    );
  });

  it("closes a same-turn readonly multi-step loop through the composed app runtime", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const toolWorkspace = await createTempToolWorkspace(".endec-readonly-tools-");
    tempDirs.add(toolWorkspace);
    const toolFile = join(toolWorkspace, "runtime-loop.txt");
    await writeFile(toolFile, "phase 3 runtime loop contents", "utf8");
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "Let me read that file."
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
                        id: "tool_call_read_001",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({ path: toolFile })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 28,
                completion_tokens: 14,
                total_tokens: 42
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "The file says: phase 3 runtime loop contents"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 36,
                completion_tokens: 12,
                total_tokens: 48
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_runtime_loop",
      input: "inspect the file with the readonly tools"
    }));
    const history = await app.operator.browseSessionHistory({
      sessionId: "session_001",
      limit: 10
    });
    const secondRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});

    expect(capturedRequests).toHaveLength(2);
    expect(secondRequestBody).toContain("phase 3 runtime loop contents");
    expect(result).toMatchObject({
      turnId: "turn_runtime_loop",
      sessionId: "session_001",
      status: "completed",
      messages: [
        {
          role: "assistant",
          content: "The file says: phase 3 runtime loop contents"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_read_001",
          toolName: "read",
          state: "executed"
        })
      ],
      usage: {
        inputTokens: 64,
        outputTokens: 26,
        totalTokens: 90,
        estimatedCost: 0
      }
    });
    expect(history.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: "turn_runtime_loop",
          eventKind: "tool_result"
        }),
        expect.objectContaining({
          turnId: "turn_runtime_loop",
          eventKind: "assistant_message",
          summary: expect.stringContaining("phase 3 runtime loop contents")
        })
      ])
    );
  });

  it("completes a chat readonly summary after a glob-read-answer loop", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const toolWorkspace = await createTempToolWorkspace(".endec-readonly-tools-");
    tempDirs.add(toolWorkspace);
    const composeFile = join(toolWorkspace, "docker-compose.yml");
    await writeFile(composeFile, [
      "services:",
      "  telegram:",
      "    image: endec-telegram:local",
      "    restart: unless-stopped"
    ].join("\n"), "utf8");
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "先定位 docker-compose.yml。"
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
                        id: "tool_call_glob_001",
                        type: "function",
                        function: {
                          name: "glob",
                          arguments: JSON.stringify({ cwd: toolWorkspace, pattern: "docker-compose.yml" })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 24,
                completion_tokens: 10,
                total_tokens: 34
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "找到文件，现在读取内容。"
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
                        id: "tool_call_read_001",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({ path: composeFile })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 30,
                completion_tokens: 12,
                total_tokens: 42
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "telegram 服务使用镜像 endec-telegram:local，并配置了 unless-stopped 重启策略。"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 40,
                completion_tokens: 16,
                total_tokens: 56
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_readonly_summary",
      input: "请读取 docker-compose.yml 并摘要 telegram 服务配置"
    }));
    const thirdRequestBody = JSON.stringify(capturedRequests[2]?.body ?? {});

    expect(capturedRequests).toHaveLength(3);
    expect(thirdRequestBody).toContain("endec-telegram:local");
    expect(result).toMatchObject({
      turnId: "turn_chat_readonly_summary",
      sessionId: "session_001",
      status: "completed",
      warnings: [],
      messages: [
        {
          role: "assistant",
          content: expect.stringContaining("endec-telegram:local")
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_glob_001",
          toolName: "glob",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_read_001",
          toolName: "read",
          state: "executed"
        })
      ]
    });
  });

  it("does not trip the chat readonly tool-call ceiling when discovery uses two glob calls before read", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const toolWorkspace = await createTempToolWorkspace(".endec-readonly-tools-");
    tempDirs.add(toolWorkspace);
    const composeFile = join(toolWorkspace, "docker-compose.yml");
    await writeFile(composeFile, [
      "services:",
      "  telegram:",
      "    image: endec-telegram:local",
      "    restart: unless-stopped",
      "    environment:",
      "      ENDEC_DATA_DIR: /data"
    ].join("\n"), "utf8");
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "先找 compose 文件。"
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
                        id: "tool_call_glob_001",
                        type: "function",
                        function: {
                          name: "glob",
                          arguments: JSON.stringify({ cwd: toolWorkspace, pattern: "docker-compose.yml" })
                        }
                      },
                      {
                        index: 1,
                        id: "tool_call_glob_002",
                        type: "function",
                        function: {
                          name: "glob",
                          arguments: JSON.stringify({ cwd: toolWorkspace, pattern: "configs/**/docker-compose.yml" })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 26,
                completion_tokens: 12,
                total_tokens: 38
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "定位完成，读取 telegram 服务配置。"
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
                        id: "tool_call_read_001",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({ path: composeFile })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 34,
                completion_tokens: 11,
                total_tokens: 45
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "telegram 服务挂载 ./data:/data，并显式设置 ENDEC_DATA_DIR=/data。"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 44,
                completion_tokens: 14,
                total_tokens: 58
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_tool_call_ceiling",
      input: "请读取 docker-compose.yml 并告诉我 telegram 服务的配置摘要"
    }));
    const secondRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});
    const thirdRequestBody = JSON.stringify(capturedRequests[2]?.body ?? {});

    expect(capturedRequests).toHaveLength(3);
    expect(secondRequestBody).toContain('"tool_call_id":"tool_call_glob_001"');
    expect(secondRequestBody).toContain('"tool_call_id":"tool_call_glob_002"');
    expect(thirdRequestBody).toContain("ENDEC_DATA_DIR: /data");
    expect(result).toMatchObject({
      turnId: "turn_chat_tool_call_ceiling",
      sessionId: "session_001",
      status: "completed",
      warnings: [],
      messages: [
        {
          role: "assistant",
          content: expect.stringContaining("ENDEC_DATA_DIR=/data")
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_glob_001",
          toolName: "glob",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_glob_002",
          toolName: "glob",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_read_001",
          toolName: "read",
          state: "executed"
        })
      ]
    });
  });

  it("keeps owner-private self-awareness on chat with bounded inspect tools instead of generic workspace tools", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_owner",
      peerId: "chat_owner",
      peerKind: "dm" as const
    };
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4",
        OPENAI_API_KEY: "test-openai-key"
      },
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "先看源码入口，再看当前掩码配置。"
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
                        id: "tool_call_self_inspect_source_001",
                        type: "function",
                        function: {
                          name: "inspect_source",
                          arguments: JSON.stringify({ path: "packages/app/src/index.ts" })
                        }
                      },
                      {
                        index: 1,
                        id: "tool_call_self_inspect_config_001",
                        type: "function",
                        function: {
                          name: "inspect_config",
                          arguments: JSON.stringify({})
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 25,
                completion_tokens: 11,
                total_tokens: 36
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "可以。我会在 owner-private 边界内读取源码和掩码配置，但不会默认泄露完整密钥，也不会改文件。"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 40,
                completion_tokens: 15,
                total_tokens: 55
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });
    const paths = ensureEndecDataLayout(dataDir);
    const accessStore = createAccessStore({ filename: paths.accessDbPath });

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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
    const ownerBinding = await accessStore.inspectOwnerBinding({
      source: "telegram",
      accountId: "acct_bot"
    });
    const ownerActorId = ownerBinding?.ownerActorId ?? "owner_user";

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_self_inspection",
      source: "telegram",
      actorId: ownerActorId,
      input: "你能看见你自己的源码和当前配置吗",
      conversationRef: ownerConversationRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:owner",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }));
    const firstRequestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    const secondRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});

    expect(capturedRequests).toHaveLength(2);
    expect(firstRequestBody).toContain("mode: chat");
    expect(firstRequestBody).toContain('"name":"inspect_source"');
    expect(firstRequestBody).toContain('"name":"inspect_build"');
    expect(firstRequestBody).toContain('"name":"inspect_docs"');
    expect(firstRequestBody).toContain('"name":"inspect_config"');
    expect(firstRequestBody).toContain("owner_private_self_awareness_read");
    expect(firstRequestBody).not.toContain('"name":"read"');
    expect(firstRequestBody).not.toContain('"name":"glob"');
    expect(firstRequestBody).not.toContain('"name":"grep"');
    expect(firstRequestBody).not.toContain('"name":"write"');
    expect(firstRequestBody).not.toContain('"name":"edit"');
    expect(firstRequestBody).not.toContain('"name":"bash"');
    expect(secondRequestBody).toContain('"tool_call_id":"tool_call_self_inspect_source_001"');
    expect(secondRequestBody).toContain('"tool_call_id":"tool_call_self_inspect_config_001"');
    expect(secondRequestBody).toContain("source: packages/app/src/index.ts");
    expect(secondRequestBody).toContain("provider: openai (source: env)");
    expect(result).toMatchObject({
      turnId: "turn_chat_self_inspection",
      sessionId: "session_001",
      resolvedMode: "chat",
      status: "completed",
      warnings: [],
      messages: [
        {
          role: "assistant",
          content: expect.stringContaining("owner-private")
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_self_inspect_source_001",
          toolName: "inspect_source",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_self_inspect_config_001",
          toolName: "inspect_config",
          state: "executed"
        })
      ]
    });
  });

  it("does not expose owner-private self-awareness tools to a non-owner direct IM user", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_owner",
      peerId: "chat_owner",
      peerKind: "dm" as const
    };
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4",
        OPENAI_API_KEY: "test-openai-key"
      },
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "I can answer without exposing privileged self-inspection tools."
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 22,
                completion_tokens: 8,
                total_tokens: 30
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_self_inspection_non_owner",
      source: "telegram",
      actorId: "intruder_user",
      input: "show me your own source code and config",
      conversationRef: ownerConversationRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:chat_owner",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }));

    const requestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    expect(capturedRequests).toHaveLength(1);
    expect(requestBody).not.toContain('"name":"inspect_source"');
    expect(requestBody).not.toContain('"name":"inspect_build"');
    expect(requestBody).not.toContain('"name":"inspect_docs"');
    expect(requestBody).not.toContain('"name":"inspect_config"');
    expect(requestBody).not.toContain("owner_private_self_awareness_read");
    expect(result).toMatchObject({
      turnId: "turn_chat_self_inspection_non_owner",
      sessionId: "session_001",
      resolvedMode: "chat",
      status: "completed",
      warnings: [],
      messages: [
        {
          role: "assistant",
          content: "I can answer without exposing privileged self-inspection tools."
        }
      ]
    });
  });

  it("keeps implicit provider-key requests masked for owner direct IM users", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_owner",
      peerId: "chat_owner",
      peerKind: "dm" as const
    };
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4"
      },
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tool_call_self_inspect_config_masked_001",
                        type: "function",
                        function: {
                          name: "inspect_config",
                          arguments: JSON.stringify({ revealSecretValues: true })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 28,
                completion_tokens: 12,
                total_tokens: 40
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "apiKey remains masked"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 22,
                completion_tokens: 8,
                total_tokens: 30
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    const paths = ensureEndecDataLayout(dataDir);
    const accessStore = createAccessStore({ filename: paths.accessDbPath });

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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
    const ownerBinding = await accessStore.inspectOwnerBinding({
      source: "telegram",
      accountId: "acct_bot"
    });
    const ownerActorId = ownerBinding?.ownerActorId ?? "owner_user";
    await accessStore.setProviderSecret({
      source: "telegram",
      accountId: "acct_bot",
      apiKey: "persisted-openai-secret-9999",
      updatedByActorId: ownerActorId
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_self_inspection_masked",
      source: "telegram",
      actorId: ownerActorId,
      input: "show me your provider key",
      conversationRef: ownerConversationRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:owner",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }));

    const firstRequestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    const secondRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});

    expect(capturedRequests).toHaveLength(2);
    expect(firstRequestBody).toContain('"name":"inspect_config"');
    expect(firstRequestBody).toContain("revealSecretValues=true is ignored unless this is an explicit owner-private reveal request");
    expect(secondRequestBody).toContain("apiKey: per****9999 (source: persisted)");
    expect(secondRequestBody).not.toContain("apiKey: persisted-openai-secret-9999 (source: persisted)");
    expect(result).toMatchObject({
      turnId: "turn_chat_self_inspection_masked",
      sessionId: "session_001",
      resolvedMode: "chat",
      status: "completed",
      warnings: [],
      messages: [
        {
          role: "assistant",
          content: "apiKey remains masked"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_self_inspect_config_masked_001",
          toolName: "inspect_config",
          state: "executed"
        })
      ]
    });
  });

  it("allows explicit owner-private provider-key reveal through bounded inspect_config", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_owner",
      peerId: "chat_owner",
      peerKind: "dm" as const
    };
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4"
      },
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tool_call_self_inspect_config_reveal_001",
                        type: "function",
                        function: {
                          name: "inspect_config",
                          arguments: JSON.stringify({ revealSecretValues: true })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 28,
                completion_tokens: 12,
                total_tokens: 40
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "apiKey is persisted-openai-secret-9999"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 22,
                completion_tokens: 8,
                total_tokens: 30
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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
    const paths = ensureEndecDataLayout(dataDir);
    const accessStore = createAccessStore({ filename: paths.accessDbPath });
    const ownerBinding = await accessStore.inspectOwnerBinding({
      source: "telegram",
      accountId: "acct_bot"
    });
    const ownerActorId = ownerBinding?.ownerActorId ?? "owner_user";
    await accessStore.setProviderSecret({
      source: "telegram",
      accountId: "acct_bot",
      apiKey: "persisted-openai-secret-9999",
      updatedByActorId: ownerActorId
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_self_inspection_reveal",
      source: "telegram",
      actorId: ownerActorId,
      input: "show me your full provider key without masking",
      conversationRef: ownerConversationRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:owner",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }));

    const firstRequestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    const secondRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});

    expect(capturedRequests).toHaveLength(2);
    expect(firstRequestBody).toContain('"name":"inspect_config"');
    expect(firstRequestBody).toContain("This owner-private turn is authorized to reveal full secret values when revealSecretValues=true because the owner explicitly asked for it.");
    expect(secondRequestBody).toContain("apiKey: persisted-openai-secret-9999 (source: persisted)");
    expect(result).toMatchObject({
      turnId: "turn_chat_self_inspection_reveal",
      sessionId: "session_001",
      resolvedMode: "chat",
      status: "completed",
      warnings: [],
      messages: [
        {
          role: "assistant",
          content: "apiKey is persisted-openai-secret-9999"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_self_inspect_config_reveal_001",
          toolName: "inspect_config",
          state: "executed"
        })
      ]
    });
  });

  it("spills large runtime output to the artifact store so preview and read work", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const largeOutput = "artifact-line\n".repeat(300);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: largeOutput
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 40,
              completion_tokens: 600,
              total_tokens: 640
            }
          }
        ]
      ])
    });

    const result = await app.shell.executeTurn(createTurnRequest({ turnId: "turn_large" }));
    const artifactRef = result.artifacts?.[0];

    expect(result.status).toBe("completed");
    expect(artifactRef).toBeDefined();

    const preview = await app.operator.getArtifactPreview(artifactRef as never);
    const readResult = await app.operator.readArtifact({
      artifactId: (artifactRef as { artifactId: string }).artifactId,
      limit: 128
    });

    expect(preview).toMatchObject({
      artifactId: (artifactRef as { artifactId: string }).artifactId,
      truncated: true,
      previewText: expect.stringContaining("artifact-line")
    });
    expect(readResult).toMatchObject({
      content: largeOutput.slice(0, 128),
      nextCursor: expect.any(String)
    });
  });

  it("normalizes missing artifact preview and read lookups to null through the operator facade", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    await expect(app.operator.getArtifactPreview({ artifactId: "artifact_missing" })).resolves.toBeNull();
    await expect(app.operator.readArtifact({ artifactId: "artifact_missing", limit: 32 })).resolves.toBeNull();
  });

  it("threads toolExposureResolver into the provider-facing tool schema request", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      toolExposureResolver: async () => ({
        exposureSource: "lazy",
        exposedTools: [
          {
            name: "memory_lookup",
            description: "Look up a memory record",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" }
              },
              required: ["query"]
            }
          }
        ],
        hiddenToolNames: ["bash"]
      }),
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "custom exposure observed"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 8,
                total_tokens: 28
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    const result = await app.shell.executeTurn(createTurnRequest({ turnId: "turn_tool_exposure" }));
    const requestBody = JSON.stringify(capturedRequests[0]?.body ?? {});

    expect(result).toMatchObject({
      status: "completed",
      messages: [
        {
          role: "assistant",
          content: "custom exposure observed"
        }
      ]
    });
    expect(requestBody).toContain('"name":"memory_lookup"');
    expect(requestBody).not.toContain('"name":"read"');
  });

  it("injects runtime self-awareness into provider requests for telegram turns", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      toolExposureResolver: async () => ({
        exposureSource: "lazy",
        exposedTools: [
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
          },
          {
            name: "glob",
            description: "Find files",
            inputSchema: {
              type: "object",
              properties: {
                pattern: { type: "string" }
              },
              required: ["pattern"]
            }
          }
        ],
        hiddenToolNames: ["bash"]
      }),
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "telegram runtime awareness observed"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 8,
                total_tokens: 28
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_telegram_awareness",
      source: "telegram",
      actorId: "actor_tg",
      requestedMode: "act",
      input: "你现在通过什么入口和工具工作？"
    }))).resolves.toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "telegram runtime awareness observed" })]
    });

    const requestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    expect(requestBody).toContain("### runtime self-awareness");
    expect(requestBody).toContain("source/channel: telegram");
    expect(requestBody).toContain("mode: act");
    expect(requestBody).toContain("reply path: normal");
    expect(requestBody).toContain("exposed tools: read, glob");
  });

  it("keeps chat lightweight, keeps review strong, and exposes the unified permission truth surface", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "chat exposure observed"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 18,
                completion_tokens: 8,
                total_tokens: 26
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "review exposure observed"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 19,
                completion_tokens: 8,
                total_tokens: 27
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "act exposure observed"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 8,
                total_tokens: 28
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_exposure",
      requestedMode: "chat",
      input: "show my chat tools"
    }))).resolves.toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "chat exposure observed" })]
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_review_exposure",
      requestedMode: "review",
      input: "review the current diff"
    }))).resolves.toMatchObject({
      resolvedMode: "review",
      status: "completed",
      messages: [expect.objectContaining({ content: "review exposure observed" })]
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_act_exposure",
      requestedMode: "act",
      input: "show my act tools"
    }))).resolves.toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "act exposure observed" })]
    });

    const chatRequestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    const reviewRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});
    const actRequestBody = JSON.stringify(capturedRequests[2]?.body ?? {});

    expect(chatRequestBody).toContain('"name":"read"');
    expect(chatRequestBody).toContain('"name":"glob"');
    expect(chatRequestBody).toContain('"name":"grep"');
    expect(chatRequestBody).toContain('"name":"write"');
    expect(chatRequestBody).toContain('"name":"edit"');
    expect(chatRequestBody).toContain('"name":"bash"');
    expect(chatRequestBody).toContain('"model":"cheap-default"');
    expect(chatRequestBody).toContain("mode: chat");
    expect(chatRequestBody).toContain("exposed tools: read, glob, grep, write, edit, bash");
    expect(chatRequestBody).toContain("workspace_local_routine_bash=guaranteed");

    expect(reviewRequestBody).toContain('"name":"read"');
    expect(reviewRequestBody).toContain('"name":"glob"');
    expect(reviewRequestBody).toContain('"name":"grep"');
    expect(reviewRequestBody).toContain('"name":"write"');
    expect(reviewRequestBody).toContain('"name":"edit"');
    expect(reviewRequestBody).toContain('"name":"bash"');
    expect(reviewRequestBody).toContain('"model":"cheap-default"');
    expect(reviewRequestBody).toContain("mode: review");
    expect(reviewRequestBody).toContain("exposed tools: read, glob, grep, write, edit, bash");
    expect(reviewRequestBody).toContain("workspace_local_routine_bash=guaranteed");

    expect(actRequestBody).toContain('"name":"read"');
    expect(actRequestBody).toContain('"name":"glob"');
    expect(actRequestBody).toContain('"name":"grep"');
    expect(actRequestBody).toContain('"name":"write"');
    expect(actRequestBody).toContain('"name":"edit"');
    expect(actRequestBody).toContain('"name":"bash"');
    expect(actRequestBody).toContain('"model":"cheap-default"');
    expect(actRequestBody).toContain("mode: act");
    expect(actRequestBody).toContain("exposed tools: read, glob, grep, write, edit, bash");
  });

  it("completes a same-turn act loop that reads, edits, and then replies", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const toolWorkspace = await mkdtemp(join(process.cwd(), ".endec-act-tools-"));
    tempDirs.add(toolWorkspace);
    const targetFile = join(toolWorkspace, "note.txt");
    await writeFile(targetFile, "phase one\nphase two\n", "utf8");
    const relativeTargetFile = relative(process.cwd(), targetFile).replaceAll("\\", "/");
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "先读取文件。"
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
                        id: "tool_call_read_edit_loop_001",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({ path: relativeTargetFile })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 26,
                completion_tokens: 10,
                total_tokens: 36
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "现在修改文件。"
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
                        id: "tool_call_edit_loop_001",
                        type: "function",
                        function: {
                          name: "edit",
                          arguments: JSON.stringify({
                            path: relativeTargetFile,
                            edits: [
                              {
                                oldText: "phase two",
                                newText: "phase two updated"
                              }
                            ]
                          })
                        }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ],
              usage: {
                prompt_tokens: 34,
                completion_tokens: 12,
                total_tokens: 46
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "修改完成。"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 40,
                completion_tokens: 8,
                total_tokens: 48
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_act_read_edit_loop",
      requestedMode: "act",
      input: "read the file, update it, and finish the task"
    }));
    const thirdRequestBody = JSON.stringify(capturedRequests[2]?.body ?? {});

    expect(capturedRequests).toHaveLength(3);
    expect(await readFile(targetFile, "utf8")).toBe("phase one\nphase two updated\n");
    expect(thirdRequestBody).toContain("editsApplied");
    expect(result).toMatchObject({
      status: "completed",
      turnId: "turn_act_read_edit_loop",
      messages: [
        {
          role: "assistant",
          content: "修改完成。"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_read_edit_loop_001",
          toolName: "read",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_edit_loop_001",
          toolName: "edit",
          state: "executed"
        })
      ]
    });
  });

  it("auto-allows routine bash in chat mode under the unified truth surface", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "trying bash in chat mode"
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
                      id: "tool_call_bash_hidden_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "pwd" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 12,
              total_tokens: 36
            }
          }
        ]
      ])
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_chat_hidden_bash",
      requestedMode: "chat",
      input: "try bash anyway"
    }));

    expect(result).toMatchObject({
      status: "interrupted",
      toolEvents: expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "tool_call_bash_hidden_001",
          toolName: "bash",
          state: "executed",
          permissionDecision: expect.objectContaining({
            behavior: "allow",
            reasonCode: "bash_action_auto_allowed"
          })
        })
      ])
    });
    await expect(app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    })).resolves.toBeNull();
  });

  it("updates the working set after committing a completed turn and rewires the session pointer", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const taskStore = createTaskStore({ filename: paths.tasksDbPath });
    await taskStore.upsertTask({
      taskId: "task_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      title: "Batch 3 / Lane 1 — working set synthesis",
      description: "Evolve the working set into structured continuity.",
      kind: "act",
      status: "active",
      lastTurnId: "turn_prev",
      checkpointRef: "checkpoint:task_001",
      currentStep: "write the failing tests",
      nextAction: "run app + memory verification"
    });
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "working set update reply"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 9,
              total_tokens: 27
            }
          }
        ]
      ])
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_working_set",
      taskId: "task_001",
      input: "remember the execution seam"
    }));
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const memoryStore = createMemoryStore({ filename: paths.memoryDbPath });
    const session = await sessionStore.loadById("session_001");
    const memory = await memoryStore.retrieve({
      query: {
        queryId: "query_after_commit",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        purpose: "turn_context",
        memoryTypes: ["working_set"],
        maxItems: 5,
        maxInjectTokens: 128
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      },
      typedMemory: [],
      evidence: []
    });

    expect(result.status).toBe("completed");
    expect(session).toMatchObject({
      workingSetVersion: 1,
      workingSetRef: expect.stringMatching(/^working_set:session_001:1$/)
    });
    expect(memory.workingSetSummary).toContain("Objective: Batch 3 / Lane 1 — working set synthesis");
    expect(memory.continuity?.workingSet).toMatchObject({
      objective: "Batch 3 / Lane 1 — working set synthesis",
      recentProgress: [
        "Task step: write the failing tests",
        "User asked: remember the execution seam",
        "Assistant replied: working set update reply",
        "Carry-forward: working set update reply"
      ],
      openLoops: ["run app + memory verification"],
      activeTaskRefs: ["task_001", "checkpoint:task_001"]
    });
    expect(memory.continuity?.workingSet.recentEventRefs).toEqual(
      expect.arrayContaining(["turn_working_set:user", "turn_working_set:message:0"])
    );
    expect(memory.continuity?.workingSet.sourceRefs).toEqual(
      expect.arrayContaining([
        "turn_working_set",
        "checkpoint:turn_working_set",
        "task_001",
        "checkpoint:task_001",
        "turn_working_set:user",
        "turn_working_set:message:0"
      ])
    );
    expect(memory.sourceRefs).toEqual(
      expect.arrayContaining(["turn_working_set", "task_001", "checkpoint:task_001"])
    );
  });

  it("materializes turn memory into durable typed memory that the next turn injects", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [
                {
                  delta: {
                    content: "Got it. I will remember that preference."
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 10,
                total_tokens: 30
              }
            }
          ],
          [
            {
              choices: [
                {
                  delta: {
                    content: "You said helix."
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 24,
                completion_tokens: 8,
                total_tokens: 32
              }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_memory_write",
      input: "Remember that my preferred editor is helix."
    }));

    const paths = ensureEndecDataLayout(dataDir);
    const memoryStore = createMemoryStore({ filename: paths.memoryDbPath });
    const typedMemory = await memoryStore.listTypedMemory({
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });

    expect(typedMemory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          writeId: "write:turn_memory_write",
          summary: expect.stringContaining("helix")
        })
      ])
    );

    await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_memory_read",
      input: "What editor preference did I mention earlier?"
    }));

    const secondRequestBody = JSON.stringify(capturedRequests[1]?.body ?? {});

    expect(capturedRequests).toHaveLength(2);
    expect(secondRequestBody).toContain("### session durable memory");
    expect(secondRequestBody).toContain("scope: session");
    expect(secondRequestBody).toContain("helix");
  });

  it("projects daily memory markdown after a committed turn drain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T09:30:00.000Z"));
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "Okay, I will keep that in mind."
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 9,
              total_tokens: 27
            }
          }
        ]
      ])
    });

    await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_daily_projection",
      input: "Remember that my preferred editor is helix."
    }));

    const paths = ensureEndecDataLayout(dataDir);
    const markdown = await readFile(
      join(paths.dailyMemoryProjectionDir, "workspace_local", "2026-04-16.md"),
      "utf8"
    );

    expect(markdown).toContain("# Daily Memory Projection");
    expect(markdown).toContain("- workspace_id: workspace_local");
    expect(markdown).toContain("Remember that my preferred editor is helix.");
    expect(markdown).toContain("turn_daily_projection");
  });

  it("keeps turn finalization intact when best-effort outbox materialization fails", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const memoryStore = createMemoryStore({ filename: paths.memoryDbPath });
    await memoryStore.enqueueWrites([
      {
        writeId: "write_bad_backlog",
        sourceTurnId: "turn_bad_backlog",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_bad_backlog"],
        proposedMemoryType: "broken"
      }
    ]);

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "completed despite failed backlog drain"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 9,
              total_tokens: 27
            }
          }
        ]
      ])
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_drain_failure",
      input: "finish this turn even if memory materialization fails"
    }));
    const outbox = await memoryStore.listOutbox();

    expect(result).toMatchObject({
      status: "completed",
      turnId: "turn_drain_failure"
    });
    expect(outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          writeId: "write_bad_backlog",
          status: "failed",
          lastError: expect.stringContaining("materializable content")
        }),
        expect.objectContaining({
          writeId: "write:turn_drain_failure",
          status: "processed"
        })
      ])
    );
  });

  it("persists history and session state when a blocked turn resumes on the same turn id", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      toolExposureResolver: async () => ({
        exposureSource: "lazy",
        exposedTools: [
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
          },
          {
            name: "glob",
            description: "Find files",
            inputSchema: {
              type: "object",
              properties: {
                pattern: { type: "string" }
              },
              required: ["pattern"]
            }
          }
        ],
        hiddenToolNames: ["bash"]
      }),
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "resume completed successfully"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 22,
              completion_tokens: 8,
              total_tokens: 30
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    const blocked = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_resume_same_turn",
      input: "budget ".repeat(5_000)
    }));
    const blockedSnapshot = await app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    });
    const blockedRuntimeAwareness = await app.operator.getRuntimeSelfAwareness({
      sessionId: "session_001"
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const memoryStore = createMemoryStore({ filename: paths.memoryDbPath });
    const blockedSession = await sessionStore.loadById("session_001");
    const blockedHistory = await app.operator.browseSessionHistory({
      sessionId: "session_001",
      limit: 10
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      blockedBy: "user_decision",
      turnId: "turn_resume_same_turn"
    });
    expect(blockedSnapshot).toMatchObject({
      schemaVersion: 1,
      contractVersion: "ws5.operator-recovery-snapshot.v1",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      recoverable: true,
      hasPendingExecution: true,
      turnId: "turn_resume_same_turn",
      frameRef: "frame:turn_resume_same_turn",
      checkpointRef: "checkpoint:turn_resume_same_turn",
      blockedBy: "user_decision",
      waitingReason: "user_decision",
      state: "awaiting_user_decision",
      allowedActions: ["resume", "cancel"],
      pendingApprovalRef: "budget:turn_resume_same_turn",
      pendingDecision: expect.objectContaining({
        decisionId: "budget:turn_resume_same_turn",
        reasonCode: "budget_requires_confirmation"
      }),
      contextSummary: expect.objectContaining({
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "chat",
        recentTurnRefs: ["turn_resume_same_turn"]
      }),
      runtimeSelfAwareness: expect.objectContaining({
        contractVersion: "ws5.runtime-self-awareness.v1",
        replyPath: "blocked"
      })
    });
    expect(blockedRuntimeAwareness).toEqual(blockedSnapshot?.runtimeSelfAwareness);
    expect(blockedSession).toMatchObject({
      status: "waiting_input",
      workingSetVersion: 1,
      recentTurnRefs: ["turn_resume_same_turn"]
    });

    await expect(app.operator.getRuntimeSelfAwareness({ sessionId: "session_001" })).resolves.toMatchObject({
      source: "cli",
      channel: "cli",
      mode: "chat",
      exposedToolNames: ["read", "glob"],
      replyPath: "blocked",
      constraints: [
        expect.objectContaining({
          code: "budget_requires_confirmation",
          blocking: true
        })
      ]
    });

    const resumed = await app.shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "resume",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      turnId: "turn_resume_same_turn",
      frameRef: "frame:turn_resume_same_turn",
      input: "continue once the operator approves the budget"
    });

    const snapshotAfterResume = await app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    });
    const runtimeAwarenessAfterResume = await app.operator.getRuntimeSelfAwareness({
      sessionId: "session_001"
    });
    const session = await sessionStore.loadById("session_001");
    const history = await app.operator.browseSessionHistory({
      sessionId: "session_001",
      limit: 10
    });
    const latestByTurn = await app.operator.lookupSessionEvent({
      sessionId: "session_001",
      turnId: "turn_resume_same_turn"
    });
    const memory = await memoryStore.retrieve({
      query: {
        queryId: "query_after_resume",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        purpose: "turn_context",
        memoryTypes: ["working_set", "typed_memory"],
        queryText: "resume completed successfully",
        maxItems: 5,
        maxInjectTokens: 128
      },
      recentHistory: {
        summary: "",
        refs: [],
        turnRefs: []
      }
    });
    const outbox = await memoryStore.listOutbox();
    const typedMemory = await memoryStore.listTypedMemory({
      sessionId: "session_001",
      workspaceId: "workspace_local"
    });

    expect(resumed).toMatchObject({
      status: "completed",
      turnId: "turn_resume_same_turn",
      messages: [
        {
          role: "assistant",
          content: "resume completed successfully"
        }
      ]
    });
    expect(snapshotAfterResume).toBeNull();
    expect(runtimeAwarenessAfterResume).toBeNull();
    const resumedRequestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    expect(resumedRequestBody).toContain("### runtime self-awareness");
    expect(resumedRequestBody).toContain("reply path: continuation");
    expect(resumedRequestBody).toContain("exposed tools: read, glob");
    expect(history.items.length).toBeGreaterThan(blockedHistory.items.length);
    expect(history.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: "turn_resume_same_turn",
          eventKind: "assistant_message",
          summary: expect.stringContaining("resume completed successfully")
        })
      ])
    );
    expect(latestByTurn.entry).toMatchObject({
      turnId: "turn_resume_same_turn",
      eventKind: "assistant_message",
      summary: expect.stringContaining("resume completed successfully")
    });
    expect(session).toMatchObject({
      status: "active",
      workingSetVersion: 2,
      recentTurnRefs: ["turn_resume_same_turn"]
    });
    expect(memory.workingSetSummary).toContain("resume completed successfully");
    expect(memory.sourceRefs).toContain("turn_resume_same_turn");
    expect(memory.continuity?.typedMemory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRefs: expect.arrayContaining(["turn_resume_same_turn"])
        })
      ])
    );
    expect(outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          writeId: "write:turn_resume_same_turn",
          status: "processed"
        })
      ])
    );
    expect(typedMemory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          writeId: "write:turn_resume_same_turn",
          summary: expect.stringContaining("resume completed successfully")
        })
      ])
    );
  });

  it("preserves continuation semantics while core + app assembly still retrieve user durable memory via the real actor", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const memoryStore = createMemoryStore({ filename: paths.memoryDbPath });
    await memoryStore.enqueueWrites([
      {
        writeId: "write_user_resume_pref",
        sourceTurnId: "turn_user_resume_pref",
        sessionId: "session_seed",
        workspaceId: "workspace_other",
        actorId: "actor_cli",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_user_resume_pref"],
        scope: "user",
        proposedMemoryType: "preference",
        importance: 0.9,
        content: {
          summary: "User preference: keep continuation status reports concise."
        }
      },
      {
        writeId: "write_other_actor_pref",
        sourceTurnId: "turn_other_actor_pref",
        sessionId: "session_other",
        workspaceId: "workspace_other",
        actorId: "actor_other",
        writeKind: "typed_upsert",
        evidenceRefs: ["turn_other_actor_pref"],
        scope: "user",
        proposedMemoryType: "preference",
        importance: 1,
        content: {
          summary: "Other user preference: verbose resume reports only."
        }
      }
    ]);
    await memoryStore.drainOutbox({ maxItems: 10 });

    const assembler = createContextAssembler({
      historyStore: {
        async loadRecentHistory() {
          return [];
        }
      },
      memoryStore: {
        ...memoryStore,
        async searchEvidence(input) {
          return {
            items: await memoryStore.searchEvidence(input)
          };
        }
      },
      taskStore: {
        async loadById() {
          return undefined;
        },
        async loadLatestActiveBySession() {
          return undefined;
        },
        async listActiveBySession() {
          return [];
        }
      },
      resolveToolExposure: async () => ({
        exposureSource: "policy",
        exposedTools: [
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
          },
          {
            name: "glob",
            description: "Find files",
            inputSchema: {
              type: "object",
              properties: {
                pattern: { type: "string" }
              },
              required: ["pattern"]
            }
          }
        ],
        hiddenToolNames: ["bash"]
      })
    });

    const run = vi.fn(async (input) => ({
      turnId: input.turnId,
      messages: [{ role: "assistant", content: "continuation resumed with real-actor memory" }],
      requestedToolCalls: [],
      loopCount: 0,
      toolCallCount: 0,
      toolResultTokensUsed: 0,
      usage: {
        inputTokens: 16,
        outputTokens: 8,
        totalTokens: 24,
        estimatedCost: 0
      },
      warnings: [],
      permissionDecisions: [],
      toolExecutionResults: [],
      artifacts: [],
      stopReason: "stop"
    }));

    const core = createAgentCore({
      sessionStore: {
        async loadOrCreate() {
          return { sessionId: "session_001", workspaceId: "workspace_local" };
        },
        async finalize() {
          return "session_state_ref_001";
        }
      },
      contextAssembler: assembler,
      memoryPort: {
        async enqueueWrites() {
          return [];
        }
      },
      toolPort: {
        async handleBatch(input) {
          return {
            schemaVersion: 1 as const,
            contractVersion: "ws0.tool-batch.v1" as const,
            batchId: input.batchId,
            turnId: input.turnId,
            requestedToolCalls: input.requestedToolCalls,
            permissionDecisions: [],
            executionResults: []
          };
        }
      },
      budgetPort: {
        async resolve() {
          return {
            resolvedMode: "chat" as const,
            model: {
              providerId: "local-default",
              modelId: "cheap-default",
              modelTier: "cheap" as const
            },
            limits: {
              inputTokenBudget: 6000,
              outputTokenBudget: 900,
              memoryInjectionBudget: 600,
              toolResultInjectionBudget: 800,
              maxLoopCount: 2,
              maxToolCallsPerBatch: 2,
              maxToolCallsPerTurn: 2
            }
          };
        },
        async recordCost() {
          return "ledger_001";
        }
      },
      runtimePort: {
        run: run as never
      }
    });

    const result = await core.continueExecution({
      session: {
        sessionId: "session_001",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "chat"
      },
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:turn_resume_user_memory",
        frameRef: "frame:turn_resume_user_memory",
        checkpointRef: "checkpoint:turn_resume_user_memory",
        status: "blocked",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:turn_resume_user_memory",
          checkpointRef: "checkpoint:turn_resume_user_memory",
          turnId: "turn_resume_user_memory",
          sessionId: "session_001",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "budget_check",
          pendingToolCalls: [],
          pendingPermissionDecisions: [
            {
              decisionId: "budget:turn_resume_user_memory",
              behavior: "ask",
              scope: "once",
              reasonCode: "budget_requires_confirmation",
              reasonText: "soft_limit",
              issuedAt: "2026-04-20T01:00:00.000Z",
              requestedBy: "turn_resume_user_memory"
            }
          ],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "awaiting_operator",
            allowedActions: ["resume", "cancel"],
            metadata: {
              actorId: "actor_cli"
            }
          }
        }
      } as never,
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "resume",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        turnId: "turn_resume_user_memory",
        frameRef: "frame:turn_resume_user_memory",
        input: "continue once the operator approves the budget"
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      turnId: "turn_resume_user_memory"
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      correlation: expect.objectContaining({
        actorId: "actor_cli"
      }),
      turnContext: expect.objectContaining({
        selfAwareness: expect.objectContaining({
          replyPath: "continuation"
        })
      }),
      contextBlocks: expect.arrayContaining([
        expect.objectContaining({
          title: "pending execution continuation"
        }),
        expect.objectContaining({
          title: "user durable memory",
          content: expect.stringContaining("User preference: keep continuation status reports concise.")
        })
      ])
    }));

    const resumedRequest = run.mock.calls[0]?.[0];
    const userDurableMemoryBlock = resumedRequest?.contextBlocks.find((block: { title?: string }) => block.title === "user durable memory");
    expect(userDurableMemoryBlock?.content).not.toContain("Other user preference: verbose resume reports only.");
  });

  it("searches evidence through the operator facade without exposing store internals", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const memoryStore = createMemoryStore({ filename: paths.memoryDbPath });
    await memoryStore.appendEvidence({
      evidenceId: "evidence_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      topic: "auth",
      content: "auth migration decision"
    });
    await memoryStore.appendEvidence({
      evidenceId: "evidence_002",
      workspaceId: "workspace_local",
      sessionId: "session_002",
      topic: "billing",
      content: "billing launch checklist"
    });

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    await expect(
      app.operator.searchEvidence({
        workspaceId: "workspace_local",
        queryText: "auth migration",
        maxItems: 5
      })
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          evidenceId: "evidence_001",
          sessionId: "session_001",
          topic: "auth",
          content: "auth migration decision"
        })
      ]
    });
  });

  it("returns real status information derived from the composed app", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const status = await app.operator.getStatus();

    expect(status).toMatchObject({
      productName: "endec",
      dataDir,
      defaultProviderId: "local-default",
      defaultModelId: "cheap-default",
      capabilities: {
        execute: true,
        history: true,
        artifactRead: true,
        evidenceRead: true
      },
      currentModel: {
        providerId: "local-default",
        modelId: "cheap-default",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: []
    });
    expect(status).not.toHaveProperty("defaultExecuteModels");
  });

  it("uses env-configured provider models for status and default execution", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "qwen2.5:latest" }]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url.endsWith("/chat/completions")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toEqual(
          expect.stringContaining('"model":"qwen2.5:latest"')
        );

        return new Response(
          JSON.stringify([
            {
              choices: [
                {
                  delta: {
                    content: "configured model reply"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 14,
                completion_tokens: 8,
                total_tokens: 22
              }
            }
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER_MODEL: "qwen2.5:latest"
      }
    });

    const status = await app.operator.getStatus();

    expect(status).toMatchObject({
      productName: "endec",
      dataDir,
      defaultProviderId: "local-default",
      defaultModelId: "qwen2.5:latest",
      currentModel: {
        providerId: "local-default",
        modelId: "qwen2.5:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: []
    });
    expect(status).not.toHaveProperty("defaultExecuteModels");

    await expect(app.shell.executeTurn(createTurnRequest({ turnId: "turn_env_default" }))).resolves.toMatchObject({
      status: "completed",
      messages: [
        {
          role: "assistant",
          content: "configured model reply"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:11434/v1/models", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("allows known providers to execute with explicitly configured external models", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "https://api.anthropic.com/models") {
        return new Response(JSON.stringify({ data: [{ id: "glm-5.1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "https://api.anthropic.com/v1/messages") {
        expect(init?.method).toBe("POST");
        expect(init?.body).toEqual(expect.stringContaining('"model":"glm-5.1"'));
        expect(init?.headers).toEqual(
          expect.objectContaining({
            "anthropic-version": "2023-06-01",
            "x-api-key": "anthropic-test-key"
          })
        );

        return new Response(
          JSON.stringify([
            {
              type: "content_block_delta",
              delta: {
                type: "text_delta",
                text: "glm51 external model reply"
              }
            },
            {
              type: "message_delta",
              delta: {
                stop_reason: "end_turn"
              },
              usage: {
                input_tokens: 15,
                output_tokens: 6
              }
            },
            {
              type: "message_stop"
            }
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "anthropic",
        ENDEC_PROVIDER_MODEL: "glm-5.1",
        ANTHROPIC_API_KEY: "anthropic-test-key"
      }
    });

    const status = await app.operator.getStatus();

    expect(status).toMatchObject({
      defaultProviderId: "anthropic",
      defaultModelId: "glm-5.1",
      currentModel: {
        providerId: "anthropic",
        modelId: "glm-5.1",
        baseUrl: "https://api.anthropic.com",
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: []
    });
    expect(status).not.toHaveProperty("defaultExecuteModels");

    await expect(app.shell.executeTurn(createTurnRequest({ turnId: "turn_external_model" }))).resolves.toMatchObject({
      status: "completed",
      messages: [
        {
          role: "assistant",
          content: "glm51 external model reply"
        }
      ]
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/models", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("resolves one current model for chat and act turns across multiple registered providers", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const providerRegistrations: ProviderRegistration[] = [
      {
        providerId: "openai-compatible",
        displayName: "OpenAI compatible",
        baseUrl: "http://openai.test/v1",
        auth: {
          type: "none"
        },
        models: [
          {
            modelId: "qwen-chat",
            displayName: "Qwen chat",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false,
              maxContextTokens: 128000,
              maxOutputTokens: 16384
            }
          }
        ]
      },
      {
        providerId: "anthropic-compatible",
        displayName: "Anthropic compatible",
        baseUrl: "http://anthropic.test/v1",
        auth: {
          type: "none"
        },
        models: [
          {
            modelId: "claude-act",
            displayName: "Claude act",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false,
              maxContextTokens: 200000,
              maxOutputTokens: 64000
            }
          }
        ]
      }
    ];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "http://openai.test/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "qwen-chat" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "http://anthropic.test/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "claude-act" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "http://openai.test/v1/chat/completions") {
        expect(init?.body).toEqual(expect.stringContaining('"model":"qwen-chat"'));
        return new Response(
          JSON.stringify([
            {
              choices: [
                {
                  delta: {
                    content: "cheap route reply"
                  }
                }
              ]
            },
            {
              choices: [{ finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15
              }
            }
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url === "http://anthropic.test/v1/chat/completions") {
        expect(init?.body).toEqual(expect.stringContaining('"model":"claude-act"'));
        return new Response(
          JSON.stringify([
            {
              choices: [
                {
                  delta: {
                    content: "strong route reply"
                  }
                }
              ]
            },
            {
              choices: [{ finish_reason: "stop" }],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 7,
                total_tokens: 19
              }
            }
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createEndecApp({
      dataDir,
      providerRegistrations,
      env: {
        ENDEC_PROVIDER_CHEAP: "openai-compatible",
        ENDEC_PROVIDER_CHEAP_MODEL: "qwen-chat",
        ENDEC_PROVIDER_STRONG: "anthropic-compatible",
        ENDEC_PROVIDER_STRONG_MODEL: "claude-act"
      }
    });

    const status = await app.operator.getStatus();

    expect(status).toMatchObject({
      currentModel: {
        providerId: "anthropic-compatible",
        modelId: "claude-act",
        baseUrl: "http://anthropic.test/v1",
        modelCapability: "chat",
        executeCapable: true
      },
      warningDetails: [],
      warnings: []
    });
    expect(status).not.toHaveProperty("defaultExecuteModels");

    await expect(app.shell.executeTurn(createTurnRequest({ turnId: "turn_multi_provider_chat" }))).resolves.toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "strong route reply" })]
    });
    await expect(
      app.shell.executeTurn(
        createTurnRequest({
          turnId: "turn_multi_provider_act",
          requestedMode: "act",
          input: "perform the act path"
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "strong route reply" })]
    });
  });

  it("passes model-aware balanced budget ceilings into runtime context assembly", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const providerRegistrations: ProviderRegistration[] = [
      {
        providerId: "test-large-context",
        displayName: "Test large context",
        baseUrl: "http://provider.test/v1",
        auth: { type: "none" },
        protocolFamily: "chat_completions",
        models: [
          {
            modelId: "large-200k",
            displayName: "Large 200k",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false,
              maxContextTokens: 200000,
              maxOutputTokens: 64000
            }
          }
        ]
      }
    ];

    const app = createEndecApp({
      dataDir,
      providerRegistrations,
      env: {
        ENDEC_PROVIDER_CHEAP: "test-large-context",
        ENDEC_PROVIDER_CHEAP_MODEL: "large-200k",
        ENDEC_PROVIDER_STRONG: "test-large-context",
        ENDEC_PROVIDER_STRONG_MODEL: "large-200k"
      },
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "requesting approval for bash"
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
                      id: "tool_call_budget_truth_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf budget-truth; git push --dry-run . HEAD:refs/heads/budget-truth" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    const result = await app.shell.executeTurn(createTurnRequest({ turnId: "turn_budget_truth", requestedMode: "act" }));
    const operatorInspection = await app.operator.inspectOperatorTurn({
      target: {
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        turnId: "turn_budget_truth"
      }
    });

    expect(result.status).toBe("blocked");
    expect(capturedRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain('"model":"large-200k"');
    expect(operatorInspection?.context.observability.contextBudget?.budgetResolution).toMatchObject({
      mode: "act",
      budgetProfile: "balanced",
      maxContextTokens: 200000,
      protocolFamily: "chat_completions",
      effectiveInputTokenBudget: 49550,
      effectiveMemoryInjectionBudget: 8000,
      outputReserveTokens: 1800,
      safetyReserveTokens: 0
    });
    expect(operatorInspection?.context.observability.contextBudget?.toolSchemaAccounting.status).toBe("estimated");
  });

  it("flags provider/model capability mismatch when an embedding-only model is configured for execute", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "shaw/dmeta-embedding-zh:latest" }]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER_MODEL: "shaw/dmeta-embedding-zh:latest"
      }
    });
    const status = await app.operator.getStatus();
    const result = await app.shell.executeTurn(createTurnRequest({ turnId: "turn_embedding_mismatch" }));

    expect(status.currentModel).toMatchObject({
      providerId: "local-default",
      modelId: "shaw/dmeta-embedding-zh:latest",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelCapability: "embedding",
      executeCapable: false
    });
    expect(status.warningDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "provider_model_capability_mismatch",
          providerId: "local-default",
          modelId: "shaw/dmeta-embedding-zh:latest"
        })
      ])
    );
    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("embedding-only")])
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.anything()
    );
  });

  it("reports reachable providers that only expose embedding models as execute-path warnings", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "shaw/dmeta-embedding-zh:latest" }]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createEndecApp({ dataDir });
    const status = await app.operator.getStatus();
    const result = await app.shell.executeTurn(createTurnRequest({ turnId: "turn_model_alignment" }));

    expect(status).toMatchObject({
      defaultProviderId: "local-default",
      defaultModelId: "cheap-default"
    });
    expect(status.warningDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "provider_embeddings_only",
          providerId: "local-default"
        }),
        expect.objectContaining({
          code: "default_model_unconfigured",
          providerId: "local-default",
          modelId: "cheap-default"
        })
      ])
    );
    expect(status.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("only embedding models"),
        expect.stringContaining("No current model is configured")
      ])
    );
    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("only embedding models"),
        expect.stringContaining("Configured current model")
      ])
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.anything()
    );
  });

  it("blocks the first act-mode bash call, exposes pending state, and resumes the same turn after approval", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
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
                      id: "tool_call_bash_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bash-phase1-approved; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
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
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "bash completed and the turn continued"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 10,
              total_tokens: 34
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    const blocked = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_blocked",
      requestedMode: "act",
      input: "run a controlled bash command"
    }));
    const snapshot = await app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      turnId: "turn_bash_blocked",
      blockedBy: "permission",
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_001",
          toolName: "bash",
          state: "ask",
          permissionDecision: expect.objectContaining({
            behavior: "ask",
            reasonCode: "bash_action_requires_approval"
          })
        })
      ]
    });
    expect(snapshot).toMatchObject({
      sessionId: "session_001",
      turnId: "turn_bash_blocked",
      blockedBy: "permission",
      state: "awaiting_permission",
      allowedActions: ["approve", "deny", "cancel"],
      pendingApprovalRef: "tool_call_bash_001",
      pendingDecision: expect.objectContaining({
        decisionId: "tool_call_bash_001",
        behavior: "ask",
        reasonCode: "bash_action_requires_approval",
        reasonText: "git push crosses from the local workspace into remote branch state."
      }),
      runtimeSelfAwareness: expect.objectContaining({
        mode: "act",
        exposedToolNames: ["read", "glob", "grep", "write", "edit", "bash"],
        replyPath: "blocked"
      })
    });

    const approved = await app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_blocked",
      decisionId: "tool_call_bash_001",
      approved: true,
      approverId: "operator_001"
    });

    expect(approved).toMatchObject({
      status: "completed",
      turnId: "turn_bash_blocked",
      messages: [
        {
          role: "assistant",
          content: "bash completed and the turn continued"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_001",
          toolName: "bash",
          state: "executed",
          normalizedPayload: {
            contentType: "json",
            value: {
              command: "printf bash-phase1-approved; git push --dry-run . HEAD:refs/heads/endec-test-dry-run",
              exitCode: 0,
              stdout: "bash-phase1-approved",
              stderr: expect.stringContaining("endec-test-dry-run")
            }
          }
        })
      ]
    });
    expect(await app.operator.getRecoverySnapshot({ sessionId: "session_001" })).toBeNull();
    expect(JSON.stringify(capturedRequests[1]?.body ?? {})).toContain("bash-phase1-approved");
  });

  it("re-asks for later bash calls in the same turn when approval scope stays once", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_once_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf once-first; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_once_002",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf once-second; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 14,
              total_tokens: 34
            }
          }
        ]
      ])
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_scope_once",
      requestedMode: "act",
      input: "request bash twice but only approve the first one once"
    }))).resolves.toMatchObject({
      status: "blocked",
      blockedBy: "permission",
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_once_001",
          toolName: "bash",
          state: "ask"
        })
      ]
    });

    const approved = await app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_scope_once",
      decisionId: "tool_call_bash_once_001",
      approved: true,
      scope: "once",
      approverId: "operator_001"
    });
    const snapshot = await app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    });

    expect(approved).toMatchObject({
      status: "blocked",
      turnId: "turn_bash_scope_once",
      blockedBy: "permission",
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_once_001",
          toolName: "bash",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_bash_once_002",
          toolName: "bash",
          state: "ask",
          permissionDecision: expect.objectContaining({
            behavior: "ask",
            reasonCode: "bash_action_requires_approval"
          })
        })
      ]
    });
    expect(snapshot).toMatchObject({
      turnId: "turn_bash_scope_once",
      pendingApprovalRef: "tool_call_bash_once_002",
      pendingDecision: expect.objectContaining({
        decisionId: "tool_call_bash_once_002",
        behavior: "ask",
        reasonCode: "bash_action_requires_approval"
      }),
      runtimeSelfAwareness: expect.objectContaining({
        replyPath: "blocked",
        constraints: [
          expect.objectContaining({
            code: "bash_action_requires_approval",
            metadata: expect.objectContaining({
              decisionId: "tool_call_bash_once_002"
            })
          })
        ]
      })
    });
  });

  it("keeps turn-scoped bash trust active for later bash calls in the same turn", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_turn_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf turn-first; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_turn_002",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf turn-second" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 14,
              total_tokens: 34
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "turn-scoped bash trust completed both commands"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 28,
              completion_tokens: 10,
              total_tokens: 38
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_scope_turn",
      requestedMode: "act",
      input: "approve bash for the rest of this turn"
    }))).resolves.toMatchObject({
      status: "blocked",
      blockedBy: "permission",
      toolEvents: [expect.objectContaining({ toolCallId: "tool_call_bash_turn_001", state: "ask" })]
    });

    const approved = await app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_scope_turn",
      decisionId: "tool_call_bash_turn_001",
      approved: true,
      scope: "turn",
      approverId: "operator_001"
    });

    expect(approved).toMatchObject({
      status: "completed",
      turnId: "turn_bash_scope_turn",
      messages: [
        {
          role: "assistant",
          content: "turn-scoped bash trust completed both commands"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_turn_001",
          toolName: "bash",
          state: "executed",
          permissionDecision: expect.objectContaining({
            behavior: "allow",
            scope: "turn",
            reasonCode: "tool_trusted_for_turn"
          })
        }),
        expect.objectContaining({
          toolCallId: "tool_call_bash_turn_002",
          toolName: "bash",
          state: "executed",
          permissionDecision: expect.objectContaining({
            behavior: "allow",
            scope: "turn",
            reasonCode: "tool_trusted_for_turn"
          })
        })
      ]
    });
    expect(JSON.stringify(capturedRequests[1]?.body ?? {})).toContain("bash_trust_active");
    expect(await app.operator.getRecoverySnapshot({ sessionId: "session_001" })).toBeNull();
  });

  it("expires turn-scoped bash trust once the turn finishes", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_turn_expire_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf expire-first; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "first turn completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 10,
              total_tokens: 34
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_turn_expire_002",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf expire-second; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });

    await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_expire_first",
      requestedMode: "act",
      input: "grant turn trust once"
    }));
    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_expire_first",
      decisionId: "tool_call_bash_turn_expire_001",
      approved: true,
      scope: "turn",
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "turn_bash_expire_first"
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_expire_second",
      requestedMode: "act",
      input: "new turn should ask again"
    }))).resolves.toMatchObject({
      status: "blocked",
      turnId: "turn_bash_expire_second",
      blockedBy: "permission",
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_turn_expire_002",
          toolName: "bash",
          state: "ask",
          permissionDecision: expect.objectContaining({
            behavior: "ask",
            reasonCode: "bash_action_requires_approval"
          })
        })
      ]
    });
  });

  it("rejects unsupported approval scopes instead of silently drifting", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_scope_reject_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf reject-scope; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_scope_reject",
      requestedMode: "act",
      input: "request bash and try unsupported scopes"
    }))).resolves.toMatchObject({
      status: "blocked",
      blockedBy: "permission"
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_scope_reject",
      decisionId: "tool_call_bash_scope_reject_001",
      approved: true,
      scope: "session"
    } as unknown as Parameters<typeof app.shell.resolveApproval>[0])).rejects.toThrow(
      'Unsupported approval scope "session". Supported scopes: once, turn.'
    );
    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_scope_reject",
      decisionId: "tool_call_bash_scope_reject_001",
      approved: true,
      scope: "workspace"
    } as unknown as Parameters<typeof app.shell.resolveApproval>[0])).rejects.toThrow(
      'Unsupported approval scope "workspace". Supported scopes: once, turn.'
    );
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toMatchObject({
      pendingApprovalRef: "tool_call_bash_scope_reject_001",
      pendingDecision: expect.objectContaining({
        decisionId: "tool_call_bash_scope_reject_001",
        behavior: "ask"
      })
    });
  });

  it("does not replay executed edit calls when approving a mixed edit + bash batch", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const workspaceDir = await mkdtemp(join(process.cwd(), ".tmp-endec-app-"));
    tempDirs.add(workspaceDir);
    const fixturePath = join(workspaceDir, "mixed-batch.txt");
    const relativeFixturePath = relative(process.cwd(), fixturePath);
    const capturedRequests: ProviderTransportRequest[] = [];
    await writeFile(fixturePath, "seed\n", "utf8");

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_edit_001",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          path: relativeFixturePath,
                          edits: [
                            {
                              oldText: "seed",
                              newText: "seed +edit"
                            }
                          ]
                        })
                      }
                    },
                    {
                      index: 1,
                      id: "tool_call_bash_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command: `cat ${relativeFixturePath}; git push --dry-run . HEAD:refs/heads/endec-test-dry-run`
                        })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 32,
              completion_tokens: 20,
              total_tokens: 52
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "mixed batch continued after approval"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 28,
              completion_tokens: 12,
              total_tokens: 40
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    const blocked = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_mixed_edit_bash",
      requestedMode: "act",
      input: "edit once, then request bash approval"
    }));
    const snapshot = await app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    });
    const runtimeSelfAwareness = await app.operator.getRuntimeSelfAwareness({
      sessionId: "session_001"
    });

    expect(await readFile(fixturePath, "utf8")).toBe("seed +edit\n");
    expect(blocked).toMatchObject({
      status: "blocked",
      turnId: "turn_mixed_edit_bash",
      blockedBy: "permission",
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_edit_001",
          toolName: "edit",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_bash_001",
          toolName: "bash",
          state: "ask"
        })
      ]
    });
    expect(snapshot).toMatchObject({
      turnId: "turn_mixed_edit_bash",
      pendingApprovalRef: "tool_call_bash_001",
      pendingDecision: expect.objectContaining({
        decisionId: "tool_call_bash_001",
        behavior: "ask",
        reasonCode: "bash_action_requires_approval"
      }),
      runtimeSelfAwareness: expect.objectContaining({
        replyPath: "blocked",
        constraints: [
          expect.objectContaining({
            code: "bash_action_requires_approval",
            metadata: expect.objectContaining({
              decisionId: "tool_call_bash_001"
            })
          })
        ]
      })
    });
    expect(runtimeSelfAwareness).toMatchObject({
      replyPath: "blocked",
      constraints: [
        expect.objectContaining({
          code: "bash_action_requires_approval",
          metadata: expect.objectContaining({
            decisionId: "tool_call_bash_001"
          })
        })
      ]
    });

    const approved = await app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_mixed_edit_bash",
      decisionId: "tool_call_bash_001",
      approved: true,
      approverId: "operator_001"
    });

    expect(approved).toMatchObject({
      status: "completed",
      turnId: "turn_mixed_edit_bash",
      messages: [
        {
          role: "assistant",
          content: "mixed batch continued after approval"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_001",
          toolName: "bash",
          state: "executed"
        })
      ]
    });
    expect(approved.toolEvents).toHaveLength(1);
    expect(await readFile(fixturePath, "utf8")).toBe("seed +edit\n");
    expect(JSON.stringify(capturedRequests[1]?.body ?? {})).toContain("seed +edit");
    expect(JSON.stringify(capturedRequests[1]?.body ?? {})).not.toContain("seed +edit +edit");
  });

  it("stops at the bash ask boundary and resumes the unexecuted suffix without double-applying later edits", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const workspaceDir = await mkdtemp(join(process.cwd(), ".tmp-endec-app-"));
    tempDirs.add(workspaceDir);
    const fixturePath = join(workspaceDir, "mixed-ask-boundary.txt");
    const relativeFixturePath = relative(process.cwd(), fixturePath);
    await writeFile(fixturePath, "seed\n", "utf8");

    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_edit_before_001",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          path: relativeFixturePath,
                          edits: [
                            {
                              oldText: "seed",
                              newText: "seed +1"
                            }
                          ]
                        })
                      }
                    },
                    {
                      index: 1,
                      id: "tool_call_bash_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command: `cat ${relativeFixturePath}; git push --dry-run . HEAD:refs/heads/endec-test-dry-run`
                        })
                      }
                    },
                    {
                      index: 2,
                      id: "tool_call_edit_after_001",
                      type: "function",
                      function: {
                        name: "edit",
                        arguments: JSON.stringify({
                          path: relativeFixturePath,
                          edits: [
                            {
                              oldText: "\n",
                              newText: " +2\n"
                            }
                          ]
                        })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 36,
              completion_tokens: 24,
              total_tokens: 60
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "three-call batch continued after approval"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 14,
              total_tokens: 44
            }
          }
        ]
      ])
    });

    const blocked = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_three_call_ask_boundary",
      requestedMode: "act",
      input: "edit, ask for bash approval, then keep editing"
    }));
    const snapshot = await app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    });
    const runtimeSelfAwareness = await app.operator.getRuntimeSelfAwareness({
      sessionId: "session_001"
    });

    expect(await readFile(fixturePath, "utf8")).toBe("seed +1\n");
    expect(blocked).toMatchObject({
      status: "blocked",
      turnId: "turn_three_call_ask_boundary",
      blockedBy: "permission",
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_edit_before_001",
          toolName: "edit",
          state: "executed"
        }),
        expect.objectContaining({
          toolCallId: "tool_call_bash_001",
          toolName: "bash",
          state: "ask"
        })
      ]
    });
    expect(blocked.toolEvents).toHaveLength(2);
    expect(snapshot).toMatchObject({
      turnId: "turn_three_call_ask_boundary",
      pendingApprovalRef: "tool_call_bash_001",
      pendingDecision: expect.objectContaining({
        decisionId: "tool_call_bash_001",
        behavior: "ask",
        reasonCode: "bash_action_requires_approval"
      }),
      runtimeSelfAwareness: expect.objectContaining({
        replyPath: "blocked",
        constraints: [
          expect.objectContaining({
            code: "bash_action_requires_approval",
            metadata: expect.objectContaining({
              decisionId: "tool_call_bash_001"
            })
          })
        ]
      })
    });
    expect(runtimeSelfAwareness).toMatchObject({
      replyPath: "blocked",
      constraints: [
        expect.objectContaining({
          code: "bash_action_requires_approval",
          metadata: expect.objectContaining({
            decisionId: "tool_call_bash_001"
          })
        })
      ]
    });

    const approved = await app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_three_call_ask_boundary",
      decisionId: "tool_call_bash_001",
      approved: true,
      approverId: "operator_001"
    });

    expect(approved).toMatchObject({
      status: "completed",
      turnId: "turn_three_call_ask_boundary",
      messages: [
        {
          role: "assistant",
          content: "three-call batch continued after approval"
        }
      ],
      toolEvents: [
        expect.objectContaining({
          toolCallId: "tool_call_bash_001",
          toolName: "bash",
          state: "executed",
          normalizedPayload: {
            contentType: "json",
            value: expect.objectContaining({
              stdout: expect.stringContaining("seed +1\n")
            })
          }
        }),
        expect.objectContaining({
          toolCallId: "tool_call_edit_after_001",
          toolName: "edit",
          state: "executed"
        })
      ]
    });
    expect(approved.toolEvents).toHaveLength(2);
    expect(await readFile(fixturePath, "utf8")).toBe("seed +1 +2\n");
    expect(await app.operator.getRecoverySnapshot({ sessionId: "session_001" })).toBeNull();
  });

  it("closes the recoverable bash turn on deny without reopening recovery", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_deny_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf deny-me; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_deny",
      requestedMode: "act",
      input: "request bash and then deny it"
    }))).resolves.toMatchObject({
      status: "blocked",
      blockedBy: "permission"
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_deny",
      decisionId: "tool_call_bash_deny_001",
      approved: false
    })).resolves.toMatchObject({
      status: "interrupted",
      warnings: ["approval rejected for tool_call_bash_deny_001"]
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toBeNull();
    await expect(app.shell.resumeTurn({
      sessionId: "session_001",
      turnId: "turn_bash_deny",
      workspaceId: "workspace_local",
      input: "resume after deny"
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
  });

  it("closes the recoverable bash turn on cancel without misleading recovery state", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bash_cancel_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf cancel-me; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_bash_cancel",
      requestedMode: "act",
      input: "request bash and then cancel it"
    }))).resolves.toMatchObject({
      status: "blocked",
      blockedBy: "permission"
    });

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_001",
      turnId: "turn_bash_cancel",
      workspaceId: "workspace_local",
      reason: "operator cancelled bash"
    })).resolves.toMatchObject({
      status: "interrupted",
      warnings: ["operator cancelled bash"]
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toBeNull();
    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "turn_bash_cancel",
      decisionId: "tool_call_bash_cancel_001",
      approved: true
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
  });

  it("does not open recoverable turns when hidden tools are denied", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "need a hidden tool"
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
                      id: "tool_call_hidden_001",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({ path: "note.txt" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 16,
              total_tokens: 46
            }
          }
        ]
      ])
    });

    const result = await app.shell.executeTurn(
      createTurnRequest({ turnId: "turn_hidden_no_recovery", input: "please try a hidden tool" })
    );

    expect(result).toMatchObject({
      status: "completed",
      toolEvents: [
        expect.objectContaining({
          toolName: "write_file",
          state: "deny",
          permissionDecision: expect.objectContaining({ behavior: "deny" })
        })
      ]
    });
    await expect(app.shell.resumeTurn({
      turnId: "turn_hidden_no_recovery",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      input: "resume after deny"
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
    await expect(app.shell.cancelInflightTurn({
      turnId: "turn_hidden_no_recovery",
      sessionId: "session_001",
      workspaceId: "workspace_local",
      reason: "cancel after deny"
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
    await expect(app.operator.getRecoverySnapshot({
      sessionId: "session_001"
    })).resolves.toBeNull();
    await expect(app.operator.getRuntimeSelfAwareness({
      sessionId: "session_001"
    })).resolves.toBeNull();
    await expect(app.shell.resolveApproval({
      turnId: "turn_hidden_no_recovery",
      sessionId: "session_001",
      decisionId: "tool_call_hidden_001",
      approved: false
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
  });

  it("keeps omitted-turn execution controls unrecoverable after hidden tool denial", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "another hidden tool"
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
                      id: "tool_call_hidden_omit_001",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({ path: "note-optional.txt" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 15,
              total_tokens: 45
            }
          }
        ]
      ])
    });

    const result = await app.shell.executeTurn(
      createTurnRequest({ turnId: "turn_hidden_omit", input: "please deny a hidden tool" })
    );

    expect(result).toMatchObject({
      status: "completed",
      toolEvents: [expect.objectContaining({ state: "deny" })]
    });
    await expect(app.shell.resumeTurn({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      input: "resume without passing --turn"
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      decisionId: "tool_call_hidden_omit_001",
      approved: true
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_001",
      workspaceId: "workspace_local",
      reason: "operator cancelled without explicit turn"
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
  });

  it("does not bind approval decisions when no approval gate exists", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      decisionId: "tool_call_wrong_999",
      approved: true
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
  });

  it("cancel suspended background run closes recovery and rejects later approval/resume", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_cancel_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-cancel; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_cancel_recovery_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      title: "Investigate background cancel recovery",
      description: "request bash approval in background",
      sourceTurnId: "turn_bg_cancel_origin_001",
      now: "2026-04-27T00:00:00.000Z"
    });

    await runStore.enqueueRun({
      runId: "run_bg_cancel_recovery_001",
      taskId: "task_bg_cancel_recovery_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-cancel-recovery",
      turnRequest: {
        turnId: "turn_bg_cancel_origin_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "run a controlled bash command in background",
        requestedMode: "act",
        originTurnId: "turn_bg_cancel_origin_001"
      },
      sourceTurnId: "turn_bg_cancel_origin_001",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.000Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      runId: "run_bg_cancel_recovery_001",
      taskId: "task_bg_cancel_recovery_001",
      outcome: "suspended",
      callbackKind: "blocked",
      turnResultStatus: "blocked"
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toMatchObject({
      turnId: "run_bg_cancel_recovery_001",
      pendingApprovalRef: "tool_call_bg_cancel_001"
    });

    await expect(app.operator.cancelBackgroundTask({
      taskId: "task_bg_cancel_recovery_001",
      runId: "run_bg_cancel_recovery_001",
      actorId: "operator_001",
      reason: "operator canceled suspended background run"
    })).resolves.toMatchObject({
      status: "canceled",
      taskStatus: "canceled",
      runStatus: "canceled"
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toBeNull();
    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "run_bg_cancel_recovery_001",
      decisionId: "tool_call_bg_cancel_001",
      approved: true,
      approverId: "operator_001"
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
    await expect(app.shell.resumeTurn({
      sessionId: "session_001",
      turnId: "run_bg_cancel_recovery_001",
      workspaceId: "workspace_local",
      input: "resume canceled background run"
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
  });

  it("hides detached running cancel recovery as soon as task-side closed truth is latched", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_running_cancel_truth",
      workspaceId: "workspace_local",
      source: "cli",
      turnId: "turn_running_cancel_truth",
      actorId: "actor_cli",
      input: "resume detached running task",
      attachments: []
    });
    await runStore.createBackgroundTask({
      taskId: "task_running_cancel_truth",
      workspaceId: "workspace_local",
      sessionId: "session_running_cancel_truth",
      actorId: "actor_cli",
      title: "Running cancel truth task",
      description: "running cancel should hide stale recovery immediately",
      sourceTurnId: "turn_running_cancel_truth",
      now: "2026-04-30T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_running_cancel_truth",
      taskId: "task_running_cancel_truth",
      workspaceId: "workspace_local",
      sessionId: "session_running_cancel_truth",
      actorId: "actor_cli",
      idempotencyKey: "seed:running-cancel-truth",
      turnRequest: {
        turnId: "turn_running_cancel_truth",
        sessionId: "session_running_cancel_truth",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "resume detached running task",
        requestedMode: "act",
        originTurnId: "turn_running_cancel_truth"
      },
      sourceTurnId: "turn_running_cancel_truth",
      maxAttempts: 1,
      now: "2026-04-30T00:00:00.010Z"
    });
    await sliceStore.enqueueNextSlice({
      sliceId: "slice_running_cancel_truth_001",
      runId: "run_running_cancel_truth",
      taskId: "task_running_cancel_truth",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-30T00:00:00.020Z"
    });

    const db = new Database(paths.tasksDbPath);
    db.prepare(`
      UPDATE task_runs
      SET status = 'running',
          claimed_at = ?,
          started_at = ?,
          run_started_at = ?,
          worker_id = 'worker_running_cancel_truth',
          lease_owner = 'worker_running_cancel_truth',
          lease_expires_at = ?,
          continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-30T00:00:00.100Z",
      "2026-04-30T00:00:00.100Z",
      "2026-04-30T00:00:00.100Z",
      "2026-04-30T00:01:00.100Z",
      JSON.stringify({ checkpointRef: "checkpoint:running_cancel_truth" }),
      "2026-04-30T00:00:00.100Z",
      "2026-04-30T00:00:00.100Z",
      "run_running_cancel_truth"
    );
    db.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_running_cancel_truth',
          lease_owner = 'worker_running_cancel_truth',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-04-30T00:01:00.100Z",
      "2026-04-30T00:00:00.100Z",
      "2026-04-30T00:00:00.100Z",
      JSON.stringify({ checkpointRef: "checkpoint:running_cancel_truth" }),
      "2026-04-30T00:00:00.100Z",
      "slice_running_cancel_truth_001"
    );
    db.close();

    await sessionStore.markInflight({
      turnId: "run_running_cancel_truth",
      sessionId: "session_running_cancel_truth",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      checkpointRef: "checkpoint:running_cancel_truth",
      frameRef: "frame:running_cancel_truth",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:running_cancel_truth",
        frameRef: "frame:running_cancel_truth",
        checkpointRef: "checkpoint:running_cancel_truth",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:running_cancel_truth",
          checkpointRef: "checkpoint:running_cancel_truth",
          turnId: "run_running_cancel_truth",
          sessionId: "session_running_cancel_truth",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "recovery_retry",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {}
          }
        }
      }
    });

    await expect(app.operator.cancelBackgroundTask({
      taskId: "task_running_cancel_truth",
      runId: "run_running_cancel_truth",
      actorId: "operator_cancel_truth",
      reason: "cancel during running detached resume"
    })).resolves.toMatchObject({
      status: "cancel_requested",
      runStatus: "running"
    });

    await expect(sessionStore.loadRecoveryContext("session_running_cancel_truth")).resolves.toMatchObject({
      inflight: expect.objectContaining({
        turnId: "run_running_cancel_truth"
      })
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_running_cancel_truth" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_running_cancel_truth")).resolves.toMatchObject({
      status: "running",
      cancelRequestedAt: expect.any(String),
      recoveryTruthState: "closed"
    });
  });

  it("keeps canceled queued background slices non-runnable and preserves priority ordering across runnable runs", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_low_priority",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      title: "Low priority task",
      description: "should not claim first",
      sourceTurnId: "turn_bg_low_priority",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_low_priority",
      taskId: "task_bg_low_priority",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-low-priority",
      priority: 0,
      turnRequest: {
        turnId: "turn_bg_low_priority",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "low priority background run",
        requestedMode: "chat",
        originTurnId: "turn_bg_low_priority"
      },
      sourceTurnId: "turn_bg_low_priority",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_bg_canceled_priority",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      title: "Canceled high priority task",
      description: "must not resurrect from queued slice",
      sourceTurnId: "turn_bg_canceled_priority",
      now: "2026-04-27T00:00:00.020Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_canceled_priority",
      taskId: "task_bg_canceled_priority",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-canceled-priority",
      priority: 100,
      turnRequest: {
        turnId: "turn_bg_canceled_priority",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "canceled high priority background run",
        requestedMode: "chat",
        originTurnId: "turn_bg_canceled_priority"
      },
      sourceTurnId: "turn_bg_canceled_priority",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.030Z"
    });

    await runStore.createBackgroundTask({
      taskId: "task_bg_high_priority",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      title: "High priority task",
      description: "should claim first",
      sourceTurnId: "turn_bg_high_priority",
      now: "2026-04-27T00:00:00.040Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_high_priority",
      taskId: "task_bg_high_priority",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-high-priority",
      priority: 10,
      turnRequest: {
        turnId: "turn_bg_high_priority",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "high priority background run",
        requestedMode: "chat",
        originTurnId: "turn_bg_high_priority"
      },
      sourceTurnId: "turn_bg_high_priority",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.050Z"
    });

    await expect(app.operator.cancelBackgroundTask({
      taskId: "task_bg_canceled_priority",
      runId: "run_bg_canceled_priority",
      actorId: "operator_001",
      reason: "cancel before any worker claim"
    })).resolves.toMatchObject({
      status: "canceled",
      runStatus: "canceled"
    });

    app.shell.executeTurn = vi.fn(async (request): Promise<TurnResult> => ({
      turnId: request.turnId,
      sessionId: request.sessionId,
      resolvedMode: request.requestedMode ?? "chat",
      status: "completed",
      messages: [{ role: "assistant", content: `completed ${request.turnId}` }],
      toolEvents: [],
      taskUpdates: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCost: 0
      },
      warnings: [],
      checkpointRef: `checkpoint:${request.turnId}`,
      nextSessionStateRef: `session_state_ref:${request.turnId}`
    }));

    const first = await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    });
    const second = await app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:02.000Z"
    });

    expect(first).toMatchObject({
      status: "claimed",
      runId: "run_bg_high_priority",
      taskId: "task_bg_high_priority",
      outcome: "succeeded"
    });
    expect(second).toMatchObject({
      status: "claimed",
      runId: "run_bg_low_priority",
      taskId: "task_bg_low_priority",
      outcome: "succeeded"
    });
    expect(app.shell.executeTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      turnId: "run_bg_high_priority"
    }));
    expect(app.shell.executeTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      turnId: "run_bg_low_priority"
    }));
    await expect(runStore.loadRunById("run_bg_canceled_priority")).resolves.toMatchObject({
      status: "canceled"
    });
  });

  it("still-suspended background run remains recoverable until canceled", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_recoverable_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-recoverable; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "background approval completed successfully"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 10,
              total_tokens: 34
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_recoverable_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      title: "Investigate background recoverability",
      description: "request bash approval in background",
      sourceTurnId: "turn_bg_recoverable_origin_001",
      now: "2026-04-27T00:00:00.000Z"
    });

    await runStore.enqueueRun({
      runId: "run_bg_recoverable_001",
      taskId: "task_bg_recoverable_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-recoverable",
      turnRequest: {
        turnId: "turn_bg_recoverable_origin_001",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "run a controlled bash command in background",
        requestedMode: "act",
        originTurnId: "turn_bg_recoverable_origin_001"
      },
      sourceTurnId: "turn_bg_recoverable_origin_001",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.000Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toMatchObject({
      turnId: "run_bg_recoverable_001",
      pendingApprovalRef: "tool_call_bg_recoverable_001"
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "run_bg_recoverable_001",
      decisionId: "tool_call_bg_recoverable_001",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_recoverable_001",
      messages: [
        expect.objectContaining({
          content: "background approval completed successfully"
        })
      ]
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_001" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_bg_recoverable_001")).resolves.toMatchObject({
      status: "completed",
      pendingApprovalRef: undefined,
      pendingControlRef: undefined,
      continuationKind: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_recoverable_001")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "blocked",
        triggerKind: "legacy_cutover"
      },
      {
        sliceNo: 2,
        status: "completed",
        triggerKind: "approval_resume"
      }
    ]);
  });

  it("falls back to durable Task 2 approval recovery after inflight loss and reuses persisted source/mode", async () => {
    const capturedRequests: ProviderTransportRequest[] = [];
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_approval_fallback_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-approval-fallback; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "background approval durable fallback completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 10,
              total_tokens: 34
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_approval_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_approval_fallback",
      actorId: "actor_cli",
      title: "Approval durable fallback",
      description: "recover approval after inflight loss",
      sourceTurnId: "turn_bg_approval_fallback_origin",
      now: "2026-04-27T00:00:00.000Z"
    });

    await runStore.enqueueRun({
      runId: "run_bg_approval_fallback",
      taskId: "task_bg_approval_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_approval_fallback",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-approval-fallback",
      turnRequest: {
        turnId: "turn_bg_approval_fallback_origin",
        sessionId: "session_bg_approval_fallback",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "run a controlled bash command in background",
        requestedMode: "act",
        originTurnId: "turn_bg_approval_fallback_origin"
      },
      sourceTurnId: "turn_bg_approval_fallback_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.000Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_approval_fallback",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    await expect(runStore.loadRunById("run_bg_approval_fallback")).resolves.toMatchObject({
      status: "blocked",
      continuationKind: "approval_resume",
      continuationPayload: expect.objectContaining({
        recovery: expect.objectContaining({
          contractVersion: "im.task2.slice-recovery.v1",
          source: "cli",
          mode: "act",
          pendingApprovalRef: "tool_call_bg_approval_fallback_001",
          pendingExecution: expect.objectContaining({
            frame: expect.objectContaining({
              turnId: "run_bg_approval_fallback",
              sessionId: "session_bg_approval_fallback"
            })
          })
        })
      })
    });
    await expect(sliceStore.listSlicesByRun("run_bg_approval_fallback")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "blocked",
        continuationPayload: expect.objectContaining({
          recovery: expect.objectContaining({
            source: "cli",
            mode: "act",
            pendingApprovalRef: "tool_call_bg_approval_fallback_001"
          })
        })
      }
    ]);

    await sessionStore.finalize({
      turnId: "run_bg_approval_fallback",
      sessionId: "session_bg_approval_fallback",
      status: "interrupted"
    });
    const sessionDb = new Database(paths.sessionsDbPath);
    sessionDb.prepare(`
      UPDATE sessions
      SET last_source = 'telegram',
          mode = 'review'
      WHERE session_id = ?
    `).run("session_bg_approval_fallback");
    sessionDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_approval_fallback" })).resolves.toBeNull();

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_approval_fallback",
      turnId: "run_bg_approval_fallback",
      decisionId: "tool_call_bg_approval_fallback_001",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_approval_fallback",
      resolvedMode: "act",
      messages: [
        expect.objectContaining({
          content: "background approval durable fallback completed"
        })
      ]
    });

    await expect(sessionStore.loadById("session_bg_approval_fallback")).resolves.toMatchObject({
      lastSource: "cli",
      mode: "act"
    });
    expect(JSON.stringify(capturedRequests[1]?.body ?? {})).toContain("reply path: continuation");

    await expect(runStore.loadRunById("run_bg_approval_fallback")).resolves.toMatchObject({
      status: "completed",
      pendingApprovalRef: undefined,
      pendingControlRef: undefined,
      continuationKind: undefined
    });
  });

  it("falls back to durable Task 2 deny recovery and closes the blocked run lifecycle after inflight loss", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_deny_fallback_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-deny-fallback; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_deny_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_deny_fallback",
      actorId: "actor_cli",
      title: "Deny durable fallback",
      description: "recover deny after inflight loss",
      sourceTurnId: "turn_bg_deny_fallback_origin",
      now: "2026-04-27T00:00:00.000Z"
    });

    await runStore.enqueueRun({
      runId: "run_bg_deny_fallback",
      taskId: "task_bg_deny_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_deny_fallback",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-deny-fallback",
      turnRequest: {
        turnId: "turn_bg_deny_fallback_origin",
        sessionId: "session_bg_deny_fallback",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "request background approval and then deny it",
        requestedMode: "act",
        originTurnId: "turn_bg_deny_fallback_origin"
      },
      sourceTurnId: "turn_bg_deny_fallback_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_deny_fallback",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    await sessionStore.finalize({
      turnId: "run_bg_deny_fallback",
      sessionId: "session_bg_deny_fallback",
      status: "interrupted"
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_deny_fallback" })).resolves.toBeNull();

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_deny_fallback",
      turnId: "run_bg_deny_fallback",
      decisionId: "tool_call_bg_deny_fallback_001",
      approved: false,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "interrupted",
      warnings: ["approval rejected for tool_call_bg_deny_fallback_001"]
    });

    await expect(runStore.loadRunById("run_bg_deny_fallback")).resolves.toMatchObject({
      status: "failed",
      pendingApprovalRef: undefined,
      pendingControlRef: undefined,
      continuationKind: undefined
    });
    const denySlices = await sliceStore.listSlicesByRun("run_bg_deny_fallback");
    expect(denySlices.some((slice) => slice.status === "queued" || slice.status === "running")).toBe(false);
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_deny_fallback" })).resolves.toBeNull();
  });

  it("falls back to durable Task 2 cancel recovery and closes the blocked run lifecycle after inflight loss", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_cancel_fallback_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-cancel-fallback; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_cancel_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_cancel_fallback",
      actorId: "actor_cli",
      title: "Cancel durable fallback",
      description: "recover cancel after inflight loss",
      sourceTurnId: "turn_bg_cancel_fallback_origin",
      now: "2026-04-27T00:00:00.000Z"
    });

    await runStore.enqueueRun({
      runId: "run_bg_cancel_fallback",
      taskId: "task_bg_cancel_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_cancel_fallback",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-cancel-fallback",
      turnRequest: {
        turnId: "turn_bg_cancel_fallback_origin",
        sessionId: "session_bg_cancel_fallback",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "request background approval and then cancel it",
        requestedMode: "act",
        originTurnId: "turn_bg_cancel_fallback_origin"
      },
      sourceTurnId: "turn_bg_cancel_fallback_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_cancel_fallback",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    await sessionStore.finalize({
      turnId: "run_bg_cancel_fallback",
      sessionId: "session_bg_cancel_fallback",
      status: "interrupted"
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_cancel_fallback" })).resolves.toBeNull();

    await expect(app.shell.cancelInflightTurn({
      sessionId: "session_bg_cancel_fallback",
      workspaceId: "workspace_local",
      turnId: "run_bg_cancel_fallback",
      reason: "operator canceled durable fallback"
    })).resolves.toMatchObject({
      status: "interrupted",
      warnings: ["operator canceled durable fallback"]
    });

    await expect(runStore.loadRunById("run_bg_cancel_fallback")).resolves.toMatchObject({
      status: "canceled",
      cancelReason: "operator canceled durable fallback",
      pendingApprovalRef: undefined,
      pendingControlRef: undefined,
      continuationKind: undefined
    });
    const cancelSlices = await sliceStore.listSlicesByRun("run_bg_cancel_fallback");
    expect(cancelSlices.some((slice) => slice.status === "queued" || slice.status === "running")).toBe(false);
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_cancel_fallback" })).resolves.toBeNull();
  });

  it("re-persists durable Task 2 blocked truth when explicit approval re-blocks and supports a second inflight-loss fallback", async () => {
    const capturedRequests: ProviderTransportRequest[] = [];
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_reapproval_fallback_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-reapproval-first; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_reapproval_fallback_002",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-reapproval-second; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 14,
              total_tokens: 34
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "background approval second fallback completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 10,
              total_tokens: 34
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_reapproval_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_reapproval_fallback",
      actorId: "actor_cli",
      title: "Approval re-block fallback",
      description: "recover approval twice after inflight loss",
      sourceTurnId: "turn_bg_reapproval_fallback_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_reapproval_fallback",
      taskId: "task_bg_reapproval_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_reapproval_fallback",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-reapproval-fallback",
      turnRequest: {
        turnId: "turn_bg_reapproval_fallback_origin",
        sessionId: "session_bg_reapproval_fallback",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "run a controlled bash command twice in background",
        requestedMode: "act",
        originTurnId: "turn_bg_reapproval_fallback_origin"
      },
      sourceTurnId: "turn_bg_reapproval_fallback_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.000Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_reapproval_fallback",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    await sessionStore.finalize({
      turnId: "run_bg_reapproval_fallback",
      sessionId: "session_bg_reapproval_fallback",
      status: "interrupted"
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_reapproval_fallback",
      turnId: "run_bg_reapproval_fallback",
      decisionId: "tool_call_bg_reapproval_fallback_001",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "blocked",
      turnId: "run_bg_reapproval_fallback",
      blockedBy: "permission"
    });

    await expect(runStore.loadRunById("run_bg_reapproval_fallback")).resolves.toMatchObject({
      status: "blocked",
      continuationKind: "approval_resume",
      continuationPayload: expect.objectContaining({
        recovery: expect.objectContaining({
          source: "cli",
          mode: "act",
          pendingApprovalRef: "tool_call_bg_reapproval_fallback_002"
        })
      })
    });

    await sessionStore.finalize({
      turnId: "run_bg_reapproval_fallback",
      sessionId: "session_bg_reapproval_fallback",
      status: "interrupted"
    });
    const sessionDb = new Database(paths.sessionsDbPath);
    sessionDb.prepare(`
      UPDATE sessions
      SET last_source = 'telegram',
          mode = 'review'
      WHERE session_id = ?
    `).run("session_bg_reapproval_fallback");
    sessionDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_reapproval_fallback" })).resolves.toBeNull();

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_reapproval_fallback",
      turnId: "run_bg_reapproval_fallback",
      decisionId: "tool_call_bg_reapproval_fallback_002",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_reapproval_fallback",
      resolvedMode: "act",
      messages: [
        expect.objectContaining({
          content: "background approval second fallback completed"
        })
      ]
    });

    await expect(sessionStore.loadById("session_bg_reapproval_fallback")).resolves.toMatchObject({
      lastSource: "cli",
      mode: "act"
    });
    expect(JSON.stringify(capturedRequests[2]?.body ?? {})).toContain("reply path: continuation");
  });

  it("rejects mismatched approval ids on Task 2 background approval-resume routing", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_wrong_decision_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-wrong-decision; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_wrong_decision",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      title: "Wrong decision guard",
      description: "request bash approval in background",
      sourceTurnId: "turn_bg_wrong_decision",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_wrong_decision",
      taskId: "task_bg_wrong_decision",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-wrong-decision",
      turnRequest: {
        turnId: "turn_bg_wrong_decision",
        sessionId: "session_001",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "run a controlled bash command in background",
        requestedMode: "act",
        originTurnId: "turn_bg_wrong_decision"
      },
      sourceTurnId: "turn_bg_wrong_decision",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      turnId: "run_bg_wrong_decision",
      decisionId: "tool_call_bg_wrong_decision_999",
      approved: true,
      approverId: "operator_001"
    })).rejects.toThrow(
      "Session session_001 is waiting on approval decision tool_call_bg_wrong_decision_001, not tool_call_bg_wrong_decision_999. Retry with --decision tool_call_bg_wrong_decision_001."
    );
    await expect(runStore.loadRunById("run_bg_wrong_decision")).resolves.toMatchObject({
      status: "blocked",
      pendingApprovalRef: "tool_call_bg_wrong_decision_001"
    });
  });

  it("rejects mistaken resume on approval-gated Task 2 background continuations without mutating durable run truth", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_resume_requires_approval_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-resume-needs-approval; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_resume_requires_approval",
      workspaceId: "workspace_local",
      sessionId: "session_bg_resume_requires_approval",
      actorId: "actor_cli",
      title: "Resume needs approval guard",
      description: "background approval must not route through resume",
      sourceTurnId: "turn_bg_resume_requires_approval",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_resume_requires_approval",
      taskId: "task_bg_resume_requires_approval",
      workspaceId: "workspace_local",
      sessionId: "session_bg_resume_requires_approval",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-resume-requires-approval",
      turnRequest: {
        turnId: "turn_bg_resume_requires_approval",
        sessionId: "session_bg_resume_requires_approval",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "run a controlled bash command in background",
        requestedMode: "act",
        originTurnId: "turn_bg_resume_requires_approval"
      },
      sourceTurnId: "turn_bg_resume_requires_approval",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_resume_requires_approval",
      workspaceId: "workspace_local",
      turnId: "run_bg_resume_requires_approval",
      input: "continue"
    })).rejects.toThrow(
      "Session session_bg_resume_requires_approval is waiting on approval decision tool_call_bg_resume_requires_approval_001. Use approve/deny with --decision tool_call_bg_resume_requires_approval_001 instead of resume."
    );
    await expect(runStore.loadRunById("run_bg_resume_requires_approval")).resolves.toMatchObject({
      status: "blocked",
      continuationKind: "approval_resume",
      pendingApprovalRef: "tool_call_bg_resume_requires_approval_001"
    });
  });

  it("normalizes post-approval safe-pauses onto operator-resume slice truth so follow-up resume does not require re-approval", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      toolLoop: {
        maxToolCallsPerBatchByMode: { act: 2, chat: 2 },
        maxToolCallsPerTurnByMode: { act: 2, chat: 2 }
      },
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_approval_pause",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_approval_pause",
      workspaceId: "workspace_local",
      sessionId: "session_bg_approval_pause",
      actorId: "actor_cli",
      title: "Approval safe pause background run",
      description: "approval is consumed before the next resumable safe pause",
      sourceTurnId: "turn_bg_approval_pause_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_approval_pause",
      taskId: "task_bg_approval_pause",
      workspaceId: "workspace_local",
      sessionId: "session_bg_approval_pause",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-approval-pause",
      turnRequest: {
        turnId: "turn_bg_approval_pause_origin",
        sessionId: "session_bg_approval_pause",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "approve and continue the blocked background run",
        requestedMode: "act",
        originTurnId: "turn_bg_approval_pause_origin"
      },
      sourceTurnId: "turn_bg_approval_pause_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:00.020Z"
    });
    await runStore.suspendRun({
      runId: "run_bg_approval_pause",
      pendingApprovalRef: "tool_call_bg_approval_pause_001",
      pendingControlRef: "frame:run_bg_approval_pause",
      blockedBy: "permission",
      resultSummary: "awaiting approval",
      now: "2026-04-27T00:00:00.030Z"
    });
    await sessionStore.markInflight({
      turnId: "run_bg_approval_pause",
      sessionId: "session_bg_approval_pause",
      workspaceId: "workspace_local",
      state: "awaiting_permission",
      waitingReason: "permission",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 2,
      pendingApprovalRef: "tool_call_bg_approval_pause_001",
      checkpointRef: "checkpoint:run_bg_approval_pause",
      frameRef: "frame:run_bg_approval_pause",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:run_bg_approval_pause",
        frameRef: "frame:run_bg_approval_pause",
        checkpointRef: "checkpoint:run_bg_approval_pause",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:run_bg_approval_pause",
          checkpointRef: "checkpoint:run_bg_approval_pause",
          turnId: "run_bg_approval_pause",
          sessionId: "session_bg_approval_pause",
          workspaceId: "workspace_local",
          phase: "awaiting_permission",
          step: "tool_batch",
          pendingToolCalls: [
            {
              toolCallId: "tool_call_bg_approval_pause_001",
              toolName: "bash",
              arguments: { command: "printf bg-approval-safe-pause; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" }
            }
          ],
          pendingPermissionDecisions: [
            {
              decisionId: "tool_call_bg_approval_pause_001",
              behavior: "ask",
              scope: "once",
              reasonCode: "bash_action_requires_approval",
              reasonText: "git push crosses from the local workspace into remote branch state.",
              issuedAt: "2026-04-27T00:00:00.030Z",
              requestedBy: "run_bg_approval_pause"
            }
          ],
          loopCount: 1,
          toolCallCount: 2,
          usage: {
            inputTokens: 42,
            outputTokens: 19,
            totalTokens: 61,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "awaiting_operator",
            allowedActions: ["approve", "deny", "cancel"],
            metadata: {
              actorId: "actor_cli"
            }
          }
        }
      }
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_approval_pause",
      turnId: "run_bg_approval_pause",
      decisionId: "tool_call_bg_approval_pause_001",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_bg_approval_pause",
      warnings: [
        "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume."
      ]
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_approval_pause" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_bg_approval_pause")).resolves.toMatchObject({
      status: "queued",
      continuationKind: "operator_resume",
      pendingApprovalRef: undefined,
      pendingControlRef: "frame:run_bg_approval_pause"
    });
    await expect(sliceStore.listSlicesByRun("run_bg_approval_pause")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "yielded",
        triggerKind: "approval_resume"
      },
      {
        sliceNo: 2,
        status: "queued",
        triggerKind: "operator_resume"
      }
    ]);

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_approval_pause",
      workspaceId: "workspace_local",
      turnId: "run_bg_approval_pause",
      input: "continue after approval safe pause"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_bg_approval_pause",
      warnings: [
        "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume."
      ]
    });
    await expect(runStore.loadRunById("run_bg_approval_pause")).resolves.toMatchObject({
      status: "queued",
      continuationKind: "operator_resume",
      pendingApprovalRef: undefined,
      pendingControlRef: "frame:run_bg_approval_pause"
    });
    await expect(sliceStore.listSlicesByRun("run_bg_approval_pause")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "yielded",
        triggerKind: "approval_resume"
      },
      {
        sliceNo: 2,
        status: "yielded",
        triggerKind: "operator_resume"
      },
      {
        sliceNo: 3,
        status: "queued",
        triggerKind: "operator_resume"
      }
    ]);
  });

  it("reuses an already-queued Task 2 approval-resume slice from slice truth even when run continuation truth is stale", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tool_call_bg_reuse_approval_slice_001",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "printf bg-reuse-approval; git push --dry-run . HEAD:refs/heads/endec-test-dry-run" })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 12,
              total_tokens: 30
            }
          }
        ],
        [
          {
            choices: [
              {
                delta: {
                  content: "reused queued approval slice completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 14,
              completion_tokens: 8,
              total_tokens: 22
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await runStore.createBackgroundTask({
      taskId: "task_bg_reuse_approval_slice",
      workspaceId: "workspace_local",
      sessionId: "session_bg_reuse_approval_slice",
      actorId: "actor_cli",
      title: "Reuse queued approval slice",
      description: "resume through the pre-existing Task 2 slice",
      sourceTurnId: "turn_bg_reuse_approval_slice_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_reuse_approval_slice",
      taskId: "task_bg_reuse_approval_slice",
      workspaceId: "workspace_local",
      sessionId: "session_bg_reuse_approval_slice",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-reuse-approval-slice",
      turnRequest: {
        turnId: "turn_bg_reuse_approval_slice_origin",
        sessionId: "session_bg_reuse_approval_slice",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "complete through queued approval slice",
        requestedMode: "act",
        originTurnId: "turn_bg_reuse_approval_slice_origin"
      },
      sourceTurnId: "turn_bg_reuse_approval_slice_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      outcome: "suspended",
      callbackKind: "blocked"
    });

    const durableApprovalRecoveryPayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_reuse_approval_slice",
        turnId: "run_bg_reuse_approval_slice",
        frameRef: "frame:run_bg_reuse_approval_slice",
        decisionId: "tool_call_bg_reuse_approval_slice_001",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_reuse_approval_slice",
        sessionId: "session_bg_reuse_approval_slice",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act",
        checkpointRef: "checkpoint:run_bg_reuse_approval_slice",
        frameRef: "frame:run_bg_reuse_approval_slice",
        pendingApprovalRef: "tool_call_bg_reuse_approval_slice_001",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_reuse_approval_slice",
          frameRef: "frame:run_bg_reuse_approval_slice",
          checkpointRef: "checkpoint:run_bg_reuse_approval_slice",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_reuse_approval_slice",
            checkpointRef: "checkpoint:run_bg_reuse_approval_slice",
            turnId: "run_bg_reuse_approval_slice",
            sessionId: "session_bg_reuse_approval_slice",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };
    const staleRunResumePayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_reuse_approval_slice",
        turnId: "run_bg_reuse_approval_slice",
        frameRef: "frame:run_bg_reuse_approval_slice",
        decisionId: "tool_call_bg_reuse_approval_slice_stale",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_reuse_approval_slice",
        sessionId: "session_bg_reuse_approval_slice",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act",
        checkpointRef: "checkpoint:run_bg_reuse_approval_slice",
        frameRef: "frame:run_bg_reuse_approval_slice",
        pendingApprovalRef: "tool_call_bg_reuse_approval_slice_stale",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_reuse_approval_slice",
          frameRef: "frame:run_bg_reuse_approval_slice",
          checkpointRef: "checkpoint:run_bg_reuse_approval_slice",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_reuse_approval_slice",
            checkpointRef: "checkpoint:run_bg_reuse_approval_slice",
            turnId: "run_bg_reuse_approval_slice",
            sessionId: "session_bg_reuse_approval_slice",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_reuse_approval_001",
      runId: "run_bg_reuse_approval_slice",
      taskId: "task_bg_reuse_approval_slice",
      triggerKind: "approval_resume",
      lane: "background",
      now: "2026-04-27T00:00:01.100Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'queued',
          continuation_kind = 'operator_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_approval_ref = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify(staleRunResumePayload),
      "2026-04-27T00:00:01.100Z",
      "2026-04-27T00:00:01.100Z",
      "run_bg_reuse_approval_slice"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify(durableApprovalRecoveryPayload),
      "2026-04-27T00:00:01.100Z",
      "slice_bg_reuse_approval_001"
    );
    taskDb.close();

    await expect(runStore.loadRunById("run_bg_reuse_approval_slice")).resolves.toMatchObject({
      status: "queued",
      continuationPayload: staleRunResumePayload
    });
    await expect(sliceStore.listSlicesByRun("run_bg_reuse_approval_slice")).resolves.toMatchObject([
      {
        status: "blocked",
        triggerKind: "legacy_cutover"
      },
      {
        sliceId: "slice_bg_reuse_approval_001",
        status: "queued",
        continuationPayload: durableApprovalRecoveryPayload
      }
    ]);
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_reuse_approval_slice" })).resolves.toBeNull();

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_reuse_approval_slice",
      turnId: "run_bg_reuse_approval_slice",
      decisionId: "tool_call_bg_reuse_approval_slice_001",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_reuse_approval_slice",
      messages: [
        expect.objectContaining({
          content: "reused queued approval slice completed"
        })
      ]
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_reuse_approval_slice" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_bg_reuse_approval_slice")).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_reuse_approval_slice")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "blocked",
        triggerKind: "legacy_cutover"
      },
      {
        sliceId: "slice_bg_reuse_approval_001",
        sliceNo: 2,
        status: "completed",
        triggerKind: "approval_resume"
      }
    ]);
  });

  it("reuses an already-queued Task 2 operator-resume slice from slice truth even when run continuation truth is stale after inflight loss", async () => {
    const capturedRequests: ProviderTransportRequest[] = [];
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "reused queued operator slice completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 14,
              completion_tokens: 8,
              total_tokens: 22
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_reuse_operator_slice",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_reuse_operator_slice",
      workspaceId: "workspace_local",
      sessionId: "session_bg_reuse_operator_slice",
      actorId: "actor_cli",
      title: "Reuse queued operator slice",
      description: "resume through the pre-existing Task 2 slice after inflight loss",
      sourceTurnId: "turn_bg_reuse_operator_slice_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_reuse_operator_slice",
      taskId: "task_bg_reuse_operator_slice",
      workspaceId: "workspace_local",
      sessionId: "session_bg_reuse_operator_slice",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-reuse-operator-slice",
      turnRequest: {
        turnId: "turn_bg_reuse_operator_slice_origin",
        sessionId: "session_bg_reuse_operator_slice",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "continue the queued operator slice",
        requestedMode: "chat",
        originTurnId: "turn_bg_reuse_operator_slice_origin"
      },
      sourceTurnId: "turn_bg_reuse_operator_slice_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableResumePayload = {
      checkpointRef: "checkpoint:run_bg_reuse_operator_slice",
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_reuse_operator_slice",
        sessionId: "session_bg_reuse_operator_slice",
        workspaceId: "workspace_local",
        source: "cli" as const,
        mode: "chat" as const,
        checkpointRef: "checkpoint:run_bg_reuse_operator_slice",
        frameRef: "frame:run_bg_reuse_operator_slice",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_reuse_operator_slice",
          frameRef: "frame:run_bg_reuse_operator_slice",
          checkpointRef: "checkpoint:run_bg_reuse_operator_slice",
          status: "ready" as const,
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_reuse_operator_slice",
            checkpointRef: "checkpoint:run_bg_reuse_operator_slice",
            turnId: "run_bg_reuse_operator_slice",
            sessionId: "session_bg_reuse_operator_slice",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "confirmation",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };
    const staleRunApprovalPayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_reuse_operator_slice",
        turnId: "run_bg_reuse_operator_slice",
        frameRef: "frame:run_bg_reuse_operator_slice",
        decisionId: "tool_call_bg_reuse_operator_slice_001",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_reuse_operator_slice",
        sessionId: "session_bg_reuse_operator_slice",
        workspaceId: "workspace_local",
        source: "cli" as const,
        mode: "chat" as const,
        checkpointRef: "checkpoint:run_bg_reuse_operator_slice",
        frameRef: "frame:run_bg_reuse_operator_slice",
        pendingApprovalRef: "tool_call_bg_reuse_operator_slice_001",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_reuse_operator_slice",
          frameRef: "frame:run_bg_reuse_operator_slice",
          checkpointRef: "checkpoint:run_bg_reuse_operator_slice",
          status: "ready" as const,
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_reuse_operator_slice",
            checkpointRef: "checkpoint:run_bg_reuse_operator_slice",
            turnId: "run_bg_reuse_operator_slice",
            sessionId: "session_bg_reuse_operator_slice",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_reuse_operator_001",
      runId: "run_bg_reuse_operator_slice",
      taskId: "task_bg_reuse_operator_slice",
      triggerKind: "operator_resume",
      lane: "background",
      now: "2026-04-27T00:00:00.040Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'queued',
          continuation_kind = 'approval_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_approval_ref = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify(staleRunApprovalPayload),
      "2026-04-27T00:00:00.040Z",
      "2026-04-27T00:00:00.040Z",
      "run_bg_reuse_operator_slice"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify(durableResumePayload),
      "2026-04-27T00:00:00.040Z",
      "slice_bg_reuse_operator_001"
    );
    taskDb.close();

    await expect(runStore.loadRunById("run_bg_reuse_operator_slice")).resolves.toMatchObject({
      status: "queued",
      continuationPayload: staleRunApprovalPayload
    });
    await expect(sliceStore.listSlicesByRun("run_bg_reuse_operator_slice")).resolves.toMatchObject([
      {
        sliceId: "slice_bg_reuse_operator_001",
        status: "queued",
        continuationPayload: durableResumePayload
      }
    ]);
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_reuse_operator_slice" })).resolves.toBeNull();

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_reuse_operator_slice",
      workspaceId: "workspace_local",
      turnId: "run_bg_reuse_operator_slice",
      input: "continue"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_reuse_operator_slice",
      messages: [
        expect.objectContaining({
          content: "reused queued operator slice completed"
        })
      ]
    });

    expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain("reply path: continuation");
    await expect(runStore.loadRunById("run_bg_reuse_operator_slice")).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_reuse_operator_slice")).resolves.toMatchObject([
      {
        sliceId: "slice_bg_reuse_operator_001",
        sliceNo: 1,
        status: "completed",
        triggerKind: "operator_resume"
      }
    ]);
  });

  it("routes blocked background resume through operator-resume slices and completes the run lifecycle", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "background operator resume completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 16,
              completion_tokens: 9,
              total_tokens: 25
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_operator_resume",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_operator_resume",
      workspaceId: "workspace_local",
      sessionId: "session_bg_operator_resume",
      actorId: "actor_cli",
      title: "Resume blocked background run",
      description: "continue after user confirmation",
      sourceTurnId: "turn_bg_operator_resume_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_operator_resume",
      taskId: "task_bg_operator_resume",
      workspaceId: "workspace_local",
      sessionId: "session_bg_operator_resume",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-operator-resume",
      turnRequest: {
        turnId: "turn_bg_operator_resume_origin",
        sessionId: "session_bg_operator_resume",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "continue blocked background run",
        requestedMode: "chat",
        originTurnId: "turn_bg_operator_resume_origin"
      },
      sourceTurnId: "turn_bg_operator_resume_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:00.020Z"
    });
    await runStore.suspendRun({
      runId: "run_bg_operator_resume",
      pendingControlRef: "frame:run_bg_operator_resume",
      blockedBy: "user_decision",
      resultSummary: "awaiting operator resume",
      now: "2026-04-27T00:00:00.030Z"
    });
    await sessionStore.markInflight({
      turnId: "run_bg_operator_resume",
      sessionId: "session_bg_operator_resume",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      checkpointRef: "checkpoint:run_bg_operator_resume",
      frameRef: "frame:run_bg_operator_resume",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:run_bg_operator_resume",
        frameRef: "frame:run_bg_operator_resume",
        checkpointRef: "checkpoint:run_bg_operator_resume",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:run_bg_operator_resume",
          checkpointRef: "checkpoint:run_bg_operator_resume",
          turnId: "run_bg_operator_resume",
          sessionId: "session_bg_operator_resume",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "confirmation",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              actorId: "actor_cli"
            }
          }
        }
      }
    });

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_operator_resume",
      workspaceId: "workspace_local",
      turnId: "run_bg_operator_resume",
      input: "continue"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_operator_resume",
      messages: [
        expect.objectContaining({
          content: "background operator resume completed"
        })
      ]
    });
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_operator_resume" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_bg_operator_resume")).resolves.toMatchObject({
      status: "completed",
      pendingControlRef: undefined,
      continuationKind: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_operator_resume")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "completed",
        triggerKind: "operator_resume"
      }
    ]);
  });

  it("fails explicit approval replay against the actual running approval-resume slice even when run continuation truth is stale after inflight loss", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_running_approval_stale",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_running_approval_stale",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_approval_stale",
      actorId: "actor_cli",
      title: "Running approval slice with stale run truth",
      description: "approval replay should trust the open slice truth",
      sourceTurnId: "turn_bg_running_approval_stale_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_running_approval_stale",
      taskId: "task_bg_running_approval_stale",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_approval_stale",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-running-approval-stale",
      turnRequest: {
        turnId: "turn_bg_running_approval_stale_origin",
        sessionId: "session_bg_running_approval_stale",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "approve the active background slice",
        requestedMode: "act",
        originTurnId: "turn_bg_running_approval_stale_origin"
      },
      sourceTurnId: "turn_bg_running_approval_stale_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableApprovalRecoveryPayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_running_approval_stale",
        turnId: "run_bg_running_approval_stale",
        frameRef: "frame:run_bg_running_approval_stale",
        decisionId: "tool_call_bg_running_approval_stale_001",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_running_approval_stale",
        sessionId: "session_bg_running_approval_stale",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act",
        checkpointRef: "checkpoint:run_bg_running_approval_stale",
        frameRef: "frame:run_bg_running_approval_stale",
        pendingApprovalRef: "tool_call_bg_running_approval_stale_001",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_running_approval_stale",
          frameRef: "frame:run_bg_running_approval_stale",
          checkpointRef: "checkpoint:run_bg_running_approval_stale",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_running_approval_stale",
            checkpointRef: "checkpoint:run_bg_running_approval_stale",
            turnId: "run_bg_running_approval_stale",
            sessionId: "session_bg_running_approval_stale",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };
    const staleRunningOperatorPayload = {
      checkpointRef: "checkpoint:run_bg_running_approval_stale",
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_running_approval_stale",
        sessionId: "session_bg_running_approval_stale",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act",
        checkpointRef: "checkpoint:run_bg_running_approval_stale",
        frameRef: "frame:run_bg_running_approval_stale",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_running_approval_stale",
          frameRef: "frame:run_bg_running_approval_stale",
          checkpointRef: "checkpoint:run_bg_running_approval_stale",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_running_approval_stale",
            checkpointRef: "checkpoint:run_bg_running_approval_stale",
            turnId: "run_bg_running_approval_stale",
            sessionId: "session_bg_running_approval_stale",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "confirmation",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_running_approval_stale_001",
      runId: "run_bg_running_approval_stale",
      taskId: "task_bg_running_approval_stale",
      triggerKind: "approval_resume",
      lane: "background",
      now: "2026-04-27T00:00:01.000Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_active',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'operator_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_approval_ref = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(staleRunningOperatorPayload),
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "run_bg_running_approval_stale"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_active',
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableApprovalRecoveryPayload),
      "2026-04-27T00:00:01.000Z",
      "slice_bg_running_approval_stale_001"
    );
    taskDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_running_approval_stale" })).resolves.toBeNull();

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_running_approval_stale",
      turnId: "run_bg_running_approval_stale",
      decisionId: "tool_call_bg_running_approval_stale_001",
      approved: true,
      approverId: "operator_001"
    })).rejects.toThrow("Run run_bg_running_approval_stale is already processing a approval_resume slice.");
  });

  it("fails explicit resume replay against the actual running operator-resume slice even when run continuation truth is stale after inflight loss", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_running_operator_stale",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_running_operator_stale",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_operator_stale",
      actorId: "actor_cli",
      title: "Running operator slice with stale run truth",
      description: "resume replay should trust the open slice truth",
      sourceTurnId: "turn_bg_running_operator_stale_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_running_operator_stale",
      taskId: "task_bg_running_operator_stale",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_operator_stale",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-running-operator-stale",
      turnRequest: {
        turnId: "turn_bg_running_operator_stale_origin",
        sessionId: "session_bg_running_operator_stale",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "resume the active background slice",
        requestedMode: "chat",
        originTurnId: "turn_bg_running_operator_stale_origin"
      },
      sourceTurnId: "turn_bg_running_operator_stale_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableResumePayload = {
      checkpointRef: "checkpoint:run_bg_running_operator_stale",
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_running_operator_stale",
        sessionId: "session_bg_running_operator_stale",
        workspaceId: "workspace_local",
        source: "cli" as const,
        mode: "chat" as const,
        checkpointRef: "checkpoint:run_bg_running_operator_stale",
        frameRef: "frame:run_bg_running_operator_stale",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_running_operator_stale",
          frameRef: "frame:run_bg_running_operator_stale",
          checkpointRef: "checkpoint:run_bg_running_operator_stale",
          status: "ready" as const,
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_running_operator_stale",
            checkpointRef: "checkpoint:run_bg_running_operator_stale",
            turnId: "run_bg_running_operator_stale",
            sessionId: "session_bg_running_operator_stale",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "confirmation",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };
    const staleRunningApprovalPayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_running_operator_stale",
        turnId: "run_bg_running_operator_stale",
        frameRef: "frame:run_bg_running_operator_stale",
        decisionId: "tool_call_bg_running_operator_stale_001",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_running_operator_stale",
        sessionId: "session_bg_running_operator_stale",
        workspaceId: "workspace_local",
        source: "cli" as const,
        mode: "chat" as const,
        checkpointRef: "checkpoint:run_bg_running_operator_stale",
        frameRef: "frame:run_bg_running_operator_stale",
        pendingApprovalRef: "tool_call_bg_running_operator_stale_001",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_running_operator_stale",
          frameRef: "frame:run_bg_running_operator_stale",
          checkpointRef: "checkpoint:run_bg_running_operator_stale",
          status: "ready" as const,
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_running_operator_stale",
            checkpointRef: "checkpoint:run_bg_running_operator_stale",
            turnId: "run_bg_running_operator_stale",
            sessionId: "session_bg_running_operator_stale",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_running_operator_stale_001",
      runId: "run_bg_running_operator_stale",
      taskId: "task_bg_running_operator_stale",
      triggerKind: "operator_resume",
      lane: "background",
      now: "2026-04-27T00:00:01.000Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_active',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'approval_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_approval_ref = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(staleRunningApprovalPayload),
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "run_bg_running_operator_stale"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_active',
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableResumePayload),
      "2026-04-27T00:00:01.000Z",
      "slice_bg_running_operator_stale_001"
    );
    taskDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_running_operator_stale" })).resolves.toBeNull();

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_running_operator_stale",
      workspaceId: "workspace_local",
      turnId: "run_bg_running_operator_stale",
      input: "continue"
    })).rejects.toThrow("Run run_bg_running_operator_stale is already processing a operator_resume slice.");
  });

  it("surfaces the live inflight operator-resume continuation for a running background slice", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_operator_running",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_operator_running",
      workspaceId: "workspace_local",
      sessionId: "session_bg_operator_running",
      actorId: "actor_cli",
      title: "Running operator resume background run",
      description: "the active continuation should stay visible while the slice is running",
      sourceTurnId: "turn_bg_operator_running_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_operator_running",
      taskId: "task_bg_operator_running",
      workspaceId: "workspace_local",
      sessionId: "session_bg_operator_running",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-operator-running",
      turnRequest: {
        turnId: "turn_bg_operator_running_origin",
        sessionId: "session_bg_operator_running",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "continue the active background operator resume",
        requestedMode: "chat",
        originTurnId: "turn_bg_operator_running_origin"
      },
      sourceTurnId: "turn_bg_operator_running_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_active',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'operator_resume',
          pending_control_ref = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "frame:run_bg_operator_running",
      "2026-04-27T00:00:01.000Z",
      "run_bg_operator_running"
    );
    taskDb.close();

    await sessionStore.markInflight({
      turnId: "run_bg_operator_running",
      sessionId: "session_bg_operator_running",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      checkpointRef: "checkpoint:run_bg_operator_running",
      frameRef: "frame:run_bg_operator_running",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:run_bg_operator_running",
        frameRef: "frame:run_bg_operator_running",
        checkpointRef: "checkpoint:run_bg_operator_running",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:run_bg_operator_running",
          checkpointRef: "checkpoint:run_bg_operator_running",
          turnId: "run_bg_operator_running",
          sessionId: "session_bg_operator_running",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "confirmation",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              actorId: "actor_cli"
            }
          }
        }
      }
    });

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_operator_running",
      workspaceId: "workspace_local",
      turnId: "run_bg_operator_running",
      input: "continue"
    })).rejects.toThrow("Run run_bg_operator_running is already processing a operator_resume slice.");
  });

  it("keeps resumable interrupted operator-resume slices queued as non-gated continuation truth with durable Task 2 payload", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      toolLoop: {
        maxToolCallsPerBatchByMode: { chat: 2 },
        maxToolCallsPerTurnByMode: { chat: 2 }
      },
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "background operator safe pause resumed durably"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 16,
              completion_tokens: 9,
              total_tokens: 25
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_operator_pause",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_operator_pause",
      workspaceId: "workspace_local",
      sessionId: "session_bg_operator_pause",
      actorId: "actor_cli",
      title: "Resume blocked background run",
      description: "continue after a safe pause",
      sourceTurnId: "turn_bg_operator_pause_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_operator_pause",
      taskId: "task_bg_operator_pause",
      workspaceId: "workspace_local",
      sessionId: "session_bg_operator_pause",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-operator-pause",
      turnRequest: {
        turnId: "turn_bg_operator_pause_origin",
        sessionId: "session_bg_operator_pause",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "continue blocked background run after safe pause",
        requestedMode: "chat",
        originTurnId: "turn_bg_operator_pause_origin"
      },
      sourceTurnId: "turn_bg_operator_pause_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:00.020Z"
    });
    await runStore.suspendRun({
      runId: "run_bg_operator_pause",
      pendingControlRef: "frame:run_bg_operator_pause",
      blockedBy: "user_decision",
      resultSummary: "awaiting operator resume",
      now: "2026-04-27T00:00:00.030Z"
    });
    await sessionStore.markInflight({
      turnId: "run_bg_operator_pause",
      sessionId: "session_bg_operator_pause",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 2,
      checkpointRef: "checkpoint:run_bg_operator_pause",
      frameRef: "frame:run_bg_operator_pause",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:run_bg_operator_pause",
        frameRef: "frame:run_bg_operator_pause",
        checkpointRef: "checkpoint:run_bg_operator_pause",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:run_bg_operator_pause",
          checkpointRef: "checkpoint:run_bg_operator_pause",
          turnId: "run_bg_operator_pause",
          sessionId: "session_bg_operator_pause",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "tool_turn_limit",
          pendingToolCalls: [
            {
              toolCallId: "tool_call_bg_operator_pause",
              toolName: "read",
              arguments: { path: "packages/app/package.json" }
            }
          ],
          pendingPermissionDecisions: [],
          loopCount: 1,
          toolCallCount: 2,
          usage: {
            inputTokens: 42,
            outputTokens: 19,
            totalTokens: 61,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              stopReason: "tool_turn_limit",
              requestedToolCallsInBatch: 1,
              toolCallCountBeforePausedBatch: 2,
              executedToolCalls: 0,
              actorId: "actor_cli"
            }
          }
        }
      }
    });

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_operator_pause",
      workspaceId: "workspace_local",
      turnId: "run_bg_operator_pause",
      input: "continue"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_bg_operator_pause",
      warnings: [
        "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume."
      ]
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_operator_pause" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_bg_operator_pause")).resolves.toMatchObject({
      status: "queued",
      continuationKind: "operator_resume",
      pendingApprovalRef: undefined,
      pendingControlRef: "frame:run_bg_operator_pause",
      continuationPayload: expect.objectContaining({
        recovery: expect.objectContaining({
          contractVersion: "im.task2.slice-recovery.v1",
          source: "cli",
          mode: "chat",
          pendingExecution: expect.objectContaining({
            frame: expect.objectContaining({
              turnId: "run_bg_operator_pause",
              sessionId: "session_bg_operator_pause"
            })
          })
        })
      })
    });
    await expect(sliceStore.listSlicesByRun("run_bg_operator_pause")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "yielded",
        triggerKind: "operator_resume"
      },
      {
        sliceNo: 2,
        status: "queued",
        triggerKind: "operator_resume"
      }
    ]);

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_operator_pause",
      workspaceId: "workspace_local",
      turnId: "run_bg_operator_pause",
      input: "continue after durable safe pause"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_bg_operator_pause",
      warnings: [
        "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume."
      ]
    });
    await expect(runStore.loadRunById("run_bg_operator_pause")).resolves.toMatchObject({
      status: "queued",
      continuationKind: "operator_resume",
      pendingControlRef: "frame:run_bg_operator_pause"
    });
    await expect(sliceStore.listSlicesByRun("run_bg_operator_pause")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "yielded",
        triggerKind: "operator_resume"
      },
      {
        sliceNo: 2,
        status: "yielded",
        triggerKind: "operator_resume"
      },
      {
        sliceNo: 3,
        status: "queued",
        triggerKind: "operator_resume"
      }
    ]);
  });

  it("falls back to durable Task 2 resume recovery after inflight loss and reuses persisted source/mode", async () => {
    const capturedRequests: ProviderTransportRequest[] = [];
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "background operator durable fallback completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 16,
              completion_tokens: 9,
              total_tokens: 25
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_resume_fallback",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_resume_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_resume_fallback",
      actorId: "actor_cli",
      title: "Resume durable fallback",
      description: "continue after inflight recovery is gone",
      sourceTurnId: "turn_bg_resume_fallback_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_resume_fallback",
      taskId: "task_bg_resume_fallback",
      workspaceId: "workspace_local",
      sessionId: "session_bg_resume_fallback",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-resume-fallback",
      turnRequest: {
        turnId: "turn_bg_resume_fallback_origin",
        sessionId: "session_bg_resume_fallback",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "continue blocked background run",
        requestedMode: "chat",
        originTurnId: "turn_bg_resume_fallback_origin"
      },
      sourceTurnId: "turn_bg_resume_fallback_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });
    await runStore.claimNextRun({
      workerId: "legacy_worker",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:00.020Z"
    });
    await runStore.suspendRun({
      runId: "run_bg_resume_fallback",
      pendingControlRef: "frame:run_bg_resume_fallback",
      blockedBy: "user_decision",
      resultSummary: "awaiting operator resume",
      now: "2026-04-27T00:00:00.030Z"
    });

    const durableResumePayload = {
      checkpointRef: "checkpoint:run_bg_resume_fallback",
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_resume_fallback",
        sessionId: "session_bg_resume_fallback",
        workspaceId: "workspace_local",
        source: "cli" as const,
        mode: "chat" as const,
        checkpointRef: "checkpoint:run_bg_resume_fallback",
        frameRef: "frame:run_bg_resume_fallback",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_resume_fallback",
          frameRef: "frame:run_bg_resume_fallback",
          checkpointRef: "checkpoint:run_bg_resume_fallback",
          status: "ready" as const,
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_resume_fallback",
            checkpointRef: "checkpoint:run_bg_resume_fallback",
            turnId: "run_bg_resume_fallback",
            sessionId: "session_bg_resume_fallback",
            workspaceId: "workspace_local",
            phase: "awaiting_operator" as const,
            step: "confirmation",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET continuation_kind = 'operator_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify(durableResumePayload),
      "2026-04-27T00:00:00.040Z",
      "2026-04-27T00:00:00.040Z",
      "run_bg_resume_fallback"
    );
    taskDb.close();

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_resume_fallback_blocked",
      runId: "run_bg_resume_fallback",
      taskId: "task_bg_resume_fallback",
      triggerKind: "operator_resume",
      lane: "background",
      now: "2026-04-27T00:00:00.040Z"
    });

    const taskDb2 = new Database(paths.tasksDbPath);
    taskDb2.prepare(`
      UPDATE runtime_slices
      SET status = 'blocked',
          continuation_payload_json = ?,
          finished_at = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify(durableResumePayload),
      "2026-04-27T00:00:00.041Z",
      "2026-04-27T00:00:00.041Z",
      "slice_bg_resume_fallback_blocked"
    );
    taskDb2.close();

    const sessionDb = new Database(paths.sessionsDbPath);
    sessionDb.prepare(`
      UPDATE sessions
      SET last_source = 'telegram',
          mode = 'review'
      WHERE session_id = ?
    `).run("session_bg_resume_fallback");
    sessionDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_resume_fallback" })).resolves.toBeNull();

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_resume_fallback",
      workspaceId: "workspace_local",
      turnId: "run_bg_resume_fallback",
      input: "continue"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_resume_fallback",
      resolvedMode: "chat",
      messages: [
        expect.objectContaining({
          content: "background operator durable fallback completed"
        })
      ]
    });

    await expect(sessionStore.loadById("session_bg_resume_fallback")).resolves.toMatchObject({
      lastSource: "cli",
      mode: "chat"
    });
    expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain("reply path: continuation");

    await expect(runStore.loadRunById("run_bg_resume_fallback")).resolves.toMatchObject({
      status: "completed",
      pendingControlRef: undefined,
      continuationKind: undefined
    });
  });

  it("routes recovery-retry background slices through the continuation executor and completes the same run", async () => {
    const capturedRequests: ProviderTransportRequest[] = [];
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "background recovery retry completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 15,
              completion_tokens: 8,
              total_tokens: 23
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_recovery_retry",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_recovery_retry",
      workspaceId: "workspace_local",
      sessionId: "session_bg_recovery_retry",
      actorId: "actor_cli",
      title: "Recovery retry background run",
      description: "resume same-run recoverable continuation after lease recovery",
      sourceTurnId: "turn_bg_recovery_retry_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_recovery_retry",
      taskId: "task_bg_recovery_retry",
      workspaceId: "workspace_local",
      sessionId: "session_bg_recovery_retry",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-recovery-retry",
      turnRequest: {
        turnId: "turn_bg_recovery_retry_origin",
        sessionId: "session_bg_recovery_retry",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "continue recovered background run",
        requestedMode: "chat",
        originTurnId: "turn_bg_recovery_retry_origin"
      },
      sourceTurnId: "turn_bg_recovery_retry_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const setupDb = new Database(paths.tasksDbPath);
    setupDb.prepare(`
      UPDATE task_runs
      SET continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      JSON.stringify({ checkpointRef: "checkpoint:run_bg_recovery_retry" }),
      "2026-04-27T00:00:00.020Z",
      "2026-04-27T00:00:00.020Z",
      "run_bg_recovery_retry"
    );
    setupDb.close();

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_recovery_retry_001",
      runId: "run_bg_recovery_retry",
      taskId: "task_bg_recovery_retry",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-27T00:00:00.030Z"
    });

    const slicePayloadDb = new Database(paths.tasksDbPath);
    slicePayloadDb.prepare(`
      UPDATE runtime_slices
      SET continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      JSON.stringify({ checkpointRef: "checkpoint:run_bg_recovery_retry" }),
      "2026-04-27T00:00:00.031Z",
      "slice_bg_recovery_retry_001"
    );
    slicePayloadDb.close();

    await sessionStore.markInflight({
      turnId: "run_bg_recovery_retry",
      sessionId: "session_bg_recovery_retry",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 0,
      toolCallCount: 0,
      checkpointRef: "checkpoint:run_bg_recovery_retry",
      frameRef: "frame:run_bg_recovery_retry",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:run_bg_recovery_retry",
        frameRef: "frame:run_bg_recovery_retry",
        checkpointRef: "checkpoint:run_bg_recovery_retry",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:run_bg_recovery_retry",
          checkpointRef: "checkpoint:run_bg_recovery_retry",
          turnId: "run_bg_recovery_retry",
          sessionId: "session_bg_recovery_retry",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "recovery_retry",
          pendingToolCalls: [],
          pendingPermissionDecisions: [],
          loopCount: 0,
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              actorId: "actor_cli"
            }
          }
        }
      }
    });

    app.shell.executeTurn = vi.fn(async () => {
      throw new Error("fresh executeTurn should not run for recovery_retry while live inflight recovery exists");
    });

    await expect(app.background.runWorkerOnce({
      workerId: "worker_001",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:00:01.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      runId: "run_bg_recovery_retry",
      taskId: "task_bg_recovery_retry",
      outcome: "succeeded",
      callbackKind: "final",
      turnResultStatus: "completed"
    });
    expect(app.shell.executeTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain("reply path: continuation");
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_recovery_retry" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_bg_recovery_retry")).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingControlRef: undefined,
      pendingApprovalRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_recovery_retry")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "completed",
        triggerKind: "recovery_retry"
      }
    ]);
  });

  it("recovers an expired resumed slice from durable slice truth after inflight cleanup loses session recovery state", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "recovered durable continuation completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 15,
              completion_tokens: 9,
              total_tokens: 24
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_recovery_durable_truth",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_recovery_durable_truth",
      workspaceId: "workspace_local",
      sessionId: "session_bg_recovery_durable_truth",
      actorId: "actor_cli",
      title: "Durable recovery truth background run",
      description: "recover from an expired resumed slice without inflight truth",
      sourceTurnId: "turn_bg_recovery_durable_truth_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_recovery_durable_truth",
      taskId: "task_bg_recovery_durable_truth",
      workspaceId: "workspace_local",
      sessionId: "session_bg_recovery_durable_truth",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-recovery-durable-truth",
      turnRequest: {
        turnId: "turn_bg_recovery_durable_truth_origin",
        sessionId: "session_bg_recovery_durable_truth",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "continue recovered durable slice",
        requestedMode: "chat",
        originTurnId: "turn_bg_recovery_durable_truth_origin"
      },
      sourceTurnId: "turn_bg_recovery_durable_truth_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableContinuationPayload = {
      checkpointRef: "checkpoint:run_bg_recovery_durable_truth",
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_recovery_durable_truth",
        sessionId: "session_bg_recovery_durable_truth",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "chat",
        checkpointRef: "checkpoint:run_bg_recovery_durable_truth",
        frameRef: "frame:run_bg_recovery_durable_truth",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_recovery_durable_truth",
          frameRef: "frame:run_bg_recovery_durable_truth",
          checkpointRef: "checkpoint:run_bg_recovery_durable_truth",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_recovery_durable_truth",
            checkpointRef: "checkpoint:run_bg_recovery_durable_truth",
            turnId: "run_bg_recovery_durable_truth",
            sessionId: "session_bg_recovery_durable_truth",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "recovery_retry",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_recovery_durable_truth_001",
      runId: "run_bg_recovery_durable_truth",
      taskId: "task_bg_recovery_durable_truth",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-27T00:00:00.030Z"
    });

    const crashDb = new Database(paths.tasksDbPath);
    crashDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_crashed',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:30.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableContinuationPayload),
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "run_bg_recovery_durable_truth"
    );
    crashDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_crashed',
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-04-27T00:00:30.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableContinuationPayload),
      "2026-04-27T00:00:01.000Z",
      "slice_bg_recovery_durable_truth_001"
    );
    crashDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_recovery_durable_truth" })).resolves.toBeNull();

    await expect(app.background.runWorkerOnce({
      workerId: "worker_recovery_durable_truth",
      leaseDurationMs: 60_000,
      now: "2026-04-27T00:02:00.000Z"
    })).resolves.toMatchObject({
      status: "claimed",
      runId: "run_bg_recovery_durable_truth",
      taskId: "task_bg_recovery_durable_truth",
      outcome: "succeeded",
      callbackKind: "final",
      turnResultStatus: "completed"
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_recovery_durable_truth" })).resolves.toBeNull();
    await expect(runStore.loadRunById("run_bg_recovery_durable_truth")).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingControlRef: undefined,
      pendingApprovalRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_recovery_durable_truth")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "lease_expired",
        triggerKind: "recovery_retry"
      },
      {
        sliceNo: 2,
        status: "completed",
        triggerKind: "recovery_retry"
      }
    ]);
  });

  it("recovers detached approval replay through recovery-retry after the claimed approval slice lease expires", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "recovered detached approval replay completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 14,
              completion_tokens: 8,
              total_tokens: 22
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_expired_approval_replay",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_expired_approval_replay",
      workspaceId: "workspace_local",
      sessionId: "session_bg_expired_approval_replay",
      actorId: "actor_cli",
      title: "Expired detached approval replay",
      description: "recover detached approval replay via recovery_retry after claim expiry",
      sourceTurnId: "turn_bg_expired_approval_replay_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_expired_approval_replay",
      taskId: "task_bg_expired_approval_replay",
      workspaceId: "workspace_local",
      sessionId: "session_bg_expired_approval_replay",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-expired-approval-replay",
      turnRequest: {
        turnId: "turn_bg_expired_approval_replay_origin",
        sessionId: "session_bg_expired_approval_replay",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "complete recovered detached approval replay",
        requestedMode: "act",
        originTurnId: "turn_bg_expired_approval_replay_origin"
      },
      sourceTurnId: "turn_bg_expired_approval_replay_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableApprovalRecoveryPayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_expired_approval_replay",
        turnId: "run_bg_expired_approval_replay",
        frameRef: "frame:run_bg_expired_approval_replay",
        decisionId: "tool_call_bg_expired_approval_replay_001",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_expired_approval_replay",
        sessionId: "session_bg_expired_approval_replay",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act",
        checkpointRef: "checkpoint:run_bg_expired_approval_replay",
        frameRef: "frame:run_bg_expired_approval_replay",
        pendingApprovalRef: "tool_call_bg_expired_approval_replay_001",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_expired_approval_replay",
          frameRef: "frame:run_bg_expired_approval_replay",
          checkpointRef: "checkpoint:run_bg_expired_approval_replay",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_expired_approval_replay",
            checkpointRef: "checkpoint:run_bg_expired_approval_replay",
            turnId: "run_bg_expired_approval_replay",
            sessionId: "session_bg_expired_approval_replay",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };
    const staleRunningOperatorPayload = {
      checkpointRef: "checkpoint:run_bg_expired_approval_replay",
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_expired_approval_replay",
        sessionId: "session_bg_expired_approval_replay",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act",
        checkpointRef: "checkpoint:run_bg_expired_approval_replay",
        frameRef: "frame:run_bg_expired_approval_replay",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_expired_approval_replay",
          frameRef: "frame:run_bg_expired_approval_replay",
          checkpointRef: "checkpoint:run_bg_expired_approval_replay",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_expired_approval_replay",
            checkpointRef: "checkpoint:run_bg_expired_approval_replay",
            turnId: "run_bg_expired_approval_replay",
            sessionId: "session_bg_expired_approval_replay",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "confirmation",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_expired_approval_replay_001",
      runId: "run_bg_expired_approval_replay",
      taskId: "task_bg_expired_approval_replay",
      triggerKind: "approval_resume",
      lane: "background",
      now: "2026-04-27T00:00:00.040Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_crashed',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'operator_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_approval_ref = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:30.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(staleRunningOperatorPayload),
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "run_bg_expired_approval_replay"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_crashed',
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-04-27T00:00:30.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableApprovalRecoveryPayload),
      "2026-04-27T00:00:01.000Z",
      "slice_bg_expired_approval_replay_001"
    );
    taskDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_expired_approval_replay" })).resolves.toBeNull();

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_expired_approval_replay",
      turnId: "run_bg_expired_approval_replay",
      decisionId: "tool_call_bg_expired_approval_replay_001",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_expired_approval_replay",
      messages: [
        expect.objectContaining({
          content: "recovered detached approval replay completed"
        })
      ]
    });

    await expect(runStore.loadRunById("run_bg_expired_approval_replay")).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_expired_approval_replay")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "lease_expired",
        triggerKind: "approval_resume"
      },
      {
        sliceNo: 2,
        status: "completed",
        triggerKind: "recovery_retry"
      }
    ]);
  });

  it("recovers detached resume replay through recovery-retry after the claimed operator slice lease expires", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "recovered detached resume replay completed"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 14,
              completion_tokens: 8,
              total_tokens: 22
            }
          }
        ]
      ])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_expired_resume_replay",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_expired_resume_replay",
      workspaceId: "workspace_local",
      sessionId: "session_bg_expired_resume_replay",
      actorId: "actor_cli",
      title: "Expired detached resume replay",
      description: "recover detached resume replay via recovery_retry after claim expiry",
      sourceTurnId: "turn_bg_expired_resume_replay_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_expired_resume_replay",
      taskId: "task_bg_expired_resume_replay",
      workspaceId: "workspace_local",
      sessionId: "session_bg_expired_resume_replay",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-expired-resume-replay",
      turnRequest: {
        turnId: "turn_bg_expired_resume_replay_origin",
        sessionId: "session_bg_expired_resume_replay",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "complete recovered detached resume replay",
        requestedMode: "chat",
        originTurnId: "turn_bg_expired_resume_replay_origin"
      },
      sourceTurnId: "turn_bg_expired_resume_replay_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableResumePayload = {
      checkpointRef: "checkpoint:run_bg_expired_resume_replay",
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_expired_resume_replay",
        sessionId: "session_bg_expired_resume_replay",
        workspaceId: "workspace_local",
        source: "cli" as const,
        mode: "chat" as const,
        checkpointRef: "checkpoint:run_bg_expired_resume_replay",
        frameRef: "frame:run_bg_expired_resume_replay",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_expired_resume_replay",
          frameRef: "frame:run_bg_expired_resume_replay",
          checkpointRef: "checkpoint:run_bg_expired_resume_replay",
          status: "ready" as const,
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_expired_resume_replay",
            checkpointRef: "checkpoint:run_bg_expired_resume_replay",
            turnId: "run_bg_expired_resume_replay",
            sessionId: "session_bg_expired_resume_replay",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "confirmation",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };
    const staleRunningApprovalPayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_expired_resume_replay",
        turnId: "run_bg_expired_resume_replay",
        frameRef: "frame:run_bg_expired_resume_replay",
        decisionId: "tool_call_bg_expired_resume_replay_001",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_expired_resume_replay",
        sessionId: "session_bg_expired_resume_replay",
        workspaceId: "workspace_local",
        source: "cli" as const,
        mode: "chat" as const,
        checkpointRef: "checkpoint:run_bg_expired_resume_replay",
        frameRef: "frame:run_bg_expired_resume_replay",
        pendingApprovalRef: "tool_call_bg_expired_resume_replay_001",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_expired_resume_replay",
          frameRef: "frame:run_bg_expired_resume_replay",
          checkpointRef: "checkpoint:run_bg_expired_resume_replay",
          status: "ready" as const,
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_expired_resume_replay",
            checkpointRef: "checkpoint:run_bg_expired_resume_replay",
            turnId: "run_bg_expired_resume_replay",
            sessionId: "session_bg_expired_resume_replay",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_expired_resume_replay_001",
      runId: "run_bg_expired_resume_replay",
      taskId: "task_bg_expired_resume_replay",
      triggerKind: "operator_resume",
      lane: "background",
      now: "2026-04-27T00:00:00.040Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_crashed',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'approval_resume',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          pending_approval_ref = NULL,
          pending_control_ref = NULL,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:30.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(staleRunningApprovalPayload),
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "run_bg_expired_resume_replay"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_crashed',
          lease_owner = 'worker_crashed',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2026-04-27T00:00:30.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableResumePayload),
      "2026-04-27T00:00:01.000Z",
      "slice_bg_expired_resume_replay_001"
    );
    taskDb.close();

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_bg_expired_resume_replay" })).resolves.toBeNull();

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_expired_resume_replay",
      workspaceId: "workspace_local",
      turnId: "run_bg_expired_resume_replay",
      input: "continue"
    })).resolves.toMatchObject({
      status: "completed",
      turnId: "run_bg_expired_resume_replay",
      messages: [
        expect.objectContaining({
          content: "recovered detached resume replay completed"
        })
      ]
    });

    await expect(runStore.loadRunById("run_bg_expired_resume_replay")).resolves.toMatchObject({
      status: "completed",
      continuationKind: undefined,
      pendingApprovalRef: undefined,
      pendingControlRef: undefined
    });
    await expect(sliceStore.listSlicesByRun("run_bg_expired_resume_replay")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "lease_expired",
        triggerKind: "operator_resume"
      },
      {
        sliceNo: 2,
        status: "completed",
        triggerKind: "recovery_retry"
      }
    ]);
  });

  it("acknowledges detached approval replay when the recovered head is already running as recovery_retry", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_running_recovery_retry_approval_ack",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_running_recovery_retry_approval_ack",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_recovery_retry_approval_ack",
      actorId: "actor_cli",
      title: "Running recovery retry approval ack",
      description: "acknowledge accepted detached approval when recovery_retry is already running",
      sourceTurnId: "turn_bg_running_recovery_retry_approval_ack_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_running_recovery_retry_approval_ack",
      taskId: "task_bg_running_recovery_retry_approval_ack",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_recovery_retry_approval_ack",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-running-recovery-retry-approval-ack",
      turnRequest: {
        turnId: "turn_bg_running_recovery_retry_approval_ack_origin",
        sessionId: "session_bg_running_recovery_retry_approval_ack",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "acknowledge running recovered approval",
        requestedMode: "act",
        originTurnId: "turn_bg_running_recovery_retry_approval_ack_origin"
      },
      sourceTurnId: "turn_bg_running_recovery_retry_approval_ack_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableApprovalRecoveryPayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "approve",
        sessionId: "session_bg_running_recovery_retry_approval_ack",
        turnId: "run_bg_running_recovery_retry_approval_ack",
        frameRef: "frame:run_bg_running_recovery_retry_approval_ack",
        decisionId: "tool_call_bg_running_recovery_retry_approval_ack_001",
        scope: "once",
        approverId: "operator_001"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_running_recovery_retry_approval_ack",
        sessionId: "session_bg_running_recovery_retry_approval_ack",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "act",
        checkpointRef: "checkpoint:run_bg_running_recovery_retry_approval_ack",
        frameRef: "frame:run_bg_running_recovery_retry_approval_ack",
        pendingApprovalRef: "tool_call_bg_running_recovery_retry_approval_ack_001",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_running_recovery_retry_approval_ack",
          frameRef: "frame:run_bg_running_recovery_retry_approval_ack",
          checkpointRef: "checkpoint:run_bg_running_recovery_retry_approval_ack",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_running_recovery_retry_approval_ack",
            checkpointRef: "checkpoint:run_bg_running_recovery_retry_approval_ack",
            turnId: "run_bg_running_recovery_retry_approval_ack",
            sessionId: "session_bg_running_recovery_retry_approval_ack",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "approval_resume",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["approve", "deny", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_running_recovery_retry_approval_ack_001",
      runId: "run_bg_running_recovery_retry_approval_ack",
      taskId: "task_bg_running_recovery_retry_approval_ack",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-27T00:00:00.040Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_active',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableApprovalRecoveryPayload),
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "run_bg_running_recovery_retry_approval_ack"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_active',
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableApprovalRecoveryPayload),
      "2026-04-27T00:00:01.000Z",
      "slice_bg_running_recovery_retry_approval_ack_001"
    );
    taskDb.close();

    await expect(app.shell.resolveApproval({
      sessionId: "session_bg_running_recovery_retry_approval_ack",
      turnId: "run_bg_running_recovery_retry_approval_ack",
      decisionId: "tool_call_bg_running_recovery_retry_approval_ack_001",
      approved: true,
      approverId: "operator_001"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_bg_running_recovery_retry_approval_ack",
      warnings: [
        expect.stringContaining("Approval already accepted")
      ]
    });
    await expect(sliceStore.listSlicesByRun("run_bg_running_recovery_retry_approval_ack")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "running",
        triggerKind: "recovery_retry"
      }
    ]);
  });

  it("acknowledges detached resume replay when the recovered head is already running as recovery_retry", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });

    await sessionStore.loadOrCreate({
      sessionId: "session_bg_running_recovery_retry_resume_ack",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await runStore.createBackgroundTask({
      taskId: "task_bg_running_recovery_retry_resume_ack",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_recovery_retry_resume_ack",
      actorId: "actor_cli",
      title: "Running recovery retry resume ack",
      description: "acknowledge accepted detached resume when recovery_retry is already running",
      sourceTurnId: "turn_bg_running_recovery_retry_resume_ack_origin",
      now: "2026-04-27T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_bg_running_recovery_retry_resume_ack",
      taskId: "task_bg_running_recovery_retry_resume_ack",
      workspaceId: "workspace_local",
      sessionId: "session_bg_running_recovery_retry_resume_ack",
      actorId: "actor_cli",
      idempotencyKey: "seed:bg-running-recovery-retry-resume-ack",
      turnRequest: {
        turnId: "turn_bg_running_recovery_retry_resume_ack_origin",
        sessionId: "session_bg_running_recovery_retry_resume_ack",
        workspaceId: "workspace_local",
        actorId: "actor_cli",
        source: "cli",
        input: "acknowledge running recovered resume",
        requestedMode: "chat",
        originTurnId: "turn_bg_running_recovery_retry_resume_ack_origin"
      },
      sourceTurnId: "turn_bg_running_recovery_retry_resume_ack_origin",
      maxAttempts: 1,
      now: "2026-04-27T00:00:00.010Z"
    });

    const durableResumePayload = {
      control: {
        schemaVersion: 1,
        contractVersion: "ws0.execution-control.v1",
        action: "resume",
        sessionId: "session_bg_running_recovery_retry_resume_ack",
        workspaceId: "workspace_local",
        turnId: "run_bg_running_recovery_retry_resume_ack",
        frameRef: "frame:run_bg_running_recovery_retry_resume_ack",
        input: "continue"
      },
      recovery: {
        schemaVersion: 1,
        contractVersion: "im.task2.slice-recovery.v1",
        turnId: "run_bg_running_recovery_retry_resume_ack",
        sessionId: "session_bg_running_recovery_retry_resume_ack",
        workspaceId: "workspace_local",
        source: "cli",
        mode: "chat",
        checkpointRef: "checkpoint:run_bg_running_recovery_retry_resume_ack",
        frameRef: "frame:run_bg_running_recovery_retry_resume_ack",
        pendingExecution: {
          schemaVersion: 1,
          contractVersion: "ws0.pending-execution.v1",
          pendingExecutionId: "pending:run_bg_running_recovery_retry_resume_ack",
          frameRef: "frame:run_bg_running_recovery_retry_resume_ack",
          checkpointRef: "checkpoint:run_bg_running_recovery_retry_resume_ack",
          status: "ready",
          frame: {
            schemaVersion: 1,
            contractVersion: "ws0.execution-frame.v1",
            frameRef: "frame:run_bg_running_recovery_retry_resume_ack",
            checkpointRef: "checkpoint:run_bg_running_recovery_retry_resume_ack",
            turnId: "run_bg_running_recovery_retry_resume_ack",
            sessionId: "session_bg_running_recovery_retry_resume_ack",
            workspaceId: "workspace_local",
            phase: "awaiting_operator",
            step: "confirmation",
            pendingToolCalls: [],
            pendingPermissionDecisions: [],
            loopCount: 0,
            toolCallCount: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              estimatedCost: 0
            },
            continuation: {
              continuationKind: "resume",
              allowedActions: ["resume", "cancel"],
              metadata: {
                actorId: "actor_cli"
              }
            }
          }
        }
      }
    };

    await sliceStore.enqueueNextSlice({
      sliceId: "slice_bg_running_recovery_retry_resume_ack_001",
      runId: "run_bg_running_recovery_retry_resume_ack",
      taskId: "task_bg_running_recovery_retry_resume_ack",
      triggerKind: "recovery_retry",
      lane: "background",
      now: "2026-04-27T00:00:00.040Z"
    });

    const taskDb = new Database(paths.tasksDbPath);
    taskDb.prepare(`
      UPDATE task_runs
      SET status = 'running',
          worker_id = 'worker_active',
          claimed_at = ?,
          started_at = ?,
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          run_started_at = ?,
          continuation_kind = 'recovery_retry',
          continuation_payload_json = ?,
          continuation_updated_at = ?,
          updated_at = ?
      WHERE run_id = ?
    `).run(
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableResumePayload),
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "run_bg_running_recovery_retry_resume_ack"
    );
    taskDb.prepare(`
      UPDATE runtime_slices
      SET status = 'running',
          worker_id = 'worker_active',
          lease_owner = 'worker_active',
          lease_expires_at = ?,
          claimed_at = ?,
          started_at = ?,
          continuation_payload_json = ?,
          updated_at = ?
      WHERE slice_id = ?
    `).run(
      "2099-01-01T00:01:01.000Z",
      "2026-04-27T00:00:01.000Z",
      "2026-04-27T00:00:01.000Z",
      JSON.stringify(durableResumePayload),
      "2026-04-27T00:00:01.000Z",
      "slice_bg_running_recovery_retry_resume_ack_001"
    );
    taskDb.close();

    await expect(app.shell.resumeTurn({
      sessionId: "session_bg_running_recovery_retry_resume_ack",
      workspaceId: "workspace_local",
      turnId: "run_bg_running_recovery_retry_resume_ack",
      input: "continue"
    })).resolves.toMatchObject({
      status: "interrupted",
      turnId: "run_bg_running_recovery_retry_resume_ack",
      warnings: [
        expect.stringContaining("Resume already accepted")
      ]
    });
    await expect(sliceStore.listSlicesByRun("run_bg_running_recovery_retry_resume_ack")).resolves.toMatchObject([
      {
        sliceNo: 1,
        status: "running",
        triggerKind: "recovery_retry"
      }
    ]);
  });

  it("keeps the existing no-recoverable behavior for approval resolution", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    await expect(app.shell.resolveApproval({
      sessionId: "session_001",
      decisionId: "decision_missing",
      approved: true
    })).rejects.toThrow("No recoverable turn is open for session session_001.");
  });

  it("passes through raw provider incomplete errors in app shell failed fallback by default", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: {
        async *stream() {
          throw new Error("Provider stream ended without a completed event for invocation invoke_raw_001");
        }
      }
    });

    const result = await app.shell.executeTurn({
      turnId: "turn_app_provider_incomplete_raw",
      sessionId: "session_app_provider_incomplete_raw",
      workspaceId: "workspace_local",
      source: "cli",
      actorId: "actor_user",
      input: "hello",
      attachments: [],
      requestedMode: "chat"
    });

    expect(result.status).toBe("failed");
    expect(result.warnings[0]).toContain("Provider stream ended without a completed event for invocation invoke_raw_001");
    expect(result.warnings[0]).not.toContain("模型响应流提前结束，本轮已安全停止，请重试。");
  });

  it("uses the default HTTP transport when providerTransport is omitted", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "cheap-default" }]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      return new Response(
        JSON.stringify([
          {
            choices: [
              {
                delta: {
                  content: "default transport reply"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18
            }
          }
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createEndecApp({ dataDir });
    const result = await app.shell.executeTurn(createTurnRequest({ turnId: "turn_http" }));

    expect(result).toMatchObject({
      status: "completed",
      messages: [expect.objectContaining({ content: "default transport reply" })]
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.at(0)?.at(0)).toBe("http://127.0.0.1:11434/v1/models");
    expect(fetchMock.mock.calls.at(1)?.at(0)).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("fails clearly when no fetch implementation is available for the default transport", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    vi.stubGlobal("fetch", undefined);

    expect(() => createEndecApp({ dataDir })).toThrow("HTTP provider transport requires a fetch implementation");
  });

  it("sanitizes raw provider incomplete errors in app shell failed fallback when configured", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_ERROR_EXPOSURE_MODE: "sanitized"
      },
      providerTransport: {
        async *stream() {
          throw new Error("Provider stream ended without a completed event for invocation invoke_raw_001");
        }
      }
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_app_provider_incomplete_raw",
      sessionId: "session_app_provider_incomplete_raw"
    }));

    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual(["模型响应流提前结束，本轮已安全停止，请重试。"]);
    expect(JSON.stringify(result)).not.toContain("Provider stream ended without a completed event");
  });

  it("uses a neutral passthrough fallback for unsafe provider transport errors", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: {
        async *stream() {
          throw new Error("POST https://internal-provider.local/v1/chat failed\n    at ProviderClient.invoke (/srv/endec/provider.ts:42:11)");
        }
      }
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_app_unknown_provider_raw",
      sessionId: "session_app_unknown_provider_raw"
    }));

    expect(result.status).toBe("failed");
    expect(result.warnings).toEqual(["请求失败，请重试。"]);
    expect(JSON.stringify(result)).not.toContain("internal-provider.local");
    expect(JSON.stringify(result)).not.toContain("ProviderClient.invoke");
  });

  it("preserves same-turn tool budget across recoverable tool_turn_limit resume", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    await sessionStore.loadOrCreate({
      sessionId: "session_resume_tool_budget",
      workspaceId: "workspace_local",
      source: "cli"
    });
    await sessionStore.markInflight({
      turnId: "turn_resume_tool_budget",
      sessionId: "session_resume_tool_budget",
      workspaceId: "workspace_local",
      state: "awaiting_user_decision",
      waitingReason: "user_decision",
      resumePolicy: "resume",
      loopCount: 1,
      toolCallCount: 2,
      checkpointRef: "checkpoint:turn_resume_tool_budget",
      frameRef: "frame:turn_resume_tool_budget",
      contractVersion: "ws0.pending-execution.v1",
      pendingExecution: {
        schemaVersion: 1,
        contractVersion: "ws0.pending-execution.v1",
        pendingExecutionId: "pending:turn_resume_tool_budget",
        frameRef: "frame:turn_resume_tool_budget",
        checkpointRef: "checkpoint:turn_resume_tool_budget",
        status: "ready",
        frame: {
          schemaVersion: 1,
          contractVersion: "ws0.execution-frame.v1",
          frameRef: "frame:turn_resume_tool_budget",
          checkpointRef: "checkpoint:turn_resume_tool_budget",
          turnId: "turn_resume_tool_budget",
          sessionId: "session_resume_tool_budget",
          workspaceId: "workspace_local",
          phase: "awaiting_operator",
          step: "tool_turn_limit",
          pendingToolCalls: [
            {
              toolCallId: "tool_call_003",
              toolName: "read",
              arguments: { path: "packages/app/package.json" }
            }
          ],
          pendingPermissionDecisions: [],
          loopCount: 1,
          toolCallCount: 2,
          usage: {
            inputTokens: 42,
            outputTokens: 19,
            totalTokens: 61,
            estimatedCost: 0
          },
          continuation: {
            continuationKind: "resume",
            allowedActions: ["resume", "cancel"],
            metadata: {
              stopReason: "tool_turn_limit",
              requestedToolCallsInBatch: 1,
              toolCallCountBeforePausedBatch: 2,
              executedToolCalls: 0,
              actorId: "actor_cli"
            }
          }
        }
      }
    });

    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      toolLoop: {
        maxToolCallsPerBatchByMode: { chat: 2 },
        maxToolCallsPerTurnByMode: { chat: 2 }
      },
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "This provider response should never be consumed on resume."
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 18,
              completion_tokens: 6,
              total_tokens: 24
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_resume_tool_budget" })).resolves.toMatchObject({
      turnId: "turn_resume_tool_budget",
      hasPendingExecution: true,
      allowedActions: ["resume", "cancel"],
      pendingExecutionId: "pending:turn_resume_tool_budget"
    });

    const resumed = await app.shell.resumeTurn({
      turnId: "turn_resume_tool_budget",
      sessionId: "session_resume_tool_budget",
      workspaceId: "workspace_local",
      input: "continue"
    });

    expect(resumed).toMatchObject({
      status: "interrupted",
      turnId: "turn_resume_tool_budget",
      warnings: [
        "I hit this turn’s tool-step safety limit and paused safely before the next step. No tools from the paused step were run. Reply \"continue\" to resume."
      ]
    });
    expect(resumed.toolEvents).toEqual([]);
    expect(capturedRequests).toHaveLength(0);
    await expect(app.operator.getRecoverySnapshot({ sessionId: "session_resume_tool_budget" })).resolves.toMatchObject({
      turnId: "turn_resume_tool_budget",
      hasPendingExecution: true,
      allowedActions: ["resume", "cancel"],
      pendingExecutionId: "pending:turn_resume_tool_budget"
    });
  });

  it("EndecAppOptions.toolLoop changes effective runtime limits without raising hard caps", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      toolLoop: {
        maxToolCallsPerBatchByMode: { chat: 99 },
        maxToolCallsPerTurnByMode: { chat: 99 },
        globalMaxToolCallsPerBatchHardCap: 99,
        maxToolBatchRepairAttempts: 99,
        maxToolBatchRepairAttemptsHardCap: 99
      },
      providerTransport: createChatCompletionTransport(
        [
          [
            {
              choices: [{
                delta: {
                  tool_calls: Array.from({ length: 9 }, (_, index) => ({
                    index,
                    id: `tool_call_${index}`,
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify({ path: `file_${index}` }) }
                  }))
                },
                finish_reason: "tool_calls"
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            }
          ],
          [
            {
              choices: [{ finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            }
          ]
        ],
        (request) => capturedRequests.push(request)
      )
    });

    const result = await app.shell.executeTurn(createTurnRequest({
      turnId: "turn_tool_loop_options",
      sessionId: "session_tool_loop_options",
      requestedMode: "chat",
      input: "try nine reads"
    }));

    expect(capturedRequests).toHaveLength(2);
    expect(JSON.stringify(capturedRequests[1]?.body ?? {})).toContain("at most 8 tool calls");
    expect(result.status).toBe("completed");
    expect(result.warnings).toEqual([]);
    expect(result.toolEvents).toEqual([]);
  });

  it("commits pairing-success owner notices as assistant-visible history and uses them as the next time anchor", async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));

      const dataDir = await createTempDataDir();
      tempDirs.add(dataDir);
      const capturedRequests: ProviderTransportRequest[] = [];
      const app = createEndecApp({
        dataDir,
        env: {
          TZ: "UTC"
        },
        providerTransport: createChatCompletionTransport([
          [
            {
              choices: [
                {
                  delta: {
                    content: "ordinary chat reply"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 24,
                completion_tokens: 12,
                total_tokens: 36
              }
            }
          ]
        ], (request) => capturedRequests.push(request))
      });

      const ownerConversationRef = {
        accountId: "acct_bot",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm" as const
      };

      const pairingDecision = await app.im.evaluateInboundAdmission({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "owner_user",
        conversationRef: ownerConversationRef,
        conversationScope: "direct",
        activationHint: {
          pairRequested: true,
          explicitActivation: true,
          mentionMatched: true
        }
      });
      expect(pairingDecision).toMatchObject({ outcome: "reply_direct" });

      vi.setSystemTime(new Date("2026-04-29T00:05:00.000Z"));

      const claims = await app.operator.listPairClaims({
        source: "telegram",
        accountId: "acct_bot",
        includeInactive: true
      });
      const approved = await app.operator.approvePairClaim({
        source: "telegram",
        accountId: "acct_bot",
        claimId: claims.claims[0]?.claimId,
        operatorActorId: "operator_alpha"
      });
      expect(approved.outcome).toBe("approved");

      const sessions = await app.operator.listSessions({
        workspaceId: "workspace_local",
        limit: 10
      });
      const sessionId = sessions.items[0]?.sessionId;
      expect(sessionId).toBeDefined();
      const actorId = await app.im.resolveActorId({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "owner_user",
        conversationRef: ownerConversationRef
      });

      vi.setSystemTime(new Date("2026-04-29T00:18:00.000Z"));

      const result = await app.shell.executeTurn({
        turnId: "turn_after_pairing_success_notice",
        sessionId,
        workspaceId: "workspace_local",
        source: "telegram",
        actorId,
        input: "hello after pairing",
        attachments: [],
        requestedMode: "chat",
        conversationRef: ownerConversationRef,
        channelContext: {
          messageId: "msg_after_pairing_success_notice"
        }
      });

      expect(result.status).toBe("completed");
      expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain("13 minutes ago");

      const history = await app.operator.browseSessionHistory({
        sessionId,
        limit: 10
      });
      expect(history.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: expect.stringMatching(/^authority_notice_/),
          eventKind: "assistant_message",
          summary: expect.stringContaining("Pairing complete. Normal chat is ready now.")
        })
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits trusted-conversation-granted owner notices as assistant-visible history and uses them as the next time anchor", async () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));

      const dataDir = await createTempDataDir();
      tempDirs.add(dataDir);
      const capturedRequests: ProviderTransportRequest[] = [];
      const app = createEndecApp({
        dataDir,
        env: {
          TZ: "UTC"
        },
        providerTransport: createChatCompletionTransport([
          [
            {
              choices: [
                {
                  delta: {
                    content: "ordinary chat reply"
                  }
                }
              ]
            },
            {
              choices: [
                {
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 24,
                completion_tokens: 12,
                total_tokens: 36
              }
            }
          ]
        ], (request) => capturedRequests.push(request))
      });

      const ownerConversationRef = {
        accountId: "acct_bot",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm" as const
      };
      const trustedConversationRef = {
        accountId: "acct_bot",
        conversationId: "group:chat_100:thread:thread_1",
        peerId: "chat_100",
        peerKind: "group" as const,
        parentConversationId: "group:chat_100",
        baseConversationId: "group:chat_100",
        threadId: "thread_1"
      };

      const pairingDecision = await app.im.evaluateInboundAdmission({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "owner_user",
        conversationRef: ownerConversationRef,
        conversationScope: "direct",
        activationHint: {
          pairRequested: true,
          explicitActivation: true,
          mentionMatched: true
        }
      });
      expect(pairingDecision).toMatchObject({ outcome: "reply_direct" });

      vi.setSystemTime(new Date("2026-04-29T00:01:00.000Z"));

      const claims = await app.operator.listPairClaims({
        source: "telegram",
        accountId: "acct_bot",
        includeInactive: true
      });
      const approved = await app.operator.approvePairClaim({
        source: "telegram",
        accountId: "acct_bot",
        claimId: claims.claims[0]?.claimId,
        operatorActorId: "operator_alpha"
      });
      expect(approved.outcome).toBe("approved");

      const sessions = await app.operator.listSessions({
        workspaceId: "workspace_local",
        limit: 10
      });
      const sessionId = sessions.items[0]?.sessionId;
      expect(sessionId).toBeDefined();
      const actorId = await app.im.resolveActorId({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "owner_user",
        conversationRef: ownerConversationRef
      });

      const trustGrantAt = "2026-04-29T00:10:00.000Z";
      await app.im.applyConversationLifecycleEvent({
        source: "telegram",
        accountId: "acct_bot",
        conversationRef: trustedConversationRef,
        conversationScope: "shared",
        eventKind: "bot_added",
        subjectRef: "owner_user",
        observedAt: trustGrantAt,
        metadata: {
          workspaceId: "workspace_local"
        }
      });

      const ownerSessionIds = new Set(
        (await app.operator.listSessions({
          workspaceId: "workspace_local",
          limit: 10
        })).items.map((item) => item.sessionId)
      );
      const historyWithNotice = await Promise.all(
        [...ownerSessionIds].map(async (candidateSessionId) => ({
          sessionId: candidateSessionId,
          history: await app.operator.browseSessionHistory({
            sessionId: candidateSessionId,
            limit: 12
          })
        }))
      );
      const ownerNoticeSession = historyWithNotice.find(({ history }) =>
        history.items.some((item) => item.summary.includes("Trusted conversation granted for group:chat_100."))
      );
      expect(ownerNoticeSession?.sessionId).toBeDefined();
      expect(ownerNoticeSession?.history.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: expect.stringMatching(/^authority_notice_/),
          eventKind: "assistant_message",
          summary: expect.stringContaining("Trusted conversation granted for group:chat_100."),
          createdAt: trustGrantAt
        })
      ]));

      const ownerSessionId = ownerNoticeSession?.sessionId ?? sessionId;

      vi.setSystemTime(new Date("2026-04-29T00:18:00.000Z"));

      const result = await app.shell.executeTurn({
        turnId: "turn_after_trust_notice",
        sessionId: ownerSessionId,
        workspaceId: "workspace_local",
        source: "telegram",
        actorId,
        input: "hello after trust grant",
        attachments: [],
        requestedMode: "chat",
        conversationRef: ownerConversationRef,
        channelContext: {
          messageId: "msg_after_trust_notice"
        }
      });

      expect(result.status).toBe("completed");
      expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain("8 minutes ago");

      const history = await app.operator.browseSessionHistory({
        sessionId: ownerSessionId,
        limit: 12
      });
      expect(history.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          turnId: expect.stringMatching(/^authority_notice_/),
          eventKind: "assistant_message",
          summary: expect.stringContaining("Trusted conversation granted for group:chat_100.")
        })
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits consumed owner-init replies through the app seam and uses them as the next time-context anchor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));

    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      env: {
        TZ: "UTC"
      },
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "ordinary chat reply"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 12,
              total_tokens: 36
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_42",
      peerId: "chat_42",
      peerKind: "dm" as const
    };

    const pairingDecision = await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
      conversationScope: "direct",
      activationHint: {
        pairRequested: true,
        explicitActivation: true,
        mentionMatched: true
      }
    });
    expect(pairingDecision).toMatchObject({ outcome: "reply_direct" });

    const claims = await app.operator.listPairClaims({
      source: "telegram",
      accountId: "acct_bot",
      includeInactive: true
    });
    const approved = await app.operator.approvePairClaim({
      source: "telegram",
      accountId: "acct_bot",
      claimId: claims.claims[0]?.claimId,
      operatorActorId: "operator_alpha"
    });
    expect(approved.outcome).toBe("approved");

    const sessionId = await app.im.resolveSessionId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: ownerConversationRef
    });
    const actorId = await app.im.resolveActorId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef
    });

    const preflight = await app.im.preflightOwnerInit?.({
      turnRequest: {
        turnId: "turn_owner_init_preflight",
        sessionId,
        workspaceId: "workspace_local",
        source: "telegram",
        actorId,
        input: "timezone is Beijing time",
        attachments: [],
        requestedMode: "chat",
        conversationRef: ownerConversationRef,
        channelContext: {
          messageId: "msg_owner_init_preflight"
        }
      },
      conversationScope: "direct"
    });

    expect(preflight).toMatchObject({
      outcome: "consumed",
      completionReason: "fields_captured",
      replyText: expect.stringContaining("Asia/Shanghai")
    });
    await expect(app.operator.inspectOwnerBinding({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toMatchObject({
      resolvedOwnerPreferences: {
        timezone: "Asia/Shanghai",
        timezoneSource: "owner_preference"
      },
      ownerInitState: {
        status: "completed",
        completionReason: "fields_captured"
      }
    });

    vi.setSystemTime(new Date("2026-04-29T00:18:00.000Z"));

    const result = await app.shell.executeTurn({
      turnId: "turn_after_owner_init",
      sessionId,
      workspaceId: "workspace_local",
      source: "telegram",
      actorId,
      input: "hello again",
      attachments: [],
      requestedMode: "chat",
      conversationRef: ownerConversationRef,
      channelContext: {
        messageId: "msg_after_owner_init"
      }
    });

    expect(result.status).toBe("completed");
    expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain("Asia/Shanghai");
    expect(JSON.stringify(capturedRequests[0]?.body ?? {})).toContain("earlier today, 18 minutes ago");

    const history = await app.operator.browseSessionHistory({
      sessionId,
      limit: 10
    });
    expect(history.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKind: "user_message", summary: "timezone is Beijing time" }),
      expect.objectContaining({ eventKind: "assistant_message", summary: expect.stringContaining("Asia/Shanghai") })
    ]));
  });

  it("keeps timezone resolution on stored owner preferences after init completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));

    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      env: {
        TZ: "UTC"
      },
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "ordinary chat reply"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 12,
              total_tokens: 36
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_42",
      peerId: "chat_42",
      peerKind: "dm" as const
    };

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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

    const sessionId = await app.im.resolveSessionId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: ownerConversationRef
    });
    const actorId = await app.im.resolveActorId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef
    });

    await app.im.preflightOwnerInit?.({
      turnRequest: {
        turnId: "turn_owner_init_preflight",
        sessionId,
        workspaceId: "workspace_local",
        source: "telegram",
        actorId,
        input: "timezone is Beijing time",
        attachments: [],
        requestedMode: "chat",
        conversationRef: ownerConversationRef,
        channelContext: {
          messageId: "msg_owner_init_preflight"
        }
      },
      conversationScope: "direct"
    });

    const inspection = await app.operator.inspectOwnerBinding({
      source: "telegram",
      accountId: "acct_bot"
    });
    expect(inspection.ownerInitState).toMatchObject({
      status: "completed",
      completionReason: "fields_captured"
    });
    expect(inspection.ownerPreferences).toMatchObject({
      timezone: "Asia/Shanghai"
    });

    vi.setSystemTime(new Date("2026-04-29T00:18:00.000Z"));

    await app.shell.executeTurn({
      turnId: "turn_after_owner_init",
      sessionId,
      workspaceId: "workspace_local",
      source: "telegram",
      actorId,
      input: "hello again",
      attachments: [],
      requestedMode: "chat",
      conversationRef: ownerConversationRef,
      channelContext: {
        messageId: "msg_after_owner_init"
      }
    });

    const requestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    expect(requestBody).toContain("Asia/Shanghai");
    expect(requestBody).not.toContain("timezone: UTC (server_default)");
  });

  it("treats completed owner-init without a stored timezone as server-default runtime truth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));

    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      env: {
        TZ: "UTC"
      },
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "ordinary chat reply"
                }
              }
            ]
          },
          {
            choices: [
              {
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 12,
              total_tokens: 36
            }
          }
        ]
      ], (request) => capturedRequests.push(request))
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_42",
      peerId: "chat_42",
      peerKind: "dm" as const
    };

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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

    const sessionId = await app.im.resolveSessionId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: ownerConversationRef
    });
    const actorId = await app.im.resolveActorId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef
    });

    await app.im.preflightOwnerInit?.({
      turnRequest: {
        turnId: "turn_owner_init_skip",
        sessionId,
        workspaceId: "workspace_local",
        source: "telegram",
        actorId,
        input: "skip this for now",
        attachments: [],
        requestedMode: "chat",
        conversationRef: ownerConversationRef,
        channelContext: {
          messageId: "msg_owner_init_skip"
        }
      },
      conversationScope: "direct"
    });

    await expect(app.operator.inspectOwnerBinding({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toMatchObject({
      ownerPreferences: undefined,
      resolvedOwnerPreferences: {
        timezone: "UTC",
        timezoneSource: "server_default"
      },
      ownerInitState: {
        status: "completed",
        completionReason: "explicit_skip"
      }
    });

    vi.setSystemTime(new Date("2026-04-29T00:18:00.000Z"));

    await app.shell.executeTurn({
      turnId: "turn_after_owner_init_skip",
      sessionId,
      workspaceId: "workspace_local",
      source: "telegram",
      actorId,
      input: "hello again",
      attachments: [],
      requestedMode: "chat",
      conversationRef: ownerConversationRef,
      channelContext: {
        messageId: "msg_after_owner_init_skip"
      }
    });

    const requestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    expect(requestBody).toContain("timezone: UTC (server_default)");
    expect(requestBody).not.toContain("timezone: Asia/Shanghai (owner_preference)");
  });

  it("resolves owner-DM recall targets through recorded conversation activity", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([])
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_42",
      peerId: "chat_42",
      peerKind: "dm" as const
    };
    const sharedConversationRef = {
      accountId: "acct_bot",
      conversationId: "supergroup:-100123:topic:77",
      peerId: "-100123",
      peerKind: "group" as const,
      parentConversationId: "supergroup:-100123",
      baseConversationId: "supergroup:-100123",
      topicId: "77"
    };

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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
      conversationRef: ownerConversationRef
    });

    await app.im.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: sharedConversationRef,
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "owner_user",
      actorId: ownerActorId,
      observedAt: "2026-05-01T09:00:00.000Z",
      metadata: {
        workspaceId: "workspace_local"
      }
    });

    await app.im.recordConversationActivity({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: sharedConversationRef,
      sessionId: "session_group_a",
      conversationLabel: "alpha",
      observedAt: "2026-05-01T09:00:00.000Z"
    });

    const result = await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_recall_001",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/recall --chat alpha what changed",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      },
      commandIntent: {
        name: "recall",
        args: ["what", "changed"],
        options: { chat: "alpha" },
        rawText: "/recall --chat alpha what changed",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(result).toMatchObject({
      kind: "dispatch_turn",
      turnRequest: {
        input: "what changed",
        imContext: {
          boundary: {
            disclosureMode: "owner_targeted",
            targetConversationKeys: ["supergroup:-100123:topic:77"],
            borrowedConversationKeys: ["supergroup:-100123:topic:77"],
            transientBorrowed: true
          }
        }
      }
    });
  });

  it("keeps one Telegram execution model across chat and review turns without restarting the app", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const providerRegistrations: ProviderRegistration[] = [
      {
        providerId: "openai",
        displayName: "OpenAI",
        baseUrl: "http://openai.test/v1",
        auth: {
          type: "none"
        },
        models: [
          {
            modelId: "gpt5.4",
            displayName: "GPT 5.4",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false,
              maxContextTokens: 128000,
              maxOutputTokens: 16384
            }
          },
          {
            modelId: "gpt5.5",
            displayName: "GPT 5.5",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false,
              maxContextTokens: 128000,
              maxOutputTokens: 16384
            }
          }
        ]
      },
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        baseUrl: "http://anthropic.test/v1",
        auth: {
          type: "none"
        },
        models: [
          {
            modelId: "claude-sonnet-4.5",
            displayName: "Claude Sonnet 4.5",
            protocolFamily: "chat_completions",
            capabilities: {
              supportsTools: true,
              supportsStreaming: true,
              supportsImages: false,
              maxContextTokens: 200000,
              maxOutputTokens: 64000
            }
          }
        ]
      }
    ];
    const app = createEndecApp({
      dataDir,
      providerRegistrations,
      env: {
        ENDEC_PROVIDER_CHEAP: "openai",
        ENDEC_PROVIDER_CHEAP_MODEL: "gpt5.4",
        ENDEC_PROVIDER_STRONG: "anthropic",
        ENDEC_PROVIDER_STRONG_MODEL: "claude-sonnet-4.5"
      },
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("chat-tier reply after selection"),
        createCompletedTransportResponse("review-tier reply after selection")
      ], (request) => capturedRequests.push(request))
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "dm:chat_42",
      peerId: "chat_42",
      peerKind: "dm" as const
    };

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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

    const paths = ensureEndecDataLayout(dataDir);
    const accessStore = createAccessStore({ filename: paths.accessDbPath });
    const ownerActorId = await app.im.resolveActorId({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef
    });

    const picker = await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_models_001",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/models",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      },
      commandIntent: {
        name: "models" as never,
        args: [],
        options: {},
        rawText: "/models",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(picker).toMatchObject({
      kind: "reply_model_picker",
      options: [
        expect.objectContaining({ providerId: "anthropic", modelId: "claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5" })
      ]
    });

    await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_models_002",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/models select anthropic/claude-sonnet-4.5",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      },
      commandIntent: {
        name: "models" as never,
        subcommand: "select",
        args: ["anthropic/claude-sonnet-4.5"],
        options: {},
        rawText: "/models select anthropic/claude-sonnet-4.5",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    await expect(accessStore.getProviderControl({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toMatchObject({
      providerId: "anthropic",
      modelId: "claude-sonnet-4.5"
    });
    await expect(accessStore.getModelOverrides({
      source: "telegram",
      accountId: "acct_bot"
    })).resolves.toEqual([]);

    await app.shell.executeTurn({
      turnId: "turn_after_model_selection_chat",
      sessionId: "session_owner_dm",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: ownerActorId,
      input: "hello after selection",
      attachments: [],
      requestedMode: "chat",
      conversationRef: ownerConversationRef
    });

    await app.shell.executeTurn({
      turnId: "turn_after_model_selection_review",
      sessionId: "session_owner_dm",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: ownerActorId,
      input: "review after selection",
      attachments: [],
      requestedMode: "review",
      conversationRef: ownerConversationRef
    });

    const finalRequestBodies = capturedRequests.slice(-2).map((request) => JSON.stringify(request.body ?? {}));
    const finalModels = finalRequestBodies.map((body) => body.match(/"model":"([^"]+)"/)?.[1]);

    expect(finalModels[0]).toBe("claude-sonnet-4.5");
    expect(finalModels[1]).toBe("claude-sonnet-4.5");
  });

  it("treats auto-seeded models.json as fallback while preserving explicit owner-selected current models across restarts", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const accessStore = createAccessStore({ filename: paths.accessDbPath });
    const inertProviderTransport: ProviderTransport = {
      async *stream() {
        throw new Error("provider should not execute for /model command tests");
      }
    };
    const conversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };

    const firstApp = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt5.4"
      },
      providerTransport: inertProviderTransport
    });
    const firstModelReply = await firstApp.im.executeCommand({
      turnRequest: {
        turnId: "turn_model_seed",
        sessionId: "session_model_seed",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: "actor_owner",
        input: "/model",
        attachments: [],
        conversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      },
      commandIntent: {
        name: "model" as never,
        args: [],
        options: {},
        rawText: "/model",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(firstModelReply).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("model: openai/gpt-5.4")
    });

    const restartedApp = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "anthropic",
        ENDEC_PROVIDER_MODEL: "claude-sonnet-4-5"
      },
      providerTransport: inertProviderTransport
    });
    const restartedModelReply = await restartedApp.im.executeCommand({
      turnRequest: {
        turnId: "turn_model_restart_env",
        sessionId: "session_model_restart_env",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: "actor_owner",
        input: "/model",
        attachments: [],
        conversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      },
      commandIntent: {
        name: "model" as never,
        args: [],
        options: {},
        rawText: "/model",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(restartedModelReply).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("model: anthropic/claude-sonnet-4-5")
    });

    await accessStore.upsertProviderControl({
      source: "telegram",
      accountId: "acct_bot",
      providerId: "openai",
      modelId: "gpt5.4",
      updatedByActorId: "actor_owner"
    });

    const restartedWithOwnerSelection = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.5"
      },
      providerTransport: inertProviderTransport
    });
    const ownerSelectedReply = await restartedWithOwnerSelection.im.executeCommand({
      turnRequest: {
        turnId: "turn_model_restart_owner",
        sessionId: "session_model_restart_owner",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: "actor_owner",
        input: "/model",
        attachments: [],
        conversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: {
            boundaryKey: "private:42",
            conversationScope: "direct",
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      },
      commandIntent: {
        name: "model" as never,
        args: [],
        options: {},
        rawText: "/model",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(ownerSelectedReply).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("model: openai/gpt-5.4")
    });
  });

  it("uses the env OpenAI proxy for telegram turns even when ownerSelected=false config still carries the builtin baseUrl", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    await ensureEndecConfig({
      paths,
      seed: {
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1"
        }
      }
    });

    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4",
        OPENAI_BASE_URL: "https://api.psydo.top/v1",
        OPENAI_API_KEY: "sk-env-openai-proxy-1234"
      },
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("proxy-backed reply")
      ], (request) => capturedRequests.push(request))
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_env_proxy_runtime_auth",
      source: "telegram",
      actorId: "actor_owner",
      input: "reply via the proxy",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }))).resolves.toMatchObject({
      status: "completed",
      messages: [
        {
          role: "assistant",
          content: "proxy-backed reply"
        }
      ]
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      baseUrl: "https://api.psydo.top/v1",
      providerId: "openai",
      modelId: "gpt-5.4"
    });
  });

  it("keeps an explicit owner-selected provider baseUrl authoritative over the env proxy", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.endecConfigPath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-05-04T08:00:00.000Z",
      ownerSelected: true,
      provider: {
        providerId: "openai",
        modelId: "gpt-5.4",
        baseUrl: "https://owner.override.example/v1"
      },
      embeddings: {
        enabled: false,
        providerId: "openai",
        modelId: "gpt-5.4",
        baseUrl: "https://owner.override.example/v1",
        indexBackend: "sqlite_vec",
        allowedKinds: ["chat_summary", "typed_memory", "evidence", "memory_md", "user_memory_doc"],
        chunking: {
          maxDocumentChars: 12000,
          maxChunkChars: 2400,
          overlapChars: 200
        }
      }
    }, null, 2), "utf8");

    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4",
        OPENAI_BASE_URL: "https://api.psydo.top/v1",
        OPENAI_API_KEY: "sk-env-openai-proxy-1234"
      },
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("owner override reply")
      ], (request) => capturedRequests.push(request))
    });

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_owner_override_runtime_auth",
      source: "telegram",
      actorId: "actor_owner",
      input: "reply via the explicit owner override",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }))).resolves.toMatchObject({
      status: "completed",
      messages: [
        {
          role: "assistant",
          content: "owner override reply"
        }
      ]
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      baseUrl: "https://owner.override.example/v1",
      providerId: "openai",
      modelId: "gpt-5.4"
    });
  });

  it("keeps legacy telegram provider auth working after operator status seeds endec.json without account context", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const accessStore = createAccessStore({ filename: paths.accessDbPath });
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4"
      },
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("legacy auth reply")
      ], (request) => capturedRequests.push(request))
    });

    await accessStore.upsertProviderControl({
      source: "telegram",
      accountId: "acct_bot",
      providerId: "openai",
      modelId: "gpt-5.4",
      baseUrlOverride: "https://legacy.telegram-provider.example/v1",
      updatedByActorId: "actor_owner"
    });
    await accessStore.setProviderSecret({
      source: "telegram",
      accountId: "acct_bot",
      apiKey: "persisted-openai-secret-9999",
      updatedByActorId: "actor_owner"
    });

    const seededStatus = await app.operator.getStatus();
    expect(seededStatus.config.source).toBe("seeded_endec_json");

    await expect(app.shell.executeTurn(createTurnRequest({
      turnId: "turn_legacy_telegram_provider_auth",
      source: "telegram",
      actorId: "actor_owner",
      input: "use the legacy telegram provider auth",
      conversationRef: {
        accountId: "acct_bot",
        conversationId: "private:42",
        peerId: "42",
        peerKind: "dm"
      },
      imContext: {
        activationKind: "interactive_turn",
        boundary: {
          boundaryKey: "private:42",
          conversationScope: "direct",
          disclosureMode: "local_only",
          targetConversationKeys: [],
          borrowedConversationKeys: [],
          transientBorrowed: false
        }
      }
    }))).resolves.toMatchObject({
      status: "completed",
      messages: [
        {
          role: "assistant",
          content: "legacy auth reply"
        }
      ]
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      baseUrl: "https://legacy.telegram-provider.example/v1",
      providerId: "openai",
      modelId: "gpt-5.4"
    });
    expect(capturedRequests[0]?.headers.authorization ?? capturedRequests[0]?.headers.Authorization).toBe(
      "Bearer persisted-openai-secret-9999"
    );
  });

  it("keeps shared-chat retrieval local and excludes other groups plus owner-private history", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("group a seed reply"),
        createCompletedTransportResponse("group b seed reply"),
        createCompletedTransportResponse("owner seed reply"),
        createCompletedTransportResponse("group a follow-up reply")
      ], (request) => capturedRequests.push(request))
    });

    const groupARef = {
      accountId: "acct_bot",
      conversationId: "supergroup:-1001",
      peerId: "-1001",
      peerKind: "group" as const,
      baseConversationId: "supergroup:-1001"
    };
    const groupBRef = {
      accountId: "acct_bot",
      conversationId: "supergroup:-1002",
      peerId: "-1002",
      peerKind: "group" as const,
      baseConversationId: "supergroup:-1002"
    };
    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const createBoundary = (boundaryKey: string, conversationScope: "direct" | "shared") => ({
      boundaryKey,
      conversationScope,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    });

    await app.shell.executeTurn({
      turnId: "turn_group_a_seed",
      sessionId: "session_group_a",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_group_a",
      input: "group a release plan",
      attachments: [],
      requestedMode: "chat",
      conversationRef: groupARef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("supergroup:-1001", "shared")
      }
    });
    await app.shell.executeTurn({
      turnId: "turn_group_b_seed",
      sessionId: "session_group_b",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_group_b",
      input: "group b budget note",
      attachments: [],
      requestedMode: "chat",
      conversationRef: groupBRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("supergroup:-1002", "shared")
      }
    });
    await app.shell.executeTurn({
      turnId: "turn_owner_seed",
      sessionId: "session_owner_dm",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "private owner note",
      attachments: [],
      requestedMode: "chat",
      conversationRef: ownerConversationRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("private:42", "direct")
      }
    });
    await app.shell.executeTurn({
      turnId: "turn_group_a_follow_up",
      sessionId: "session_group_a",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_group_a",
      input: "what did we discuss?",
      attachments: [],
      requestedMode: "chat",
      conversationRef: groupARef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("supergroup:-1001", "shared")
      }
    });

    const requestBody = JSON.stringify(capturedRequests[3]?.body ?? {});
    expect(requestBody).toContain("privacy boundary: disclosureMode=local_only; conversationBoundary=supergroup:-1001.");
    expect(requestBody).toContain("group a release plan");
    expect(requestBody).not.toContain("group b budget note");
    expect(requestBody).not.toContain("private owner note");
  });

  it("uses explicit owner-DM cross-group recall without widening later shared retrieval defaults", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("group a recall seed"),
        createCompletedTransportResponse("group b recall seed"),
        createCompletedTransportResponse("owner cross-group recall reply")
      ], (request) => capturedRequests.push(request))
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const groupARef = {
      accountId: "acct_bot",
      conversationId: "supergroup:-1001",
      peerId: "-1001",
      peerKind: "group" as const,
      baseConversationId: "supergroup:-1001"
    };
    const groupBRef = {
      accountId: "acct_bot",
      conversationId: "supergroup:-1002",
      peerId: "-1002",
      peerKind: "group" as const,
      baseConversationId: "supergroup:-1002"
    };
    const createBoundary = (boundaryKey: string, conversationScope: "direct" | "shared") => ({
      boundaryKey,
      conversationScope,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    });

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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
      conversationRef: ownerConversationRef
    });

    await app.im.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: groupARef,
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "owner_user",
      actorId: ownerActorId,
      observedAt: "2026-05-01T09:00:00.000Z",
      metadata: {
        workspaceId: "workspace_local"
      }
    });
    await app.im.applyConversationLifecycleEvent({
      source: "telegram",
      accountId: "acct_bot",
      conversationRef: groupBRef,
      conversationScope: "shared",
      eventKind: "bot_added",
      subjectRef: "owner_user",
      actorId: ownerActorId,
      observedAt: "2026-05-01T09:01:00.000Z",
      metadata: {
        workspaceId: "workspace_local"
      }
    });

    await app.shell.executeTurn({
      turnId: "turn_group_a_recall_seed",
      sessionId: "session_group_a",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_group_a",
      input: "alpha release delta",
      attachments: [],
      requestedMode: "chat",
      conversationRef: groupARef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("supergroup:-1001", "shared")
      }
    });
    await app.shell.executeTurn({
      turnId: "turn_group_b_recall_seed",
      sessionId: "session_group_b",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_group_b",
      input: "beta budget note",
      attachments: [],
      requestedMode: "chat",
      conversationRef: groupBRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("supergroup:-1002", "shared")
      }
    });

    const commandResult = await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_recall_all_001",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/recall --all what changed",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: createBoundary("private:42", "direct")
        }
      },
      commandIntent: {
        name: "recall",
        args: ["what", "changed"],
        options: { all: true },
        rawText: "/recall --all what changed",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(commandResult).toMatchObject({
      kind: "dispatch_turn",
      turnRequest: {
        imContext: {
          boundary: {
            disclosureMode: "owner_cross_group",
            transientBorrowed: true
          }
        }
      }
    });

    if (commandResult.kind !== "dispatch_turn") {
      throw new Error(`expected cross-group recall dispatch, got ${commandResult.kind}`);
    }

    expect([...commandResult.turnRequest.imContext!.boundary.borrowedConversationKeys].sort()).toEqual([
      "supergroup:-1001",
      "supergroup:-1002"
    ]);

    await app.shell.executeTurn(commandResult.turnRequest);

    const requestBody = JSON.stringify(capturedRequests[2]?.body ?? {});
    expect(requestBody).toContain("privacy boundary: disclosureMode=owner_cross_group; conversationBoundary=private:42.");
    expect(requestBody).toContain("Borrowed sources:");
    expect(requestBody).toContain("supergroup:-1001");
    expect(requestBody).toContain("supergroup:-1002");
  });

  it("captures same-conversation IM ingress as durable steer control when a focus run is active", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
    const controlStore = createRunControlStore({ filename: paths.tasksDbPath });
    const app = createEndecApp({
      dataDir,
      providerTransport: {
        async *stream() {
          throw new Error("provider should not execute for steer capture");
        }
      }
    });

    const conversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const boundary = {
      boundaryKey: "private:42",
      conversationScope: "direct" as const,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    };

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_steer_focus",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });
    await runStore.createBackgroundTask({
      taskId: "task_steer_focus",
      workspaceId: "workspace_local",
      sessionId: "session_steer_focus",
      actorId: "actor_owner",
      conversationRef,
      title: "Investigate failures",
      description: "Focus run for steer capture",
      sourceTurnId: "turn_seed",
      now: "2026-05-02T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_steer_focus",
      taskId: "task_steer_focus",
      workspaceId: "workspace_local",
      sessionId: "session_steer_focus",
      actorId: "actor_owner",
      conversationRef,
      attentionMode: "foreground_attached",
      now: "2026-05-02T00:00:00.100Z"
    });
    await sliceStore.enqueueInitialSlice({
      sliceId: "slice_steer_focus_001",
      runId: "run_steer_focus",
      taskId: "task_steer_focus",
      lane: "foreground",
      now: "2026-05-02T00:00:00.200Z"
    });
    await sessionStore.setFocusRun({
      sessionId: "session_steer_focus",
      taskId: "task_steer_focus",
      runId: "run_steer_focus",
      now: "2026-05-02T00:00:00.300Z"
    });

    const result = await app.shell.executeTurn({
      turnId: "turn_steer_focus",
      sessionId: "session_steer_focus",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "focus on the flaky test first",
      attachments: [],
      requestedMode: "chat",
      conversationRef,
      channelContext: {
        messageId: "message_steer_focus"
      },
      imContext: {
        activationKind: "interactive_turn",
        boundary
      }
    });

    expect(result).toMatchObject({
      status: "interrupted",
      warnings: [expect.stringContaining("Guidance captured")]
    });
    await expect(controlStore.listPendingControls("run_steer_focus")).resolves.toEqual([
      expect.objectContaining({
        kind: "steer",
        payload: expect.objectContaining({
          text: "focus on the flaky test first",
          imControl: expect.objectContaining({
            messageMode: "steer",
            source: "telegram",
            messageId: "message_steer_focus",
            senderId: "actor_owner",
            text: "focus on the flaky test first"
          })
        })
      })
    ]);
    await expect(sliceStore.listSlicesByRun("run_steer_focus")).resolves.toHaveLength(1);
  });

  it("does not implicitly convert blocked focus runs into steer targets", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const controlStore = createRunControlStore({ filename: paths.tasksDbPath });
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("ordinary blocked-turn follow-up")
      ])
    });

    const conversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const boundary = {
      boundaryKey: "private:42",
      conversationScope: "direct" as const,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    };

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_blocked_focus",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });
    await runStore.createBackgroundTask({
      taskId: "task_blocked_focus",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_focus",
      actorId: "actor_owner",
      conversationRef,
      title: "Blocked task",
      description: "Focus run should stay on resume/approval flows",
      sourceTurnId: "turn_seed",
      now: "2026-05-02T00:00:00.000Z"
    });
    await runStore.createRun({
      runId: "run_blocked_focus",
      taskId: "task_blocked_focus",
      workspaceId: "workspace_local",
      sessionId: "session_blocked_focus",
      actorId: "actor_owner",
      conversationRef,
      attentionMode: "foreground_attached",
      turnRequest: {
        turnId: "turn_seed",
        sessionId: "session_blocked_focus",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: "actor_owner",
        input: "blocked task",
        attachments: [],
        requestedMode: "chat",
        conversationRef
      },
      sourceTurnId: "turn_seed",
      now: "2026-05-02T00:00:00.100Z"
    });
    await runStore.claimNextRun({
      workerId: "worker_blocked_focus",
      leaseDurationMs: 60_000,
      now: "2026-05-02T00:00:00.150Z"
    });
    await runStore.suspendRun({
      runId: "run_blocked_focus",
      pendingControlRef: "frame:blocked_focus",
      blockedBy: "user_decision",
      resultSummary: "waiting for operator",
      now: "2026-05-02T00:00:00.200Z"
    });
    await sessionStore.setFocusRun({
      sessionId: "session_blocked_focus",
      taskId: "task_blocked_focus",
      runId: "run_blocked_focus",
      now: "2026-05-02T00:00:00.300Z"
    });

    const result = await app.shell.executeTurn({
      turnId: "turn_blocked_focus_follow_up",
      sessionId: "session_blocked_focus",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "can you continue now?",
      attachments: [],
      requestedMode: "chat",
      conversationRef,
      channelContext: {
        messageId: "message_blocked_focus"
      },
      imContext: {
        activationKind: "interactive_turn",
        boundary
      }
    });

    expect(result).not.toMatchObject({
      warnings: [expect.stringContaining("Guidance captured")]
    });
    await expect(controlStore.listPendingControls("run_blocked_focus")).resolves.toEqual([]);
  });

  it("re-engages detached queued focus runs by promoting the queued slice back to foreground steering", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const paths = ensureEndecDataLayout(dataDir);
    const sessionStore = createSessionStore({ filename: paths.sessionsDbPath });
    const runStore = createTaskRunStore({ filename: paths.tasksDbPath });
    const sliceStore = createRuntimeSliceStore({ filename: paths.tasksDbPath });
    const controlStore = createRunControlStore({ filename: paths.tasksDbPath });
    const app = createEndecApp({
      dataDir,
      providerTransport: {
        async *stream() {
          throw new Error("provider should not execute for steer capture");
        }
      }
    });

    const conversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const boundary = {
      boundaryKey: "private:42",
      conversationScope: "direct" as const,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    };

    await sessionStore.loadOrCreate({
      turnId: "turn_seed",
      sessionId: "session_detached_focus",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "seed",
      attachments: []
    });
    await runStore.createBackgroundTask({
      taskId: "task_detached_focus",
      workspaceId: "workspace_local",
      sessionId: "session_detached_focus",
      actorId: "actor_owner",
      conversationRef,
      title: "Detached task",
      description: "Should return to foreground when steered",
      sourceTurnId: "turn_seed",
      now: "2026-05-02T00:00:00.000Z"
    });
    await runStore.enqueueRun({
      runId: "run_detached_focus",
      taskId: "task_detached_focus",
      workspaceId: "workspace_local",
      sessionId: "session_detached_focus",
      actorId: "actor_owner",
      conversationRef,
      idempotencyKey: "detached-focus",
      turnRequest: {
        turnId: "turn_seed",
        sessionId: "session_detached_focus",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: "actor_owner",
        input: "detached task",
        attachments: [],
        requestedMode: "chat",
        conversationRef
      },
      sourceTurnId: "turn_seed",
      seedInitialSlice: true,
      now: "2026-05-02T00:00:00.100Z"
    });
    await sessionStore.setFocusRun({
      sessionId: "session_detached_focus",
      taskId: "task_detached_focus",
      runId: "run_detached_focus",
      now: "2026-05-02T00:00:00.300Z"
    });

    const result = await app.shell.executeTurn({
      turnId: "turn_detached_focus_steer",
      sessionId: "session_detached_focus",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_owner",
      input: "come back to the foreground and summarize progress",
      attachments: [],
      requestedMode: "chat",
      conversationRef,
      channelContext: {
        messageId: "message_detached_focus"
      },
      imContext: {
        activationKind: "interactive_turn",
        boundary
      }
    });

    expect(result).toMatchObject({
      status: "interrupted",
      warnings: [expect.stringContaining("Guidance captured")]
    });
    await expect(runStore.loadRunById("run_detached_focus")).resolves.toMatchObject({
      attentionMode: "foreground_attached",
      status: "queued"
    });
    await expect(sliceStore.loadLatestSliceByRun("run_detached_focus")).resolves.toMatchObject({
      sliceId: "slice_run_detached_focus_001",
      lane: "foreground",
      status: "queued"
    });
    await expect(controlStore.listPendingControls("run_detached_focus")).resolves.toEqual([
      expect.objectContaining({
        kind: "steer",
        payload: expect.objectContaining({
          text: "come back to the foreground and summarize progress"
        })
      })
    ]);
  });

  it("layers shared-default and conversation-override personas into later shared turns", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createCompletedTransportResponse("persona layered reply")
      ], (request) => capturedRequests.push(request))
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const topicConversationRef = {
      accountId: "acct_bot",
      conversationId: "supergroup:-100123:topic:77",
      peerId: "-100123",
      peerKind: "group" as const,
      parentConversationId: "supergroup:-100123",
      baseConversationId: "supergroup:-100123",
      topicId: "77"
    };
    const createBoundary = (boundaryKey: string, conversationScope: "direct" | "shared") => ({
      boundaryKey,
      conversationScope,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    });

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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
      conversationRef: ownerConversationRef
    });

    await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_persona_shared_default_001",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/persona set --shared-default friendly but terse",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: createBoundary("private:42", "direct")
        }
      },
      commandIntent: {
        name: "persona",
        subcommand: "set",
        args: ["friendly", "but", "terse"],
        options: { "shared-default": true },
        rawText: "/persona set --shared-default friendly but terse",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_persona_override_001",
        sessionId: "session_group_topic_77",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/persona set speak like a pirate",
        attachments: [],
        conversationRef: topicConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: createBoundary("supergroup:-100123:topic:77", "shared")
        }
      },
      commandIntent: {
        name: "persona",
        subcommand: "set",
        args: ["speak", "like", "a", "pirate"],
        options: {},
        rawText: "/persona set speak like a pirate",
        helpRequested: false
      },
      conversationScope: "shared"
    });

    await app.shell.executeTurn({
      turnId: "turn_persona_group_follow_up",
      sessionId: "session_group_topic_77",
      workspaceId: "workspace_local",
      source: "telegram",
      actorId: "actor_group_member",
      input: "summarize the latest topic changes",
      attachments: [],
      requestedMode: "chat",
      conversationRef: topicConversationRef,
      imContext: {
        activationKind: "interactive_turn",
        boundary: createBoundary("supergroup:-100123:topic:77", "shared")
      }
    });

    const requestBody = JSON.stringify(capturedRequests[0]?.body ?? {});
    expect(requestBody).toContain("persona scope: conversation_override.");
    expect(requestBody).toContain("friendly but terse");
    expect(requestBody).toContain("speak like a pirate");
    expect(requestBody).toContain("cannot override privacy or tool rules");
  });

  it("wires owner-private /inspect through bounded source and masked config inspection", async () => {
    const dataDir = await createTempDataDir();
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      env: {
        ENDEC_PROVIDER: "openai",
        ENDEC_PROVIDER_MODEL: "gpt-5.4",
        OPENAI_API_KEY: "env-openai-secret-1234"
      },
      providerTransport: createChatCompletionTransport([])
    });

    const ownerConversationRef = {
      accountId: "acct_bot",
      conversationId: "private:42",
      peerId: "42",
      peerKind: "dm" as const
    };
    const createBoundary = (boundaryKey: string, conversationScope: "direct" | "shared") => ({
      boundaryKey,
      conversationScope,
      disclosureMode: "local_only" as const,
      targetConversationKeys: [],
      borrowedConversationKeys: [],
      transientBorrowed: false
    });

    await app.im.evaluateInboundAdmission({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "owner_user",
      conversationRef: ownerConversationRef,
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
      conversationRef: ownerConversationRef
    });

    const paths = ensureEndecDataLayout(dataDir);
    const accessStore = createAccessStore({ filename: paths.accessDbPath });
    await accessStore.setProviderSecret({
      source: "telegram",
      accountId: "acct_bot",
      apiKey: "persisted-openai-secret-9999",
      updatedByActorId: ownerActorId
    });

    const sourceReply = await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_inspect_source_001",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/inspect source packages/app/src/im-command-service.ts",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: createBoundary("private:42", "direct")
        }
      },
      commandIntent: {
        name: "inspect" as never,
        subcommand: "source",
        args: ["packages/app/src/im-command-service.ts"],
        options: {},
        rawText: "/inspect source packages/app/src/im-command-service.ts",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    const configReply = await app.im.executeCommand({
      turnRequest: {
        turnId: "turn_inspect_config_001",
        sessionId: "session_owner_dm",
        workspaceId: "workspace_local",
        source: "telegram",
        actorId: ownerActorId,
        input: "/inspect config",
        attachments: [],
        conversationRef: ownerConversationRef,
        imContext: {
          activationKind: "command_execution",
          boundary: createBoundary("private:42", "direct")
        }
      },
      commandIntent: {
        name: "inspect" as never,
        subcommand: "config",
        args: [],
        options: {},
        rawText: "/inspect config",
        helpRequested: false
      },
      conversationScope: "direct"
    });

    expect(sourceReply).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("packages/app/src/im-command-service.ts")
    });
    if (sourceReply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${sourceReply.kind}`);
    }
    expect(sourceReply.replyText).toContain('import type { createAccessStore } from "@endec/access";');

    expect(configReply).toMatchObject({
      kind: "reply_text",
      replyText: expect.stringContaining("provider: openai")
    });
    if (configReply.kind !== "reply_text") {
      throw new Error(`expected reply_text, received ${configReply.kind}`);
    }
    expect(configReply.replyText).toContain("apiKey: per****9999 (source: persisted)");
    expect(configReply.replyText).not.toContain("persisted-openai-secret-9999");
  });
});
