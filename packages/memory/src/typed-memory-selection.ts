import type {
  DurableMemoryObservability,
  DurableMemorySelectionItem,
  ExecutionRetrievalPolicy,
  MemoryQuery,
  TypedMemorySurfaceItem
} from "@endec/domain";
import {
  normalizeMemoryScope,
  passesScopeGate,
  scoreScope,
  scopeAppliesToContext
} from "./memory-scope.ts";
import { createMaterializedTypedMemorySurfaceItem, type MaterializedTypedMemoryRecord } from "./typed-memory.ts";

type TypedMemoryFamily = "fact" | "preference" | "procedural" | "continuity" | "other";
type TypedMemoryBucket =
  | "fact"
  | "preference"
  | "procedural"
  | "task_continuity"
  | "blocker"
  | "open_loop"
  | "decision"
  | "episodic"
  | "other";

type RankedCandidate = {
  row: MaterializedTypedMemoryRecord;
  scope: "session" | "workspace" | "user";
  bucket: TypedMemoryBucket;
  family: TypedMemoryFamily;
  lexicalScore: number;
  salienceScore: number;
  scopeScore: number;
  taskMatch: boolean;
};

function createCorrectionTarget(row: MaterializedTypedMemoryRecord) {
  return {
    kind: "typed_memory" as const,
    memoryId: row.memoryId,
    scope: row.scope,
    workspaceId: row.workspaceId,
    actorId: row.actorId,
    taskId: row.taskId
  };
}

const FAMILY_BUCKETS: Record<Exclude<TypedMemoryFamily, "other">, TypedMemoryBucket[]> = {
  fact: ["fact"],
  preference: ["preference"],
  procedural: ["procedural"],
  continuity: ["task_continuity", "blocker", "open_loop", "decision", "episodic"]
};

const ALL_BUCKETS: TypedMemoryBucket[] = [
  "fact",
  "preference",
  "procedural",
  "task_continuity",
  "blocker",
  "open_loop",
  "decision",
  "episodic",
  "other"
];

function normalizeMemoryType(memoryType: string) {
  return memoryType.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function classifyBucket(memoryType: string): TypedMemoryBucket {
  const normalized = normalizeMemoryType(memoryType);

  if (["fact", "durable_fact", "identity", "profile"].includes(normalized)) {
    return "fact";
  }

  if (normalized.includes("preference")) {
    return "preference";
  }

  if (["procedural", "procedure", "instruction", "workflow", "playbook", "how_to"].includes(normalized)) {
    return "procedural";
  }

  if (["task_continuity", "continuation", "active_task"].includes(normalized)) {
    return "task_continuity";
  }

  if (["blocker", "blocked", "blocking"].includes(normalized)) {
    return "blocker";
  }

  if (["open_loop", "follow_up", "followup", "todo"].includes(normalized)) {
    return "open_loop";
  }

  if (["decision", "recent_decision"].includes(normalized)) {
    return "decision";
  }

  if (["episodic", "turn_summary", "summary", "event", "note"].includes(normalized)) {
    return "episodic";
  }

  return "other";
}

function classifyFamily(bucket: TypedMemoryBucket): TypedMemoryFamily {
  if (bucket === "fact") {
    return "fact";
  }

  if (bucket === "preference") {
    return "preference";
  }

  if (bucket === "procedural") {
    return "procedural";
  }

  if (["task_continuity", "blocker", "open_loop", "decision", "episodic"].includes(bucket)) {
    return "continuity";
  }

  return "other";
}

function tokenize(value: string) {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function scoreText(queryText: string, ...values: string[]) {
  const queryTerms = tokenize(queryText);
  if (queryTerms.length === 0) {
    return 0;
  }

  const normalizedQuery = queryTerms.join(" ");
  const allTerms = new Set(values.flatMap((value) => tokenize(value)));
  const normalizedValues = values.map((value) => tokenize(value).join(" "));
  let score = 0;

  for (const normalizedValue of normalizedValues) {
    if (normalizedValue.includes(normalizedQuery)) {
      score += 8;
    }
  }

  if (queryTerms.every((term) => allTerms.has(term))) {
    score += 5;
  }

  for (const term of queryTerms) {
    if (allTerms.has(term)) {
      score += 2;
    }
  }

  return score;
}

function clampImportance(importance: number) {
  return Math.max(0, Math.min(1, importance));
}

function scoreSalience(row: MaterializedTypedMemoryRecord, bucket: TypedMemoryBucket, family: TypedMemoryFamily) {
  const familyWeights: Record<TypedMemoryFamily, number> = {
    fact: 4.5,
    preference: 4.2,
    procedural: 4,
    continuity: 3.6,
    other: 2
  };
  const bucketWeights: Record<TypedMemoryBucket, number> = {
    fact: 0.5,
    preference: 0.5,
    procedural: 0.6,
    task_continuity: 1.2,
    blocker: 1,
    open_loop: 0.9,
    decision: 0.8,
    episodic: 0.2,
    other: 0
  };
  const kindBonus = row.kind === "typed_upsert" ? 0.8 : 0;

  return clampImportance(row.importance) * 10 + familyWeights[family] + bucketWeights[bucket] + kindBonus;
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate, preferSelectedTask: boolean) {
  if (preferSelectedTask && left.taskMatch !== right.taskMatch) {
    return left.taskMatch ? -1 : 1;
  }

  if (right.scopeScore !== left.scopeScore) {
    return right.scopeScore - left.scopeScore;
  }

  if (right.lexicalScore !== left.lexicalScore) {
    return right.lexicalScore - left.lexicalScore;
  }

  if (right.salienceScore !== left.salienceScore) {
    return right.salienceScore - left.salienceScore;
  }

  if (right.row.updatedAt !== left.row.updatedAt) {
    return right.row.updatedAt.localeCompare(left.row.updatedAt);
  }

  return left.row.memoryId.localeCompare(right.row.memoryId);
}

function resolveBucketOrder(bias: ExecutionRetrievalPolicy["typedMemoryBias"]): TypedMemoryBucket[] {
  const ordered = new Set<TypedMemoryBucket>();

  for (const bucket of bias?.preferredBuckets ?? []) {
    if (ALL_BUCKETS.includes(bucket as TypedMemoryBucket)) {
      ordered.add(bucket as TypedMemoryBucket);
    }
  }

  for (const family of bias?.preferredFamilies ?? []) {
    for (const bucket of FAMILY_BUCKETS[family]) {
      ordered.add(bucket);
    }
  }

  for (const bucket of ALL_BUCKETS) {
    ordered.add(bucket);
  }

  return [...ordered];
}

function resolveFallbackBias(strategy: ExecutionRetrievalPolicy["strategy"]): NonNullable<ExecutionRetrievalPolicy["typedMemoryBias"]> {
  if (strategy === "continuation") {
    return {
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "blocker", "open_loop", "decision"],
      preferredScopes: ["session", "workspace", "user"],
      preferSelectedTask: true
    };
  }

  if (strategy === "active_task_preferred") {
    return {
      preferredFamilies: ["continuity", "procedural", "fact", "preference"],
      preferredBuckets: ["task_continuity", "procedural", "blocker", "open_loop", "decision"],
      preferredScopes: ["session", "workspace", "user"],
      preferSelectedTask: true
    };
  }

  return {
    preferredFamilies: ["fact", "preference", "procedural", "continuity"],
    preferredBuckets: [],
    preferredScopes: ["workspace", "user", "session"],
    preferSelectedTask: false
  };
}

function resolveScopeOrder(candidates: RankedCandidate[], preferredScopes: Array<"session" | "workspace" | "user"> = []) {
  const ordered = new Set<"session" | "workspace" | "user">();

  for (const scope of preferredScopes) {
    ordered.add(scope);
  }

  for (const candidate of candidates) {
    ordered.add(candidate.scope);
  }

  return [...ordered];
}

function rankCandidatesWithinScope(input: {
  candidates: RankedCandidate[];
  orderedBuckets: TypedMemoryBucket[];
  preferSelectedTask: boolean;
}) {
  const grouped = new Map<TypedMemoryBucket, RankedCandidate[]>();
  for (const candidate of input.candidates) {
    const bucket = grouped.get(candidate.bucket) ?? [];
    bucket.push(candidate);
    grouped.set(candidate.bucket, bucket);
  }

  for (const bucket of grouped.values()) {
    bucket.sort((left, right) => compareCandidates(left, right, input.preferSelectedTask));
  }

  const ordered: RankedCandidate[] = [];

  for (let round = 0; ; round += 1) {
    let added = false;

    for (const bucket of input.orderedBuckets) {
      const candidate = grouped.get(bucket)?.[round];
      if (!candidate) {
        continue;
      }

      ordered.push(candidate);
      added = true;
    }

    if (!added) {
      break;
    }
  }

  return ordered;
}

function buildSelectionReason(input: {
  candidate: RankedCandidate;
  selected: boolean;
  bias: NonNullable<ExecutionRetrievalPolicy["typedMemoryBias"]>;
}) {
  const reasons: string[] = [];

  if (input.bias.preferSelectedTask && input.candidate.taskMatch) {
    reasons.push("matched_selected_task");
  }

  if (!input.selected) {
    reasons.push("ranked_below_limit");
  }

  return reasons;
}

function explainScopeMismatch(input: {
  row: MaterializedTypedMemoryRecord;
  scope: "session" | "workspace" | "user";
  scopeFilter?: MemoryQuery["scopeFilter"];
  sessionId: string;
  workspaceId: string;
  actorId?: string;
}) {
  if (!scopeAppliesToContext({
    record: input.row,
    scope: input.scope,
    context: {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      actorId: input.actorId
    }
  })) {
    switch (input.scope) {
      case "session":
        return ["session_scope_mismatch"];
      case "workspace":
        return ["workspace_scope_mismatch"];
      case "user":
        return ["actor_scope_mismatch"];
    }
  }

  if (input.scopeFilter && input.scope !== input.scopeFilter) {
    return ["scope_filter_mismatch"];
  }

  return ["scope_mismatch"];
}

function createObservabilityItem(input: {
  candidate: RankedCandidate;
  route: ExecutionRetrievalPolicy["strategy"];
  rank?: number;
  selectionStatus: DurableMemorySelectionItem["selectionStatus"];
  reasons: string[];
}): DurableMemorySelectionItem {
  return {
    memoryId: input.candidate.row.memoryId,
    writeId: input.candidate.row.writeId,
    sourceTurnId: input.candidate.row.sourceTurnId,
    scope: input.candidate.scope,
    memoryType: input.candidate.row.memoryType,
    family: input.candidate.family,
    bucket: input.candidate.bucket,
    route: input.route,
    rank: input.rank,
    taskMatch: input.candidate.taskMatch,
    selectionStatus: input.selectionStatus,
    injectionStatus: "not-applicable",
    reasons: input.reasons,
    summary: input.candidate.row.summary,
    correctionTarget: createCorrectionTarget(input.candidate.row)
  };
}

function summarizeObservability(observability: DurableMemoryObservability) {
  const selected = observability.items.filter((item) => item.selectionStatus === "selected").length;
  const notChosen = observability.items.filter((item) => item.selectionStatus === "not-chosen").length;
  const scopeMisses = observability.items.filter((item) => item.selectionStatus === "scope-mismatch").length;
  const correctedOut = observability.items.filter((item) => item.selectionStatus === "corrected-out").length;

  return `route=${observability.route}; selected=${selected}; not-chosen=${notChosen}; scope-mismatch=${scopeMisses}; corrected-out=${correctedOut}`;
}

export function selectTypedMemorySurfacesWithObservability(input: {
  rows: MaterializedTypedMemoryRecord[];
  policy: ExecutionRetrievalPolicy;
  selectedTaskId?: string;
  purpose: MemoryQuery["purpose"];
  queryText?: string;
  scopeFilter?: MemoryQuery["scopeFilter"];
  sessionId: string;
  workspaceId: string;
  actorId?: string;
  maxItems: number;
}): {
  items: TypedMemorySurfaceItem[];
  observability: DurableMemoryObservability;
} {
  const limit = Math.max(0, input.maxItems);
  const queryText = input.queryText?.trim();
  const bias = input.policy.typedMemoryBias ?? resolveFallbackBias(input.policy.strategy);
  const rankedCandidates: RankedCandidate[] = [];
  const observabilityItems: DurableMemorySelectionItem[] = [];

  for (const row of input.rows) {
    const scope = normalizeMemoryScope(row);
    const bucket = classifyBucket(row.memoryType);
    const family = classifyFamily(bucket);
    const lexicalScore = queryText ? scoreText(queryText, row.memoryType, row.summary, row.content) : 0;
    const candidate: RankedCandidate = {
      row,
      scope,
      bucket,
      family,
      lexicalScore,
      salienceScore: scoreSalience(row, bucket, family),
      scopeScore: scoreScope({
        record: row,
        context: {
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          scopeFilter: input.scopeFilter,
          preferredScopes: bias.preferredScopes,
          queryText
        }
      }),
      taskMatch: !!(input.selectedTaskId && row.taskId && row.taskId === input.selectedTaskId)
    };

    const selectionState = row.selectionState ?? "active";
    if (selectionState !== "active") {
      const reasons = selectionState === "superseded"
        ? ["superseded", ...(row.supersededByMemoryId ? [`superseded_by:${row.supersededByMemoryId}`] : [])]
        : [selectionState];
      observabilityItems.push(createObservabilityItem({
        candidate,
        route: input.policy.strategy,
        selectionStatus: "corrected-out",
        reasons
      }));
      continue;
    }

    if (!passesScopeGate({
      record: row,
      context: {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        scopeFilter: input.scopeFilter
      }
    })) {
      observabilityItems.push(createObservabilityItem({
        candidate,
        route: input.policy.strategy,
        selectionStatus: "scope-mismatch",
        reasons: explainScopeMismatch({
          row,
          scope,
          scopeFilter: input.scopeFilter,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          actorId: input.actorId
        })
      }));
      continue;
    }

    rankedCandidates.push(candidate);
  }

  const visibleCandidates = rankedCandidates
    .filter((candidate) => input.purpose !== "explicit_search" || !queryText || candidate.lexicalScore > 0);
  const orderedBuckets = resolveBucketOrder(bias);
  const orderedScopes = resolveScopeOrder(visibleCandidates, bias.preferredScopes);
  const orderedCandidates: RankedCandidate[] = [];

  for (const scope of orderedScopes) {
    orderedCandidates.push(...rankCandidatesWithinScope({
      candidates: visibleCandidates.filter((candidate) => candidate.scope === scope),
      orderedBuckets,
      preferSelectedTask: bias.preferSelectedTask
    }));
  }

  const selectedCandidates = orderedCandidates.slice(0, limit);
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.row.memoryId));

  orderedCandidates.forEach((candidate, index) => {
    const selected = selectedIds.has(candidate.row.memoryId);
    observabilityItems.push(createObservabilityItem({
      candidate,
      route: input.policy.strategy,
      rank: index + 1,
      selectionStatus: selected ? "selected" : "not-chosen",
      reasons: buildSelectionReason({
        candidate,
        selected,
        bias
      })
    }));
  });

  const observability: DurableMemoryObservability = {
    route: input.policy.strategy,
    preferredScopes: bias.preferredScopes,
    preferredFamilies: bias.preferredFamilies,
    preferredBuckets: bias.preferredBuckets,
    items: observabilityItems.sort((left, right) => {
      if (left.rank !== right.rank) {
        if (left.rank === undefined) {
          return 1;
        }

        if (right.rank === undefined) {
          return -1;
        }

        return left.rank - right.rank;
      }

      return `${left.memoryId ?? ""}:${left.scope ?? ""}`.localeCompare(`${right.memoryId ?? ""}:${right.scope ?? ""}`);
    })
  };
  observability.summary = summarizeObservability(observability);

  return {
    items: selectedCandidates.map((candidate) => createMaterializedTypedMemorySurfaceItem(candidate.row)),
    observability
  };
}

export function selectTypedMemorySurfaces(input: {
  rows: MaterializedTypedMemoryRecord[];
  policy: ExecutionRetrievalPolicy;
  selectedTaskId?: string;
  purpose: MemoryQuery["purpose"];
  queryText?: string;
  scopeFilter?: MemoryQuery["scopeFilter"];
  sessionId: string;
  workspaceId: string;
  actorId?: string;
  maxItems: number;
}): TypedMemorySurfaceItem[] {
  return selectTypedMemorySurfacesWithObservability(input).items;
}
