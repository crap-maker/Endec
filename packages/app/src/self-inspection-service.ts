import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { type createAccessStore } from "@endec/access";
import { resolveAuth, type ProviderCatalog } from "@endec/ai";
import type { EndecConfigService } from "./endec-config-service.ts";
import type { Source } from "@endec/domain";
import type { RegisteredTool } from "@endec/tools";
import {
  resolveCanonicalVisibleModelSelection,
  type ProviderSelectionOverride
} from "./provider-selection.ts";

type AccessStore = ReturnType<typeof createAccessStore>;
type ProviderControlFieldSource = "persisted" | "env" | "derived_legacy" | "builtin" | "missing";
type SurfaceKind = "source" | "build" | "docs";
type SelfInspectionSurface = SurfaceKind | "config";
type SurfaceAction = "read" | "list" | "search";

type RuntimeConfigInspectionArgs = {
  revealSecretValues?: boolean;
};

const ROOT_DOC_FILES = new Set(["PRODUCT.md", "ARCHITECTURE.md", "README.md"]);
const GENERIC_ENV_DUMP_PATTERNS = [/^env$/iu, /^process\.env$/iu, /printenv/iu, /environment/iu];
const MAX_PREVIEW_CHARS = 4_000;
const MAX_LIST_RESULTS = 50;
const MAX_SEARCH_RESULTS = 20;
const SELF_INSPECTION_TOOL_NAMES = ["inspect_source", "inspect_build", "inspect_docs", "inspect_config"] as const;

export type SelfInspectionToolName = typeof SELF_INSPECTION_TOOL_NAMES[number];

export type SelfInspectionRequest = {
  source: Source;
  accountId: string;
  subcommand?: string;
  args: string[];
};

export type SelfInspectionService = ReturnType<typeof createSelfInspectionService>;

export function createSelfInspectionService(input: {
  repoRoot: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  providerCatalog?: ProviderCatalog;
  accessStore?: Pick<
    AccessStore,
    | "getProviderControl"
    | "getModelOverrides"
    | "getProviderSecret"
  >;
  configService: Pick<EndecConfigService, "getSnapshot" | "renderMaskedSummary">;
}) {
  const repoRoot = resolve(input.repoRoot);
  const dataDir = input.dataDir ? resolve(input.dataDir) : undefined;

  function normalizeArgs(args: string[]) {
    return args
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0);
  }

  function normalizeTarget(args: string[]) {
    const joined = normalizeArgs(args).join(" ").trim();
    return joined.length > 0 ? joined : undefined;
  }

  function normalizeRelativePath(path: string) {
    return path.replaceAll("\\", "/");
  }

  function isWithinDirectory(path: string, directory: string) {
    const relativePath = relative(directory, path);
    return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`));
  }

  function isProtectedRawQuery(target: string | undefined) {
    if (!target) {
      return false;
    }

    const normalized = target.trim();
    return GENERIC_ENV_DUMP_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  function isProtectedRawPath(targetPath: string, rawTarget: string | undefined) {
    const normalizedRawTarget = rawTarget?.trim().toLowerCase() ?? "";
    const normalizedPath = targetPath.toLowerCase();
    const relativePath = normalizeRelativePath(relative(repoRoot, targetPath)).toLowerCase();

    if (normalizedRawTarget === ".env" || normalizedRawTarget.endsWith("/.env") || normalizedPath.endsWith(`${sep}.env`)) {
      return true;
    }

    if (normalizedPath.endsWith(".sqlite") || normalizedPath.endsWith(".db")) {
      return true;
    }

    if (dataDir && isWithinDirectory(targetPath, dataDir)) {
      return true;
    }

    return relativePath === ".env" || relativePath.endsWith("/.env");
  }

  function isAllowedPathForKind(kind: SurfaceKind, relativePath: string) {
    if (kind === "source") {
      return relativePath.startsWith("packages/") && !relativePath.includes("/dist/");
    }

    if (kind === "build") {
      return relativePath.startsWith("dist/") || /^packages\/[^/]+\/dist\//u.test(relativePath);
    }

    return relativePath.startsWith("docs/") || ROOT_DOC_FILES.has(relativePath);
  }

  function renderFilePreview(kind: SurfaceKind, relativePath: string, content: string) {
    const truncated = content.length > MAX_PREVIEW_CHARS;
    const preview = truncated ? `${content.slice(0, MAX_PREVIEW_CHARS).trimEnd()}\n[truncated]` : content.trimEnd();
    return `${kind}: ${relativePath}\n${preview}`;
  }

  function parseIntegerFlag(value: string | undefined, options: { min: number }) {
    if (!value) {
      return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < options.min) {
      return undefined;
    }

    return parsed;
  }

  function parseSurfaceFlags(tokens: string[]) {
    const positional: string[] = [];
    let pattern: string | undefined;
    let limit: number | undefined;
    let offset: number | undefined;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "--pattern") {
        pattern = tokens[index + 1];
        index += 1;
        continue;
      }
      if (token === "--limit") {
        limit = parseIntegerFlag(tokens[index + 1], { min: 1 });
        index += 1;
        continue;
      }
      if (token === "--offset") {
        offset = parseIntegerFlag(tokens[index + 1], { min: 0 });
        index += 1;
        continue;
      }

      positional.push(token);
    }

    return {
      positional,
      pattern,
      limit,
      offset
    };
  }

  function matchesGlobPattern(pattern: string, value: string) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "__DOUBLE_STAR__")
      .replace(/\*/g, "[^/]*")
      .replace(/__DOUBLE_STAR__/g, ".*");
    return new RegExp(`^${escaped}$`, "u").test(value);
  }

  async function pathExists(targetPath: string) {
    try {
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async function collectFilesUnder(relativeDir: string): Promise<string[]> {
    const basePath = join(repoRoot, relativeDir);
    if (!await pathExists(basePath)) {
      return [];
    }

    const entries = await readdir(basePath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const entryRelativePath = normalizeRelativePath(join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        files.push(...await collectFilesUnder(entryRelativePath));
        continue;
      }
      if (entry.isFile()) {
        files.push(entryRelativePath);
      }
    }

    return files;
  }

  async function listSurfaceFiles(kind: SurfaceKind): Promise<string[]> {
    if (kind === "source") {
      return (await collectFilesUnder("packages")).filter((path) => isAllowedPathForKind(kind, path));
    }

    if (kind === "build") {
      return [
        ...(await collectFilesUnder("dist")),
        ...(await collectFilesUnder("packages"))
      ].filter((path, index, all) => all.indexOf(path) === index && isAllowedPathForKind(kind, path));
    }

    const rootDocs = await Promise.all([...ROOT_DOC_FILES].map(async (file) =>
      await pathExists(join(repoRoot, file)) ? file : null
    ));
    return [
      ...(await collectFilesUnder("docs")).filter((path) => isAllowedPathForKind(kind, path)),
      ...rootDocs.filter((path): path is string => path !== null)
    ];
  }

  function renderSurfaceUsage(kind: SurfaceKind) {
    return [
      `Usage: /inspect ${kind} <repo-relative-path>`,
      `       /inspect ${kind} read <repo-relative-path> [--offset N] [--limit N]`,
      `       /inspect ${kind} list [repo-relative-dir] [--pattern GLOB] [--limit N]`,
      `       /inspect ${kind} search <text> [repo-relative-path-or-dir] [--limit N]`
    ].join("\n");
  }

  function resolveAllowedSurfaceTarget(kind: SurfaceKind, rawTarget: string | undefined) {
    if (!rawTarget) {
      return undefined;
    }

    if (isProtectedRawQuery(rawTarget)) {
      return {
        error: "Protected raw target. Use /inspect config for structured masked runtime configuration."
      } as const;
    }

    const resolvedPath = resolve(repoRoot, rawTarget);
    if (isProtectedRawPath(resolvedPath, rawTarget)) {
      return {
        error: "Protected raw target. Use /inspect config for structured masked runtime configuration."
      } as const;
    }

    const relativePath = normalizeRelativePath(relative(repoRoot, resolvedPath));
    if (relativePath.startsWith("../") || relativePath === ".." || !isAllowedPathForKind(kind, relativePath)) {
      return {
        error: `Unsupported ${kind} target. Use a repo-relative path within the allowed ${kind} surface.`
      } as const;
    }

    return {
      resolvedPath,
      relativePath
    } as const;
  }

  function filterSurfaceFilesByTarget(files: string[], relativeTarget: string | undefined) {
    if (!relativeTarget) {
      return files;
    }

    const directoryPrefix = relativeTarget.endsWith("/") ? relativeTarget : `${relativeTarget}/`;
    return files.filter((file) => file === relativeTarget || file.startsWith(directoryPrefix));
  }

  async function inspectSurfaceRead(kind: SurfaceKind, target: string | undefined, offset?: number, limit?: number): Promise<string> {
    if (!target) {
      return renderSurfaceUsage(kind);
    }

    const resolvedTarget = resolveAllowedSurfaceTarget(kind, target);
    if (!resolvedTarget || "error" in resolvedTarget) {
      return resolvedTarget?.error ?? renderSurfaceUsage(kind);
    }

    try {
      const content = await readFile(resolvedTarget.resolvedPath, "utf8");
      const start = Math.max(0, offset ?? 0);
      const maxLength = Math.min(Math.max(1, limit ?? MAX_PREVIEW_CHARS), MAX_PREVIEW_CHARS);
      const snippet = content.slice(start, start + maxLength);
      const truncated = start + maxLength < content.length;
      return `${kind}: ${resolvedTarget.relativePath}\n${snippet.trimEnd()}${truncated ? "\n[truncated]" : ""}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `Unable to inspect ${kind} target ${resolvedTarget.relativePath}: ${reason}`;
    }
  }

  async function inspectSurfaceList(kind: SurfaceKind, target: string | undefined, pattern?: string, limit?: number): Promise<string> {
    const resolvedTarget = resolveAllowedSurfaceTarget(kind, target);
    if (resolvedTarget && "error" in resolvedTarget) {
      return resolvedTarget.error ?? `Unsupported ${kind} target. Use a repo-relative path within the allowed ${kind} surface.`;
    }

    const allFiles = await listSurfaceFiles(kind);
    const scopedFiles = filterSurfaceFilesByTarget(allFiles, resolvedTarget?.relativePath);
    const matchedFiles = scopedFiles
      .filter((file) => pattern ? matchesGlobPattern(pattern, file) : true)
      .slice(0, limit ?? MAX_LIST_RESULTS);

    if (matchedFiles.length === 0) {
      return `No matching ${kind} files found.`;
    }

    return [`${kind} files:`, ...matchedFiles].join("\n");
  }

  async function inspectSurfaceSearch(kind: SurfaceKind, query: string | undefined, target: string | undefined, limit?: number): Promise<string> {
    if (!query) {
      return renderSurfaceUsage(kind);
    }

    const resolvedTarget = resolveAllowedSurfaceTarget(kind, target);
    if (resolvedTarget && "error" in resolvedTarget) {
      return resolvedTarget.error ?? `Unsupported ${kind} target. Use a repo-relative path within the allowed ${kind} surface.`;
    }

    const allFiles = await listSurfaceFiles(kind);
    const scopedFiles = filterSurfaceFilesByTarget(allFiles, resolvedTarget?.relativePath);
    const maxMatches = limit ?? MAX_SEARCH_RESULTS;
    const matches: string[] = [];

    for (const file of scopedFiles) {
      const content = await readFile(join(repoRoot, file), "utf8");
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!line.includes(query)) {
          continue;
        }

        matches.push(`${file}:${index + 1}: ${line}`);
        if (matches.length >= maxMatches) {
          return [`${kind} search: ${query}`, ...matches].join("\n");
        }
      }
    }

    if (matches.length === 0) {
      return `No ${kind} matches found for ${query}.`;
    }

    return [`${kind} search: ${query}`, ...matches].join("\n");
  }

  async function inspectSurface(kind: SurfaceKind, args: string[]): Promise<string> {
    const normalized = normalizeArgs(args);
    if (normalized.length === 0) {
      return renderSurfaceUsage(kind);
    }

    const legacyTarget = normalizeTarget(normalized);
    const firstArg = normalized[0]?.toLowerCase();
    if (firstArg !== "read" && firstArg !== "list" && firstArg !== "search") {
      return inspectSurfaceRead(kind, legacyTarget);
    }

    const { positional, pattern, limit, offset } = parseSurfaceFlags(normalized.slice(1));
    if (firstArg === "list") {
      return inspectSurfaceList(kind, normalizeTarget(positional.slice(0, 1)), pattern, limit);
    }

    if (firstArg === "search") {
      const query = positional[0];
      const target = normalizeTarget(positional.slice(1, 2));
      return inspectSurfaceSearch(kind, query, target, limit);
    }

    return inspectSurfaceRead(kind, normalizeTarget(positional.slice(0, 1)), offset, limit);
  }

  function mapVisibleSource(source: "persisted_provider_control" | "env" | "derived_legacy" | "catalog"): Exclude<ProviderControlFieldSource, "persisted"> {
    switch (source) {
      case "env":
        return "env";
      case "derived_legacy":
        return "derived_legacy";
      case "catalog":
      case "persisted_provider_control":
        return "builtin";
    }
  }

  function mapResolvedAuthSource(source: "explicit" | "env" | "literal" | "none"): Exclude<ProviderControlFieldSource, "persisted"> {
    switch (source) {
      case "env":
        return "env";
      case "literal":
      case "explicit":
        return "builtin";
      case "none":
        return "missing";
    }
  }

  function resolveConfigRevealArgs(args: string[]) {
    const normalizedArgs = normalizeArgs(args);
    return {
      revealSecretValues: normalizedArgs.includes("--reveal"),
      targetArgs: normalizedArgs.filter((arg) => arg !== "--reveal")
    } satisfies {
      revealSecretValues: boolean;
      targetArgs: string[];
    };
  }

  function maskSecret(secret: string | undefined) {
    if (!secret) {
      return undefined;
    }

    if (secret.length <= 4) {
      return "****";
    }

    return `${secret.slice(0, 3)}****${secret.slice(-4)}`;
  }

  function resolveFullSecret(inputValue: {
    persistedSecret?: string;
    fallbackSecret?: string;
    fallbackSource: Exclude<ProviderControlFieldSource, "persisted">;
  }) {
    if (typeof inputValue.persistedSecret === "string" && inputValue.persistedSecret.trim().length > 0) {
      return {
        value: inputValue.persistedSecret,
        source: "persisted" as const
      };
    }

    if (typeof inputValue.fallbackSecret === "string" && inputValue.fallbackSecret.trim().length > 0) {
      return {
        value: inputValue.fallbackSecret,
        source: inputValue.fallbackSource
      };
    }

    return {
      value: undefined,
      source: "missing" as const
    };
  }

  async function inspectConfig(request: Pick<SelfInspectionRequest, "source" | "accountId" | "args">): Promise<string> {
    const { revealSecretValues, targetArgs } = resolveConfigRevealArgs(request.args);
    const target = normalizeTarget(targetArgs);
    if (target && isProtectedRawQuery(target)) {
      return "Protected raw target. Use /inspect config without extra targets to view structured masked runtime configuration.";
    }

    const snapshot = await input.configService.getSnapshot({ source: request.source, accountId: request.accountId });
    const [persistedControl, persistedSecret] = input.accessStore
      ? await Promise.all([
          input.accessStore.getProviderControl({
            source: request.source,
            accountId: request.accountId
          }).catch(() => undefined),
          input.accessStore.getProviderSecret({
            source: request.source,
            accountId: request.accountId
          }).catch(() => undefined)
        ])
      : [undefined, undefined];

    const providerId = persistedControl?.providerId ?? snapshot.config.provider.providerId;
    const modelId = persistedControl?.modelId ?? snapshot.config.provider.modelId;
    const baseUrl = persistedControl?.baseUrlOverride ?? snapshot.config.provider.baseUrl;
    const apiKey = persistedSecret?.apiKey ?? snapshot.config.provider.apiKey;
    const source = persistedControl?.providerId || persistedControl?.modelId || persistedControl?.baseUrlOverride
      ? "persisted"
      : snapshot.source === "seeded_endec_json"
        ? "env"
        : "builtin";
    const apiKeySource = persistedSecret?.apiKey ? "persisted" : snapshot.config.provider.apiKey ? source : "missing";
    const embeddingKeySource = snapshot.config.embeddings.apiKey ? source : "missing";

    return [
      `config: ${snapshot.path}`,
      `schemaVersion: ${snapshot.schemaVersion}`,
      `loadedAt: ${snapshot.loadedAt}`,
      `source: ${snapshot.source}`,
      `provider: ${providerId} (source: ${source})`,
      `model: ${modelId} (source: ${source})`,
      `baseUrl: ${baseUrl ?? "missing"} (source: ${baseUrl ? source : "missing"})`,
      revealSecretValues
        ? `apiKey: ${apiKey ?? "missing"} (source: ${apiKeySource})`
        : `apiKey: ${maskSecret(apiKey) ?? "missing"} (source: ${apiKeySource})`,
      `embeddings: ${snapshot.config.embeddings.enabled ? "enabled" : "disabled"}`,
      `embeddingProvider: ${snapshot.config.embeddings.providerId}/${snapshot.config.embeddings.modelId}`,
      `embeddingBaseUrl: ${snapshot.config.embeddings.baseUrl ?? "missing"}`,
      revealSecretValues
        ? `embeddingApiKey: ${snapshot.config.embeddings.apiKey ?? "missing"} (source: ${embeddingKeySource})`
        : `embeddingApiKey: ${maskSecret(snapshot.config.embeddings.apiKey) ?? "missing"} (source: ${embeddingKeySource})`,
      `embeddingIndexBackend: ${snapshot.config.embeddings.indexBackend}`,
      `embeddingAllowedKinds: ${snapshot.config.embeddings.allowedKinds.join(", ")}`
    ].join("\n");
  }

  async function inspect(request: SelfInspectionRequest): Promise<string> {
    const subcommand = request.subcommand?.trim().toLowerCase();
    switch (subcommand) {
      case "source":
        return inspectSurface("source", request.args);
      case "build":
        return inspectSurface("build", request.args);
      case "docs":
        return inspectSurface("docs", request.args);
      case "config":
        return inspectConfig(request);
      default:
        return [
          "Usage:",
          renderSurfaceUsage("source"),
          renderSurfaceUsage("build"),
          renderSurfaceUsage("docs"),
          "/inspect config [--reveal]"
        ].join("\n");
    }
  }

  return {
    inspect
  };
}

function requireArgumentsObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, unknown>;
  }

  return value as Record<string, unknown>;
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNonNegativeInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function createTextToolOutput(value: string) {
  return {
    normalizedPayload: {
      contentType: "text" as const,
      value
    }
  };
}

function buildRuntimeSurfaceArgs(args: Record<string, unknown>) {
  const action = optionalNonEmptyString(args, "action")?.toLowerCase();
  const path = optionalNonEmptyString(args, "path");
  const query = optionalNonEmptyString(args, "query");
  const pattern = optionalNonEmptyString(args, "pattern");
  const offset = optionalNonNegativeInteger(args, "offset");
  const limit = optionalPositiveInteger(args, "limit");

  const runtimeArgs: string[] = [];
  if (action === "list") {
    runtimeArgs.push("list");
    if (path) {
      runtimeArgs.push(path);
    }
  } else if (action === "search") {
    runtimeArgs.push("search");
    if (query) {
      runtimeArgs.push(query);
    }
    if (path) {
      runtimeArgs.push(path);
    }
  } else {
    if (action === "read") {
      runtimeArgs.push("read");
    }
    if (path) {
      runtimeArgs.push(path);
    }
  }

  if (pattern) {
    runtimeArgs.push("--pattern", pattern);
  }
  if (offset !== undefined) {
    runtimeArgs.push("--offset", String(offset));
  }
  if (limit !== undefined) {
    runtimeArgs.push("--limit", String(limit));
  }

  return runtimeArgs;
}

export function createSelfInspectionRuntimeTools(input: {
  service: SelfInspectionService;
  source: Source;
  accountId: string;
  allowSecretReveal?: boolean;
}): RegisteredTool[] {
  return [
    {
      name: "inspect_source",
      description: "Inspect bounded Endec source under packages/. Supports action=read|list|search for snippet reads, file discovery, and text search across the allowed source surface.",
      hiddenByDefault: false,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "list", "search"] },
          path: { type: "string" },
          query: { type: "string" },
          pattern: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        }
      },
      async execute(context) {
        const args = requireArgumentsObject(context.arguments);
        return createTextToolOutput(await input.service.inspect({
          source: input.source,
          accountId: input.accountId,
          subcommand: "source",
          args: buildRuntimeSurfaceArgs(args)
        }));
      }
    },
    {
      name: "inspect_build",
      description: "Inspect bounded Endec build artifacts under dist/. Supports action=read|list|search.",
      hiddenByDefault: false,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "list", "search"] },
          path: { type: "string" },
          query: { type: "string" },
          pattern: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        }
      },
      async execute(context) {
        const args = requireArgumentsObject(context.arguments);
        return createTextToolOutput(await input.service.inspect({
          source: input.source,
          accountId: input.accountId,
          subcommand: "build",
          args: buildRuntimeSurfaceArgs(args)
        }));
      }
    },
    {
      name: "inspect_docs",
      description: "Inspect bounded Endec docs under docs/ or root product docs. Supports action=read|list|search.",
      hiddenByDefault: false,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "list", "search"] },
          path: { type: "string" },
          query: { type: "string" },
          pattern: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        }
      },
      async execute(context) {
        const args = requireArgumentsObject(context.arguments);
        return createTextToolOutput(await input.service.inspect({
          source: input.source,
          accountId: input.accountId,
          subcommand: "docs",
          args: buildRuntimeSurfaceArgs(args)
        }));
      }
    },
    {
      name: "inspect_config",
      description: input.allowSecretReveal
        ? "Inspect structured Endec runtime config. This owner-private turn is authorized to reveal full secret values when revealSecretValues=true because the owner explicitly asked for it."
        : "Inspect structured Endec runtime config with masked secrets by default. revealSecretValues=true is ignored unless this is an explicit owner-private reveal request.",
      hiddenByDefault: false,
      inputSchema: {
        type: "object",
        properties: {
          revealSecretValues: { type: "boolean" }
        }
      },
      async execute(context) {
        const args = requireArgumentsObject(context.arguments);
        const revealRequested = optionalBoolean(args, "revealSecretValues") === true;
        const runtimeArgs = revealRequested && input.allowSecretReveal ? ["--reveal"] : [];
        return createTextToolOutput(await input.service.inspect({
          source: input.source,
          accountId: input.accountId,
          subcommand: "config",
          args: runtimeArgs
        }));
      }
    }
  ];
}
