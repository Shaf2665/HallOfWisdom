import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { installErrorHandler, installNotFoundHandler } from "./errors/error-handler.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTaskEventsRoute } from "./routes/task-events.js";
import { registerAdapterRoutes } from "./routes/adapters.js";
import type { TaskOrchestrator } from "./tasks/task-orchestrator.js";
import type { TaskStore } from "./tasks/task-store.js";
import type { EventStore } from "./events/event-store.js";
import type { EventBus } from "./events/event-bus.js";
import { DEFAULT_WEB_ORIGIN, type ServerLimits } from "./config/server-config.js";

export interface CreateHallCoreAppOptions {
  readonly orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly registry: AgentRegistry;
  readonly limits: ServerLimits;
  /** The single browser origin allowed by CORS and WebSocket Origin validation. */
  readonly webOrigin?: string | undefined;
  /** Passed straight through to Fastify's `logger` option; pass `false` in tests to keep output quiet. */
  readonly logger?: boolean | FastifyBaseLogger;
  readonly startedAt?: number;
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
    methods: ["GET", "POST", "OPTIONS"],
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

  registerHealthRoute(app, { startedAt: options.startedAt ?? Date.now() });
  registerTaskRoutes(app, { orchestrator: options.orchestrator, taskStore: options.taskStore });
  registerAdapterRoutes(app, { registry: options.registry });
  registerTaskEventsRoute(app, {
    taskStore: options.taskStore,
    eventStore: options.eventStore,
    eventBus: options.eventBus,
    maxBufferedBytes: options.limits.maxWebSocketMessageBytes * 16,
    allowedOrigin: webOrigin,
  });

  return app;
}
