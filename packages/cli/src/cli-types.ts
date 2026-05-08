import { formatStatusSnapshotLines, type EndecApp } from "@endec/app";

export interface CliWriter {
  write(text: string): void;
}

export type CliAppFactory = () => EndecApp | Promise<EndecApp>;
export type CliAppInput = EndecApp | CliAppFactory;

export interface CliCommandContext {
  stdout: CliWriter;
  stderr: CliWriter;
  app: EndecApp;
  now: () => number;
}

export type CliTurnRequest = Parameters<EndecApp["shell"]["executeTurn"]>[0];
export type CliTurnResult = Awaited<ReturnType<EndecApp["shell"]["executeTurn"]>>;
export type CliStatusResult = Awaited<ReturnType<EndecApp["operator"]["getStatus"]>>;
export type CliRecoverySnapshotResult = Awaited<ReturnType<EndecApp["operator"]["getRecoverySnapshot"]>>;
export type CliSessionListResult = Awaited<ReturnType<EndecApp["operator"]["listSessions"]>>;
export type CliSessionBrowseResult = Awaited<ReturnType<EndecApp["operator"]["browseSessionHistory"]>>;
export type CliSessionSearchResult = Awaited<ReturnType<EndecApp["operator"]["searchSessionEvents"]>>;
export type CliSessionLookupResult = Awaited<ReturnType<EndecApp["operator"]["lookupSessionEvent"]>>;
export type CliArtifactPreviewResult = Awaited<ReturnType<EndecApp["operator"]["getArtifactPreview"]>>;
export type CliArtifactReadResult = Awaited<ReturnType<EndecApp["operator"]["readArtifact"]>>;
export type CliEvidenceSearchResult = Awaited<ReturnType<EndecApp["operator"]["searchEvidence"]>>;
export type CliOperatorTurnInspectionResult = Awaited<ReturnType<EndecApp["operator"]["inspectOperatorTurn"]>>;
export type CliInspectOwnerBindingResult = Awaited<ReturnType<EndecApp["operator"]["inspectOwnerBinding"]>>;
export type CliListPairClaimsResult = Awaited<ReturnType<EndecApp["operator"]["listPairClaims"]>>;
export type CliApprovePairClaimResult = Awaited<ReturnType<EndecApp["operator"]["approvePairClaim"]>>;
export type CliResetOwnerBindingResult = Awaited<ReturnType<EndecApp["operator"]["resetOwnerBinding"]>>;
export type CliListTrustedConversationsResult = Awaited<ReturnType<EndecApp["operator"]["listTrustedConversations"]>>;
export type CliRevokeTrustedConversationResult = Awaited<ReturnType<EndecApp["operator"]["revokeTrustedConversation"]>>;

interface CliTurnRenderOptions {
  command?: "execute" | "resume" | "approve" | "cancel";
  sessionId?: string;
  decisionId?: string;
  approved?: boolean;
}

export const cliDefaults = {
  sessionId: "session_cli_default",
  workspaceId: "workspace_local",
  actorId: "actor_cli_user"
} as const;

function extractMessageContent(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function writeLine(output: CliWriter, text: string) {
  output.write(`${text}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function describeBlockedReason(blockedBy: string | undefined) {
  if (blockedBy === "permission") {
    return "waiting for approval before continuing";
  }

  if (blockedBy === "user_decision") {
    return "waiting for operator decision before continuing";
  }

  return "waiting for external input before continuing";
}

function extractApprovalSummaries(result: CliTurnResult) {
  return (result.approvals ?? [])
    .map((approval) => {
      const record = asRecord(approval);
      if (!record || typeof record.decisionId !== "string") {
        return null;
      }

      return {
        decisionId: record.decisionId,
        scope: typeof record.scope === "string" ? record.scope : "once",
        reasonText:
          typeof record.reasonText === "string" && record.reasonText.length > 0
            ? record.reasonText
            : "approval required"
      };
    })
    .filter((approval): approval is { decisionId: string; scope: string; reasonText: string } => approval !== null);
}

function renderBlockedTurnGuidance(output: CliWriter, result: CliTurnResult) {
  writeLine(output, `reason: ${describeBlockedReason(result.blockedBy)}`);

  if (result.blockedBy === "permission") {
    const approvals = extractApprovalSummaries(result);

    if (approvals.length > 0) {
      writeLine(output, "pending approvals:");
      for (const approval of approvals) {
        writeLine(output, `- ${approval.decisionId} [${approval.scope}]: ${approval.reasonText}`);
      }
    }

    writeLine(output, "next:");
    for (const approval of approvals) {
      writeLine(
        output,
        `- approve: endec approve --session ${result.sessionId} --decision ${approval.decisionId} --turn ${result.turnId}`
      );
      writeLine(
        output,
        `- deny: endec approve --session ${result.sessionId} --decision ${approval.decisionId} --deny --turn ${result.turnId}`
      );
    }
    writeLine(output, `- cancel: endec cancel --session ${result.sessionId} --turn ${result.turnId}`);
    return;
  }

  if (result.blockedBy === "user_decision") {
    writeLine(output, "next:");
    writeLine(output, `- resume: endec resume --session ${result.sessionId} --turn ${result.turnId} [message...]`);
    writeLine(output, `- cancel: endec cancel --session ${result.sessionId} --turn ${result.turnId} [--reason <text>]`);
    return;
  }

  writeLine(output, "next:");
  writeLine(output, `- resume: endec resume --session ${result.sessionId} --turn ${result.turnId}`);
  writeLine(output, `- cancel: endec cancel --session ${result.sessionId} --turn ${result.turnId}`);
}

function renderCommandSummary(output: CliWriter, result: CliTurnResult, options: CliTurnRenderOptions) {
  if (options.command === "resume") {
    writeLine(output, `resume: continuing session ${options.sessionId ?? result.sessionId}`);
    return;
  }

  if (options.command === "approve" && options.decisionId) {
    writeLine(
      output,
      `approval: ${options.approved === false ? "denied" : "approved"} ${options.decisionId} for session ${options.sessionId ?? result.sessionId}`
    );
    return;
  }

  if (options.command === "cancel") {
    writeLine(output, `cancel: interrupted recoverable work in session ${options.sessionId ?? result.sessionId}`);
  }
}

function renderNextCursor(output: CliWriter, cursor: string | undefined) {
  if (cursor) {
    writeLine(output, `nextCursor: ${cursor}`);
  }
}

function renderRefList(output: CliWriter, label: string, values: string[] | undefined) {
  if (values && values.length > 0) {
    writeLine(output, `  ${label}: ${values.join(", ")}`);
  }
}

function renderArtifactRefs(
  output: CliWriter,
  refs: Array<{ artifactId: string }> | undefined
) {
  if (refs && refs.length > 0) {
    writeLine(output, `  artifactRefs: ${refs.map((ref) => ref.artifactId).join(", ")}`);
  }
}

function renderSessionEventEntry(
  output: CliWriter,
  entry: {
    eventId: string;
    sessionId: string;
    turnId: string;
    eventKind: string;
    createdAt: string;
    summary: string;
    sourceRefs?: string[];
    artifactRefs?: Array<{ artifactId: string }>;
  },
  extraLines: string[] = []
) {
  writeLine(
    output,
    `event: ${entry.eventId} session=${entry.sessionId} turn=${entry.turnId} kind=${entry.eventKind} at=${entry.createdAt}`
  );
  writeLine(output, `  summary: ${entry.summary}`);
  for (const line of extraLines) {
    writeLine(output, `  ${line}`);
  }
  renderArtifactRefs(output, entry.artifactRefs);
  renderRefList(output, "sourceRefs", entry.sourceRefs);
}

function renderRecoveryNextActions(
  output: CliWriter,
  snapshot: NonNullable<CliRecoverySnapshotResult>
) {
  const decisionId = snapshot.pendingDecision?.decisionId ?? snapshot.pendingApprovalRef;
  const turnSuffix = snapshot.turnId ? ` --turn ${snapshot.turnId}` : "";
  const workspaceSegment = snapshot.workspaceId ? ` --workspace ${snapshot.workspaceId}` : "";
  let wroteAction = false;

  writeLine(output, "next:");

  for (const action of snapshot.allowedActions) {
    if (action === "approve") {
      if (decisionId) {
        writeLine(
          output,
          `- approve: endec approve --session ${snapshot.sessionId} --decision ${decisionId}${turnSuffix}`
        );
      } else {
        writeLine(output, "- approve: unavailable (operator snapshot omitted decisionId)");
      }
      wroteAction = true;
      continue;
    }

    if (action === "deny") {
      if (decisionId) {
        writeLine(
          output,
          `- deny: endec approve --session ${snapshot.sessionId} --decision ${decisionId} --deny${turnSuffix}`
        );
      } else {
        writeLine(output, "- deny: unavailable (operator snapshot omitted decisionId)");
      }
      wroteAction = true;
      continue;
    }

    if (action === "resume") {
      writeLine(output, `- resume: endec resume --session ${snapshot.sessionId}${turnSuffix} [message...]`);
      wroteAction = true;
      continue;
    }

    if (action === "cancel") {
      writeLine(
        output,
        `- cancel: endec cancel --session ${snapshot.sessionId}${workspaceSegment}${turnSuffix} [--reason <text>]`
      );
      wroteAction = true;
    }
  }

  if (!wroteAction) {
    writeLine(output, "- none");
  }
}

export async function resolveCliApp(app: CliAppInput): Promise<EndecApp> {
  if (typeof app === "function") {
    return app();
  }

  return app;
}

export function renderTurnResult(output: CliWriter, result: CliTurnResult, options: CliTurnRenderOptions = {}) {
  renderCommandSummary(output, result, options);

  const lastMessage = [...result.messages].reverse().map(extractMessageContent).find((value) => value);

  if (lastMessage) {
    writeLine(output, lastMessage);
  }

  if (result.status !== "completed") {
    writeLine(output, `status: ${result.status}`);
  }

  if (result.status === "blocked") {
    renderBlockedTurnGuidance(output, result);
  }

  for (const warning of result.warnings) {
    writeLine(output, `warning: ${warning}`);
  }
}

export function renderRecoverySnapshotResult(
  output: CliWriter,
  query: { sessionId: string },
  result: CliRecoverySnapshotResult
) {
  if (!result) {
    writeLine(output, `sessionId: ${query.sessionId}`);
    writeLine(output, "recoverable: no");
    writeLine(output, "pending: no");
    writeLine(output, "next: none");
    writeLine(output, "hint: no recoverable turn is currently exposed through the operator snapshot.");
    return;
  }

  writeLine(output, `sessionId: ${result.sessionId}`);
  writeLine(output, `workspaceId: ${result.workspaceId}`);
  writeLine(output, `recoverable: ${result.recoverable ? "yes" : "no"}`);
  writeLine(output, `pending: ${result.hasPendingExecution ? "yes" : "no"}`);
  writeLine(output, `state: ${result.state}`);

  if (result.blockedBy) {
    writeLine(output, `blockedBy: ${result.blockedBy}`);
  }

  if (result.waitingReason) {
    writeLine(output, `waitingReason: ${result.waitingReason}`);
  }

  if (result.turnId) {
    writeLine(output, `turnId: ${result.turnId}`);
  }

  if (result.frameRef) {
    writeLine(output, `frameRef: ${result.frameRef}`);
  }

  if (result.pendingExecutionId) {
    writeLine(output, `pendingExecutionId: ${result.pendingExecutionId}`);
  }

  writeLine(
    output,
    `allowedActions: ${result.allowedActions.length > 0 ? result.allowedActions.join(", ") : "none"}`
  );

  const decisionId = result.pendingDecision?.decisionId ?? result.pendingApprovalRef;
  if (decisionId) {
    writeLine(output, `decisionId: ${decisionId}`);
  }

  if (result.pendingDecision?.reasonText) {
    writeLine(output, `decisionReason: ${result.pendingDecision.reasonText}`);
  }

  renderRecoveryNextActions(output, result);
}

function renderOperatorActionHint(output: CliWriter, action: NonNullable<CliOperatorTurnInspectionResult>["explanation"]["nextActions"][number]) {
  const parts = [
    `- ${action.code} [${action.kind}]: ${action.summary}`,
    action.targetRef ? `target=${action.targetRef}` : undefined,
    action.relatedRefs && action.relatedRefs.length > 0 ? `refs=${action.relatedRefs.join(",")}` : undefined,
    action.riskLevel ? `risk=${action.riskLevel}` : undefined,
    action.requiresApproval !== undefined ? `approval=${action.requiresApproval ? "yes" : "no"}` : undefined
  ].filter((part): part is string => !!part);

  writeLine(output, parts.join(" "));
}

export function renderOperatorTurnInspectionResult(
  output: CliWriter,
  query: { sessionId: string },
  result: CliOperatorTurnInspectionResult
) {
  if (!result) {
    writeLine(output, `operator inspection unavailable for session ${query.sessionId}.`);
    writeLine(output, "hint: shared operator turn inspection returned no result; no fallback truth was computed.");
    return;
  }

  writeLine(output, `headline: ${result.summary.headline}`);
  writeLine(output, `summary: ${result.explanation.summary}`);
  writeLine(output, `state: ${result.summary.state}`);
  writeLine(output, `truth: ${result.context.summary.truthSummary}`);
  writeLine(output, `context: ${result.context.summary.headline}`);
  writeLine(output, `continuity: ${result.context.summary.continuitySummary}`);
  writeLine(output, `durableMemory: ${result.context.summary.durableMemorySummary}`);
  writeLine(output, `truncation: ${result.context.summary.truncationSummary}`);
  writeLine(output, `driftDiagnostics: ${result.context.summary.driftDiagnosticsSummary}`);

  if (result.context.summary.continuationSummary) {
    writeLine(output, `continuation: ${result.context.summary.continuationSummary}`);
  }

  if (result.context.summary.correctionSummary) {
    writeLine(output, `correction: ${result.context.summary.correctionSummary}`);
  }

  if (result.context.summary.budgetSummary) {
    writeLine(output, `budget: ${result.context.summary.budgetSummary}`);
  }

  writeLine(output, "nextActions:");
  if (result.explanation.nextActions.length === 0) {
    writeLine(output, "- none");
  } else {
    for (const action of result.explanation.nextActions) {
      renderOperatorActionHint(output, action);
    }
  }

  if (result.explanation.explanations.length > 0) {
    writeLine(output, "explanations:");
    for (const item of result.explanation.explanations) {
      writeLine(output, `- ${item.code}: ${item.summary}`);
    }
  }
}

function renderConversationRef(output: CliWriter, label: string, conversationRef: {
  conversationId: string;
  peerKind: string;
  peerId: string;
  baseConversationId?: string;
  parentConversationId?: string;
  threadId?: string;
  topicId?: string;
}) {
  writeLine(
    output,
    `${label}: ${conversationRef.conversationId} peerKind=${conversationRef.peerKind} peerId=${conversationRef.peerId}`
  );

  if (conversationRef.baseConversationId) {
    writeLine(output, `  baseConversationId: ${conversationRef.baseConversationId}`);
  }

  if (conversationRef.parentConversationId) {
    writeLine(output, `  parentConversationId: ${conversationRef.parentConversationId}`);
  }

  if (conversationRef.threadId) {
    writeLine(output, `  threadId: ${conversationRef.threadId}`);
  }

  if (conversationRef.topicId) {
    writeLine(output, `  topicId: ${conversationRef.topicId}`);
  }
}

export function renderInspectOwnerBindingResult(output: CliWriter, result: CliInspectOwnerBindingResult) {
  writeLine(output, `source: ${result.state.source}`);
  writeLine(output, `accountId: ${result.state.accountId}`);
  writeLine(output, `authorityStatus: ${result.state.status}`);
  writeLine(output, `ownerGeneration: ${result.state.ownerGeneration}`);
  writeLine(output, `ownerBindingId: ${result.state.ownerBindingId ?? "none"}`);

  if (!result.ownerBinding) {
    writeLine(output, "owner: none");
    return;
  }

  writeLine(output, `owner: ${result.ownerBinding.status}`);
  writeLine(output, `ownerBinding: ${result.ownerBinding.ownerBindingId}`);
  writeLine(output, `ownerSubjectRef: ${result.ownerBinding.ownerSubjectRef}`);
  writeLine(output, `ownerActorId: ${result.ownerBinding.ownerActorId}`);
  writeLine(output, `consumedClaimId: ${result.ownerBinding.consumedClaimId}`);
  writeLine(output, `boundAt: ${result.ownerBinding.boundAt}`);
  if (result.ownerBinding.approvedByOperatorId) {
    writeLine(output, `approvedByOperatorId: ${result.ownerBinding.approvedByOperatorId}`);
  }
  if (result.ownerBinding.revokedAt) {
    writeLine(output, `revokedAt: ${result.ownerBinding.revokedAt}`);
  }
  if (result.ownerBinding.revokedReason) {
    writeLine(output, `revokedReason: ${result.ownerBinding.revokedReason}`);
  }
  if (result.ownerBinding.revokedByOperatorId) {
    writeLine(output, `revokedByOperatorId: ${result.ownerBinding.revokedByOperatorId}`);
  }
  renderConversationRef(output, "pairedConversation", result.ownerBinding.pairedConversationRef);

  if (result.ownerPreferences?.ownerDisplayName) {
    writeLine(output, `storedOwnerDisplayName: ${result.ownerPreferences.ownerDisplayName}`);
  }
  if (result.ownerPreferences?.assistantDisplayName) {
    writeLine(output, `storedAssistantDisplayName: ${result.ownerPreferences.assistantDisplayName}`);
  }
  if (result.ownerPreferences?.timezone) {
    writeLine(output, `storedTimezone: ${result.ownerPreferences.timezone}`);
  }

  if (result.resolvedOwnerPreferences) {
    writeLine(output, `resolvedAssistantDisplayName: ${result.resolvedOwnerPreferences.assistantDisplayName}`);
    writeLine(output, `resolvedTimezone: ${result.resolvedOwnerPreferences.timezone}`);
    writeLine(output, `timezoneSource: ${result.resolvedOwnerPreferences.timezoneSource}`);
  }

  if (result.ownerInitState) {
    writeLine(output, `ownerInitStatus: ${result.ownerInitState.status}`);
    writeLine(output, `ownerInitPromptVersion: ${result.ownerInitState.promptVersion}`);
    if (result.ownerInitState.promptSentAt) {
      writeLine(output, `ownerInitPromptSentAt: ${result.ownerInitState.promptSentAt}`);
    }
    if (result.ownerInitState.completionReason) {
      writeLine(output, `ownerInitCompletionReason: ${result.ownerInitState.completionReason}`);
    }
    if (result.ownerInitState.completedAt) {
      writeLine(output, `ownerInitCompletedAt: ${result.ownerInitState.completedAt}`);
    }
  }
}

export function renderListPairClaimsResult(output: CliWriter, result: CliListPairClaimsResult) {
  writeLine(output, `source: ${result.state.source}`);
  writeLine(output, `accountId: ${result.state.accountId}`);
  writeLine(output, `authorityStatus: ${result.state.status}`);
  writeLine(output, `ownerGeneration: ${result.state.ownerGeneration}`);

  if (result.claims.length === 0) {
    writeLine(output, "claims: none");
    return;
  }

  for (const claim of result.claims) {
    writeLine(
      output,
      `claim: ${claim.claimId} status=${claim.status} code=${claim.pairCode} subject=${claim.requesterSubjectRef} actor=${claim.requesterActorId} generation=${claim.ownerGeneration}`
    );
    writeLine(output, `  expiresAt: ${claim.expiresAt}`);
    writeLine(output, `  createdAt: ${claim.createdAt}`);
    if (claim.requestWorkspaceId) {
      writeLine(output, `  requestWorkspaceId: ${claim.requestWorkspaceId}`);
    }
    if (claim.requestSessionId) {
      writeLine(output, `  requestSessionId: ${claim.requestSessionId}`);
    }
    if (claim.consumedAt) {
      writeLine(output, `  consumedAt: ${claim.consumedAt}`);
    }
    if (claim.supersededAt) {
      writeLine(output, `  supersededAt: ${claim.supersededAt}`);
    }
    if (claim.approvedByOperatorId) {
      writeLine(output, `  approvedByOperatorId: ${claim.approvedByOperatorId}`);
    }
    renderConversationRef(output, "  requestConversation", claim.requestConversationRef);
  }
}

export function renderApprovePairClaimResult(output: CliWriter, result: CliApprovePairClaimResult) {
  writeLine(output, `outcome: ${result.outcome}`);
  writeLine(output, `source: ${result.state.source}`);
  writeLine(output, `accountId: ${result.state.accountId}`);
  writeLine(output, `authorityStatus: ${result.state.status}`);
  writeLine(output, `ownerGeneration: ${result.state.ownerGeneration}`);
  writeLine(output, `pairingSuccessNoticeStatus: ${result.pairingSuccessNoticeStatus}`);
  writeLine(output, `supersededClaimCount: ${result.supersededClaimCount}`);

  if (result.consumedClaim) {
    writeLine(output, `claimId: ${result.consumedClaim.claimId}`);
    writeLine(output, `pairCode: ${result.consumedClaim.pairCode}`);
    writeLine(output, `claimStatus: ${result.consumedClaim.status}`);
    if (result.consumedClaim.approvedByOperatorId) {
      writeLine(output, `approvedByOperatorId: ${result.consumedClaim.approvedByOperatorId}`);
    }
  }

  if (result.ownerBinding) {
    writeLine(output, `ownerBinding: ${result.ownerBinding.ownerBindingId}`);
    writeLine(output, `ownerSubjectRef: ${result.ownerBinding.ownerSubjectRef}`);
    writeLine(output, `ownerActorId: ${result.ownerBinding.ownerActorId}`);
    renderConversationRef(output, "pairedConversation", result.ownerBinding.pairedConversationRef);
  }
}

export function renderResetOwnerBindingResult(output: CliWriter, result: CliResetOwnerBindingResult) {
  writeLine(output, `outcome: ${result.outcome}`);
  writeLine(output, `source: ${result.state.source}`);
  writeLine(output, `accountId: ${result.state.accountId}`);
  writeLine(output, `authorityStatus: ${result.state.status}`);
  writeLine(output, `ownerGeneration: ${result.state.ownerGeneration}`);
  writeLine(output, `newOwnerGeneration: ${result.newOwnerGeneration}`);
  writeLine(output, `revokedTrustCount: ${result.revokedTrustCount}`);
  writeLine(output, `supersededClaimCount: ${result.supersededClaimCount}`);

  if (result.revokedOwnerBinding) {
    writeLine(output, `revokedOwnerBinding: ${result.revokedOwnerBinding.ownerBindingId}`);
    if (result.revokedOwnerBinding.revokedReason) {
      writeLine(output, `revokedReason: ${result.revokedOwnerBinding.revokedReason}`);
    }
    if (result.revokedOwnerBinding.revokedByOperatorId) {
      writeLine(output, `revokedByOperatorId: ${result.revokedOwnerBinding.revokedByOperatorId}`);
    }
  }
}

export function renderListTrustedConversationsResult(output: CliWriter, result: CliListTrustedConversationsResult) {
  writeLine(output, `source: ${result.state.source}`);
  writeLine(output, `accountId: ${result.state.accountId}`);
  writeLine(output, `authorityStatus: ${result.state.status}`);
  writeLine(output, `ownerGeneration: ${result.state.ownerGeneration}`);

  if (result.bindings.length === 0) {
    writeLine(output, "trusted: none");
    return;
  }

  for (const binding of result.bindings) {
    writeLine(
      output,
      `trust: ${binding.trustId} status=${binding.status} key=${binding.conversationKey} coverage=${binding.coverage} grantKind=${binding.grantKind} generation=${binding.ownerGeneration}`
    );
    writeLine(output, `  grantedByOwnerBindingId: ${binding.grantedByOwnerBindingId}`);
    writeLine(output, `  grantedAt: ${binding.grantedAt}`);
    if (binding.revokedAt) {
      writeLine(output, `  revokedAt: ${binding.revokedAt}`);
    }
    if (binding.revokedReason) {
      writeLine(output, `  revokedReason: ${binding.revokedReason}`);
    }
    if (binding.revokedByOperatorId) {
      writeLine(output, `  revokedByOperatorId: ${binding.revokedByOperatorId}`);
    }
    renderConversationRef(output, "  conversation", binding.conversationRef);
  }
}

export function renderRevokeTrustedConversationResult(output: CliWriter, result: CliRevokeTrustedConversationResult) {
  writeLine(output, `outcome: ${result.outcome}`);
  writeLine(output, `source: ${result.state.source}`);
  writeLine(output, `accountId: ${result.state.accountId}`);
  writeLine(output, `authorityStatus: ${result.state.status}`);
  writeLine(output, `ownerGeneration: ${result.state.ownerGeneration}`);
  writeLine(output, `affectedOutboundLegality: ${result.affectedOutboundLegality ? "yes" : "no"}`);

  if (result.revokedBinding) {
    writeLine(output, `trustId: ${result.revokedBinding.trustId}`);
    writeLine(output, `trustStatus: ${result.revokedBinding.status}`);
    if (result.revokedBinding.revokedReason) {
      writeLine(output, `revokedReason: ${result.revokedBinding.revokedReason}`);
    }
    if (result.revokedBinding.revokedByOperatorId) {
      writeLine(output, `revokedByOperatorId: ${result.revokedBinding.revokedByOperatorId}`);
    }
    renderConversationRef(output, "conversation", result.revokedBinding.conversationRef);
  }
}

export function renderStatusResult(output: CliWriter, result: CliStatusResult) {
  writeLine(output, `product: ${result.productName}`);
  writeLine(output, `dataDir: ${result.dataDir}`);
  writeLine(output, "capabilities:");
  writeLine(output, `- execute: ${result.capabilities.execute ? "yes" : "no"}`);
  writeLine(output, `- history: ${result.capabilities.history ? "yes" : "no"}`);
  writeLine(output, `- artifactRead: ${result.capabilities.artifactRead ? "yes" : "no"}`);
  writeLine(output, `- evidenceRead: ${result.capabilities.evidenceRead ? "yes" : "no"}`);

  for (const line of formatStatusSnapshotLines({
    status: result,
    audience: "operator"
  })) {
    writeLine(output, line);
  }
}

export function renderSessionListResult(output: CliWriter, result: CliSessionListResult) {
  if (result.items.length === 0) {
    writeLine(output, "no sessions found");
    return;
  }

  for (const item of result.items) {
    writeLine(
      output,
      `session: ${item.sessionId} workspace=${item.workspaceId} source=${item.source} mode=${item.mode} status=${item.status} lastTurnAt=${item.lastTurnAt} createdAt=${item.createdAt}`
    );
    if (item.currentGoal) {
      writeLine(output, `  goal: ${item.currentGoal}`);
    }
  }

  renderNextCursor(output, result.nextCursor);
}

export function renderSessionBrowseResult(output: CliWriter, result: CliSessionBrowseResult) {
  if (result.items.length === 0) {
    writeLine(output, "no session history entries found");
    return;
  }

  for (const item of result.items) {
    renderSessionEventEntry(output, item);
  }

  renderNextCursor(output, result.nextCursor);
}

export function renderSessionSearchResult(output: CliWriter, result: CliSessionSearchResult) {
  if (result.hits.length === 0) {
    writeLine(output, "no session event hits found");
    return;
  }

  for (const hit of result.hits) {
    renderSessionEventEntry(output, hit, [`snippet: ${hit.snippet}`]);
  }

  renderNextCursor(output, result.nextCursor);
}

export function renderSessionLookupResult(output: CliWriter, result: CliSessionLookupResult) {
  if (!result.entry) {
    writeLine(output, "event not found");
    return false;
  }

  renderSessionEventEntry(output, result.entry);
  return true;
}

export function renderArtifactPreviewResult(output: CliWriter, result: CliArtifactPreviewResult) {
  if (!result) {
    writeLine(output, "artifact: not found");
    return;
  }

  writeLine(output, `artifactId: ${result.artifactId}`);
  writeLine(output, `sessionId: ${result.ref.sessionId}`);
  writeLine(output, `turnId: ${result.ref.turnId}`);
  writeLine(output, `kind: ${result.ref.kind}`);
  writeLine(output, `mimeType: ${result.ref.mimeType ?? "unknown"}`);
  writeLine(output, `byteLength: ${result.byteLength}`);
  writeLine(output, `truncated: ${result.truncated ? "yes" : "no"}`);
  writeLine(output, "preview:");
  writeLine(output, result.previewText);
}

export function renderArtifactReadResult(output: CliWriter, result: CliArtifactReadResult) {
  if (!result) {
    writeLine(output, "artifact: not found");
    return;
  }

  writeLine(output, `artifactId: ${result.artifact.artifactId}`);
  writeLine(
    output,
    `range: offset=${result.range.offset} limit=${result.range.limit} returned=${result.range.returned}`
  );
  writeLine(output, `eof: ${result.eof ? "yes" : "no"}`);
  if (result.nextCursor) {
    writeLine(output, `nextCursor: ${result.nextCursor}`);
  }
  writeLine(output, "content:");
  writeLine(output, result.content ?? "");
}

export function renderEvidenceSearchResult(output: CliWriter, result: CliEvidenceSearchResult) {
  writeLine(output, `items: ${result.items.length}`);

  for (const item of result.items) {
    writeLine(output, `- evidenceId: ${item.evidenceId}`);
    writeLine(output, `  sessionId: ${item.sessionId}`);
    writeLine(output, `  topic: ${item.topic}`);
    writeLine(output, `  createdAt: ${item.createdAt}`);
    writeLine(output, `  content: ${item.content}`);
  }
}

export function createTurnId(now: () => number) {
  return `turn_${now()}`;
}
