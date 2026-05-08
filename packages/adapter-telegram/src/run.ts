import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createEndecApp } from "@endec/app";
import { createTaskStore } from "@endec/tasks";
import { runBackgroundMaintenanceTick } from "./background-runtime.ts";
import { createTelegramAdapter } from "./adapter.ts";
import { createTelegramBotApiClient } from "./client.ts";
import { createTelegramPollingWorker } from "./polling.ts";
import { createSqliteTelegramAdapterStateStore } from "./state-store.ts";
import type {
  TelegramAdapterStateStore,
  TelegramBotClient,
  TelegramBotCommand,
  TelegramPollResult,
  TelegramSetMyCommandsParams
} from "./telegram-types.ts";

const DEFAULT_WORKSPACE_ID = "workspace_local";
const DEFAULT_ACCOUNT_ID = "telegram-bot";
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_STATE_STORE_FILENAME = "telegram-adapter.sqlite";
const DEFAULT_BACKGROUND_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_BACKGROUND_OUTBOX_INTERVAL_MS = 1_000;
const DEFAULT_BACKGROUND_LEASE_DURATION_MS = 30_000;
const DEFAULT_BACKGROUND_MAX_ITERATIONS = 4;
const TELEGRAM_GROUP_NATIVE_COMMANDS = [
  { command: "help", description: "Show supported commands" },
  { command: "status", description: "Show conversation and trust status" },
  { command: "model", description: "Show model and connection status" },
  { command: "persona", description: "Show or change persona" },
  { command: "history", description: "Summarize recent history" },
  { command: "trust", description: "Trust the current shared chat" }
] as const satisfies readonly TelegramBotCommand[];

const TELEGRAM_PRIVATE_NATIVE_COMMANDS = [
  { command: "help", description: "Show supported commands" },
  { command: "status", description: "Show conversation and trust status" },
  { command: "model", description: "Show model and connection status" },
  { command: "models", description: "Choose the active model" },
  { command: "reload", description: "Reload runtime config" },
  { command: "restart", description: "Request a graceful restart" },
  { command: "persona", description: "Show or change persona" },
  { command: "history", description: "Summarize recent history" },
  { command: "recall", description: "Run owner-only cross-conversation recall" }
] as const satisfies readonly TelegramBotCommand[];

export type TelegramRunnerConfig = {
  token: string;
  dataDir: string;
  workspaceId: string;
  accountId: string;
  pollTimeoutSeconds: number;
  apiBase: string;
  allowedChatIds: string[];
  allowedSenderIds: string[];
  env: Record<string, string | undefined>;
  enableBackgroundWorker: boolean;
  backgroundWorkerId: string;
  backgroundWorkerIntervalMs: number;
  backgroundOutboxIntervalMs: number;
  backgroundWorkerLeaseDurationMs: number;
  backgroundOutboxLeaseDurationMs: number;
  backgroundMaxIterations: number;
};

export type TelegramRunnerApp = {
  shell: {
    executeTurn: ReturnType<typeof createEndecApp>["shell"]["executeTurn"];
  };
  im: {
    resolveSessionId: ReturnType<typeof createEndecApp>["im"]["resolveSessionId"];
    resolveActorId: ReturnType<typeof createEndecApp>["im"]["resolveActorId"];
    recordPassiveIngress: ReturnType<typeof createEndecApp>["im"]["recordPassiveIngress"];
    executeCommand: ReturnType<typeof createEndecApp>["im"]["executeCommand"];
    evaluateInboundAdmission: ReturnType<typeof createEndecApp>["im"]["evaluateInboundAdmission"];
    applyConversationLifecycleEvent: ReturnType<typeof createEndecApp>["im"]["applyConversationLifecycleEvent"];
    evaluateOutboundConversationLegality: ReturnType<typeof createEndecApp>["im"]["evaluateOutboundConversationLegality"];
  };
  background?: {
    runWorkerOnce: ReturnType<typeof createEndecApp>["background"]["runWorkerOnce"];
  };
};

export type RunTelegramBotInput = {
  env?: Record<string, string | undefined>;
  config?: TelegramRunnerConfig;
  once?: boolean;
  signal?: AbortSignal;
  app?: TelegramRunnerApp;
  createApp?: (options: Parameters<typeof createEndecApp>[0]) => TelegramRunnerApp;
  client?: TelegramBotClient;
  stateStore?: TelegramAdapterStateStore;
};

export type RunTelegramBotResult = {
  config: TelegramRunnerConfig;
  pollResult: TelegramPollResult;
};

function parseCommaSeparatedIds(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function requireEnv(name: string, value: string | undefined) {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePollTimeoutSeconds(value: string | undefined) {
  if (!value || value.trim().length === 0) {
    return DEFAULT_POLL_TIMEOUT_SECONDS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("TELEGRAM_POLL_TIMEOUT_SECONDS must be a positive integer");
  }

  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, fieldName: string) {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean) {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error("TELEGRAM_ENABLE_BACKGROUND_WORKER must be a boolean-like value");
}

export function loadTelegramRunnerConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): TelegramRunnerConfig {
  const token = requireEnv("TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN);
  const dataDir = requireEnv("ENDEC_DATA_DIR", env.ENDEC_DATA_DIR);
  const enableBackgroundWorker = parseBooleanFlag(env.TELEGRAM_ENABLE_BACKGROUND_WORKER, true);

  return {
    token,
    dataDir,
    workspaceId: env.ENDEC_WORKSPACE_ID?.trim() || DEFAULT_WORKSPACE_ID,
    accountId: env.TELEGRAM_ACCOUNT_ID?.trim() || DEFAULT_ACCOUNT_ID,
    pollTimeoutSeconds: parsePollTimeoutSeconds(env.TELEGRAM_POLL_TIMEOUT_SECONDS),
    apiBase: env.TELEGRAM_API_BASE?.trim() || DEFAULT_API_BASE,
    allowedChatIds: parseCommaSeparatedIds(env.TELEGRAM_ALLOWED_CHAT_IDS),
    allowedSenderIds: parseCommaSeparatedIds(env.TELEGRAM_ALLOWED_SENDER_IDS),
    env,
    enableBackgroundWorker,
    backgroundWorkerId: env.TELEGRAM_BACKGROUND_WORKER_ID?.trim() || `telegram:${env.TELEGRAM_ACCOUNT_ID?.trim() || DEFAULT_ACCOUNT_ID}:same-process`,
    backgroundWorkerIntervalMs: parsePositiveInteger(
      env.TELEGRAM_BACKGROUND_WORKER_INTERVAL_MS,
      DEFAULT_BACKGROUND_WORKER_INTERVAL_MS,
      "TELEGRAM_BACKGROUND_WORKER_INTERVAL_MS"
    ),
    backgroundOutboxIntervalMs: parsePositiveInteger(
      env.TELEGRAM_BACKGROUND_OUTBOX_INTERVAL_MS,
      DEFAULT_BACKGROUND_OUTBOX_INTERVAL_MS,
      "TELEGRAM_BACKGROUND_OUTBOX_INTERVAL_MS"
    ),
    backgroundWorkerLeaseDurationMs: parsePositiveInteger(
      env.TELEGRAM_BACKGROUND_WORKER_LEASE_DURATION_MS,
      DEFAULT_BACKGROUND_LEASE_DURATION_MS,
      "TELEGRAM_BACKGROUND_WORKER_LEASE_DURATION_MS"
    ),
    backgroundOutboxLeaseDurationMs: parsePositiveInteger(
      env.TELEGRAM_BACKGROUND_OUTBOX_LEASE_DURATION_MS,
      DEFAULT_BACKGROUND_LEASE_DURATION_MS,
      "TELEGRAM_BACKGROUND_OUTBOX_LEASE_DURATION_MS"
    ),
    backgroundMaxIterations: parsePositiveInteger(
      env.TELEGRAM_BACKGROUND_MAX_ITERATIONS,
      DEFAULT_BACKGROUND_MAX_ITERATIONS,
      "TELEGRAM_BACKGROUND_MAX_ITERATIONS"
    )
  };
}

function ensureRunnerDataLayout(dataDir: string) {
  mkdirSync(join(dataDir, "state"), { recursive: true });
}

async function registerTelegramNativeCommands(client: TelegramBotClient) {
  if (!client.setMyCommands) {
    return;
  }

  const registrations = [
    {
      scope: { type: "all_group_chats" as const },
      commands: [...TELEGRAM_GROUP_NATIVE_COMMANDS]
    },
    {
      scope: { type: "all_private_chats" as const },
      commands: [...TELEGRAM_PRIVATE_NATIVE_COMMANDS]
    }
  ] satisfies TelegramSetMyCommandsParams[];

  for (const registration of registrations) {
    await client.setMyCommands(registration);
  }
}

function createTelegramStateStoreFilename(dataDir: string) {
  return join(dataDir, DEFAULT_STATE_STORE_FILENAME);
}

async function runPollingLoop(input: {
  worker: ReturnType<typeof createTelegramPollingWorker>;
  once?: boolean;
  signal?: AbortSignal;
  onAfterPoll?: () => Promise<void>;
}) {
  if (input.signal?.aborted) {
    return {
      receivedCount: 0,
      ignoredCount: 0,
      droppedCount: 0,
      dispatchedCount: 0,
      nextUpdateId: 0
    } satisfies TelegramPollResult;
  }

  if (input.once) {
    const result = await input.worker.pollOnce();
    if (!input.signal?.aborted) {
      await input.onAfterPoll?.();
    }
    return result;
  }

  let lastPollResult: TelegramPollResult | null = null;
  while (!input.signal?.aborted) {
    lastPollResult = await input.worker.pollOnce();
    if (!input.signal?.aborted) {
      await input.onAfterPoll?.();
    }
  }

  return lastPollResult ?? {
    receivedCount: 0,
    ignoredCount: 0,
    droppedCount: 0,
    dispatchedCount: 0,
    nextUpdateId: 0
  } satisfies TelegramPollResult;
}

export async function runTelegramBot(input: RunTelegramBotInput = {}): Promise<RunTelegramBotResult> {
  const config = input.config ?? loadTelegramRunnerConfigFromEnv(input.env);
  ensureRunnerDataLayout(config.dataDir);
  const stopController = new AbortController();
  if (input.signal?.aborted) {
    stopController.abort();
  } else if (input.signal) {
    input.signal.addEventListener("abort", () => stopController.abort(), { once: true });
  }
  const requestExit = async (exit: { code: number; reason: string }) => {
    stopController.abort();
    return undefined;
  };
  const app = input.app ?? (input.createApp ?? createEndecApp)({
    dataDir: config.dataDir,
    env: config.env,
    requestExit
  });
  const client = input.client ?? createTelegramBotApiClient({
    token: config.token,
    apiBase: config.apiBase
  });
  const stateStore = input.stateStore ?? createSqliteTelegramAdapterStateStore({
    filename: createTelegramStateStoreFilename(config.dataDir)
  });
  const taskStore = createTaskStore({
    filename: join(config.dataDir, "state", "tasks.sqlite")
  });
  const ownsStateStore = !input.stateStore;

  const enableBackgroundWorker = config.enableBackgroundWorker && !!app.background;

  try {
    const adapter = createTelegramAdapter({
      workspaceId: config.workspaceId,
      accountId: config.accountId,
      app: {
        shell: {
          executeTurn: app.shell.executeTurn.bind(app.shell)
        },
        im: {
          resolveSessionId: app.im.resolveSessionId.bind(app.im),
          resolveActorId: app.im.resolveActorId.bind(app.im),
          recordPassiveIngress: app.im.recordPassiveIngress.bind(app.im),
          executeCommand: app.im.executeCommand.bind(app.im),
          evaluateInboundAdmission: app.im.evaluateInboundAdmission.bind(app.im),
          applyConversationLifecycleEvent: app.im.applyConversationLifecycleEvent.bind(app.im),
          evaluateOutboundConversationLegality: app.im.evaluateOutboundConversationLegality.bind(app.im)
        }
      },
      client,
      stateStore,
      allow:
        config.allowedChatIds.length > 0 || config.allowedSenderIds.length > 0
          ? {
              chatIds: config.allowedChatIds,
              senderIds: config.allowedSenderIds
            }
          : undefined
    });

    await registerTelegramNativeCommands(client);

    const worker = createTelegramPollingWorker({
      accountId: config.accountId,
      client,
      adapter,
      stateStore,
      timeoutSeconds: config.pollTimeoutSeconds
    });

    const pollResult = await runPollingLoop({
      worker,
      once: input.once,
      signal: stopController.signal,
      onAfterPoll: enableBackgroundWorker
        ? async () => {
            await runBackgroundMaintenanceTick({
              app: {
                background: app.background!
              },
              adapter,
              store: taskStore,
              workerId: config.backgroundWorkerId,
              workerLeaseDurationMs: config.backgroundWorkerLeaseDurationMs,
              outboxLeaseDurationMs: config.backgroundOutboxLeaseDurationMs,
              maxIterations: config.backgroundMaxIterations,
              leaseOwner: config.backgroundWorkerId
            });
          }
        : undefined
    });

    return {
      config,
      pollResult
    };
  } finally {
    if (ownsStateStore) {
      stateStore.close();
    }
  }
}
