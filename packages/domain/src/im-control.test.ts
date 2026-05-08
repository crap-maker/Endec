import { describe, expect, it } from "vitest";
import {
  ConversationBoundaryDescriptorSchema,
  DisclosureModeSchema,
  ImCommandIntentSchema,
  ImMessageControlMetadataSchema,
  ImMessageModeSchema,
  PersonaScopeKindSchema,
  ResolvedPersonaSchema
} from "./im-control.ts";

describe("IM control contracts", () => {
  it("accepts targeted owner-DM borrowing and scoped persona resolution", () => {
    expect(DisclosureModeSchema.parse("owner_targeted")).toBe("owner_targeted");

    expect(
      ConversationBoundaryDescriptorSchema.parse({
        boundaryKey: "private:42",
        conversationScope: "direct",
        disclosureMode: "owner_targeted",
        targetConversationKeys: ["supergroup:-100123:topic:77"],
        borrowedConversationKeys: ["supergroup:-100123:topic:77"],
        transientBorrowed: true
      }).transientBorrowed
    ).toBe(true);

    expect(
      ImCommandIntentSchema.parse({
        name: "recall",
        subcommand: "run",
        args: ["what", "did", "they", "decide"],
        options: { chat: "alpha" },
        rawText: "/recall --chat alpha what did they decide",
        helpRequested: false
      }).name
    ).toBe("recall");

    expect(
      ResolvedPersonaSchema.parse({
        scopeKind: PersonaScopeKindSchema.enum.conversation_override,
        styleInstructions: "professional, concise",
        behaviorInstructions: "lead with the answer",
        sourceRefs: ["persona:conversation:supergroup:-100123"]
      }).scopeKind
    ).toBe("conversation_override");
  });

  it("parses structured IM message-mode control metadata for steer capture", () => {
    const parsed = ImMessageControlMetadataSchema.parse({
      messageMode: ImMessageModeSchema.enum.steer,
      source: "telegram",
      messageId: "msg_001",
      senderId: "user_telegram_001",
      text: "please keep the current run focused on logs",
      capturedAt: "2026-05-02T00:00:00.000Z"
    });

    expect(parsed.messageMode).toBe("steer");
    expect(parsed.messageId).toBe("msg_001");
  });
});
