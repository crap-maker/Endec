import type { ContextToolExposure, RuntimeResult, ToolBatchPermissionContext, ToolBatchResult } from "@endec/domain";

export interface RuntimeToolExecutionPort {
  handleBatch(input: {
    batchId: string;
    turnId: string;
    sessionId: string;
    workspaceId: string;
    requestedToolCalls: RuntimeResult["requestedToolCalls"];
    contextAssembly: {
      toolExposure: ContextToolExposure;
    };
    permissionContext?: ToolBatchPermissionContext;
  }): Promise<ToolBatchResult>;
}
