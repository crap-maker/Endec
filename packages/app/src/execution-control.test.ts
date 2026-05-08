import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createEndecApp } from "./index.ts";

type JsonObject = Record<string, unknown>;

function createTurnRequest(sessionId: string, turnId: string, input: string) {
  return {
    turnId,
    sessionId,
    workspaceId: "workspace_local",
    source: "cli" as const,
    actorId: "actor_cli",
    input,
    attachments: []
  };
}

function createChatCompletionTransport(responses: Array<Array<JsonObject>>) {
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

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("app execution control compatibility", () => {
  it("restores submitExecutionControl contract by rejecting actions when no recoverable frame exists", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "endec-app-execution-control-"));
    tempDirs.add(dataDir);
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        [
          {
            choices: [
              {
                delta: {
                  content: "hidden tool request"
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

    const result = await app.shell.executeTurn(createTurnRequest("session_resume", "turn_hidden_control", "please deny the hidden tool"));

    expect(result).toMatchObject({
      status: "completed",
      toolEvents: [expect.objectContaining({ state: "deny" })]
    });
    await expect(app.shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "resume",
      sessionId: "session_resume",
      workspaceId: "workspace_local",
      turnId: "turn_hidden_control",
      frameRef: "frame:turn_hidden_control"
    })).rejects.toThrow("No recoverable turn is open for session session_resume.");
    await expect(app.shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "approve",
      sessionId: "session_resume",
      turnId: "turn_hidden_control",
      frameRef: "frame:turn_hidden_control",
      decisionId: "tool_call_hidden_001",
      scope: "once"
    })).rejects.toThrow("No recoverable turn is open for session session_resume.");
    await expect(app.shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "deny",
      sessionId: "session_resume",
      turnId: "turn_hidden_control",
      frameRef: "frame:turn_hidden_control",
      decisionId: "tool_call_hidden_001",
      scope: "once"
    })).rejects.toThrow("No recoverable turn is open for session session_resume.");
    await expect(app.shell.submitExecutionControl({
      schemaVersion: 1,
      contractVersion: "ws0.execution-control.v1",
      action: "cancel",
      sessionId: "session_resume",
      workspaceId: "workspace_local",
      turnId: "turn_hidden_control",
      frameRef: "frame:turn_hidden_control",
      reason: "operator_cancelled"
    })).rejects.toThrow("No recoverable turn is open for session session_resume.");
  });
});
