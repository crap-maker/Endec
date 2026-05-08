import { z } from "zod";
import { MemoryScopeSchema } from "./memory.ts";

export const TYPED_MEMORY_SELECTION_STATE_CONTRACT_VERSION = "ws6.typed-memory-selection-state.v1";
export const CORRECTION_SURFACE_CONTRACT_VERSION = "ws6.correction-surface.v1";

export const TypedMemorySelectionStateSchema = z.enum(["active", "stale", "superseded", "disabled"]);

export const WorkingSetCorrectionTargetSchema = z.object({
  kind: z.literal("working_set"),
  sessionId: z.string(),
  workspaceId: z.string(),
  workingSetRef: z.string().optional()
});

export const TypedMemoryCorrectionTargetSchema = z.object({
  kind: z.literal("typed_memory"),
  memoryId: z.string(),
  scope: MemoryScopeSchema.optional(),
  workspaceId: z.string().optional(),
  actorId: z.string().optional(),
  taskId: z.string().optional()
});

export const CorrectionTargetSchema = z.discriminatedUnion("kind", [
  WorkingSetCorrectionTargetSchema,
  TypedMemoryCorrectionTargetSchema
]);

export const CorrectionWorkingSetSurfaceSchema = z.object({
  ref: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  summary: z.string(),
  objective: z.string().optional(),
  recentProgress: z.array(z.string()).default([]),
  recentDecisions: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  openLoops: z.array(z.string()).default([]),
  activeMemoryRefs: z.array(z.string()).default([]),
  activeTaskRefs: z.array(z.string()).default([]),
  recentEventRefs: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([])
});

export const WorkingSetCorrectionPatchSchema = z.object({
  summary: z.string().optional(),
  objective: z.string().optional(),
  recentProgress: z.array(z.string()).optional(),
  recentDecisions: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  openLoops: z.array(z.string()).optional(),
  activeMemoryRefs: z.array(z.string()).optional(),
  activeTaskRefs: z.array(z.string()).optional(),
  recentEventRefs: z.array(z.string()).optional(),
  sourceRefs: z.array(z.string()).optional()
});

export const WorkingSetCorrectionOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("refresh_working_set")
  }),
  z.object({
    kind: z.literal("rewrite_working_set"),
    replace: z.boolean().default(false),
    workingSet: WorkingSetCorrectionPatchSchema
  })
]);

export const TypedMemoryCorrectionOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mark_memory_stale")
  }),
  z.object({
    kind: z.literal("mark_memory_superseded"),
    supersededByMemoryId: z.string().optional()
  }),
  z.object({
    kind: z.literal("disable_memory")
  }),
  z.object({
    kind: z.literal("restore_memory")
  })
]);

const CorrectionRequestBaseSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  contractVersion: z.literal(CORRECTION_SURFACE_CONTRACT_VERSION).default(CORRECTION_SURFACE_CONTRACT_VERSION),
  correctionId: z.string(),
  actorId: z.string().optional(),
  reason: z.string().optional()
});

export const CorrectionOperationSchema = z.union([
  WorkingSetCorrectionOperationSchema,
  TypedMemoryCorrectionOperationSchema
]);

export const WorkingSetCorrectionRequestSchema = CorrectionRequestBaseSchema.extend({
  target: WorkingSetCorrectionTargetSchema,
  operation: WorkingSetCorrectionOperationSchema
});

export const TypedMemoryCorrectionRequestSchema = CorrectionRequestBaseSchema.extend({
  target: TypedMemoryCorrectionTargetSchema,
  operation: TypedMemoryCorrectionOperationSchema
});

export const CorrectionRequestSchema = z.union([
  WorkingSetCorrectionRequestSchema,
  TypedMemoryCorrectionRequestSchema
]);

export const TypedMemoryCorrectionRecordSchema = z.object({
  memoryId: z.string(),
  writeId: z.string(),
  sourceTurnId: z.string(),
  sessionId: z.string(),
  workspaceId: z.string(),
  actorId: z.string().optional(),
  taskId: z.string().optional(),
  scope: MemoryScopeSchema.optional(),
  importance: z.number().nonnegative(),
  kind: z.enum(["candidate_extract", "typed_upsert"]),
  status: z.literal("materialized"),
  selectionState: TypedMemorySelectionStateSchema.default("active"),
  memoryType: z.string(),
  summary: z.string(),
  content: z.string(),
  payload: z.unknown(),
  evidenceRefs: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  correctedAt: z.string().optional(),
  supersededByMemoryId: z.string().optional(),
  correctionId: z.string().optional(),
  correctionReason: z.string().optional(),
  correctionActorId: z.string().optional()
});

export const WorkingSetCorrectionInspectionSchema = z.object({
  target: WorkingSetCorrectionTargetSchema,
  workingSet: CorrectionWorkingSetSurfaceSchema
});

export const TypedMemoryCorrectionInspectionItemSchema = z.object({
  target: TypedMemoryCorrectionTargetSchema,
  record: TypedMemoryCorrectionRecordSchema
});

export const CorrectionInspectionSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  actorId: z.string().optional(),
  workingSet: WorkingSetCorrectionInspectionSchema.optional(),
  typedMemory: z.array(TypedMemoryCorrectionInspectionItemSchema).default([])
});

export const CorrectionResultSchema = z.object({
  correctionId: z.string(),
  target: CorrectionTargetSchema,
  applied: z.boolean(),
  appliedAt: z.string(),
  summary: z.string(),
  workingSet: CorrectionWorkingSetSurfaceSchema.optional(),
  typedMemory: TypedMemoryCorrectionRecordSchema.optional()
});

export type TypedMemorySelectionState = z.infer<typeof TypedMemorySelectionStateSchema>;
export type WorkingSetCorrectionTarget = z.infer<typeof WorkingSetCorrectionTargetSchema>;
export type TypedMemoryCorrectionTarget = z.infer<typeof TypedMemoryCorrectionTargetSchema>;
export type CorrectionTarget = z.infer<typeof CorrectionTargetSchema>;
export type CorrectionWorkingSetSurface = z.infer<typeof CorrectionWorkingSetSurfaceSchema>;
export type WorkingSetCorrectionPatch = z.infer<typeof WorkingSetCorrectionPatchSchema>;
export type CorrectionOperation = z.infer<typeof CorrectionOperationSchema>;
export type CorrectionRequestInput = z.input<typeof CorrectionRequestSchema>;
export type CorrectionRequest = z.infer<typeof CorrectionRequestSchema>;
export type TypedMemoryCorrectionRecord = z.infer<typeof TypedMemoryCorrectionRecordSchema>;
export type WorkingSetCorrectionInspection = z.infer<typeof WorkingSetCorrectionInspectionSchema>;
export type TypedMemoryCorrectionInspectionItem = z.infer<typeof TypedMemoryCorrectionInspectionItemSchema>;
export type CorrectionInspection = z.infer<typeof CorrectionInspectionSchema>;
export type CorrectionResult = z.infer<typeof CorrectionResultSchema>;
