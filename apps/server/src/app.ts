import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { installErrorHandler, installNotFoundHandler } from "./errors/error-handler.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTaskEventsRoute } from "./routes/task-events.js";
import type { TaskOrchestrator } from "./tasks/task-orchestrator.js";
import type { TaskStore } from "./tasks/task-store.js";
import type { EventStore } from "./events/event-store.js";
import type { EventBus } from "./events/event-bus.js";
import type { ServerLimits } from "./config/server-config.js";

export interface CreateHallCoreAppOptions {
  readonly orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly limits: ServerLimits;
  /** Passed straight through to Fastify's `logger` option; pass `false` in tests to keep output quiet. */
  readonly logger?: boolean | FastifyBaseLogger;
  readonly startedAt?: number;
}

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

  // Registered before any WebSocket route is declared, as required by
  // @fastify/websocket.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: options.limits.maxWebSocketMessageBytes },
  });

  installErrorHandler(app);
  installNotFoundHandler(app);

  registerHealthRoute(app, { startedAt: options.startedAt ?? Date.now() });
  registerTaskRoutes(app, { orchestrator: options.orchestrator, taskStore: options.taskStore });
  registerTaskEventsRoute(app, {
    taskStore: options.taskStore,
    eventStore: options.eventStore,
    eventBus: options.eventBus,
    maxBufferedBytes: options.limits.maxWebSocketMessageBytes * 16,
  });

  return app;
}
