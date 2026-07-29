import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { installErrorHandler, installNotFoundHandler } from "./errors/error-handler.js";
import { registerHealthRoute, type ReadinessRef } from "./routes/health.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTaskEventsRoute } from "./routes/task-events.js";
import { registerAdapterRoutes } from "./routes/adapters.js";
import { registerRoutingRoutes } from "./routes/routing.js";
import { registerBoardRoutes } from "./routes/boards.js";
import { registerBoardMessagesRoute } from "./routes/board-messages.js";
import { registerComparisonRoutes } from "./routes/comparisons.js";
import { registerComparisonCandidateEventsRoute } from "./routes/comparison-candidate-events.js";
import { registerSystemStorageRoute } from "./routes/system.js";
import type { RecoverySummary } from "./recovery/restart-recovery.js";
import type { ComparisonComposition } from "./composition/comparison-composition-root.js";
import type { TaskOrchestrator } from "./tasks/task-orchestrator.js";
import type { TaskStorePort } from "./tasks/task-store-port.js";
import type { NormalizedEventStorePort } from "./events/event-store-port.js";
import type { EventBus } from "./events/event-bus.js";
import type { BoardStorePort } from "./boards/board-store-port.js";
import type { MessageStorePort } from "./boards/message-store-port.js";
import type { MessageBus } from "./boards/message-bus.js";
import { DEFAULT_WEB_ORIGIN, type ServerLimits } from "./config/server-config.js";

export interface CreateHallCoreAppOptions {
  readonly orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStorePort;
  readonly eventStore: NormalizedEventStorePort;
  readonly eventBus: EventBus;
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly messageBus: MessageBus;
  readonly registry: AgentRegistry;
  readonly limits: ServerLimits;
  /** Phase 12 — present only when `--comparison-root` was supplied at startup; when absent, no comparison routes are registered at all. */
  readonly comparison?: ComparisonComposition | undefined;
  /** The single browser origin allowed by CORS and WebSocket Origin validation. */
  readonly webOrigin?: string | undefined;
  /** Passed straight through to Fastify's `logger` option; pass `false` in tests to keep output quiet. */
  readonly logger?: boolean | FastifyBaseLogger;
  readonly startedAt?: number;
  /**
   * Phase 13 — `"durable"` when `--data-dir` was supplied at startup,
   * `"in-memory"` otherwise (the default, byte-identical to pre-Phase-13
   * behavior). Drives `GET /api/v1/system/storage`.
   */
  readonly storageMode?: "durable" | "in-memory";
  /** Present only when `storageMode === "durable"` — the summary `runRestartRecovery` produced at this boot. */
  readonly recoverySummary?: RecoverySummary | undefined;
  /** Phase 13.2 — see `HealthRouteDeps.readiness`. `undefined` (the default) means `GET /api/v1/health` always reports ready. */
  readonly readiness?: ReadinessRef | undefined;
}

/** How long a browser may cache a successful CORS preflight response, in seconds. */
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Builds a fully configured Fastify instance but never calls `.listen()`
 * — only `server.ts` (the process boundary) does that, so this factory
 * stays usable from tests (via Fastify's `.inject()`) and from any future
 * caller that wants to embed Hall Core without necessarily binding a real
 * port.
 */
export async function createHallCoreApp(
  options: CreateHallCoreAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: options.limits.maxBodyBytes,
  });

  const webOrigin = options.webOrigin ?? DEFAULT_WEB_ORIGIN;

  // Registered before any route: an exact-match allowlist of exactly one
  // origin, never a wildcard, never a reflect-the-request-Origin function,
  // and never with credentials enabled. See
  // docs/architecture/0005-minimal-web-interface.md, "Exact-origin CORS
  // policy".
  await app.register(fastifyCors, {
    origin: [webOrigin],
    // Phase 12 — "DELETE" added for comparison cleanup
    // (`DELETE /api/v1/comparisons/:comparisonId`), the first endpoint in
    // this codebase to use that method; every other mutating route uses
    // POST. Without it, a browser blocks the request (and its CORS
    // preflight) before it ever reaches this server.
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: false,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  });

  // Registered before any WebSocket route is declared, as required by
  // @fastify/websocket.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: options.limits.maxWebSocketMessageBytes },
  });

  installErrorHandler(app);
  installNotFoundHandler(app);

  const startedAt = options.startedAt ?? Date.now();
  registerHealthRoute(app, { startedAt, readiness: options.readiness });
  registerSystemStorageRoute(app, {
    mode: options.storageMode ?? "in-memory",
    startedAt,
    recovery: options.recoverySummary,
  });
  registerTaskRoutes(app, { orchestrator: options.orchestrator, taskStore: options.taskStore });
  registerAdapterRoutes(app, { registry: options.registry });
  registerRoutingRoutes(app, { orchestrator: options.orchestrator });
  registerTaskEventsRoute(app, {
    taskStore: options.taskStore,
    eventStore: options.eventStore,
    eventBus: options.eventBus,
    maxBufferedBytes: options.limits.maxWebSocketMessageBytes * 16,
    allowedOrigin: webOrigin,
  });
  registerBoardRoutes(app, {
    boardStore: options.boardStore,
    messageStore: options.messageStore,
    messageBus: options.messageBus,
  });
  registerBoardMessagesRoute(app, {
    boardStore: options.boardStore,
    messageStore: options.messageStore,
    messageBus: options.messageBus,
    maxBufferedBytes: options.limits.maxWebSocketMessageBytes * 16,
    allowedOrigin: webOrigin,
  });

  if (options.comparison) {
    registerComparisonRoutes(app, {
      orchestrator: options.comparison.comparisonOrchestrator,
      comparisonStore: options.comparison.comparisonStore,
    });
    registerComparisonCandidateEventsRoute(app, {
      comparisonStore: options.comparison.comparisonStore,
      eventStore: options.comparison.comparisonEventStore,
      eventBus: options.comparison.comparisonEventBus,
      maxBufferedBytes: options.limits.maxWebSocketMessageBytes * 16,
      allowedOrigin: webOrigin,
    });
  }

  return app;
}
