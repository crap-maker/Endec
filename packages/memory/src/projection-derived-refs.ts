import type { ProjectionDerivedRefSurfaceItem } from "@endec/domain";
import type { MaterializedTypedMemoryRecord } from "./typed-memory.ts";

export type DailyMemorySection = "decisions" | "blockers" | "followUps" | "durableFacts";

export const DAILY_MEMORY_SECTION_TITLES: Record<DailyMemorySection, string> = {
  decisions: "Decisions",
  blockers: "Blockers",
  followUps: "Follow-ups",
  durableFacts: "Durable facts / preferences"
};

function compactText(value: string, maxLength = 160) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(empty)";
  }

  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function isTurnRef(ref: string) {
  return ref.startsWith("turn_");
}

function summarizeRecords(records: MaterializedTypedMemoryRecord[], fallback: string) {
  const summary = records
    .map((record) => compactText(record.summary, 96))
    .slice(0, 2)
    .join(" · ");

  return summary || fallback;
}

export function classifyDailyMemorySection(record: MaterializedTypedMemoryRecord): DailyMemorySection {
  const haystack = [record.memoryType, record.summary, record.content]
    .join("\n")
    .toLowerCase();

  if (/decision|decide|chosen|choice/.test(haystack)) {
    return "decisions";
  }

  if (/blocker|blocked|blocking/.test(haystack)) {
    return "blockers";
  }

  if (/follow[_ -]?up|next[_ -]?action|todo|task_continuity/.test(haystack)) {
    return "followUps";
  }

  return "durableFacts";
}

export function partitionDailyMemoryRecords(records: MaterializedTypedMemoryRecord[]) {
  const sections: Record<DailyMemorySection, MaterializedTypedMemoryRecord[]> = {
    decisions: [],
    blockers: [],
    followUps: [],
    durableFacts: []
  };

  for (const record of records) {
    sections[classifyDailyMemorySection(record)].push(record);
  }

  return sections;
}

export function collectProjectionSourceRefs(records: MaterializedTypedMemoryRecord[]) {
  return [...new Set(records.flatMap((record) => [record.memoryId, ...record.evidenceRefs.filter((ref) => !isTurnRef(ref))]))].sort();
}

export function collectProjectionTurnRefs(records: MaterializedTypedMemoryRecord[]) {
  return [...new Set(records.flatMap((record) => [record.sourceTurnId, ...record.evidenceRefs.filter(isTurnRef)]))].sort();
}

export function collectProjectionDerivedRefs(input: {
  workspaceId: string;
  day: string;
  sections: Record<DailyMemorySection, MaterializedTypedMemoryRecord[]>;
}) {
  const allRecords = [
    ...input.sections.decisions,
    ...input.sections.blockers,
    ...input.sections.followUps,
    ...input.sections.durableFacts
  ];
  const refs: ProjectionDerivedRefSurfaceItem[] = [
    {
      ref: `projection:${input.workspaceId}:${input.day}`,
      day: input.day,
      section: "day",
      summary: summarizeRecords(allRecords, `Daily memory projection for ${input.day}.`),
      sourceRefs: collectProjectionSourceRefs(allRecords),
      turnRefs: collectProjectionTurnRefs(allRecords)
    }
  ];

  for (const section of Object.keys(input.sections) as DailyMemorySection[]) {
    const records = input.sections[section];
    if (records.length === 0) {
      continue;
    }

    refs.push({
      ref: `projection:${input.workspaceId}:${input.day}#${section}`,
      day: input.day,
      section,
      summary: summarizeRecords(records, `${DAILY_MEMORY_SECTION_TITLES[section]} for ${input.day}.`),
      sourceRefs: collectProjectionSourceRefs(records),
      turnRefs: collectProjectionTurnRefs(records)
    });
  }

  return refs;
}
