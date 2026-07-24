import { z } from "zod";
import type {
  ExecutionTrust,
  StructuredFailure,
  TaskPriority,
  TaskRequirements,
} from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";

/**
 * `AgentComparison` lifecycle. Server-local, never persisted anywhere but
 * this process's memory — see `ComparisonStore`. Unlike `TaskStatus`,
 * comparisons never touch the source task's own status; a comparison's
 * status describes only the comparison's own worktree/execution
 * lifecycle.
 *
 * - `draft`: created (source task snapshotted, two pending candidates
 *   registered); no filesystem or Git work has happened yet.
 * - `preparing`: `POST .../prepare` is resolving the base commit and
 *   creating both candidates' worktrees.
 * - `ready`: both worktrees exist and are commit-verified; no candidate
 *   has been started yet.
 * - `running`: at least one candidate has been explicitly started and at
 *   least one candidate has not yet reached a terminal candidate status
 *   (`completed`/`failed`/`cancelled`) — this is the "still in progress"
 *   state, covering both "one candidate running, one still `prepared`"
 *   and "one candidate finished, the other hasn't been started yet."
 * - `partially_completed`: every candidate has reached a terminal
 *   candidate status, but not every one of them is `completed` (at least
 *   one `failed` or was `cancelled`).
 * - `completed`: every candidate reached `completed`.
 * - `failed`: `preparing` itself failed (e.g. the source repository was
 *   not clean, or worktree creation failed) — no candidate ever started.
 * - `cancelled`: the comparison was cancelled before every candidate
 *   reached a terminal status (an explicit operator action, not a status
 *   any candidate outcome alone produces).
 * - `cleaning` / `cleaned`: worktree removal in progress / complete — see
 *   `cleanupStatus` for the more detailed, independently tracked signal
 *   `DELETE /api/v1/comparisons/:comparisonId` drives.
 */
export const comparisonStatusSchema = z.enum([
  "draft",
  "preparing",
  "ready",
  "running",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
  "cleaning",
  "cleaned",
]);
export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

export const candidateStatusSchema = z.enum([
  "pending",
  "prepared",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

/** Independent of `ComparisonStatus`: worktree cleanup can be retried after a failure without changing what the comparison's own execution outcome was. */
export const cleanupStatusSchema = z.enum(["not_started", "in_progress", "completed", "failed"]);
export type CleanupStatus = z.infer<typeof cleanupStatusSchema>;

/**
 * Bounded, path-free evidence of one candidate's outcome — never an
 * absolute filesystem path, never raw process output, never provider
 * reasoning/tokens/cost. `changedFiles` entries are repository-relative
 * (computed against the candidate's own worktree root, which is never
 * itself exposed). See `result-evidence.ts` for how this is built and
 * bounded.
 */
export const changedFileEntrySchema = z
  .object({
    relativePath: z.string().max(4096),
    changeType: z.enum(["added", "modified", "deleted", "renamed"]),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  })
  .strict();
export type ChangedFileEntry = z.infer<typeof changedFileEntrySchema>;

export const candidateResultEvidenceSchema = z
  .object({
    changedFiles: z.array(changedFileEntrySchema).max(500),
    totalAdditions: z.number().int().min(0),
    totalDeletions: z.number().int().min(0),
    /** Unified diff text (bounded — see `result-evidence.ts`'s `MAX_DIFF_CHARS`), or omitted entirely if there were no changes. */
    boundedDiff: z.string().max(200_000).optional(),
    truncated: z.boolean(),
  })
  .strict();
export type CandidateResultEvidence = z.infer<typeof candidateResultEvidenceSchema>;

export interface ComparisonCandidateRecord {
  readonly candidateId: string;
  readonly adapterId: string;
  readonly displayName: string;
  status: CandidateStatus;
  /** Observed at prepare time (a fresh `detect()`) and re-observed at start time — never trusted stale across that gap. */
  executionTrust: ExecutionTrust | undefined;
  runId: string | undefined;
  /** Set atomically alongside `runId` at start time — the same `agentId` the adapter's own events carry, needed to verify each incoming event's identity. */
  agentId: string | undefined;
  readonly createdAt: string;
  preparedAt: string | undefined;
  startedAt: string | undefined;
  completedAt: string | undefined;
  eventCount: number;
  lastSequence: number | undefined;
  terminalEventType: TerminalEventType | undefined;
  failure: StructuredFailure | undefined;
  cancellationRequested: boolean;
  resultEvidence: CandidateResultEvidence | undefined;
  /** A safe, bounded, non-path failure reason for `preparing`-stage failures (e.g. worktree creation itself failed) — distinct from `failure`, which is an execution-run outcome. */
  safeFailureReason: string | undefined;
}

export interface ComparisonPreference {
  readonly candidateId: string;
  readonly note: string | undefined;
  readonly recordedAt: string;
}

/**
 * The full server-side comparison record `ComparisonStore` holds and
 * `GET /api/v1/comparisons/:comparisonId` serializes directly (after
 * `structuredClone`, exactly like `TaskStore.get()`) — every field here
 * must already be response-safe. Absolute filesystem paths — the canonical
 * source repository root resolved from the source task's working directory
 * (`sourceRepositoryPath` is intentionally NOT a field here; the repository
 * is resolved per-comparison from the source task, never accepted as
 * per-comparison caller input) and candidate worktree paths — are kept in
 * private, non-serialized maps inside `ComparisonOrchestrator`, exactly
 * like `TaskOrchestrator#pendingWorkingDirectories`.
 */
export interface AgentComparisonRecord {
  readonly comparisonId: string;
  readonly sourceTaskId: string;
  /** Snapshotted from the source task at creation time — never re-read from the live task afterward. See `docs/architecture/0012-controlled-agent-comparison.md`, "Source task snapshot policy." */
  readonly title: string;
  readonly description: string;
  readonly priority: TaskPriority;
  readonly requirements: TaskRequirements | undefined;
  /** Resolved once during `prepare` and shared by both candidates — never re-resolved per candidate. `undefined` until `preparing` completes. */
  baseCommit: string | undefined;
  status: ComparisonStatus;
  readonly createdAt: string;
  updatedAt: string;
  preparedAt: string | undefined;
  candidates: readonly [ComparisonCandidateRecord, ComparisonCandidateRecord];
  cleanupStatus: CleanupStatus;
  cleanupError: string | undefined;
  /**
   * A stable, machine-checkable code for a `preparing`-stage failure that
   * is not specific to either candidate (e.g. the source task had no
   * working directory, or its repository was dirty) — set alongside
   * `prepareFailureReason` whenever `status` becomes `"failed"` out of
   * `preparing`. Distinct from a candidate's own `safeFailureReason`, which
   * covers candidate-specific worktree-creation failures. See
   * `docs/architecture/0012-controlled-agent-comparison.md`, "Source
   * repository resolution failures."
   */
  prepareFailureCode: string | undefined;
  /** A safe, bounded, path-free human-readable reason paired with `prepareFailureCode`. */
  prepareFailureReason: string | undefined;
  preference: ComparisonPreference | undefined;
}
