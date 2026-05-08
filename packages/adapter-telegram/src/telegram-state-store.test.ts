import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInMemoryTelegramAdapterStateStore,
  createSqliteTelegramAdapterStateStore,
  createTelegramActorBindingLookup,
  createTelegramSessionBindingLookup
} from "./index.ts";

const tempDirs = new Set<string>();

async function createTempDir() {
  const directory = await mkdtemp(join(tmpdir(), "endec-adapter-telegram-"));
  tempDirs.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
      tempDirs.delete(directory);
    })
  );
});

describe("telegram adapter state store", () => {
  it("looks up adapter-side session and actor bindings without owning canonical truth", async () => {
    const stateStore = createInMemoryTelegramAdapterStateStore();
    const lookupSessionBinding = createTelegramSessionBindingLookup({
      stateStore
    });
    const lookupActorBinding = createTelegramActorBindingLookup({
      stateStore
    });

    const sessionInput = {
      source: "telegram" as const,
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      conversationRef: {
        accountId: "acct_bot",
        peerId: "-100123",
        peerKind: "group" as const,
        conversationId: "supergroup:-100123:topic:77",
        parentConversationId: "supergroup:-100123",
        baseConversationId: "supergroup:-100123",
        threadId: "77",
        topicId: "77"
      }
    };

    const actorInput = {
      ...sessionInput,
      senderId: "9"
    };

    await expect(lookupSessionBinding(sessionInput)).resolves.toBeNull();
    await expect(lookupActorBinding(actorInput)).resolves.toBeNull();

    await stateStore.saveSessionBinding({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      sessionId: "session_canonical_topic_77",
      conversationRef: sessionInput.conversationRef
    });
    await stateStore.saveActorBinding({
      source: "telegram",
      workspaceId: "workspace_local",
      accountId: "acct_bot",
      senderId: "9",
      actorId: "actor_canonical_bob"
    });

    await expect(lookupSessionBinding(sessionInput)).resolves.toEqual({
      sessionId: "session_canonical_topic_77"
    });
    await expect(lookupActorBinding(actorInput)).resolves.toEqual({
      actorId: "actor_canonical_bob"
    });
  });

  it("persists bindings, dedup claims, and polling offsets in sqlite", async () => {
    const dir = await createTempDir();
    const filename = join(dir, "telegram-adapter.sqlite");

    {
      const stateStore = createSqliteTelegramAdapterStateStore({ filename });
      await stateStore.saveSessionBinding({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        sessionId: "session_persisted",
        conversationRef: {
          accountId: "acct_bot",
          peerId: "42",
          peerKind: "dm",
          conversationId: "private:42",
          baseConversationId: "private:42"
        }
      });
      await stateStore.saveActorBinding({
        source: "telegram",
        workspaceId: "workspace_local",
        accountId: "acct_bot",
        senderId: "7",
        actorId: "actor_persisted"
      });
      await expect(
        stateStore.claimInboundDedup({
          dedupKey: "telegram:acct_bot:private:42:11",
          expiresAtMs: Date.now() + 60_000
        })
      ).resolves.toBe(true);
      await expect(
        stateStore.claimInboundDedup({
          dedupKey: "telegram:acct_bot:private:42:11",
          expiresAtMs: Date.now() + 60_000
        })
      ).resolves.toBe(false);
      await stateStore.writePollingOffset({
        accountId: "acct_bot",
        nextUpdateId: 105
      });
      stateStore.close();
    }

    {
      const reopened = createSqliteTelegramAdapterStateStore({ filename });
      await expect(reopened.loadSessionBindingBySessionId("session_persisted")).resolves.toMatchObject({
        sessionId: "session_persisted",
        conversationRef: {
          conversationId: "private:42"
        }
      });
      await expect(
        reopened.loadActorBinding({
          source: "telegram",
          workspaceId: "workspace_local",
          accountId: "acct_bot",
          senderId: "7"
        })
      ).resolves.toBe("actor_persisted");
      await expect(reopened.readPollingOffset({ accountId: "acct_bot" })).resolves.toBe(105);
      reopened.close();
    }
  });
});
