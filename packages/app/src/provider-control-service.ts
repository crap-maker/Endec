import type { createAccessStore } from "@endec/access";
import type { ProviderCatalog } from "@endec/ai";
import { resolveAuth } from "@endec/ai";
import type { ImCommandIntent } from "@endec/domain";
import type { EndecConfigService } from "./endec-config-service.ts";
import { normalizeLegacyModelId } from "./provider-selection.ts";

type AccessStore = ReturnType<typeof createAccessStore>;

type ProviderControlServiceInput = {
  configService: Pick<EndecConfigService, "getSnapshot" | "renderMaskedSummary" | "updateProvider">;
  accessStore?: Pick<AccessStore, "upsertProviderControl" | "setProviderSecret" | "clearProviderSecret">;
  catalog: ProviderCatalog;
  env: Record<string, string | undefined>;
};

type ProviderCommandExecutionInput = {
  source: "cli" | "tui" | "telegram" | "feishu" | "web" | "sdk";
  accountId: string;
  updatedByActorId: string;
  commandIntent: ImCommandIntent;
  allowReveal: boolean;
};

function normalizeString(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function formatField(label: string, value: string | undefined, source: "persisted" | "env" | "builtin" | "missing") {
  return `${label}: ${value ?? "missing"} (source: ${source})`;
}

function readProviderSubcommand(commandIntent: ImCommandIntent) {
  return commandIntent.subcommand?.trim().toLowerCase();
}

function parseProviderModelArg(commandIntent: ImCommandIntent) {
  const [providerModelOrProvider, maybeModelId] = commandIntent.args;
  if (!providerModelOrProvider) {
    return undefined;
  }

  if (maybeModelId) {
    const modelId = normalizeLegacyModelId(maybeModelId);
    return modelId
      ? {
          providerId: providerModelOrProvider,
          modelId
        }
      : undefined;
  }

  const separatorIndex = providerModelOrProvider.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === providerModelOrProvider.length - 1) {
    return undefined;
  }

  const providerId = providerModelOrProvider.slice(0, separatorIndex);
  const modelId = normalizeLegacyModelId(providerModelOrProvider.slice(separatorIndex + 1));
  return modelId
    ? {
        providerId,
        modelId
      }
    : undefined;
}

function validateBaseUrlOverride(value: string | undefined) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return undefined;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    return undefined;
  }

  return parsed.toString().replace(/\/+$/u, parsed.pathname === "/" ? "/" : "");
}

function maskSecret(secret: string | undefined) {
  if (!secret) {
    return undefined;
  }

  if (secret.length <= 7) {
    return `${secret.slice(0, 2)}****`;
  }

  return `${secret.slice(0, 3)}****${secret.slice(-4)}`;
}

function formatProviderUsage() {
  return [
    "Usage:",
    "/provider",
    "/provider show",
    "/provider model <provider/model>",
    "/provider baseurl <url>",
    "/provider key show [--reveal]",
    "/provider key set <secret>",
    "/provider key clear"
  ].join("\n");
}

export function createProviderControlService(input: ProviderControlServiceInput) {
  async function getCurrentState() {
    return input.configService.getSnapshot();
  }

  async function renderSummary() {
    const snapshot = await getCurrentState();
    const provider = snapshot.config.provider;
    const resolvedModel = input.catalog.findModel({
      providerId: provider.providerId,
      modelId: provider.modelId
    });
    const resolvedAuth = resolvedModel ? resolveAuth(resolvedModel, { env: input.env }) : undefined;
    const baseUrlSource = provider.baseUrl ? "persisted" as const : resolvedAuth?.baseUrlSource === "env" ? "env" as const : "builtin" as const;
    const apiKeySource = provider.apiKey ? "persisted" as const : resolvedAuth?.apiKeySource === "env" ? "env" as const : resolvedAuth?.apiKey ? "builtin" as const : "missing" as const;

    return [
      formatField("provider", provider.providerId, "persisted"),
      formatField("model", provider.modelId, "persisted"),
      formatField("baseUrl", provider.baseUrl ?? resolvedAuth?.baseUrl, baseUrlSource),
      formatField("key", maskSecret(provider.apiKey) ?? maskSecret(resolvedAuth?.apiKey), apiKeySource)
    ].join("\n");
  }

  async function renderKey(allowReveal: boolean) {
    if (allowReveal) {
      const snapshot = await getCurrentState();
      return formatField("key", snapshot.config.provider.apiKey, snapshot.config.provider.apiKey ? "persisted" : "missing");
    }

    const snapshot = await getCurrentState();
    const provider = snapshot.config.provider;
    const resolvedModel = input.catalog.findModel({
      providerId: provider.providerId,
      modelId: provider.modelId
    });
    const resolvedAuth = resolvedModel ? resolveAuth(resolvedModel, { env: input.env }) : undefined;
    const source = provider.apiKey ? "persisted" as const : resolvedAuth?.apiKeySource === "env" ? "env" as const : resolvedAuth?.apiKey ? "builtin" as const : "missing" as const;
    return formatField("key", maskSecret(provider.apiKey) ?? maskSecret(resolvedAuth?.apiKey), source);
  }

  async function persistProviderControl(update: {
    source: ProviderCommandExecutionInput["source"];
    accountId: string;
    providerId?: string;
    modelId?: string;
    baseUrl?: string;
    apiKey?: string;
    clearBaseUrl?: boolean;
    clearApiKey?: boolean;
    updatedByActorId: string;
  }) {
    const snapshot = await input.configService.updateProvider({
      updatedByActorId: update.updatedByActorId,
      providerId: update.providerId,
      modelId: update.modelId,
      baseUrl: update.clearBaseUrl ? undefined : update.baseUrl,
      apiKey: update.clearApiKey ? undefined : update.apiKey,
      clearBaseUrl: update.clearBaseUrl,
      clearApiKey: update.clearApiKey
    });

    if (input.accessStore) {
      await input.accessStore.upsertProviderControl({
        source: update.source,
        accountId: update.accountId,
        providerId: snapshot.config.provider.providerId,
        modelId: snapshot.config.provider.modelId,
        baseUrlOverride: snapshot.config.provider.baseUrl,
        updatedByActorId: update.updatedByActorId
      });
      if (update.clearApiKey) {
        await input.accessStore.clearProviderSecret({
          source: update.source,
          accountId: update.accountId
        });
      } else if (typeof update.apiKey === "string" && update.apiKey.length > 0) {
        await input.accessStore.setProviderSecret({
          source: update.source,
          accountId: update.accountId,
          apiKey: update.apiKey,
          updatedByActorId: update.updatedByActorId
        });
      }
    }
  }

  async function handleModelUpdate(request: ProviderCommandExecutionInput) {
    const parsed = parseProviderModelArg(request.commandIntent);
    if (!parsed) {
      return "Usage: /provider model <provider/model>";
    }

    if (!input.catalog.findModel(parsed)) {
      return `Unknown provider/model selection ${parsed.providerId}/${parsed.modelId}.`;
    }

    const current = await getCurrentState();
    const providerChanged = current.config.provider.providerId !== parsed.providerId;

    await persistProviderControl({
      source: request.source,
      accountId: request.accountId,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      clearBaseUrl: providerChanged,
      clearApiKey: providerChanged,
      updatedByActorId: request.updatedByActorId
    });

    return renderSummary();
  }

  async function handleBaseUrlUpdate(request: ProviderCommandExecutionInput) {
    const rawBaseUrl = request.commandIntent.args[0];
    if (!normalizeString(rawBaseUrl)) {
      return "Usage: /provider baseurl <url>";
    }

    const baseUrlOverride = validateBaseUrlOverride(rawBaseUrl);
    if (!baseUrlOverride) {
      return "Invalid provider base URL. Use an absolute http(s) URL without embedded credentials, query strings, or fragments.";
    }

    await persistProviderControl({
      source: request.source,
      accountId: request.accountId,
      baseUrl: baseUrlOverride,
      updatedByActorId: request.updatedByActorId
    });
    return renderSummary();
  }

  async function handleKeyCommand(request: ProviderCommandExecutionInput) {
    const [action, ...tail] = request.commandIntent.args;
    const normalizedAction = action?.trim().toLowerCase();

    if (!normalizedAction || normalizedAction === "show") {
      if (request.commandIntent.options.reveal === true && !request.allowReveal) {
        return "Full key reveal is only available in the owner private chat.";
      }
      return renderKey(request.commandIntent.options.reveal === true && request.allowReveal);
    }

    if (normalizedAction === "set") {
      const apiKey = normalizeString(tail.join(" "));
      if (!apiKey) {
        return "Usage: /provider key set <secret>";
      }

      await persistProviderControl({
        source: request.source,
        accountId: request.accountId,
        apiKey,
        updatedByActorId: request.updatedByActorId
      });
      return renderSummary();
    }

    if (normalizedAction === "clear") {
      await persistProviderControl({
        source: request.source,
        accountId: request.accountId,
        clearApiKey: true,
        updatedByActorId: request.updatedByActorId
      });
      return renderSummary();
    }

    return formatProviderUsage();
  }

  async function execute(request: ProviderCommandExecutionInput) {
    const subcommand = readProviderSubcommand(request.commandIntent);
    if (!subcommand || subcommand === "show") {
      return renderSummary();
    }

    switch (subcommand) {
      case "model":
        return handleModelUpdate(request);
      case "baseurl":
        return handleBaseUrlUpdate(request);
      case "key":
        return handleKeyCommand(request);
      default:
        return formatProviderUsage();
    }
  }

  return {
    execute,
    renderSummary,
    renderKey
  };
}
