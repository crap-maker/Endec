import type { ContextToolExposure, RuntimeRequest } from "@endec/domain";
import type { StaticToolRegistry } from "./registry.ts";
import { toRuntimeToolDefinition } from "./registry.ts";

const READONLY_TOOL_NAMES = new Set(["read", "glob", "grep"]);
const ACT_TOOL_NAMES = new Set(["read", "glob", "grep", "write", "edit", "bash"]);
const UNIFIED_TOOL_NAMES = new Set(["read", "glob", "grep", "write", "edit", "bash"]);
const OWNER_PRIVATE_SELF_AWARENESS_TOOL_NAMES = new Set([
  "inspect_source",
  "inspect_build",
  "inspect_docs",
  "inspect_config"
]);

export function createReadonlyToolExposure(registry: StaticToolRegistry): ContextToolExposure {
  return createToolExposureFromNames(registry, READONLY_TOOL_NAMES);
}

export function createActToolExposure(registry: StaticToolRegistry): ContextToolExposure {
  return createToolExposureFromNames(registry, ACT_TOOL_NAMES);
}

export function createUnifiedToolExposure(registry: StaticToolRegistry): ContextToolExposure {
  return createToolExposureFromNames(registry, UNIFIED_TOOL_NAMES);
}

export function createOwnerPrivateSelfAwarenessToolExposure(
  registry: StaticToolRegistry,
  options?: { allowWorkspaceMutation?: boolean }
): ContextToolExposure {
  const exposedToolNames = new Set(OWNER_PRIVATE_SELF_AWARENESS_TOOL_NAMES);
  if (options?.allowWorkspaceMutation) {
    exposedToolNames.add("write");
    exposedToolNames.add("edit");
    exposedToolNames.add("bash");
  }

  return createToolExposureFromNames(registry, exposedToolNames);
}

export function createNoToolExposure(registry: StaticToolRegistry): ContextToolExposure {
  return createToolExposureFromNames(registry, new Set());
}

export function createCanonicalToolExposure(input: {
  registry: StaticToolRegistry;
  resolvedMode: RuntimeRequest["resolvedMode"];
}): ContextToolExposure {
  void input.resolvedMode;
  return createUnifiedToolExposure(input.registry);
}

export function isToolExposed(exposure: ContextToolExposure, toolName: string) {
  return exposure.exposedTools.some((tool) => tool.name === toolName);
}

function createToolExposureFromNames(registry: StaticToolRegistry, exposedToolNames: Set<string>): ContextToolExposure {
  const allTools = registry.listAll();

  return {
    exposureSource: "policy",
    exposedTools: allTools
      .filter((tool) => exposedToolNames.has(tool.name))
      .map((tool) => toRuntimeToolDefinition(tool)),
    hiddenToolNames: allTools
      .filter((tool) => !exposedToolNames.has(tool.name))
      .map((tool) => tool.name)
  };
}
