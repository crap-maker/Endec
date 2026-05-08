import type { WorkingSetSurface } from "@endec/domain";

function normalizeText(value: string | undefined) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringList(values: string[] | undefined) {
  return [...new Set((values ?? [])
    .map((value) => normalizeText(value))
    .filter((value): value is string => typeof value === "string"))];
}

export function renderWorkingSetSummary(
  input: Pick<WorkingSetSurface, "objective" | "recentProgress" | "recentDecisions" | "blockers" | "openLoops">,
  fallbackSummary?: string
) {
  const sections: string[] = [];

  if (input.objective) {
    sections.push(`Objective: ${input.objective}`);
  }

  if (input.recentProgress.length > 0) {
    sections.push(["Recent progress:", ...input.recentProgress.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.recentDecisions.length > 0) {
    sections.push(["Recent decisions:", ...input.recentDecisions.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.blockers.length > 0) {
    sections.push(["Blockers:", ...input.blockers.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.openLoops.length > 0) {
    sections.push(["Open loops:", ...input.openLoops.map((item) => `- ${item}`)].join("\n"));
  }

  if (sections.length > 0) {
    return sections.join("\n\n");
  }

  return normalizeText(fallbackSummary) ?? "";
}

export function normalizeWorkingSetSurface(
  input: Partial<WorkingSetSurface> & Pick<WorkingSetSurface, "sourceRefs"> & { summary?: string }
): WorkingSetSurface {
  const objective = normalizeText(input.objective);
  const recentProgress = normalizeStringList(input.recentProgress);
  const recentDecisions = normalizeStringList(input.recentDecisions);
  const blockers = normalizeStringList(input.blockers);
  const openLoops = normalizeStringList(input.openLoops);
  const activeMemoryRefs = normalizeStringList(input.activeMemoryRefs);
  const activeTaskRefs = normalizeStringList(input.activeTaskRefs);
  const recentEventRefs = normalizeStringList(input.recentEventRefs);
  const sourceRefs = normalizeStringList(input.sourceRefs);

  return {
    ref: normalizeText(input.ref),
    version: input.version,
    summary: renderWorkingSetSummary(
      {
        objective,
        recentProgress,
        recentDecisions,
        blockers,
        openLoops
      },
      input.summary
    ),
    objective,
    recentProgress,
    recentDecisions,
    blockers,
    openLoops,
    activeMemoryRefs,
    activeTaskRefs,
    recentEventRefs,
    sourceRefs
  };
}
