import { describe, expectTypeOf, it } from "vitest";
import type {
  ApprovePairClaimResult,
  BackgroundCancelResult,
  BackgroundInspectOutboundState,
  BackgroundInspectTaskDetail,
  BackgroundInspectTaskSummary,
  ContextAssemblyBudget,
  ContextAssemblyResult,
  ContextAssemblySelection,
  InspectOperatorTurnRequest,
  InspectOwnerBindingResult,
  ListPairClaimsResult,
  ListTrustedConversationsResult,
  OperatorRecoverySnapshot,
  OperatorTurnInspection,
  OutboundConversationLegality,
  OwnerInitState,
  OwnerPreferences,
  PromptContract,
  PromptContractLayer,
  PromptOverlayHook,
  ResolvedOwnerPreferences,
  RuntimeSelfAwarenessSurface
} from "@endec/domain";
import type {
  EndecAppOptions,
  EndecBackgroundCancelResult,
  EndecBackgroundInspectOutboundState,
  EndecBackgroundInspectTaskDetail,
  EndecBackgroundInspectTaskSummary,
  EndecContextAssemblyBudget,
  EndecContextAssemblyResult,
  EndecContextAssemblySelection,
  EndecInspectOperatorTurnRequest,
  EndecOperatorPort,
  EndecOperatorRecoverySnapshot,
  EndecOperatorSnapshotTarget,
  EndecOperatorTurnInspection,
  EndecPromptContract,
  EndecPromptContractLayer,
  EndecPromptOverlayHook,
  EndecRuntimeSelfAwarenessSurface,
  EndecToolExposureResolver
} from "./index.ts";

describe("@endec/app public contract", () => {
  it("preserves the WS1 app-layer exposure types", () => {
    expectTypeOf<NonNullable<EndecAppOptions["toolExposureResolver"]>>().toEqualTypeOf<EndecToolExposureResolver>();
    expectTypeOf<EndecContextAssemblyResult>().toEqualTypeOf<ContextAssemblyResult>();
    expectTypeOf<EndecContextAssemblyBudget>().toEqualTypeOf<ContextAssemblyBudget>();
    expectTypeOf<EndecContextAssemblySelection>().toEqualTypeOf<ContextAssemblySelection>();
    expectTypeOf<EndecPromptContract>().toEqualTypeOf<PromptContract>();
    expectTypeOf<EndecPromptContractLayer>().toEqualTypeOf<PromptContractLayer>();
    expectTypeOf<EndecPromptOverlayHook>().toEqualTypeOf<PromptOverlayHook>();
    expectTypeOf<EndecOperatorRecoverySnapshot>().toEqualTypeOf<OperatorRecoverySnapshot>();
    expectTypeOf<EndecRuntimeSelfAwarenessSurface>().toEqualTypeOf<RuntimeSelfAwarenessSurface>();
    expectTypeOf<EndecInspectOperatorTurnRequest>().toEqualTypeOf<InspectOperatorTurnRequest>();
    expectTypeOf<EndecOperatorTurnInspection>().toEqualTypeOf<OperatorTurnInspection>();
    expectTypeOf<EndecBackgroundInspectTaskSummary>().toEqualTypeOf<BackgroundInspectTaskSummary>();
    expectTypeOf<EndecBackgroundInspectTaskDetail>().toEqualTypeOf<BackgroundInspectTaskDetail>();
    expectTypeOf<EndecBackgroundInspectOutboundState>().toEqualTypeOf<BackgroundInspectOutboundState>();
    expectTypeOf<EndecBackgroundCancelResult>().toEqualTypeOf<BackgroundCancelResult>();
    expectTypeOf<Parameters<EndecOperatorPort["getRecoverySnapshot"]>[0]>().toEqualTypeOf<EndecOperatorSnapshotTarget>();

    expectTypeOf<Parameters<EndecOperatorPort["getRuntimeSelfAwareness"]>[0]>().toEqualTypeOf<EndecOperatorSnapshotTarget>();
    expectTypeOf<Parameters<EndecOperatorPort["inspectOperatorTurn"]>[0]>().toEqualTypeOf<InspectOperatorTurnRequest>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["inspectOwnerBinding"]>>>().toEqualTypeOf<InspectOwnerBindingResult>();
    expectTypeOf<NonNullable<Awaited<ReturnType<EndecOperatorPort["inspectOwnerBinding"]>>>["ownerPreferences"]>().toEqualTypeOf<OwnerPreferences | undefined>();
    expectTypeOf<NonNullable<Awaited<ReturnType<EndecOperatorPort["inspectOwnerBinding"]>>>["resolvedOwnerPreferences"]>().toEqualTypeOf<ResolvedOwnerPreferences | undefined>();
    expectTypeOf<NonNullable<Awaited<ReturnType<EndecOperatorPort["inspectOwnerBinding"]>>>["ownerInitState"]>().toEqualTypeOf<OwnerInitState | undefined>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["listPairClaims"]>>>().toEqualTypeOf<ListPairClaimsResult>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["approvePairClaim"]>>>().toEqualTypeOf<ApprovePairClaimResult>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["listTrustedConversations"]>>>().toEqualTypeOf<ListTrustedConversationsResult>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["inspectOperatorTurn"]>>>().toEqualTypeOf<OperatorTurnInspection | null>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["listBackgroundTasks"]>>>().toEqualTypeOf<BackgroundInspectTaskSummary[]>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["inspectBackgroundTask"]>>>().toEqualTypeOf<BackgroundInspectTaskDetail | null>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["listBackgroundOutbox"]>>>().toEqualTypeOf<BackgroundInspectOutboundState[]>();
    expectTypeOf<Awaited<ReturnType<EndecOperatorPort["cancelBackgroundTask"]>>>().toEqualTypeOf<BackgroundCancelResult>();
    expectTypeOf<EndecOperatorPort>().toHaveProperty("inspectOwnerBinding");
    expectTypeOf<EndecOperatorPort>().toHaveProperty("approvePairClaim");
    expectTypeOf<EndecOperatorPort>().toHaveProperty("inspectOperatorTurn");
    expectTypeOf<EndecOperatorPort>().toHaveProperty("inspectBackgroundTask");

    type IsInspectOperatorTurnOptional = {} extends Pick<EndecOperatorPort, "inspectOperatorTurn"> ? true : false;
    expectTypeOf<IsInspectOperatorTurnOptional>().toEqualTypeOf<false>();
  });
});
