export const DEFAULT_PORT = 4310;

/** Hall Core binds to loopback only; there is deliberately no config option to change this in this phase. */
export const LOCAL_ONLY_HOST = "127.0.0.1";

/** The one browser origin allowed by CORS and WebSocket Origin validation, unless `--web-origin` overrides it. */
export const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:3000";

export interface ServerLimits {
  readonly maxTasks: number;
  readonly maxEventsPerTask: number;
  readonly maxSubscribersPerTask: number;
  readonly maxBodyBytes: number;
  readonly maxWebSocketMessageBytes: number;
  /** Excludes the General board, which is seeded once and does not count against this limit. */
  readonly maxBoards: number;
  readonly maxMessagesPerBoard: number;
  readonly maxSubscribersPerBoard: number;
  /** Phase 12 — independent of `maxTasks`: comparisons are a separate aggregate with their own capacity budget. */
  readonly maxComparisons: number;
  /** Per-candidate, not per-comparison (each comparison has exactly two candidates, each with its own event stream). */
  readonly maxEventsPerComparisonCandidate: number;
  readonly maxSubscribersPerComparisonCandidate: number;
  /** Bounded timeout for every `git` invocation Phase 12 issues (worktree create/remove/prune, status/diff/rev-parse). */
  readonly gitCommandTimeoutMs: number;
  readonly maxComparisonChangedFiles: number;
  readonly maxComparisonDiffChars: number;
  /** Bounded wait, during comparison cleanup, for an actively running (or just-finished) candidate to fully terminate before its worktree is removed. */
  readonly comparisonCleanupGraceTimeoutMs: number;
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
  maxBoards: 500,
  maxMessagesPerBoard: 1000,
  maxSubscribersPerBoard: 20,
  maxComparisons: 100,
  maxEventsPerComparisonCandidate: 2000,
  maxSubscribersPerComparisonCandidate: 20,
  gitCommandTimeoutMs: 30_000,
  maxComparisonChangedFiles: 500,
  maxComparisonDiffChars: 200_000,
  comparisonCleanupGraceTimeoutMs: 10_000,
};

/** Bounded wait for active runs to reach a terminal state during graceful shutdown. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

/** `PRAGMA busy_timeout` for the durable-mode SQLite connection — see `persistence/database.ts`. */
export const DATABASE_BUSY_TIMEOUT_MS = 5000;

export const EXIT_INVALID_INPUT = 2;
export const EXIT_INTERNAL_ERROR = 3;
export const EXIT_FORCED_SHUTDOWN = 130;
/** This instance's durable ownership epoch was superseded by another instance (Phase 13.2) — distinguished from `EXIT_INTERNAL_ERROR` purely for operator diagnosability; nothing branches on the specific value. */
export const EXIT_OWNERSHIP_LOST = 4;
