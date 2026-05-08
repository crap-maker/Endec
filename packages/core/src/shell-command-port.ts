import { ExecutionControlInputSchema, type ApprovalScope, type ExecutionControlInput, type TurnRequest, type TurnResult } from "@endec/domain";

export interface ResumeTurnCommand {
  turnId?: string;
  sessionId: string;
  workspaceId: string;
  frameRef?: string;
  input?: string;
}

export interface ResolveApprovalCommand {
  turnId?: string;
  sessionId: string;
  decisionId: string;
  approved: boolean;
  scope?: ApprovalScope;
  approverId?: string;
  frameRef?: string;
}

export interface CancelInflightTurnCommand {
  turnId?: string;
  sessionId: string;
  workspaceId: string;
  frameRef?: string;
  reason?: string;
}

export interface ShellCommandPort {
  executeTurn(request: TurnRequest): Promise<TurnResult>;
  resumeTurn(input: ResumeTurnCommand): Promise<TurnResult>;
  resolveApproval(input: ResolveApprovalCommand): Promise<TurnResult>;
  cancelInflightTurn(input: CancelInflightTurnCommand): Promise<TurnResult>;
  submitExecutionControl(input: ExecutionControlInput): Promise<TurnResult>;
}

export function createShellCommandPort(commands: Omit<ShellCommandPort, "submitExecutionControl"> & {
  submitExecutionControl?: (input: ExecutionControlInput) => Promise<TurnResult>;
}): ShellCommandPort {
  return {
    ...commands,
    async submitExecutionControl(input: ExecutionControlInput): Promise<TurnResult> {
      const parsed = ExecutionControlInputSchema.parse(input);

      if (commands.submitExecutionControl) {
        return commands.submitExecutionControl(parsed);
      }

      switch (parsed.action) {
        case "resume":
          return commands.resumeTurn({
            turnId: parsed.turnId,
            sessionId: parsed.sessionId,
            workspaceId: parsed.workspaceId ?? "",
            frameRef: parsed.frameRef,
            input: parsed.input
          });
        case "approve":
          return commands.resolveApproval({
            turnId: parsed.turnId,
            sessionId: parsed.sessionId,
            decisionId: parsed.decisionId,
            approved: true,
            scope: parsed.scope,
            approverId: parsed.approverId,
            frameRef: parsed.frameRef
          });
        case "deny":
          return commands.resolveApproval({
            turnId: parsed.turnId,
            sessionId: parsed.sessionId,
            decisionId: parsed.decisionId,
            approved: false,
            scope: parsed.scope,
            approverId: parsed.approverId,
            frameRef: parsed.frameRef
          });
        case "cancel":
          return commands.cancelInflightTurn({
            turnId: parsed.turnId,
            sessionId: parsed.sessionId,
            workspaceId: parsed.workspaceId ?? "",
            frameRef: parsed.frameRef,
            reason: parsed.reason
          });
      }
    }
  };
}
