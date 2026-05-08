import type {
  CapabilityTruth,
  ContextToolExposure,
  TurnActionAuthorization,
  TurnActionAuthorizationLevel
} from "@endec/domain";

const GUARANTEED_TOOL_NAMES = [
  "read",
  "glob",
  "grep",
  "write",
  "edit",
  "bash",
  "inspect_source",
  "inspect_build",
  "inspect_docs",
  "inspect_config"
] as const;
const READ_TOOL_NAMES = ["read", "glob", "grep", "inspect_source", "inspect_build", "inspect_docs", "inspect_config"] as const;
const WRITE_TOOL_NAMES = ["write", "edit"] as const;
const BASH_TOOL_NAMES = ["bash"] as const;

type BashCommandAuthorization = {
  actionClass: string;
  authorizationLevel: TurnActionAuthorizationLevel;
  boundaryReason: string;
  approvalPath?: string;
  examples: string[];
};

export function reclassifyCapabilityTruth(input: {
  exposure: Pick<ContextToolExposure, "exposedTools">;
}): CapabilityTruth {
  const visibleToolNames = input.exposure.exposedTools.map((tool) => tool.name);
  const visibleToolSet = new Set(visibleToolNames);
  const guaranteedToolNames = GUARANTEED_TOOL_NAMES.filter((toolName) => visibleToolSet.has(toolName));
  const guaranteedCapabilities: string[] = [];
  const approvalRequiredCapabilities: string[] = [];
  const notGuaranteedCapabilities: string[] = [];
  const actionAuthorizations: TurnActionAuthorization[] = [];

  reclassifyCapability({
    capabilityName: "workspace_read",
    authorizationLevel: "guaranteed",
    reachable: hasAnyVisibleTool(visibleToolSet, READ_TOOL_NAMES)
  }, { guaranteedCapabilities, approvalRequiredCapabilities, notGuaranteedCapabilities });
  reclassifyCapability({
    capabilityName: "workspace_write",
    authorizationLevel: "guaranteed",
    reachable: hasAnyVisibleTool(visibleToolSet, WRITE_TOOL_NAMES)
  }, { guaranteedCapabilities, approvalRequiredCapabilities, notGuaranteedCapabilities });
  reclassifyCapability({
    capabilityName: "workspace_local_routine_bash",
    authorizationLevel: "guaranteed",
    reachable: hasAnyVisibleTool(visibleToolSet, BASH_TOOL_NAMES)
  }, { guaranteedCapabilities, approvalRequiredCapabilities, notGuaranteedCapabilities });
  reclassifyCapability({
    capabilityName: "local_git_status",
    authorizationLevel: "guaranteed",
    reachable: hasAnyVisibleTool(visibleToolSet, BASH_TOOL_NAMES)
  }, { guaranteedCapabilities, approvalRequiredCapabilities, notGuaranteedCapabilities });
  reclassifyCapability({
    capabilityName: "local_git_commit",
    authorizationLevel: "guaranteed",
    reachable: hasAnyVisibleTool(visibleToolSet, BASH_TOOL_NAMES)
  }, { guaranteedCapabilities, approvalRequiredCapabilities, notGuaranteedCapabilities });
  reclassifyCapability({
    capabilityName: "remote_git_push",
    authorizationLevel: "approval-required",
    reachable: hasAnyVisibleTool(visibleToolSet, BASH_TOOL_NAMES)
  }, { guaranteedCapabilities, approvalRequiredCapabilities, notGuaranteedCapabilities });
  reclassifyCapability({
    capabilityName: "pull_request_create",
    authorizationLevel: "approval-required",
    reachable: hasAnyVisibleTool(visibleToolSet, BASH_TOOL_NAMES)
  }, { guaranteedCapabilities, approvalRequiredCapabilities, notGuaranteedCapabilities });

  notGuaranteedCapabilities.push("mainline_merge", "deploy", "production_side_effects");

  const readToolName = firstVisibleToolName(visibleToolSet, READ_TOOL_NAMES);
  if (readToolName) {
    actionAuthorizations.push({
      actionClass: "workspace_read",
      toolName: readToolName,
      authorizationLevel: "guaranteed",
      boundaryReason: "Reading files within the current workspace is part of the low-risk baseline.",
      examples: readExamplesForTool(readToolName)
    });
  }

  const writeToolName = firstVisibleToolName(visibleToolSet, WRITE_TOOL_NAMES);
  if (writeToolName) {
    actionAuthorizations.push({
      actionClass: "workspace_write",
      toolName: writeToolName,
      authorizationLevel: "guaranteed",
      boundaryReason: "Editing files within the isolated workspace stays inside the default execution boundary.",
      examples: writeExamplesForTool(writeToolName)
    });
  }

  if (visibleToolSet.has("bash")) {
    actionAuthorizations.push(
      {
        actionClass: "workspace_local_routine_bash",
        toolName: "bash",
        authorizationLevel: "guaranteed",
        boundaryReason: "Routine workspace-local commands stay inside the default execution boundary.",
        examples: ["pnpm test", "git status", "git commit -m 'slice1'"]
      },
      {
        actionClass: "remote_git_push",
        toolName: "bash",
        authorizationLevel: "approval-required",
        boundaryReason: "git push crosses from the local workspace into remote branch state.",
        approvalPath: "operator",
        examples: ["git push origin HEAD"]
      },
      {
        actionClass: "pull_request_create",
        toolName: "bash",
        authorizationLevel: "approval-required",
        boundaryReason: "Creating a PR publishes workspace changes to an external collaboration surface.",
        approvalPath: "operator",
        examples: ["gh pr create --fill"]
      },
      {
        actionClass: "deploy",
        toolName: "bash",
        authorizationLevel: "not-guaranteed",
        boundaryReason: "Deployment and equivalent external side effects require a stronger escalation path than this turn can guarantee.",
        examples: ["vercel deploy", "npm publish"]
      }
    );
  }

  return {
    visibleToolNames,
    guaranteedToolNames,
    guaranteedCapabilities,
    approvalRequiredCapabilities,
    notGuaranteedCapabilities: dedupe(notGuaranteedCapabilities),
    actionAuthorizations
  };
}

export function reclassifyCapability(
  input: {
    capabilityName: string;
    authorizationLevel: "guaranteed" | "approval-required" | "not-guaranteed";
    reachable: boolean;
  },
  buckets: {
    guaranteedCapabilities: string[];
    approvalRequiredCapabilities: string[];
    notGuaranteedCapabilities: string[];
  }
) {
  if (!input.reachable || input.authorizationLevel === "not-guaranteed") {
    buckets.notGuaranteedCapabilities.push(input.capabilityName);
    return;
  }

  if (input.authorizationLevel === "guaranteed") {
    buckets.guaranteedCapabilities.push(input.capabilityName);
    return;
  }

  buckets.approvalRequiredCapabilities.push(input.capabilityName);
}

function hasAnyVisibleTool(visibleToolSet: Set<string>, toolNames: readonly string[]) {
  return toolNames.some((toolName) => visibleToolSet.has(toolName));
}

function firstVisibleToolName(visibleToolSet: Set<string>, toolNames: readonly string[]) {
  return toolNames.find((toolName) => visibleToolSet.has(toolName));
}

function readExamplesForTool(toolName: string) {
  if (toolName === "glob") {
    return ["glob **/*.ts"];
  }

  if (toolName === "grep") {
    return ["grep pattern src"];
  }

  if (toolName === "inspect_source") {
    return ["inspect_source packages/app/src/create-endec-app.ts"];
  }

  if (toolName === "inspect_docs") {
    return ["inspect_docs PRODUCT.md"];
  }

  if (toolName === "inspect_config") {
    return ["inspect_config"];
  }

  return ["read path/to/file.ts"];
}

function writeExamplesForTool(toolName: string) {
  if (toolName === "edit") {
    return ["edit path/to/file.ts"];
  }

  return ["write path/to/file.ts", "edit path/to/file.ts"];
}

function dedupe(values: string[]) {
  return [...new Set(values)];
}

export function classifyBashCommandAuthorization(command: string): BashCommandAuthorization {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();

  if (matchesAny(normalized, [
    /^git push(?:\s|$)/,
    /(?:^|[;&|])\s*git push(?:\s|$)/,
    /^gh pr create(?:\s|$)/,
    /(?:^|[;&|])\s*gh pr create(?:\s|$)/,
    /^hub pull-request(?:\s|$)/,
    /(?:^|[;&|])\s*hub pull-request(?:\s|$)/
  ])) {
    return {
      actionClass: normalized.includes("git push") ? "remote_git_push" : "pull_request_create",
      authorizationLevel: "approval-required",
      boundaryReason: normalized.includes("git push")
        ? "git push crosses from the local workspace into remote branch state."
        : "Creating a PR publishes workspace changes to an external collaboration surface.",
      approvalPath: "operator",
      examples: normalized.includes("git push") ? ["git push origin HEAD"] : ["gh pr create --fill"]
    };
  }

  if (matchesAny(normalized, [
    /^git merge(?:\s|$)/,
    /(?:^|[;&|])\s*git merge(?:\s|$)/,
    /^gh pr merge(?:\s|$)/,
    /(?:^|[;&|])\s*gh pr merge(?:\s|$)/,
    /^vercel deploy(?:\s|$)/,
    /(?:^|[;&|])\s*vercel deploy(?:\s|$)/,
    /^npm publish(?:\s|$)/,
    /^pnpm publish(?:\s|$)/,
    /^yarn publish(?:\s|$)/,
    /^docker push(?:\s|$)/,
    /^kubectl(?:\s|$)/,
    /^terraform apply(?:\s|$)/
  ])) {
    return {
      actionClass: normalized.includes("merge") ? "mainline_merge" : "deploy",
      authorizationLevel: "not-guaranteed",
      boundaryReason: "This command has higher-risk external side effects than the current turn can authoritatively guarantee.",
      examples: [command]
    };
  }

  if (isGuaranteedRoutineCommand(normalized)) {
    return {
      actionClass: "workspace_local_routine_bash",
      authorizationLevel: "guaranteed",
      boundaryReason: "Routine workspace-local commands stay inside the default execution boundary.",
      examples: [command]
    };
  }

  return {
    actionClass: "workspace_command_not_guaranteed",
    authorizationLevel: "not-guaranteed",
    boundaryReason: "The system cannot authoritatively guarantee this bash action from the current boundary and policy context.",
    examples: [command]
  };
}

function isGuaranteedRoutineCommand(command: string) {
  return matchesAny(command, [
    /^(?:pwd|ls|find|tree|stat|cat|head|tail|wc|sort|uniq|cut|tr|printf|echo)(?:\s|$)/,
    /^(?:pnpm|npm|yarn|bun)\s+(?:test|lint|build|typecheck|check|format(?:(?:\s|$)|\s+--check(?:\s|$)))/,
    /^(?:cargo|go|pytest|python -m pytest|make|just)\s+(?:test|lint|build|check)(?:\s|$)/,
    /^git\s+(?:status|diff|log|show|rev-parse|branch|add|commit)(?:\s|$)/,
    /^gh\s+pr\s+status(?:\s|$)/
  ]);
}

function matchesAny(command: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(command));
}
