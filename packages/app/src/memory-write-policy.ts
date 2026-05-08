import {
  MemoryWriteRequestSchema,
  type MemoryVisibility,
  type TurnRequest,
  type TurnResult,
  type MemoryWriteRequest
} from "@endec/domain";

function inferVisibility(request: TurnRequest): MemoryVisibility | undefined {
  const scope = request.imContext?.boundary.conversationScope;
  if (scope === "direct") {
    return "owner_private";
  }

  if (scope === "shared" || scope === "broadcast") {
    return "conversation_local";
  }

  return undefined;
}

function annotateMemoryWrite(write: MemoryWriteRequest, request: TurnRequest): MemoryWriteRequest {
  const boundary = request.imContext?.boundary;
  if (!boundary) {
    return write;
  }

  return {
    ...write,
    conversationBoundaryKey: boundary.boundaryKey,
    disclosureMode: boundary.disclosureMode,
    targetConversationKeys: [...boundary.targetConversationKeys],
    borrowedConversationKeys: [...boundary.borrowedConversationKeys],
    transientBorrowed: boundary.transientBorrowed,
    visibility: write.visibility ?? inferVisibility(request)
  };
}

export function filterImMemoryWrites(input: {
  request: TurnRequest;
  memoryWrites: MemoryWriteRequest[];
}) {
  const annotated = input.memoryWrites.map((write) => annotateMemoryWrite(write, input.request));
  if (input.request.imContext?.boundary.transientBorrowed) {
    return [];
  }

  return annotated;
}

export function filterMemoryWritesForImContext(input: {
  request: TurnRequest;
  result: Pick<TurnResult, "memoryWrites">;
}) {
  const memoryWrites = (input.result.memoryWrites ?? [])
    .flatMap((value) => {
      const parsed = MemoryWriteRequestSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });

  return filterImMemoryWrites({
    request: input.request,
    memoryWrites
  });
}
