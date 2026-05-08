import { z } from "zod";

export const ApprovalScopeValues = ["once", "turn"] as const;
export const ApprovalScopeSchema = z.enum(ApprovalScopeValues);

export const PermissionDecisionSchema = z.object({
  decisionId: z.string(),
  behavior: z.enum(["allow", "deny", "ask"]),
  scope: ApprovalScopeSchema,
  reasonCode: z.string(),
  reasonText: z.string(),
  issuedAt: z.string(),
  updatedInput: z.unknown().optional(),
  requestedBy: z.string().optional(),
  approverId: z.string().optional(),
  expiresAt: z.string().optional(),
  auditMetadata: z.record(z.string(), z.unknown()).optional()
});

export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
