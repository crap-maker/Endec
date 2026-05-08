import type { ContextToolExposure, PermissionDecision, ToolBatchPermissionContext } from "@endec/domain";
import { classifyBashCommandAuthorization } from "./authoritative-truth.ts";
import { isToolExposed } from "./presets.ts";

export function evaluateToolCallPermission(input: {
  turnId: string;
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
  exposure: ContextToolExposure;
  permissionContext?: ToolBatchPermissionContext;
}): PermissionDecision {
  const exposed = isToolExposed(input.exposure, input.toolName);
  const issuedAt = new Date().toISOString();

  if (!exposed) {
    return {
      decisionId: input.toolCallId,
      behavior: "deny",
      scope: "once",
      reasonCode: "tool_hidden",
      reasonText: `${input.toolName} is not exposed by the current tool exposure policy`,
      issuedAt,
      requestedBy: input.turnId
    };
  }

  const approvedDecisionIds = new Set(input.permissionContext?.approvedDecisionIds ?? []);
  if (input.toolName === "bash") {
    const bashTrust = input.permissionContext?.bashTrust;
    if (bashTrust?.scope === "turn") {
      return {
        decisionId: input.toolCallId,
        behavior: "allow",
        scope: "turn",
        reasonCode: "tool_trusted_for_turn",
        reasonText: "bash is approved for the rest of this turn",
        issuedAt,
        requestedBy: input.turnId,
        approverId: bashTrust.approverId ?? input.permissionContext?.approverId
      };
    }

    if (approvedDecisionIds.has(input.toolCallId)) {
      return {
        decisionId: input.toolCallId,
        behavior: "allow",
        scope: "once",
        reasonCode: "tool_approved_once",
        reasonText: "bash was approved for this pending execution",
        issuedAt,
        requestedBy: input.turnId,
        approverId: input.permissionContext?.approverId
      };
    }

    const command = extractBashCommand(input.arguments);
    const actionAuthorization = classifyBashCommandAuthorization(command);

    if (actionAuthorization.authorizationLevel === "guaranteed") {
      return {
        decisionId: input.toolCallId,
        behavior: "allow",
        scope: "once",
        reasonCode: "bash_action_auto_allowed",
        reasonText: actionAuthorization.boundaryReason,
        issuedAt,
        requestedBy: input.turnId,
        auditMetadata: {
          actionClass: actionAuthorization.actionClass,
          command
        }
      };
    }

    if (actionAuthorization.authorizationLevel === "approval-required") {
      return {
        decisionId: input.toolCallId,
        behavior: "ask",
        scope: "once",
        reasonCode: "bash_action_requires_approval",
        reasonText: actionAuthorization.boundaryReason,
        issuedAt,
        requestedBy: input.turnId,
        auditMetadata: {
          actionClass: actionAuthorization.actionClass,
          approvalPath: actionAuthorization.approvalPath,
          command
        }
      };
    }

    return {
      decisionId: input.toolCallId,
      behavior: "deny",
      scope: "once",
      reasonCode: "bash_action_not_guaranteed",
      reasonText: actionAuthorization.boundaryReason,
      issuedAt,
      requestedBy: input.turnId,
      auditMetadata: {
        actionClass: actionAuthorization.actionClass,
        command
      }
    };
  }

  return {
    decisionId: input.toolCallId,
    behavior: "allow",
    scope: "once",
    reasonCode: "tool_auto_allowed",
    reasonText: `${input.toolName} is auto-allowed by the current tool exposure policy`,
    issuedAt,
    requestedBy: input.turnId
  };
}

function extractBashCommand(argumentsValue: unknown) {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return "";
  }

  const candidate = (argumentsValue as { command?: unknown }).command;
  return typeof candidate === "string" ? candidate : "";
}
