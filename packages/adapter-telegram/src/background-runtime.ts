import type { EndecApp } from "@endec/app";

export interface BackgroundMaintenanceTickResult {
  status: "idle" | "worked";
  iterations: number;
}

function didWorkerDoUsefulWork(result: Awaited<ReturnType<EndecApp["background"]["runWorkerOnce"]>>) {
  return result.status === "claimed";
}

function didDrainDoUsefulWork(result: { status: string }) {
  return result.status !== "idle";
}

export async function runBackgroundMaintenanceTick(input: {
  app: Pick<EndecApp, "background">;
  adapter: {
    drainBackgroundOutboxOnce(input: {
      store: unknown;
      leaseOwner: string;
      leaseDurationMs: number;
      chunkLimit?: number;
      now?: string;
    }): Promise<{ status: string }>;
  };
  store: unknown;
  workerId: string;
  workerLeaseDurationMs: number;
  outboxLeaseDurationMs: number;
  maxIterations: number;
  leaseOwner: string;
  chunkLimit?: number;
  now?: string;
}): Promise<BackgroundMaintenanceTickResult> {
  const maxIterations = Math.max(1, input.maxIterations);
  let worked = false;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const workerResult = await input.app.background.runWorkerOnce({
      workerId: input.workerId,
      leaseDurationMs: input.workerLeaseDurationMs,
      now: input.now
    });
    const drainResult = await input.adapter.drainBackgroundOutboxOnce({
      store: input.store,
      leaseOwner: input.leaseOwner,
      leaseDurationMs: input.outboxLeaseDurationMs,
      chunkLimit: input.chunkLimit,
      now: input.now
    });

    const didWork = didWorkerDoUsefulWork(workerResult) || didDrainDoUsefulWork(drainResult);
    if (!didWork) {
      return {
        status: worked ? "worked" : "idle",
        iterations: iteration
      };
    }

    worked = true;
  }

  return {
    status: worked ? "worked" : "idle",
    iterations: maxIterations
  };
}
