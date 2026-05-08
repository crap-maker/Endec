import { ToolBatchResultSchema, type ContextToolExposure, type RuntimeToolCall, type ToolBatchResult, type ToolExecutionResult } from "@endec/domain";
import { evaluateToolCallPermission } from "./permission-evaluator.ts";
import { ToolExecutionFailure, type StaticToolRegistry } from "./registry.ts";
import { applyToolResultPolicy, type ToolArtifactPolicy } from "./result-policy.ts";

export async function executeToolBatch(input: {
  batchId: string;
  turnId: string;
  sessionId: string;
  workspaceId: string;
  requestedToolCalls: RuntimeToolCall[];
  exposure: ContextToolExposure;
  registry: StaticToolRegistry;
  artifacts: ToolArtifactPolicy;
  permissionContext?: import("@endec/domain").ToolBatchPermissionContext;
}): Promise<ToolBatchResult> {
  const permissionDecisions = [] as ToolBatchResult["permissionDecisions"];
  const executionResults: ToolExecutionResult[] = [];

  for (const toolCall of input.requestedToolCalls) {
    const permissionDecision = evaluateToolCallPermission({
      turnId: input.turnId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
      exposure: input.exposure,
      permissionContext: input.permissionContext
    });
    permissionDecisions.push(permissionDecision);

    if (permissionDecision.behavior === "deny") {
      executionResults.push({
        resultId: `${input.batchId}:deny:${toolCall.toolCallId}`,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        state: "deny",
        permissionDecision,
        metadata: {
          workspaceId: input.workspaceId
        }
      });
      continue;
    }

    if (permissionDecision.behavior === "ask") {
      executionResults.push({
        resultId: `${input.batchId}:ask:${toolCall.toolCallId}`,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        state: "ask",
        permissionDecision,
        metadata: {
          workspaceId: input.workspaceId
        }
      });
      break;
    }

    const tool = input.registry.get(toolCall.toolName);
    if (!tool?.execute) {
      executionResults.push({
        resultId: `${input.batchId}:error:${toolCall.toolCallId}`,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        state: "error",
        permissionDecision,
        error: {
          code: "tool_unavailable",
          message: `${toolCall.toolName} is not available for execution`
        },
        metadata: {
          workspaceId: input.workspaceId
        }
      });
      continue;
    }

    try {
      const executed = await tool.execute({
        cwd: input.registry.cwd,
        arguments: toolCall.arguments
      });
      const materialized = await applyToolResultPolicy({
        turnId: input.turnId,
        sessionId: input.sessionId,
        normalizedPayload: executed.normalizedPayload,
        artifacts: input.artifacts
      });

      executionResults.push({
        resultId: `${input.batchId}:${materialized.state}:${toolCall.toolCallId}`,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        state: materialized.state,
        permissionDecision,
        normalizedPayload: materialized.normalizedPayload,
        artifactRef: materialized.artifactRef,
        preview: materialized.preview,
        metadata: {
          workspaceId: input.workspaceId,
          ...executed.metadata
        }
      });
    } catch (error) {
      executionResults.push({
        resultId: `${input.batchId}:error:${toolCall.toolCallId}`,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        state: "error",
        permissionDecision,
        error: {
          code: error instanceof ToolExecutionFailure ? error.code : "tool_execution_failed",
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof ToolExecutionFailure ? error.details : undefined
        },
        metadata: {
          workspaceId: input.workspaceId
        }
      });
    }
  }

  return ToolBatchResultSchema.parse({
    schemaVersion: 1,
    contractVersion: "ws0.tool-batch.v1",
    batchId: input.batchId,
    turnId: input.turnId,
    requestedToolCalls: input.requestedToolCalls,
    permissionDecisions,
    executionResults
  });
}
