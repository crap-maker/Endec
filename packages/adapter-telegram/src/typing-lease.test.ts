import { describe, expect, it, vi } from "vitest";
import { createTelegramTypingLease } from "./typing-lease.ts";

describe("telegram typing lease", () => {
  it("starts once, renews on the interval, and releases cleanly", async () => {
    const sendTyping = vi.fn(async () => undefined);
    let intervalHandler: (() => void | Promise<void>) | undefined;
    let clearCount = 0;

    const lease = createTelegramTypingLease({
      sendTyping,
      renewIntervalMs: 4_000,
      clock: {
        setInterval(handler) {
          intervalHandler = handler;
          return {
            unref: vi.fn()
          };
        },
        clearInterval() {
          clearCount += 1;
        }
      }
    });

    await lease.start();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    await intervalHandler?.();
    await intervalHandler?.();
    expect(sendTyping).toHaveBeenCalledTimes(3);

    await lease.stop();
    expect(clearCount).toBe(1);
  });

  it("does not create duplicate intervals when started repeatedly", async () => {
    const sendTyping = vi.fn(async () => undefined);
    const setInterval = vi.fn((handler: () => void | Promise<void>) => ({ unref: vi.fn(), handler }));

    const lease = createTelegramTypingLease({
      sendTyping,
      clock: {
        setInterval,
        clearInterval: vi.fn()
      }
    });

    await lease.start();
    await lease.start();

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight typing send before fully stopping", async () => {
    let resolveTyping: (() => void) | undefined;
    const sendTyping = vi.fn(() => new Promise<void>((resolve) => {
      resolveTyping = resolve;
    }));

    const lease = createTelegramTypingLease({
      sendTyping,
      clock: {
        setInterval: () => ({ unref: vi.fn() }),
        clearInterval: vi.fn()
      }
    });

    const startPromise = lease.start();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    resolveTyping?.();
    await startPromise;

    const stopPromise = lease.stop();
    await stopPromise;
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping renewals so only one sendTyping is in flight at a time", async () => {
    let resolveTyping: (() => void) | undefined;
    const sendTyping = vi.fn(() => new Promise<void>((resolve) => {
      resolveTyping = resolve;
    }));
    let intervalHandler: (() => void | Promise<void>) | undefined;

    const lease = createTelegramTypingLease({
      sendTyping,
      clock: {
        setInterval(handler) {
          intervalHandler = handler;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn()
      }
    });

    const startPromise = lease.start();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    const firstRenewal = intervalHandler?.();
    const secondRenewal = intervalHandler?.();
    expect(sendTyping).toHaveBeenCalledTimes(1);

    resolveTyping?.();
    await startPromise;
    await firstRenewal;
    await secondRenewal;
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });
});
