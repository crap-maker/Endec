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
  const dataDir = await mkdtemp(join(tmpdir(), "endec-cli-operator-inspect-smoke-"));
  tempDirs.add(dataDir);
  return dataDir;
}

function createBlockedBashTransport() {
  return createChatCompletionTransport([
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
                  id: "tool_call_bash_smoke_001",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "printf smoke; git push --dry-run . HEAD:refs/heads/operator-smoke-cli"
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
  ]);
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

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("operator inspect CLI real app smoke", () => {
  it("renders the shared operator inspection contract from a real blocked app turn", async () => {
    const dataDir = await createTempDataDir();
    const app = createEndecApp({
      dataDir,
      providerTransport: createBlockedBashTransport()
    });
    const sessionId = "session_operator_smoke_cli";
    const workspaceId = "workspace_operator_smoke_cli";
    const actorId = "actor_operator_smoke_cli";
    const turnId = "turn_operator_smoke_cli";

    const blocked = await app.shell.executeTurn({
      turnId,
      sessionId,
      workspaceId,
      source: "cli",
      actorId,
      input: "run a controlled approval-required bash command",
      attachments: [],
      requestedMode: "act"
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedBy).toBe("permission");
    expect(blocked.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "tool_call_bash_smoke_001",
          toolName: "bash",
          state: "ask"
        })
      ])
    );

    const stdout = createBufferedWriter();
    const stderr = createBufferedWriter();
    const exitCode = await runCli({
      argv: [
        "node",
        "endec",
        "operator",
        "inspect",
        "--session",
        sessionId,
        "--workspace",
        workspaceId,
        "--turn",
        turnId
      ],
      stdout: stdout.writer,
      stderr: stderr.writer,
      app,
      now: () => 1700000000000
    });
    const output = stdout.read();

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(output).toContain("headline:");
    expect(output).toContain("summary:");
    expect(output).toContain("state: blocked");
    expect(output).toMatch(/^truth: .*guaranteed.*approval-required.*not-guaranteed/m);
    expect(output).toContain("continuation: blocked continuation via blocked");
    expect(output).toContain("correction:");
    expect(output).toContain("nextActions:\n");
    expect(output).toMatch(/- approve-pending-decision \[approve\]: .*target=tool_call_bash_smoke_001.*approval=yes/);
    expect(output).toMatch(/- cancel-pending-execution \[cancel\]:/);

    if (output.includes("inspect-correction-targets")) {
      expect(output).toMatch(/- inspect-correction-targets \[inspect\]:/);
    }
    if (output.includes("apply-correction")) {
      expect(output).toMatch(/- apply-correction \[(correct|correction)\]:/);
    }

    expect(output).not.toContain("ContextAssemblyObservability");
    expect(output).not.toContain("authoritativeTruth");
    expect(output).not.toContain("\"selectionStatus\"");
    expect(output).not.toContain("\"correctionTarget\"");
    expect(output).not.toMatch(/observability[\s\S]*\{[\s\S]*\}/i);

    expect(output).not.toContain("because chat mode has no bash");
    expect(output).not.toContain("resolvedMode === chat");
    expect(output).not.toContain("chat mode has no bash");
    expect(output).not.toContain("mode-derived");
  });
});
