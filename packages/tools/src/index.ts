import type { ContextToolExposure, RuntimeResult, RuntimeToolCall, RuntimeRequest, ToolBatchPermissionContext, ToolBatchResult } from "@endec/domain";
import { executeToolBatch } from "./execute-batch.ts";
import {
  createCanonicalToolExposure,
  createNoToolExposure,
  createOwnerPrivateSelfAwarenessToolExposure
} from "./presets.ts";
import { createStaticToolRegistry, type RegisteredTool } from "./registry.ts";
import type { ToolArtifactPolicy } from "./result-policy.ts";

export * from "./registry.ts";
export * from "./presets.ts";
export * from "./authoritative-truth.ts";
export * from "./permission-evaluator.ts";
export * from "./result-policy.ts";
export * from "./execute-batch.ts";

type ToolExposurePolicy = "canonical" | "none" | "owner_private_self_awareness" | "owner_private_self_awareness_mutating";

export function createReadonlyToolPort(options: {
  cwd?: string;
  artifacts: ToolArtifactPolicy;
}): {
  describeExposure(input: {
    turnId: string;
    sessionId: string;
    workspaceId: string;
    resolvedMode: RuntimeRequest["resolvedMode"];
    policy?: ToolExposurePolicy;
    additionalTools?: RegisteredTool[];
  }): Promise<ContextToolExposure>;
  handleBatch(input: {
    batchId: string;
    turnId: string;
    sessionId: string;
    workspaceId: string;
    requestedToolCalls: RuntimeResult["requestedToolCalls"];
    contextAssembly: { toolExposure: ContextToolExposure };
    permissionContext?: ToolBatchPermissionContext;
  }): Promise<ToolBatchResult>;
} {
  const registriesByTurnId = new Map<string, ReturnType<typeof createStaticToolRegistry>>();

  function getRegistryForTurn(turnId: string, additionalTools?: RegisteredTool[]) {
    const registry = createStaticToolRegistry({ cwd: options.cwd, additionalTools });
    registriesByTurnId.set(turnId, registry);
    return registry;
  }

  function createExposure(input: {
    registry: ReturnType<typeof createStaticToolRegistry>;
    resolvedMode: RuntimeRequest["resolvedMode"];
    policy?: ToolExposurePolicy;
  }) {
    switch (input.policy) {
      case "none":
        return createNoToolExposure(input.registry);
      case "owner_private_self_awareness":
        return createOwnerPrivateSelfAwarenessToolExposure(input.registry);
      case "owner_private_self_awareness_mutating":
        return createOwnerPrivateSelfAwarenessToolExposure(input.registry, {
          allowWorkspaceMutation: true
        });
      case "canonical":
      default:
        return createCanonicalToolExposure({
          registry: input.registry,
          resolvedMode: input.resolvedMode
        });
    }
  }

  return {
    async describeExposure(input) {
      const registry = getRegistryForTurn(input.turnId, input.additionalTools);
      return createExposure({
        registry,
        resolvedMode: input.resolvedMode,
        policy: input.policy
      });
    },

    async handleBatch(input) {
      const registry = registriesByTurnId.get(input.turnId) ?? createStaticToolRegistry({ cwd: options.cwd });
      return executeToolBatch({
        batchId: input.batchId,
        turnId: input.turnId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        requestedToolCalls: input.requestedToolCalls as RuntimeToolCall[],
        exposure: input.contextAssembly.toolExposure,
        registry,
        artifacts: options.artifacts,
        permissionContext: input.permissionContext
      });
    }
  };
}
