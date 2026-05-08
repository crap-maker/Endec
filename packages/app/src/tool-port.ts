import type {
  ContextAssemblyResult,
  ContextToolExposure,
  RuntimeRequest,
  RuntimeResult,
  ToolBatchPermissionContext,
  ToolBatchResult
} from "@endec/domain";
import {
  createReadonlyToolPort,
  type RegisteredTool,
  type ToolArtifactPolicy
} from "@endec/tools";

export interface AppToolArtifactPolicy extends ToolArtifactPolicy {}

export function createAppToolPort(options: {
  cwd?: string;
  artifacts: AppToolArtifactPolicy;
}): {
  describeExposure(input: {
    turnId: string;
    sessionId: string;
    workspaceId: string;
    resolvedMode: RuntimeRequest["resolvedMode"];
    policy?: "canonical" | "none" | "owner_private_self_awareness" | "owner_private_self_awareness_mutating";
    additionalTools?: RegisteredTool[];
  }): Promise<ContextToolExposure>;
  handleBatch(input: {
    batchId: string;
    turnId: string;
    sessionId: string;
    workspaceId: string;
    requestedToolCalls: RuntimeResult["requestedToolCalls"];
    contextAssembly: Pick<ContextAssemblyResult, "toolExposure">;
    permissionContext?: ToolBatchPermissionContext;
  }): Promise<ToolBatchResult>;
} {
  const readonlyToolPort = createReadonlyToolPort(options);

  return {
    async describeExposure(input) {
      return readonlyToolPort.describeExposure(input);
    },
    async handleBatch(input) {
      return readonlyToolPort.handleBatch(input);
    }
  };
}
