export const DEFAULT_PORT = 4310;

/** Hall Core binds to loopback only; there is deliberately no config option to change this in this phase. */
export const LOCAL_ONLY_HOST = "127.0.0.1";

export interface ServerLimits {
  readonly maxTasks: number;
  readonly maxEventsPerTask: number;
  readonly maxSubscribersPerTask: number;
  readonly maxBodyBytes: number;
  readonly maxWebSocketMessageBytes: number;
}

/**
 * Conservative but practical prototype defaults. Bounding these is what
 * keeps an in-memory server from growing without limit — see
 * `docs/architecture/0004-hall-core-server.md` ("In-memory storage
 * limitations") for the reasoning behind each value.
 */
export const DEFAULT_LIMITS: ServerLimits = {
  maxTasks: 500,
  maxEventsPerTask: 2000,
  maxSubscribersPerTask: 20,
  maxBodyBytes: 64 * 1024,
  maxWebSocketMessageBytes: 4 * 1024,
};

/** Bounded wait for active runs to reach a terminal state during graceful shutdown. */
export const SHUTDOWN_TIMEOUT_MS = 5000;
