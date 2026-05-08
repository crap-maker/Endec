import { describe, expect, it } from "vitest";
import type { OutboundEvent } from "@endec/domain";
import { renderDurableOutboundEventToMessages } from "./outbound.ts";

describe("durable background outbound rendering", () => {
  it("renders background final payload without transport ownership", () => {
    const event: OutboundEvent = {
      outboundEventId: "outbound_001",
      workspaceId: "workspace_local",
      sessionId: "session_001",
      actorId: "actor_001",
      taskId: "task_001",
      runId: "run_001",
      conversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "telegram:chat:1001",
        peerId: "1001",
        peerKind: "group",
        threadId: "42",
        topicId: "7"
      },
      channel: "telegram",
      eventKind: "final",
      renderPayload: {
        schemaVersion: 1,
        contractVersion: "im.background-callback.v1",
        eventKind: "final",
        taskId: "task_001",
        runId: "run_001",
        attemptNo: 1,
        taskTitle: "Investigate failures",
        summary: "Background investigation completed with root cause summary.",
        turnResultStatus: "completed"
      },
      idempotencyKey: "run:run_001:callback:final",
      status: "pending",
      availableAt: "2026-04-26T00:00:00.000Z",
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z"
    };

    const messages = renderDurableOutboundEventToMessages({ event });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      outboundEventId: "outbound_001",
      sessionId: "session_001",
      conversationRef: event.conversationRef,
      text: expect.stringContaining("Investigate failures")
    });
    expect(messages[0]?.text).toContain("task_001");
    expect(messages[0]?.text).toContain("run_001");
    expect(messages[0]?.text).toContain("Background investigation completed with root cause summary.");
  });

  it("renders authority-control notices generically from the shared durable path", () => {
    const event: OutboundEvent = {
      outboundEventId: "outbound_pairing_001",
      workspaceId: "workspace_local",
      actorId: "operator_alpha",
      conversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      },
      channel: "telegram",
      eventKind: "operator_notice",
      renderPayload: {
        schemaVersion: 1,
        contractVersion: "im.authority-control.v1",
        noticeKind: "pairing_success",
        message: "Pairing complete. This direct conversation is now the owner conversation for this instance.",
        ownerBindingId: "binding_001",
        ownerGeneration: 0,
        conversationRef: {
          accountId: "telegram:bot:endec",
          conversationId: "dm:chat_42",
          peerId: "chat_42",
          peerKind: "dm"
        }
      },
      idempotencyKey: "authority:telegram:acct_bot:pairing_success:binding_001",
      status: "pending",
      availableAt: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    };

    const messages = renderDurableOutboundEventToMessages({ event });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      outboundEventId: "outbound_pairing_001",
      sessionId: undefined,
      conversationRef: event.conversationRef,
      text: "Pairing complete. This direct conversation is now the owner conversation for this instance.",
      metadata: {
        eventKind: "operator_notice",
        channel: "telegram"
      }
    });
  });

  it("renders trusted-conversation authority notices from the same durable path", () => {
    const event: OutboundEvent = {
      outboundEventId: "outbound_trust_001",
      workspaceId: "workspace_local",
      actorId: "operator_alpha",
      conversationRef: {
        accountId: "telegram:bot:endec",
        conversationId: "dm:chat_42",
        peerId: "chat_42",
        peerKind: "dm"
      },
      channel: "telegram",
      eventKind: "operator_notice",
      renderPayload: {
        schemaVersion: 1,
        contractVersion: "im.authority-control.v1",
        noticeKind: "trusted_conversation_granted",
        message: "Trusted conversation added. Use @endec in that group when you want me to respond there.",
        ownerBindingId: "binding_001",
        ownerGeneration: 0,
        conversationRef: {
          accountId: "telegram:bot:endec",
          conversationId: "group:chat_100:thread:77",
          peerId: "chat_100",
          peerKind: "group",
          baseConversationId: "group:chat_100",
          parentConversationId: "group:chat_100",
          threadId: "77"
        }
      },
      idempotencyKey: "authority:telegram:acct_bot:trusted_conversation_granted:binding_001",
      status: "pending",
      availableAt: "2026-04-29T00:00:00.000Z",
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    };

    const messages = renderDurableOutboundEventToMessages({ event });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      outboundEventId: "outbound_trust_001",
      sessionId: undefined,
      conversationRef: event.conversationRef,
      text: "Trusted conversation added. Use @endec in that group when you want me to respond there.",
      metadata: {
        eventKind: "operator_notice",
        channel: "telegram"
      }
    });
  });
});

