import type {
  ContextAssemblyResult,
  ContextToolExposure,
  CostLedger,
  ExecutionControlInput,
  InflightTurn,
  MemoryQuery,
  MemoryWriteRequest,
  PendingExecution,
  RuntimeMemoryContext,
  RuntimeRequest,
  ToolBatchPermissionContext,
  RuntimeResult,
  SessionState,
  ToolBatchResult,
  TurnRequest,
  TurnResult,
  Source,
  Mode,
  BudgetResolutionDebug
} from "@endec/domain";

export interface SessionStorePort {
  loadOrCreate(request: TurnRequest): Promise<Pick<SessionState, "sessionId" | "workspaceId">>;
  openOrCreateSession?(input: {
    sessionId?: string;
    workspaceId: string;
    source: TurnRequest["source"];
  }): Promise<string>;
  markInflight?(input: Pick<InflightTurn, "turnId" | "sessionId" | "workspaceId" | "state" | "waitingReason" | "resumePolicy" | "loopCount" | "toolCallCount" | "pendingApprovalRef" | "checkpointRef" | "frameRef" | "contractVersion" | "pendingExecution">): Promise<void>;
  finalize(input: { turnId: string; sessionId: string; status: TurnResult["status"]; preserveInflight?: boolean }): Promise<string>;
}

export interface MemoryPort {
  retrieve?(request: Pick<
    MemoryQuery,
    "queryId" | "sessionId" | "workspaceId" | "purpose" | "memoryTypes" | "maxItems" | "maxInjectTokens" | "taskId" | "resumeFrom" | "queryText" | "topicHints"
  >): Promise<RuntimeMemoryContext>;
  enqueueWrites(writes: MemoryWriteRequest[]): Promise<unknown[]>;
}

export interface ToolPort {
  describeExposure?(input: {
    turnId: string;
    sessionId: string;
    workspaceId: string;
    resolvedMode: RuntimeRequest["resolvedMode"];
  }): Promise<ContextToolExposure> | ContextToolExposure;
  handleBatch(input: {
    batchId: string;
    turnId: string;
    sessionId: string;
    workspaceId: string;
    requestedToolCalls: RuntimeResult["requestedToolCalls"];
    contextAssembly: Pick<ContextAssemblyResult, "toolExposure">;
    permissionContext?: ToolBatchPermissionContext;
  }): Promise<ToolBatchResult>;
}

export type BudgetResolution = Pick<RuntimeRequest, "resolvedMode" | "model" | "limits"> & {
  // Runtime selection is already collapsed onto one current model. model.modelTier, if present,
  // is compatibility-only metadata and must not drive selection.
  budgetDebug?: Partial<BudgetResolutionDebug>;
};

export interface BudgetPort {
  resolve(request: TurnRequest): Promise<BudgetResolution>;
  evaluateBudget?(input: {
    resolvedMode: RuntimeRequest["resolvedMode"];
    projectedTotalTokens: number;
    hardLimitTokens: number;
  }):
    | Promise<{ kind: "ok" | "ask_continue" | "hard_stop"; status: "completed" | "blocked" | "interrupted"; stopReason: string }>
    | { kind: "ok" | "ask_continue" | "hard_stop"; status: "completed" | "blocked" | "interrupted"; stopReason: string };
  recordCost(input: CostLedger): Promise<string>;
}

export interface ContextAssemblyPort {
  assemble(input: {
    request: TurnRequest;
    session: Pick<SessionState, "sessionId" | "workspaceId">;
    budget: BudgetResolution;
    continuation?: {
      pendingExecution: PendingExecution;
      control: ExecutionControlInput;
    };
  }): Promise<ContextAssemblyResult>;
}

export interface RuntimePort {
  run(input: RuntimeRequest): Promise<RuntimeResult>;
}

export interface ExecutionSessionContext {
  sessionId: string;
  workspaceId: string;
  source: Source;
  mode: Mode;
}
