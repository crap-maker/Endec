import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderTransport, ProviderTransportRequest } from "@endec/ai";
import { createEndecApp } from "./index.ts";

type JsonObject = Record<string, unknown>;

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

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

async function createTempDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), "endec-app-operator-acceptance-"));
  tempDirs.add(dataDir);
  return dataDir;
}

function createTurnRequest() {
  return {
    turnId: "turn_operator_acceptance_smoke",
    sessionId: "session_operator_acceptance_smoke",
    workspaceId: "workspace_operator_acceptance_smoke",
    source: "cli" as const,
    actorId: "actor_operator_acceptance",
    input: "prepare a remote publication action only if the operator approval boundary allows it",
    attachments: [],
    requestedMode: "act" as const
  };
}

function createApprovalRequiredPushResponse(): Array<JsonObject> {
  return [
    {
      choices: [
        {
          delta: {
            content: "I need operator approval before attempting the remote publication action."
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
                id: "tool_call_acceptance_push_001",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: "gh pr create --fill --dry-run"
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
  ];
}

function operatorFacingText(input: unknown) {
  return JSON.stringify(input);
}

function expectNoModeEraText(text: string) {
  expect(text).not.toMatch(/because chat mode has no bash/i);
  expect(text).not.toMatch(/resolvedMode === chat/i);
  expect(text).not.toMatch(/chat mode has no bash/i);
  expect(text).not.toMatch(/mode-derived/i);
}

describe("app operator acceptance smoke", () => {
  it("inspects an approval-blocked remote publication action through the shared operator contract", async () => {
    const dataDir = await createTempDataDir();
    const capturedRequests: ProviderTransportRequest[] = [];
    const app = createEndecApp({
      dataDir,
      providerTransport: createChatCompletionTransport([
        createApprovalRequiredPushResponse()
      ], (request) => capturedRequests.push(request))
    });
    const turn = createTurnRequest();

    const blocked = await app.shell.executeTurn(turn);

    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedBy).toBe("permission");
    expect(blocked.toolEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolCallId: "tool_call_acceptance_push_001",
        toolName: "bash",
        state: "ask",
        permissionDecision: expect.objectContaining({
          behavior: "ask",
          reasonCode: "bash_action_requires_approval"
        })
      })
    ]));

    const compact = await app.operator.inspectOperatorTurn({
      target: {
        sessionId: turn.sessionId,
        workspaceId: turn.workspaceId,
        actorId: turn.actorId,
        turnId: turn.turnId
      }
    });

    expect(compact).not.toBeNull();
    if (!compact) {
      throw new Error("operator inspection was unexpectedly null");
    }

    expect(compact.truth.capabilityTruth.guaranteedToolNames).toEqual(expect.any(Array));
    expect(compact.truth.capabilityTruth.guaranteedToolNames).toEqual(expect.arrayContaining(["bash"]));
    expect(compact.truth.capabilityTruth.approvalRequiredCapabilities).toEqual(
      expect.arrayContaining(["remote_git_push", "pull_request_create"])
    );
    expect(compact.truth.capabilityTruth.notGuaranteedCapabilities).toEqual(expect.any(Array));
    expect(compact.truth.capabilityTruth.actionAuthorizations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: "bash",
        authorizationLevel: "approval-required",
        boundaryReason: expect.stringMatching(/approval|remote|push/i)
      })
    ]));

    expect(compact.continuation).toBeDefined();
    expect(compact.continuation?.pendingDecision).toEqual(expect.objectContaining({
      decisionId: "tool_call_acceptance_push_001",
      behavior: "ask",
      reasonCode: "bash_action_requires_approval"
    }));
    expect(compact.continuation?.allowedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "approve", code: expect.any(String), summary: expect.any(String) }),
      expect.objectContaining({ kind: "deny", code: expect.any(String), summary: expect.any(String) }),
      expect.objectContaining({ kind: "cancel", code: expect.any(String), summary: expect.any(String) })
    ]));
    expect(compact.continuation?.actionAuthorization).toBeDefined();
    expect(compact.continuation?.actionAuthorization).toEqual(expect.objectContaining({
      authorizationLevel: "approval-required",
      boundaryReason: expect.stringMatching(/approval|remote|push|publish|external|collaboration|PR/i)
    }));

    expect(compact.explanation.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "approve", code: expect.any(String), summary: expect.any(String) }),
      expect.objectContaining({ kind: "cancel", code: expect.any(String), summary: expect.any(String) })
    ]));
    expect(compact.explanation.nextActions.every((action) =>
      typeof action.code === "string" &&
      action.code.length > 0 &&
      typeof action.kind === "string" &&
      action.kind.length > 0 &&
      typeof action.summary === "string" &&
      action.summary.length > 0
    )).toBe(true);
    expect(operatorFacingText(compact.explanation.nextActions)).not.toMatch(/endec .*operator|pnpm|cli/i);

    expect(compact.explanation.summary).not.toContain("{");
    for (const summary of Object.values(compact.context.summary)) {
      if (typeof summary === "string") {
        expect(summary).not.toContain("selectionStatus");
        expect(summary).not.toContain("correctionTarget");
        expect(summary).not.toContain("ContextAssemblyObservability");
      }
    }

    expectNoModeEraText(operatorFacingText({
      summary: compact.summary,
      explanation: compact.explanation,
      contextSummary: compact.context.summary
    }));

    const detailed = await app.operator.inspectOperatorTurn({
      target: {
        sessionId: turn.sessionId,
        workspaceId: turn.workspaceId,
        actorId: turn.actorId,
        turnId: turn.turnId
      },
      detail: {
        sections: ["continuation", "correction"]
      }
    });

    expect(detailed).not.toBeNull();
    if (!detailed) {
      throw new Error("detailed operator inspection was unexpectedly null");
    }

    expect(detailed.truth).toEqual(compact.truth);
    expect(detailed.explanation.nextActions).toEqual(compact.explanation.nextActions);
    expect(detailed.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "continuation-detail",
        subjectRef: "continuation",
        summary: expect.stringContaining("state=blocked")
      })
    ]));
    expect(detailed.explanation.explanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "correction-detail",
        subjectRef: "correction",
        summary: expect.stringContaining("Correction detail requested")
      })
    ]));

    expectNoModeEraText(operatorFacingText({
      explanation: detailed.explanation,
      contextSummary: detailed.context.summary,
      continuation: detailed.continuation
    }));
    expect(capturedRequests).toHaveLength(1);
  });
});
