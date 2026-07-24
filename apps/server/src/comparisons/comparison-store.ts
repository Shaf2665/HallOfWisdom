import {
  ComparisonCandidateNotFoundError,
  ComparisonCapacityReachedError,
  ComparisonNotFoundError,
  ComparisonStateConflictError,
  DuplicateComparisonError,
} from "../errors/app-error.js";
import type {
  AgentComparisonRecord,
  CandidateResultEvidence,
  ComparisonCandidateRecord,
  ComparisonPreference,
  ComparisonStatus,
} from "./comparison-record.js";
import type { ExecutionTrust, StructuredFailure } from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";

export interface ComparisonStoreOptions {
  readonly maxComparisons: number;
}

/**
 * In-memory comparison storage. `get`/`list` always return
 * `structuredClone`d copies — same convention as `TaskStore`, and for the
 * same reason.
 *
 * Owns its own, wholly independent per-comparison revision counter (never
 * `TaskStore`'s) — comparisons are a separate aggregate; see
 * `docs/architecture/0012-controlled-agent-comparison.md`, "Concurrency
 * model." Every method that performs an atomic check-then-commit
 * (`claimPreparing`, `claimCandidateStart`, `claimCleanup`) follows
 * `TaskStore.setRunId()`'s exact discipline: the live record is read,
 * validated, and written with no `await` anywhere in between, so two
 * concurrent callers can never both win the same claim.
 */
export class ComparisonStore {
  readonly #records = new Map<string, AgentComparisonRecord>();
  readonly #revisions = new Map<string, number>();
  readonly #maxComparisons: number;

  constructor(options: ComparisonStoreOptions) {
    this.#maxComparisons = options.maxComparisons;
  }

  add(record: AgentComparisonRecord): void {
    if (this.#records.has(record.comparisonId)) {
      throw new DuplicateComparisonError(record.comparisonId);
    }
    if (this.#records.size >= this.#maxComparisons) {
      throw new ComparisonCapacityReachedError(this.#maxComparisons);
    }
    this.#records.set(record.comparisonId, record);
    this.#revisions.set(record.comparisonId, 0);
  }

  get(comparisonId: string): AgentComparisonRecord {
    return structuredClone(this.#mustGetLive(comparisonId));
  }

  /** Deterministic insertion order — a `Map` preserves it in JavaScript. */
  list(): AgentComparisonRecord[] {
    return Array.from(this.#records.values(), (record) => structuredClone(record));
  }

  getRevision(comparisonId: string): number {
    this.#mustGetLive(comparisonId);
    return this.#revisions.get(comparisonId) ?? 0;
  }

  /** Atomic claim: `draft -> preparing`. Rejects a second concurrent `POST .../prepare` for the same comparison. */
  claimPreparing(comparisonId: string): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    if (record.status !== "draft") {
      throw new ComparisonStateConflictError(comparisonId, record.status, "prepared");
    }
    record.status = "preparing";
    record.updatedAt = new Date().toISOString();
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /** Success path out of `preparing`: `baseCommit` resolved once and shared by both candidates, both move `pending -> prepared`, comparison moves to `ready`. */
  setReady(
    comparisonId: string,
    input: {
      readonly baseCommit: string;
      readonly candidates: readonly {
        readonly candidateId: string;
        readonly executionTrust: ExecutionTrust;
      }[];
    },
  ): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    if (record.status !== "preparing") {
      throw new ComparisonStateConflictError(comparisonId, record.status, "marked ready");
    }
    const now = new Date().toISOString();
    record.baseCommit = input.baseCommit;
    record.status = "ready";
    record.preparedAt = now;
    record.updatedAt = now;
    for (const candidateInput of input.candidates) {
      const candidate = this.#findCandidate(record, candidateInput.candidateId);
      candidate.status = "prepared";
      candidate.executionTrust = candidateInput.executionTrust;
      candidate.preparedAt = now;
    }
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /**
   * Failure path out of `preparing`: comparison moves to `failed`;
   * candidates remain `pending` (nothing about an individual candidate
   * changed — the failure is comparison-level worktree/Git preparation,
   * not a candidate outcome). `failedCandidateId`, when identifiable
   * (e.g. the second candidate's worktree creation failed after the
   * first succeeded and was rolled back), additionally carries the same
   * safe reason on that specific candidate for display. `code`/`safeReason`
   * are always recorded at the comparison level (`prepareFailureCode`/
   * `prepareFailureReason`) regardless of whether a specific candidate
   * could be identified — see those fields' doc comments on
   * `AgentComparisonRecord`.
   */
  setPrepareFailed(
    comparisonId: string,
    failedCandidateId: string | undefined,
    code: string,
    safeReason: string,
  ): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    if (record.status !== "preparing") {
      throw new ComparisonStateConflictError(comparisonId, record.status, "marked failed");
    }
    record.status = "failed";
    record.updatedAt = new Date().toISOString();
    record.prepareFailureCode = code;
    record.prepareFailureReason = safeReason;
    if (failedCandidateId !== undefined) {
      this.#findCandidate(record, failedCandidateId).safeFailureReason = safeReason;
    }
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /**
   * Atomic claim: candidate `prepared -> running`, allocates
   * `runId`/`agentId` — mirrors `TaskStore.setRunId()`. Enforces
   * "explicit operator-controlled start, sequential only this phase, no
   * auto-parallel provider execution" (the kickoff's own words) as a
   * store-level invariant, not merely a UI convention: rejects starting a
   * candidate while any *other* candidate on the same comparison is
   * already `running`. This also sidesteps a real risk, not just a policy
   * one — two candidates finalizing concurrently would run `git add -A`/
   * `git diff` in two different worktrees that share one `.git` directory,
   * the same class of real-`git`-under-load contention
   * `GitWorktreeManager` already serializes worktree *creation* against
   * (see that class's doc comment).
   */
  claimCandidateStart(
    comparisonId: string,
    candidateId: string,
    runId: string,
    agentId: string,
  ): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    if (record.status !== "ready" && record.status !== "running") {
      throw new ComparisonStateConflictError(comparisonId, record.status, "started");
    }
    const candidate = this.#findCandidate(record, candidateId);
    if (candidate.status !== "prepared") {
      throw new ComparisonStateConflictError(comparisonId, candidate.status, "started");
    }
    const anotherCandidateRunning = record.candidates.some(
      (entry) => entry.candidateId !== candidateId && entry.status === "running",
    );
    if (anotherCandidateRunning) {
      throw new ComparisonStateConflictError(
        comparisonId,
        "running",
        "started (comparisons run candidates sequentially, one at a time)",
      );
    }
    const now = new Date().toISOString();
    candidate.status = "running";
    candidate.runId = runId;
    candidate.agentId = agentId;
    candidate.startedAt = now;
    record.status = "running";
    record.updatedAt = now;
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /** Rolls back a `claimCandidateStart()` claim when the post-claim `detect()`/eligibility re-check fails before any event was ever produced. */
  clearCandidateStart(comparisonId: string, candidateId: string): void {
    const record = this.#mustGetLive(comparisonId);
    const candidate = this.#findCandidate(record, candidateId);
    candidate.status = "prepared";
    candidate.runId = undefined;
    candidate.agentId = undefined;
    candidate.startedAt = undefined;
    record.status = this.#deriveComparisonStatus(record);
    record.updatedAt = new Date().toISOString();
    this.#bumpRevision(comparisonId);
  }

  recordCandidateEventMeta(comparisonId: string, candidateId: string, sequence: number): void {
    const record = this.#mustGetLive(comparisonId);
    const candidate = this.#findCandidate(record, candidateId);
    candidate.eventCount += 1;
    candidate.lastSequence = sequence;
    this.#bumpRevision(comparisonId);
  }

  setCandidateCompleted(
    comparisonId: string,
    candidateId: string,
    input: {
      readonly completedAt: string;
      readonly terminalEventType: TerminalEventType;
      readonly failure?: StructuredFailure | undefined;
      readonly resultEvidence?: CandidateResultEvidence | undefined;
    },
  ): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    const candidate = this.#findCandidate(record, candidateId);
    candidate.completedAt = input.completedAt;
    candidate.terminalEventType = input.terminalEventType;
    candidate.failure = input.failure;
    candidate.resultEvidence = input.resultEvidence;
    candidate.status =
      input.terminalEventType === "run.completed"
        ? "completed"
        : input.terminalEventType === "run.cancelled"
          ? "cancelled"
          : "failed";
    record.status = this.#deriveComparisonStatus(record);
    record.updatedAt = new Date().toISOString();
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /** Flags a running candidate's cancellation request (the orchestrator aborts its `AbortController` separately) — idempotent, mirrors `TaskOrchestrator.requestCancellation()`. */
  setCandidateCancellationRequested(
    comparisonId: string,
    candidateId: string,
  ): { alreadyRequested: boolean } {
    const record = this.#mustGetLive(comparisonId);
    const candidate = this.#findCandidate(record, candidateId);
    if (candidate.status !== "running") {
      throw new ComparisonStateConflictError(comparisonId, candidate.status, "cancelled");
    }
    if (candidate.cancellationRequested) {
      return { alreadyRequested: true };
    }
    candidate.cancellationRequested = true;
    this.#bumpRevision(comparisonId);
    return { alreadyRequested: false };
  }

  /** Directly cancels a candidate that never started (`pending` or `prepared`) — there is no run to abort, so this is a synchronous terminal transition, not merely a request flag. */
  cancelUnstartedCandidate(comparisonId: string, candidateId: string): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    const candidate = this.#findCandidate(record, candidateId);
    if (candidate.status !== "pending" && candidate.status !== "prepared") {
      throw new ComparisonStateConflictError(comparisonId, candidate.status, "cancelled");
    }
    const now = new Date().toISOString();
    candidate.status = "cancelled";
    candidate.completedAt = now;
    record.status = this.#deriveComparisonStatus(record);
    record.updatedAt = now;
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /**
   * Atomic claim: begins (or retries) worktree cleanup. Rejects only
   * while a cleanup is already actively in progress, already fully
   * completed, or while `preparing` is still in flight (worktree creation
   * and cleanup must never run concurrently against the same
   * comparison) — a prior *failed* cleanup may always be retried. When
   * the comparison had not yet reached a terminal outcome on its own
   * (`draft`/`ready`/`running`), this also marks it `cancelled` in the
   * same atomic step — the one, single meaning of that status: the
   * operator tore the comparison down before it finished naturally.
   */
  claimCleanup(comparisonId: string): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    if (record.status === "preparing") {
      throw new ComparisonStateConflictError(comparisonId, record.status, "cleaned up");
    }
    if (record.cleanupStatus === "in_progress") {
      throw new ComparisonStateConflictError(
        comparisonId,
        record.status,
        "cleaned up (already in progress)",
      );
    }
    if (record.cleanupStatus === "completed") {
      throw new ComparisonStateConflictError(
        comparisonId,
        record.status,
        "cleaned up (already completed)",
      );
    }
    const now = new Date().toISOString();
    record.cleanupStatus = "in_progress";
    record.cleanupError = undefined;
    if (record.status === "draft" || record.status === "ready" || record.status === "running") {
      record.status = "cancelled";
    }
    record.updatedAt = now;
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /** Marks active worktree removal in progress — always safe to call once `claimCleanup()` has succeeded. */
  markCleaning(comparisonId: string): void {
    const record = this.#mustGetLive(comparisonId);
    record.status = "cleaning";
    record.updatedAt = new Date().toISOString();
    this.#bumpRevision(comparisonId);
  }

  setCleanupCompleted(comparisonId: string): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    record.cleanupStatus = "completed";
    record.cleanupError = undefined;
    record.status = "cleaned";
    record.updatedAt = new Date().toISOString();
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /** `safeError` must already be a bounded, path-free, credential-free message — see `docs/architecture/0012-controlled-agent-comparison.md`, "Result evidence bounding." */
  setCleanupFailed(comparisonId: string, safeError: string): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    record.cleanupStatus = "failed";
    record.cleanupError = safeError;
    record.updatedAt = new Date().toISOString();
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  /** Records (or clears, when `undefined`) a non-merging operator preference — never affects any candidate's status or triggers any action. */
  setPreference(
    comparisonId: string,
    preference: ComparisonPreference | undefined,
  ): AgentComparisonRecord {
    const record = this.#mustGetLive(comparisonId);
    record.preference = preference;
    record.updatedAt = new Date().toISOString();
    this.#bumpRevision(comparisonId);
    return structuredClone(record);
  }

  #findCandidate(record: AgentComparisonRecord, candidateId: string): ComparisonCandidateRecord {
    const candidate = record.candidates.find((entry) => entry.candidateId === candidateId);
    if (!candidate) {
      throw new ComparisonCandidateNotFoundError(record.comparisonId, candidateId);
    }
    return candidate;
  }

  /**
   * Recomputes the comparison-level status from its two candidates'
   * statuses — only ever transforms `ready`/`running`. Every other
   * status (`draft`/`preparing`/`failed`/`cancelled`/`cleaning`/`cleaned`)
   * is a fixed point set by its own dedicated method above and must never
   * be silently overwritten here — in particular, a candidate terminal
   * event that arrives after cleanup has already begun (the run was
   * abort-signalled but had not yet actually stopped) must not resurrect
   * an outcome status and clobber `cleaning`/`cleaned`.
   */
  #deriveComparisonStatus(record: AgentComparisonRecord): ComparisonStatus {
    if (record.status !== "ready" && record.status !== "running") {
      return record.status;
    }
    const statuses = record.candidates.map((candidate) => candidate.status);
    const allTerminal = statuses.every(
      (status) => status === "completed" || status === "failed" || status === "cancelled",
    );
    if (allTerminal) {
      return statuses.every((status) => status === "completed")
        ? "completed"
        : "partially_completed";
    }
    const anyProgressMade = statuses.some(
      (status) =>
        status === "running" ||
        status === "completed" ||
        status === "failed" ||
        status === "cancelled",
    );
    return anyProgressMade ? "running" : "ready";
  }

  #mustGetLive(comparisonId: string): AgentComparisonRecord {
    const record = this.#records.get(comparisonId);
    if (!record) {
      throw new ComparisonNotFoundError(comparisonId);
    }
    return record;
  }

  #bumpRevision(comparisonId: string): void {
    this.#revisions.set(comparisonId, (this.#revisions.get(comparisonId) ?? 0) + 1);
  }
}
