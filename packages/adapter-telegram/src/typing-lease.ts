export type TypingLeaseClock = {
  setInterval(handler: () => void | Promise<void>, ms: number): { ref?: () => unknown; unref?: () => unknown };
  clearInterval(handle: { ref?: () => unknown; unref?: () => unknown } | undefined): void;
};

export function createTelegramTypingLease(input: {
  sendTyping: () => Promise<void>;
  renewIntervalMs?: number;
  clock?: TypingLeaseClock;
}) {
  const renewIntervalMs = input.renewIntervalMs ?? 4_000;
  const clock = input.clock ?? {
    setInterval(handler, ms) {
      const handle = globalThis.setInterval(() => {
        void handler();
      }, ms);
      return handle as unknown as { ref?: () => unknown; unref?: () => unknown };
    },
    clearInterval(handle) {
      if (handle) {
        globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
      }
    }
  };

  let active = false;
  let intervalHandle: { ref?: () => unknown; unref?: () => unknown } | undefined;
  let inFlight: Promise<void> | null = null;

  async function tick() {
    if (!active) {
      return;
    }

    if (inFlight) {
      await inFlight;
      return;
    }

    inFlight = input.sendTyping().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  return {
    async start() {
      if (active) {
        return;
      }

      active = true;
      await tick();
      intervalHandle = clock.setInterval(() => {
        void tick();
      }, renewIntervalMs);
      intervalHandle.unref?.();
    },

    async stop() {
      if (!active) {
        return;
      }

      active = false;
      clock.clearInterval(intervalHandle);
      intervalHandle = undefined;
      await inFlight;
    }
  };
}
