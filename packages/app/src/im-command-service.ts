import type { createAccessStore } from "@endec/access";
import type { ConversationScope, ImCommandIntent, PersonaScopeKind, TurnRequest } from "@endec/domain";
import type {
  EndecImCommandExecutionResult,
  EndecImModelPickerOption,
  EndecImSource
} from "./types.ts";
import { DEFAULT_PROVIDER_ID } from "./provider-selection.ts";
import { formatStatusSnapshotLines, type AppStatusSnapshot } from "./status.ts";
import type { ResolveConversationTargetResult } from "./conversation-directory.ts";
import type { createProviderControlService } from "./provider-control-service.ts";
import type { createSelfInspectionService } from "./self-inspection-service.ts";

type CommandExecutionResult = EndecImCommandExecutionResult;
type AccessStore = ReturnType<typeof createAccessStore>;
type ProviderControlService = ReturnType<typeof createProviderControlService>;
type SelfInspectionService = ReturnType<typeof createSelfInspectionService>;

type ImCommandServiceInput = {
  accessStore: Pick<
    AccessStore,
    | "inspectOwnerBinding"
    | "matchTrustedConversation"
    | "listTrustedConversations"
    | "getProviderControl"
    | "upsertProviderControl"
    | "clearProviderSecret"
    | "upsertPersonaProfile"
    | "getPersonaProfile"
    | "ensureTrustedConversation"
  >;
  resolveConversationTarget: (input: {
    source: EndecImSource;
    accountId: string;
    currentConversationRef?: TurnRequest["conversationRef"];
    target?: string;
  }) => Promise<ResolveConversationTargetResult | undefined>;
  resolveCurrentModel: (input: {
    source: EndecImSource;
    accountId?: string;
  }) => Promise<{
    providerId: string;
    modelId: string;
    baseUrl?: string;
    selectionSource: string;
  }>;
  listSelectableModels?: () => Promise<EndecImModelPickerOption[]> | EndecImModelPickerOption[];
  providerControlService?: Pick<ProviderControlService, "execute" | "renderKey">;
  selfInspectionService?: Pick<SelfInspectionService, "inspect">;
  updateCurrentModel?: (input: {
    source: EndecImSource;
    accountId: string;
    providerId: string;
    modelId: string;
    updatedByActorId: string;
    clearProviderScopedSecrets?: boolean;
  }) => Promise<void>;
  reloadConfig?: (input: {
    source: EndecImSource;
    accountId?: string;
  }) => Promise<{ source: string; loadedAt: string; schemaVersion: number }>;
  requestRestart?: (input: {
    source: EndecImSource;
    accountId?: string;
    actorId: string;
  }) => Promise<void | (() => void | Promise<void>) | undefined> | (() => void | Promise<void>) | undefined;
  getStatusSnapshot?: (input: {
    sessionId?: string;
    source?: EndecImSource;
    accountId?: string;
    suppressSessionTruth?: boolean;
  }) => Promise<AppStatusSnapshot>;
};

function replyText(replyText: string): EndecImCommandExecutionResult {
  return { kind: "reply_text", replyText };
}

function replyModelPicker(replyText: string, options: EndecImModelPickerOption[]): EndecImCommandExecutionResult {
  return { kind: "reply_model_picker", replyText, options };
}

function readCommandSubcommand(commandIntent: ImCommandIntent) {
  return commandIntent.subcommand?.trim().toLowerCase();
}

function joinCommandArgs(commandIntent: ImCommandIntent) {
  return commandIntent.args.join(" ").trim();
}

function currentBoundary(turnRequest: TurnRequest, conversationScope: ConversationScope) {
  return turnRequest.imContext?.boundary ?? {
    boundaryKey: turnRequest.conversationRef?.conversationId ?? turnRequest.conversationRef?.baseConversationId ?? turnRequest.sessionId,
    conversationScope,
    disclosureMode: "local_only" as const,
    targetConversationKeys: [],
    borrowedConversationKeys: [],
    transientBorrowed: false
  };
}

function currentConversationSummary(turnRequest: TurnRequest) {
  return turnRequest.conversationRef?.conversationId
    ?? turnRequest.conversationRef?.baseConversationId
    ?? turnRequest.sessionId;
}

function parseProviderModelSelectionArgs(commandIntent: ImCommandIntent) {
  const [providerModelOrProvider, maybeModelId] = commandIntent.args;
  if (!providerModelOrProvider) {
    return undefined;
  }

  if (maybeModelId) {
    return {
      providerId: providerModelOrProvider,
      modelId: maybeModelId
    } as const;
  }

  const separatorIndex = providerModelOrProvider.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === providerModelOrProvider.length - 1) {
    return undefined;
  }

  return {
    providerId: providerModelOrProvider.slice(0, separatorIndex),
    modelId: providerModelOrProvider.slice(separatorIndex + 1)
  } as const;
}

function describePersonaScope(scopeKind: PersonaScopeKind) {
  switch (scopeKind) {
    case "owner_direct":
      return "owner direct";
    case "shared_default":
      return "shared default";
    case "conversation_override":
      return "conversation override";
  }
}

function formatModelRef(input: { providerId: string; modelId: string }) {
  const modelId = input.providerId === DEFAULT_PROVIDER_ID && ["cheap-default", "strong-default"].includes(input.modelId)
    ? "default"
    : input.modelId;
  return `${input.providerId}/${modelId}`;
}

function formatVisibleModelId(input: { providerId: string; modelId: string }) {
  return input.providerId === DEFAULT_PROVIDER_ID && ["cheap-default", "strong-default"].includes(input.modelId)
    ? "default"
    : input.modelId;
}

export function createImCommandService(input: ImCommandServiceInput) {
  async function loadOwnerContext(turnRequest: TurnRequest) {
    const accountId = turnRequest.conversationRef?.accountId;
    if (!accountId || (turnRequest.source !== "telegram" && turnRequest.source !== "feishu")) {
      return {
        accountId,
        ownerBinding: undefined,
        isOwner: false
      };
    }

    const ownerBinding = await input.accessStore.inspectOwnerBinding({
      source: turnRequest.source,
      accountId
    });

    return {
      accountId,
      ownerBinding,
      isOwner: ownerBinding?.ownerActorId === turnRequest.actorId
    };
  }

  async function resolveCrossConversationSelection(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }) {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId || inputValue.conversationScope !== "direct" || !owner.isOwner) {
      return replyText("This cross-conversation command is only available in the owner private chat.");
    }

    const boundary = currentBoundary(inputValue.turnRequest, inputValue.conversationScope);
    if (inputValue.commandIntent.options.all === true) {
      const trusted = await input.accessStore.listTrustedConversations({
        source: inputValue.turnRequest.source,
        accountId: owner.accountId
      });
      const targetConversationKeys = [...new Set(trusted.map((binding) => binding.conversationKey))];
      if (targetConversationKeys.length === 0) {
        return replyText("No trusted shared conversations are available.");
      }

      return {
        accountId: owner.accountId,
        boundary: {
          ...boundary,
          disclosureMode: "owner_cross_group" as const,
          targetConversationKeys,
          borrowedConversationKeys: targetConversationKeys,
          transientBorrowed: true
        },
        conversationSummary: targetConversationKeys.join(", "),
        latestSessionId: undefined
      };
    }

    const resolved = await input.resolveConversationTarget({
      source: inputValue.turnRequest.source as EndecImSource,
      accountId: owner.accountId,
      currentConversationRef: inputValue.turnRequest.conversationRef,
      target: typeof inputValue.commandIntent.options.chat === "string"
        ? inputValue.commandIntent.options.chat
        : undefined
    });
    if (!resolved) {
      return replyText("Unknown conversation target. Use /status in a shared chat first or provide a known --chat label.");
    }

    const trusted = await input.accessStore.listTrustedConversations({
      source: inputValue.turnRequest.source,
      accountId: owner.accountId
    });
    if (!trusted.some((binding) => {
      if (binding.coverage === "exact") {
        return resolved.conversationKey === binding.conversationKey;
      }

      return resolved.conversationKey === binding.conversationKey
        || resolved.conversationKey.startsWith(`${binding.conversationKey}:`);
    })) {
      return replyText("That target is not a trusted shared conversation.");
    }

    return {
      accountId: owner.accountId,
      boundary: {
        ...boundary,
        disclosureMode: "owner_targeted" as const,
        targetConversationKeys: [resolved.conversationKey],
        borrowedConversationKeys: [resolved.conversationKey],
        transientBorrowed: true
      },
      conversationSummary: resolved.conversationLabel ?? resolved.conversationKey,
      latestSessionId: resolved.latestSessionId
    };
  }

  function hasCrossConversationRequest(commandIntent: ImCommandIntent) {
    return commandIntent.options.all === true || typeof commandIntent.options.chat === "string";
  }

  async function handleStatus(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }) {
    let boundary = currentBoundary(inputValue.turnRequest, inputValue.conversationScope);
    let conversationSummary = currentConversationSummary(inputValue.turnRequest);
    let accountId = inputValue.turnRequest.conversationRef?.accountId;
    let statusSessionId: string | undefined = inputValue.turnRequest.sessionId;
    let suppressSessionTruth = false;

    if (hasCrossConversationRequest(inputValue.commandIntent)) {
      const resolved = await resolveCrossConversationSelection(inputValue);
      if ("kind" in resolved) {
        return resolved;
      }
      boundary = resolved.boundary;
      conversationSummary = resolved.conversationSummary;
      accountId = resolved.accountId;
      if (resolved.latestSessionId) {
        statusSessionId = resolved.latestSessionId;
      } else if (resolved.boundary.borrowedConversationKeys.length > 0) {
        statusSessionId = undefined;
        suppressSessionTruth = true;
      }
    }

    const trusted = boundary.borrowedConversationKeys.length > 0
      ? { trustId: "borrowed" }
      : accountId && inputValue.turnRequest.conversationRef
        ? await input.accessStore.matchTrustedConversation({
            source: inputValue.turnRequest.source,
            accountId,
            conversationRef: inputValue.turnRequest.conversationRef
          })
        : undefined;
    const owner = await loadOwnerContext(inputValue.turnRequest);
    const isOwnerPrivate = inputValue.conversationScope === "direct" && owner.isOwner;

    const borrowedStatusView = boundary.borrowedConversationKeys.length > 0;
    const renderedScope = borrowedStatusView
      ? "shared (borrowed)"
      : boundary.conversationScope;
    const renderedPersonaScope = borrowedStatusView
      ? "unknown"
      : inputValue.turnRequest.imContext?.resolvedPersona?.scopeKind ?? "none";
    const lines = [
      `conversation: ${conversationSummary}`,
      `scope: ${renderedScope}`,
      `disclosureMode: ${boundary.disclosureMode}`,
      `personaScopeKind: ${renderedPersonaScope}`,
      `trusted: ${trusted ? "yes" : "no"}`
    ];

    if (isOwnerPrivate && boundary.borrowedConversationKeys.length > 0) {
      lines.push(`borrowedConversationKeys: ${boundary.borrowedConversationKeys.join(", ")}`);
    }

    if (input.getStatusSnapshot) {
      const status = await input.getStatusSnapshot({
        sessionId: statusSessionId,
        source: inputValue.turnRequest.source as EndecImSource,
        accountId,
        suppressSessionTruth: suppressSessionTruth || inputValue.commandIntent.options.all === true
      });
      lines.push(...formatStatusSnapshotLines({
        status,
        audience: isOwnerPrivate ? "owner_private" : "shared"
      }));
      return replyText(lines.join("\n"));
    }

    const currentModel = await input.resolveCurrentModel({
      source: inputValue.turnRequest.source as EndecImSource,
      accountId
    });
    lines.push(`model: ${formatModelRef(currentModel)}`);

    if (isOwnerPrivate && currentModel.baseUrl) {
      lines.push(`baseUrl: ${currentModel.baseUrl}`);
    }

    return replyText(lines.join("\n"));
  }

  async function handleRecall(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId || inputValue.conversationScope !== "direct" || !owner.isOwner) {
      return replyText("/recall is only available in the owner private chat.");
    }

    const recallPrompt = joinCommandArgs(inputValue.commandIntent);
    if (!recallPrompt) {
      return replyText("Usage: /recall --chat <conversation> <question> or /recall --all <question>");
    }

    const resolvedBoundary = await resolveCrossConversationSelection(inputValue);
    if ("kind" in resolvedBoundary) {
      return resolvedBoundary;
    }

    return {
      kind: "dispatch_turn",
      turnRequest: {
        ...inputValue.turnRequest,
        input: recallPrompt,
        imContext: {
          ...inputValue.turnRequest.imContext,
          activationKind: "command_execution",
          commandIntent: inputValue.commandIntent,
          boundary: resolvedBoundary.boundary
        }
      }
    };
  }

  async function listSelectableModels() {
    const options = await input.listSelectableModels?.() ?? [];
    return [...options];
  }

  async function renderModelConnectionSummary(inputValue: {
    turnRequest: TurnRequest;
    accountId: string;
  }) {
    const currentModel = await input.resolveCurrentModel({
      source: inputValue.turnRequest.source as EndecImSource,
      accountId: inputValue.accountId
    });
    const lines = [`model: ${formatVisibleModelId(currentModel)}`];

    if (currentModel.baseUrl) {
      lines.push(`baseUrl: ${currentModel.baseUrl}`);
    }

    const keyLine = await input.providerControlService?.renderKey(false);
    if (keyLine) {
      lines.push(keyLine);
    }

    return lines;
  }

  async function handleModel(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId) {
      return replyText("This command requires an IM account-scoped conversation.");
    }

    return replyText((await renderModelConnectionSummary({
      turnRequest: inputValue.turnRequest,
      accountId: owner.accountId
    })).join("\n"));
  }

  async function handleModels(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId) {
      return replyText("This command requires an IM account-scoped conversation.");
    }

    if (inputValue.conversationScope !== "direct" || !owner.isOwner) {
      return replyText("/models is owner-only and only available in the owner private chat. Shared chats stay read-only; use /model here to inspect the active model.");
    }

    const subcommand = readCommandSubcommand(inputValue.commandIntent);
    const selectableModels = await listSelectableModels();

    if (subcommand === "select") {
      const parsed = parseProviderModelSelectionArgs(inputValue.commandIntent);
      if (!parsed) {
        return replyText("Usage: /models select <provider/model>");
      }

      const selected = selectableModels.find((option) =>
        option.providerId === parsed.providerId && option.modelId === parsed.modelId);
      if (!selected) {
        return replyText(`Unknown model selection ${parsed.providerId}/${parsed.modelId}. Use /models to choose an available model.`);
      }

      if (input.updateCurrentModel) {
        const currentModel = await input.resolveCurrentModel({
          source: inputValue.turnRequest.source as EndecImSource,
          accountId: owner.accountId
        });
        const providerChanged = currentModel.providerId !== selected.providerId;

        await input.updateCurrentModel({
          source: inputValue.turnRequest.source as EndecImSource,
          accountId: owner.accountId,
          providerId: selected.providerId,
          modelId: selected.modelId,
          updatedByActorId: inputValue.turnRequest.actorId,
          clearProviderScopedSecrets: providerChanged
        });

        return replyText(`Updated model: ${formatModelRef(selected)}`);
      }

      const [existing, currentModel] = await Promise.all([
        input.accessStore.getProviderControl({
          source: inputValue.turnRequest.source,
          accountId: owner.accountId
        }),
        input.resolveCurrentModel({
          source: inputValue.turnRequest.source as EndecImSource,
          accountId: owner.accountId
        })
      ]);
      const providerChanged = currentModel.providerId !== selected.providerId;

      await input.accessStore.upsertProviderControl({
        source: inputValue.turnRequest.source,
        accountId: owner.accountId,
        providerId: selected.providerId,
        modelId: selected.modelId,
        baseUrlOverride: providerChanged ? undefined : existing?.baseUrlOverride,
        updatedByActorId: inputValue.turnRequest.actorId
      });
      if (providerChanged) {
        await input.accessStore.clearProviderSecret({
          source: inputValue.turnRequest.source,
          accountId: owner.accountId
        });
      }

      return replyText(`Updated model: ${formatModelRef(selected)}`);
    }

    if (selectableModels.length === 0) {
      return replyText("No selectable execute models are currently available.");
    }

    return replyModelPicker("Choose the active model:", selectableModels);
  }

  async function handlePersona(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId || !owner.ownerBinding) {
      return replyText("/persona requires a paired owner context.");
    }

    const subcommand = readCommandSubcommand(inputValue.commandIntent);
    if (subcommand !== "set") {
      const scopeKind = inputValue.turnRequest.imContext?.resolvedPersona?.scopeKind;
      return replyText(`personaScopeKind: ${scopeKind ?? "none"}`);
    }

    if (!owner.isOwner) {
      return replyText("/persona set is owner-only.");
    }

    const styleInstructions = joinCommandArgs(inputValue.commandIntent);
    if (!styleInstructions) {
      return replyText("Usage: /persona set <instructions>");
    }

    let scopeKind: PersonaScopeKind;
    let conversationKey: string | undefined;
    if (inputValue.conversationScope === "shared") {
      scopeKind = "conversation_override";
      conversationKey = inputValue.turnRequest.conversationRef?.baseConversationId
        ?? inputValue.turnRequest.conversationRef?.conversationId;
      if (!conversationKey) {
        return replyText("/persona set in shared chats requires a current conversation.");
      }
    } else if (inputValue.commandIntent.options["shared-default"] === true) {
      scopeKind = "shared_default";
    } else {
      scopeKind = "owner_direct";
    }

    await input.accessStore.upsertPersonaProfile({
      source: inputValue.turnRequest.source,
      accountId: owner.accountId,
      ownerBindingId: owner.ownerBinding.ownerBindingId,
      ownerGeneration: owner.ownerBinding.ownerGeneration,
      scopeKind,
      conversationKey,
      styleInstructions,
      behaviorInstructions: "",
      updatedByActorId: inputValue.turnRequest.actorId
    });

    return replyText(`Updated ${describePersonaScope(scopeKind)} persona.`);
  }

  async function handleTrust(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    const subcommand = readCommandSubcommand(inputValue.commandIntent);
    if (subcommand && subcommand !== "here") {
      return replyText("Usage: /trust here");
    }

    if (!owner.accountId || !owner.isOwner) {
      return replyText("/trust here is owner-only.");
    }

    if (inputValue.conversationScope !== "shared" || !inputValue.turnRequest.conversationRef) {
      return replyText("/trust here must be used in the current shared chat.");
    }

    const coverage = "exact" as const;
    await input.accessStore.ensureTrustedConversation({
      source: inputValue.turnRequest.source,
      accountId: owner.accountId,
      conversationRef: inputValue.turnRequest.conversationRef,
      coverage,
      grantKind: "owner_auto"
    });

    return replyText(`Trusted current shared conversation (${currentConversationSummary(inputValue.turnRequest)}).`);
  }

  async function handleProvider(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }) {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId || inputValue.conversationScope !== "direct" || !owner.isOwner) {
      return replyText("/provider is only available in the owner private chat.");
    }

    const subcommand = readCommandSubcommand(inputValue.commandIntent);
    if (!subcommand || subcommand === "show") {
      const summary = await renderModelConnectionSummary({
        turnRequest: inputValue.turnRequest,
        accountId: owner.accountId
      });
      return replyText(["已合并到 /model。", ...summary].join("\n"));
    }

    if (!input.providerControlService) {
      return replyText("/provider is not configured for this runtime.");
    }

    const reply = await input.providerControlService.execute({
      source: inputValue.turnRequest.source,
      accountId: owner.accountId,
      updatedByActorId: inputValue.turnRequest.actorId,
      commandIntent: inputValue.commandIntent,
      allowReveal: inputValue.commandIntent.options.reveal === true
    });
    return replyText(reply);
  }

  async function handleInspect(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId || inputValue.conversationScope !== "direct" || !owner.isOwner) {
      return replyText("/inspect is only available in the owner private chat.");
    }

    const subcommand = readCommandSubcommand(inputValue.commandIntent);
    if (!subcommand) {
      return replyText("直接告诉我你想检查什么。我会在当前边界内处理。");
    }

    if (!input.selfInspectionService) {
      return replyText("/inspect is not configured for this runtime.");
    }

    return replyText(await input.selfInspectionService.inspect({
      source: inputValue.turnRequest.source,
      accountId: owner.accountId,
      subcommand: inputValue.commandIntent.subcommand,
      args: inputValue.commandIntent.options.reveal === true
        ? [...inputValue.commandIntent.args, "--reveal"]
        : inputValue.commandIntent.args
    }));
  }

  async function handleReload(inputValue: {
    turnRequest: TurnRequest;
    conversationScope: ConversationScope;
  }) {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId || inputValue.conversationScope !== "direct" || !owner.isOwner) {
      return replyText("/reload is only available in the owner private chat.");
    }
    if (!input.reloadConfig) {
      return replyText("/reload is not configured for this runtime.");
    }

    const snapshot = await input.reloadConfig({
      source: inputValue.turnRequest.source as EndecImSource,
      accountId: owner.accountId
    });
    return replyText([
      "Reloaded config.",
      `source: ${snapshot.source}`,
      `schemaVersion: ${snapshot.schemaVersion}`,
      `loadedAt: ${snapshot.loadedAt}`
    ].join("\n"));
  }

  async function handleRestart(inputValue: {
    turnRequest: TurnRequest;
    conversationScope: ConversationScope;
  }) {
    const owner = await loadOwnerContext(inputValue.turnRequest);
    if (!owner.accountId || inputValue.conversationScope !== "direct" || !owner.isOwner) {
      return replyText("/restart is only available in the owner private chat.");
    }
    if (!input.requestRestart) {
      return replyText("/restart is not configured for this runtime.");
    }

    const afterReplyDelivered = await input.requestRestart({
      source: inputValue.turnRequest.source as EndecImSource,
      accountId: owner.accountId,
      actorId: inputValue.turnRequest.actorId
    });
    if (!afterReplyDelivered) {
      return replyText("/restart is not configured for this runtime.");
    }

    return {
      kind: "reply_text" as const,
      replyText: "Graceful restart requested. The runtime will exit so the supervisor can start it again.",
      afterReplyDelivered
    };
  }

  async function handleHelp(inputValue: {
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
    turnRequest: TurnRequest;
  }) {
    const unknownCommand = typeof inputValue.commandIntent.options.unknownCommand === "string"
      ? inputValue.commandIntent.options.unknownCommand
      : undefined;
    if (unknownCommand) {
      return replyText(`Unknown command: /${unknownCommand}. Use /help for the supported command list.`);
    }

    const targetCommand = typeof inputValue.commandIntent.args[0] === "string" ? inputValue.commandIntent.args[0] : undefined;
    if (targetCommand === "recall") {
      return replyText("/recall --chat <conversation> <question>\n/recall --all <question>");
    }
    if (targetCommand === "provider") {
      return inputValue.conversationScope === "direct" && (await loadOwnerContext(inputValue.turnRequest)).isOwner
        ? replyText("已合并到 /model。你可以直接用 /model 查看当前模型、baseUrl 和 masked key。")
        : replyText("/provider is only available in the owner private chat.");
    }
    if (targetCommand === "inspect") {
      return inputValue.conversationScope === "direct" && (await loadOwnerContext(inputValue.turnRequest)).isOwner
        ? replyText("直接告诉我你想检查什么。我会在当前边界内处理。")
        : replyText("/inspect is only available in the owner private chat.");
    }
    if (targetCommand === "reload") {
      return inputValue.conversationScope === "direct" && (await loadOwnerContext(inputValue.turnRequest)).isOwner
        ? replyText("/reload")
        : replyText("/reload is only available in the owner private chat.");
    }
    if (targetCommand === "restart") {
      return inputValue.conversationScope === "direct" && (await loadOwnerContext(inputValue.turnRequest)).isOwner
        ? replyText("/restart")
        : replyText("/restart is only available in the owner private chat.");
    }

    const owner = await loadOwnerContext(inputValue.turnRequest);
    const lines = inputValue.conversationScope === "shared"
      ? ["Commands here:", "/help", "/status", "/history", "/model", "/persona", "/trust here"]
      : owner.isOwner
        ? ["Owner private-chat commands:", "/help", "/status [--chat <conversation>|--all]", "/history [--chat <conversation>|--all]", "/model", "/models", "/persona", "/recall", "Advanced:", "/reload", "/restart", "Tip: 直接告诉我你想检查什么。"]
        : ["Commands:", "/help", "/status", "/history"];

    return replyText(lines.join("\n"));
  }

  async function handleHistory(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    const historyPrompt = joinCommandArgs(inputValue.commandIntent) || "Summarize the recent history for this conversation.";

    if (hasCrossConversationRequest(inputValue.commandIntent)) {
      const resolved = await resolveCrossConversationSelection(inputValue);
      if ("kind" in resolved) {
        return resolved;
      }

      return {
        kind: "dispatch_turn",
        turnRequest: {
          ...inputValue.turnRequest,
          input: historyPrompt,
          imContext: {
            ...inputValue.turnRequest.imContext,
            activationKind: "command_execution",
            commandIntent: inputValue.commandIntent,
            boundary: resolved.boundary
          }
        }
      };
    }

    return {
      kind: "dispatch_turn",
      turnRequest: {
        ...inputValue.turnRequest,
        input: historyPrompt,
        imContext: {
          ...inputValue.turnRequest.imContext,
          activationKind: "command_execution",
          commandIntent: inputValue.commandIntent,
          boundary: {
            ...currentBoundary(inputValue.turnRequest, inputValue.conversationScope),
            disclosureMode: "local_only",
            targetConversationKeys: [],
            borrowedConversationKeys: [],
            transientBorrowed: false
          }
        }
      }
    };
  }

  async function execute(inputValue: {
    turnRequest: TurnRequest;
    commandIntent: ImCommandIntent;
    conversationScope: ConversationScope;
  }): Promise<CommandExecutionResult> {
    if (inputValue.commandIntent.helpRequested) {
      return handleHelp(inputValue);
    }

    switch (inputValue.commandIntent.name) {
      case "help":
        return handleHelp(inputValue);
      case "status":
        return handleStatus(inputValue);
      case "model":
        return handleModel(inputValue);
      case "models":
        return handleModels(inputValue);
      case "provider":
        return handleProvider(inputValue);
      case "inspect":
        return handleInspect(inputValue);
      case "reload":
        return handleReload(inputValue);
      case "restart":
        return handleRestart(inputValue);
      case "persona":
        return handlePersona(inputValue);
      case "history":
        return handleHistory(inputValue);
      case "trust":
        return handleTrust(inputValue);
      case "recall":
        return handleRecall(inputValue);
      default:
        return replyText("Unknown command. Use /help for the supported command list.");
    }
  }

  return {
    execute
  };
}
