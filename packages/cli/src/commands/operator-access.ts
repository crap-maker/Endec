import {
  parseCommandArgs,
  readOptionalOption,
  readRequiredOption,
  CliUsageError
} from "../command-parser.ts";
import { cliDefaults, type CliCommandContext } from "../cli-types.ts";
import {
  renderApprovePairClaimResult,
  renderInspectOwnerBindingResult,
  renderListPairClaimsResult,
  renderListTrustedConversationsResult,
  renderResetOwnerBindingResult,
  renderRevokeTrustedConversationResult
} from "../cli-types.ts";

const CLI_SOURCES = ["cli", "tui", "telegram", "feishu", "web", "sdk"] as const;

type CliSource = (typeof CLI_SOURCES)[number];
type OperatorAccessSubcommand = "owner" | "pair-claims" | "pair-approve" | "owner-reset" | "trusted-list" | "trusted-revoke";

function assertNoPositionals(positionals: string[], subcommand: OperatorAccessSubcommand) {
  if (positionals.length > 0) {
    throw new CliUsageError(`operator ${subcommand} does not accept positional arguments`);
  }
}

function readSourceOption(options: Map<string, string | boolean>) {
  return readRequiredOption(options, "--source") as CliSource;
}

function readAccountOption(options: Map<string, string | boolean>) {
  return readRequiredOption(options, "--account");
}

function readOperatorActorId(options: Map<string, string | boolean>) {
  return readOptionalOption(options, "--operator-actor") ?? cliDefaults.actorId;
}

export function isOperatorAccessSubcommand(value: string | undefined): value is OperatorAccessSubcommand {
  return (
    value === "owner" ||
    value === "pair-claims" ||
    value === "pair-approve" ||
    value === "owner-reset" ||
    value === "trusted-list" ||
    value === "trusted-revoke"
  );
}

export async function operatorAccessCommand(
  resolveContext: () => Promise<CliCommandContext>,
  subcommand: OperatorAccessSubcommand,
  args: string[]
) {
  if (subcommand === "owner") {
    const { options, positionals } = parseCommandArgs(args, {
      stringOptions: ["--source", "--account"]
    });
    assertNoPositionals(positionals, subcommand);
    const source = readSourceOption(options);
    const accountId = readAccountOption(options);
    const context = await resolveContext();
    const result = await context.app.operator.inspectOwnerBinding({
      source,
      accountId
    });
    renderInspectOwnerBindingResult(context.stdout, result);
    return 0;
  }

  if (subcommand === "pair-claims") {
    const { options, positionals } = parseCommandArgs(args, {
      stringOptions: ["--source", "--account"]
    });
    assertNoPositionals(positionals, subcommand);
    const source = readSourceOption(options);
    const accountId = readAccountOption(options);
    const context = await resolveContext();
    const result = await context.app.operator.listPairClaims({
      source,
      accountId
    });
    renderListPairClaimsResult(context.stdout, result);
    return 0;
  }

  if (subcommand === "pair-approve") {
    const { options, positionals } = parseCommandArgs(args, {
      stringOptions: ["--source", "--account", "--code", "--operator-actor"]
    });
    assertNoPositionals(positionals, subcommand);
    const source = readSourceOption(options);
    const accountId = readAccountOption(options);
    const pairCode = readRequiredOption(options, "--code");
    const operatorActorId = readOperatorActorId(options);
    const context = await resolveContext();
    const result = await context.app.operator.approvePairClaim({
      source,
      accountId,
      pairCode,
      operatorActorId
    });
    renderApprovePairClaimResult(context.stdout, result);
    return 0;
  }

  if (subcommand === "owner-reset") {
    const { options, positionals } = parseCommandArgs(args, {
      stringOptions: ["--source", "--account", "--reason", "--operator-actor"]
    });
    assertNoPositionals(positionals, subcommand);
    const source = readSourceOption(options);
    const accountId = readAccountOption(options);
    const operatorActorId = readOperatorActorId(options);
    const reason = readOptionalOption(options, "--reason");
    const context = await resolveContext();
    const result = await context.app.operator.resetOwnerBinding({
      source,
      accountId,
      operatorActorId,
      reason
    });
    renderResetOwnerBindingResult(context.stdout, result);
    return 0;
  }

  if (subcommand === "trusted-list") {
    const { options, positionals } = parseCommandArgs(args, {
      stringOptions: ["--source", "--account"]
    });
    assertNoPositionals(positionals, subcommand);
    const source = readSourceOption(options);
    const accountId = readAccountOption(options);
    const context = await resolveContext();
    const result = await context.app.operator.listTrustedConversations({
      source,
      accountId
    });
    renderListTrustedConversationsResult(context.stdout, result);
    return 0;
  }

  const { options, positionals } = parseCommandArgs(args, {
    stringOptions: ["--source", "--account", "--trust", "--reason", "--operator-actor"]
  });
  assertNoPositionals(positionals, subcommand);
  const source = readSourceOption(options);
  const accountId = readAccountOption(options);
  const trustId = readRequiredOption(options, "--trust");
  const operatorActorId = readOperatorActorId(options);
  const reason = readOptionalOption(options, "--reason");
  const context = await resolveContext();
  const result = await context.app.operator.revokeTrustedConversation({
    source,
    accountId,
    trustId,
    operatorActorId,
    reason
  });
  renderRevokeTrustedConversationResult(context.stdout, result);
  return 0;
}
