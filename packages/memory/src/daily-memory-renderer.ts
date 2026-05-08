import {
  DAILY_MEMORY_SECTION_TITLES,
  collectProjectionDerivedRefs,
  collectProjectionSourceRefs,
  collectProjectionTurnRefs,
  partitionDailyMemoryRecords
} from "./projection-derived-refs.ts";
import type { MaterializedTypedMemoryRecord } from "./typed-memory.ts";

function compactText(value: string, maxLength = 160) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "(empty)";
  }

  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function stripSummaryLines(content: string, summary: string) {
  const normalizedSummary = summary.trim();

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== normalizedSummary && line !== `summary: ${normalizedSummary}`);
}

function renderRecord(record: MaterializedTypedMemoryRecord) {
  const lines = [
    `- [${record.memoryType}] ${compactText(record.summary)}`,
    `  - memory_id: ${record.memoryId}`,
    `  - session_id: ${record.sessionId}`,
    `  - source_turn_id: ${record.sourceTurnId}`,
    `  - updated_at: ${record.updatedAt}`
  ];

  if (record.evidenceRefs.length > 0) {
    lines.push("  - refs:");
    for (const ref of [...new Set(record.evidenceRefs)].sort()) {
      lines.push(`    - ${ref}`);
    }
  }

  const detailLines = stripSummaryLines(record.content, record.summary);
  if (detailLines.length > 0) {
    lines.push("  - detail:");
    for (const detailLine of detailLines) {
      lines.push(`    - ${detailLine}`);
    }
  }

  return lines.join("\n");
}

function renderSection(title: string, records: MaterializedTypedMemoryRecord[]) {
  if (records.length === 0) {
    return [`## ${title}`, "_No entries._"].join("\n");
  }

  return [`## ${title}`, ...records.map(renderRecord)].join("\n\n");
}

export function buildDailyMemoryProjection(input: {
  workspaceId: string;
  day: string;
  records: MaterializedTypedMemoryRecord[];
}) {
  const sortedRecords = [...input.records].sort((left, right) =>
    left.updatedAt.localeCompare(right.updatedAt)
    || left.memoryType.localeCompare(right.memoryType)
    || left.memoryId.localeCompare(right.memoryId)
  );
  const sections = partitionDailyMemoryRecords(sortedRecords);
  const sourceRefs = collectProjectionSourceRefs(sortedRecords);
  const turnRefs = collectProjectionTurnRefs(sortedRecords);
  const latestUpdateAt = sortedRecords[sortedRecords.length - 1]?.updatedAt ?? `${input.day}T00:00:00.000Z`;

  return {
    content: [
      "# Daily Memory Projection",
      "",
      `- workspace_id: ${input.workspaceId}`,
      `- day: ${input.day}`,
      "- source: canonical typed memory materialization",
      `- memory_count: ${sortedRecords.length}`,
      `- latest_update_at: ${latestUpdateAt}`,
      "",
      renderSection(DAILY_MEMORY_SECTION_TITLES.decisions, sections.decisions),
      "",
      renderSection(DAILY_MEMORY_SECTION_TITLES.blockers, sections.blockers),
      "",
      renderSection(DAILY_MEMORY_SECTION_TITLES.followUps, sections.followUps),
      "",
      renderSection(DAILY_MEMORY_SECTION_TITLES.durableFacts, sections.durableFacts),
      "",
      "## Source refs / turn refs",
      "### Source refs",
      ...(sourceRefs.length > 0 ? sourceRefs.map((ref) => `- ${ref}`) : ["_No entries._"]),
      "",
      "### Turn refs",
      ...(turnRefs.length > 0 ? turnRefs.map((ref) => `- ${ref}`) : ["_No entries._"]),
      ""
    ].join("\n"),
    projectionDerivedRefs: collectProjectionDerivedRefs({
      workspaceId: input.workspaceId,
      day: input.day,
      sections
    })
  };
}

export function renderDailyMemoryProjection(input: {
  workspaceId: string;
  day: string;
  records: MaterializedTypedMemoryRecord[];
}) {
  return buildDailyMemoryProjection(input).content;
}
