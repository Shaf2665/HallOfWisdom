import { randomUUID } from "node:crypto";
import {
  isTerminalEventType,
  runTask,
  type AgentRegistry,
  type TerminalEventType,
} from "@hall-of-wisdom/hall-runner";
import { parseAgentTaskInput, type AgentAdapter } from "@hall-of-wisdom/agent-adapter-sdk";
import {
  parseHallTask,
  type ExecutionTrust,
  type NormalizedAgentEvent,
} from "@hall-of-wisdom/protocol";
import {
  ComparisonAdapterNotFoundError,
  ComparisonCandidateNotEligibleError,
  ComparisonCandidateNotFoundError,
  ComparisonSourceTaskNotFoundError,
  InternalServerError,
  InvalidRequestError,
} from "../errors/app-error.js";
import type { AgentComparisonRecord, ComparisonCandidateRecord } from "./comparison-record.js";
import type { ComparisonStorePort } from "./comparison-store-port.js";
import type { GitWorktreeManager } from "./git-worktree-manager.js";
import {
  GitWorktreeError,
  NotAGitRepositoryError,
  SourceRepositoryNotCleanError,
} from "./git-worktree-errors.js";
import { resolveSourceRepositoryRoot } from "./source-repository-resolution.js";
import { SourceWorkingDirectoryRequiredError } from "./source-repository-errors.js";
import {
  InvalidWorkingDirectoryError,
  WorkingDirectoryOutsideWorkspaceError,
} from "@hall-of-wisdom/hall-runner";
import { captureResultEvidence, type CaptureResultEvidenceOptions } from "./result-evidence.js";
import { evaluateCandidateEligibility } from "../routing/routing-policy.js";
import { detectRoutingCandidates } from "../routing/candidate-detection.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import type { EventBus } from "../events/event-bus.js";
import { EventStoreError } from "../events/event-store-errors.js";
import { buildInfrastructureFailureEvent } from "../events/synthetic-events.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { ComparisonInternalPathsPort } from "./comparison-internal-paths-port.js";
import {
  createComparisonRequestSchema,
  setComparisonPreferenceRequestSchema,
  type CreateComparisonRequest,
  type SetComparisonPreferenceRequest,
} from "../schemas/comparison-request.js";

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export interface ComparisonOrchestratorOptions {
  readonly comparisonStore: ComparisonStorePort;
  readonly taskStore: TaskStorePort;
  readonly eventStore: NormalizedEventStorePort;
  readonly eventBus: EventBus;
  readonly registry: AgentRegistry;
  readonly gitWorktreeManager: GitWorktreeManager;
  /**
   * The trusted security boundary every source task's working directory
   * (and the Git repository resolved from it) must be contained within —
   * NOT itself the source repository, and need not itself be a Git
   * repository or be clean. May contain multiple independent repositories.
   * See `source-repository-resolution.ts`.
   */
  readonly workspaceRoot: string;
  readonly resultEvidenceOptions: CaptureResultEvidenceOptions;
  /** Bounded wait, when cleanup begins, for any still-running candidate to actually terminate (not merely be abort-signalled) before its worktree is removed — see `docs/architecture/0012-controlled-agent-comparison.md`, "Cleanup safety." */
  readonly cleanupGraceTimeoutMs: number;
  readonly onExecutionError?: ((candidateId: string, error: unknown) => void) | undefined;
  /**
   * Durable-mode-only. When supplied, every write/delete this class already
   * makes to its own private `#sourceRepositoryPaths`/`#worktreePaths` maps
   * is mirrored here too, so those facts survive a restart — see
   * `comparison-internal-paths-port.ts`'s doc comment. `undefined` in
   * ephemeral mode (the default), which leaves this class's behavior
   * byte-identical to before Phase 13.
   */
  readonly internalPaths?: ComparisonInternalPathsPort | undefined;
}

/**
 * Provider-neutral: resolves adapters purely through the injected
 * `AgentRegistry`, and drives candidate execution purely through Hall
 * Runner's public `runTask()` — no provider-specific branches. Mirrors
 * `TaskOrchestrator`'s concurrency discipline throughout (atomic
 * claim-before-await for start/prepare/cleanup, event-driven finalization,
 * infrastructure-failure fallback) but against `ComparisonStore`'s own,
 * separate revision mechanism — see that store's doc comment.
 *
 * Two comparison-specific safety properties beyond what `TaskOrchestrator`
 * needs: (1) `baseCommit` is resolved exactly once per comparison, in
 * `prepareComparison`, and the identical value is used for both
 * candidates' worktrees — never re-resolved per candidate, which would
 * open a window for the two candidates to silently diverge if a commit
 * landed on the source repository between them; (2) worktree paths are
 * never part of any serializable record (`ComparisonCandidateRecord` has
 * no path field) — they live only in this class's private `#worktreePaths`
 * map, exactly like `TaskOrchestrator#pendingWorkingDirectories`.
 */
export class ComparisonOrchestrator {
  readonly #comparisonStore: ComparisonStorePort;
  readonly #taskStore: TaskStorePort;
  readonly #eventStore: NormalizedEventStorePort;
  readonly #eventBus: EventBus;
  readonly #registry: AgentRegistry;
  readonly #gitWorktreeManager: GitWorktreeManager;
  readonly #workspaceRoot: string;
  readonly #resultEvidenceOptions: CaptureResultEvidenceOptions;
  readonly #cleanupGraceTimeoutMs: number;
  readonly #onExecutionError: ((candidateId: string, error: unknown) => void) | undefined;
  readonly #internalPaths: ComparisonInternalPathsPort | undefined;

  readonly #worktreePaths = new Map<string, string>();
  /**
   * Canonical source-repository root resolved for one comparison — set
   * once, in `prepareComparison`, from the source task's own stored working
   * directory (never `#workspaceRoot` directly; see
   * `source-repository-resolution.ts`). Kept alive for the comparison's
   * whole lifetime (not just the duration of `prepareComparison`) because
   * `cleanupComparison` also needs it: `git worktree remove` must run with
   * the actual repository as `cwd`, not the workspace root that may no
   * longer even be a Git repository itself. Never part of any serializable
   * record — same discipline as `#worktreePaths`.
   */
  readonly #sourceRepositoryPaths = new Map<string, string>();
  readonly #activeControllers = new Map<string, AbortController>();
  readonly #activeExecutions = new Map<string, Promise<void>>();
  /**
   * `#finalizeCandidate` runs fire-and-forget from `#handleCandidateEvent`
   * (`void this.#finalizeCandidate(...)`), started only after `runTask`'s
   * event stream has already ended — so it is never covered by
   * `#activeExecutions`, which `runTask`'s own promise resolves out of
   * moments earlier. It still performs real I/O against the candidate's
   * worktree (`captureResultEvidence`'s `git add -A` / `git diff`), so
   * cleanup and shutdown must wait for it too, or `removeWorktree` can
   * race a still-running `git` process reading/writing that same
   * worktree's index (observed as an EBUSY-class failure on Windows).
   */
  readonly #activeFinalizations = new Map<string, Promise<void>>();

  constructor(options: ComparisonOrchestratorOptions) {
    this.#comparisonStore = options.comparisonStore;
    this.#taskStore = options.taskStore;
    this.#eventStore = options.eventStore;
    this.#eventBus = options.eventBus;
    this.#registry = options.registry;
    this.#gitWorktreeManager = options.gitWorktreeManager;
    this.#workspaceRoot = options.workspaceRoot;
    this.#resultEvidenceOptions = options.resultEvidenceOptions;
    this.#cleanupGraceTimeoutMs = options.cleanupGraceTimeoutMs;
    this.#onExecutionError = options.onExecutionError;
    this.#internalPaths = options.internalPaths;
  }

  /**
   * Restores in-memory path tracking for comparisons that survived a
   * restart — called at most once, by composition/`restart-recovery.ts`,
   * before the server accepts requests. Only meaningful in durable mode
   * (`#internalPaths` is what `restart-recovery.ts` reads `listAll()` from
   * in the first place); calling this in ephemeral mode would simply have
   * nothing to pass. Never overwrites an existing in-flight entry — this
   * runs once at startup, when `#sourceRepositoryPaths`/`#worktreePaths`
   * are still empty.
   */
  rehydrateInternalPaths(paths: {
    readonly sourceRepositoryPaths: readonly {
      readonly comparisonId: string;
      readonly sourceRepositoryPath: string;
    }[];
    readonly worktreePaths: readonly {
      readonly candidateId: string;
      readonly worktreePath: string;
    }[];
  }): void {
    for (const { comparisonId, sourceRepositoryPath } of paths.sourceRepositoryPaths) {
      this.#sourceRepositoryPaths.set(comparisonId, sourceRepositoryPath);
    }
    for (const { candidateId, worktreePath } of paths.worktreePaths) {
      this.#worktreePaths.set(candidateId, worktreePath);
    }
  }

  /** Creates a `draft` comparison: snapshots the source task's title/description/priority/requirements at this moment and never re-reads it again — see `docs/architecture/0012-controlled-agent-comparison.md`, "Source task snapshot policy." Spends no filesystem or Git work. */
  createComparison(rawRequest: unknown): AgentComparisonRecord {
    const parsed = this.#parseCreateRequest(rawRequest);

    let sourceTask;
    try {
      sourceTask = this.#taskStore.get(parsed.sourceTaskId).task;
    } catch {
      throw new ComparisonSourceTaskNotFoundError(parsed.sourceTaskId);
    }

    const [adapterIdA, adapterIdB] = parsed.candidateAdapterIds;
    const adapterA = this.#resolveAdapter(adapterIdA);
    const adapterB = this.#resolveAdapter(adapterIdB);

    const now = new Date().toISOString();
    const candidates: [ComparisonCandidateRecord, ComparisonCandidateRecord] = [
      this.#buildInitialCandidate(adapterIdA, adapterA, now),
      this.#buildInitialCandidate(adapterIdB, adapterB, now),
    ];

    const record: AgentComparisonRecord = {
      comparisonId: randomUUID(),
      sourceTaskId: parsed.sourceTaskId,
      title: sourceTask.title,
      description: sourceTask.description,
      priority: sourceTask.priority,
      requirements: sourceTask.requirements,
      baseCommit: undefined,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      preparedAt: undefined,
      candidates,
      cleanupStatus: "not_started",
      cleanupError: undefined,
      prepareFailureCode: undefined,
      prepareFailureReason: undefined,
      preference: undefined,
    };

    this.#comparisonStore.add(record);
    return record;
  }

  /**
   * Resolves `baseCommit` once and creates both candidates' worktrees —
   * sequentially, not in parallel: `git worktree add` takes
   * repository-level locks, and concurrent creation against the same
   * source repository risks lock contention rather than just slower
   * completion. Atomic from the caller's perspective: any failure rolls
   * back every worktree this call itself created before marking the
   * comparison `failed`.
   */
  async prepareComparison(comparisonId: string): Promise<AgentComparisonRecord> {
    const claimed = this.#comparisonStore.claimPreparing(comparisonId);
    const [candidateA, candidateB] = claimed.candidates;

    let repositoryRoot: string;
    try {
      const rawWorkingDirectory = this.#taskStore.getWorkingDirectory(claimed.sourceTaskId);
      repositoryRoot = await resolveSourceRepositoryRoot({
        workspaceRoot: this.#workspaceRoot,
        rawWorkingDirectory,
        gitWorktreeManager: this.#gitWorktreeManager,
        sourceTaskId: claimed.sourceTaskId,
      });
    } catch (error) {
      return this.#failPreparation(comparisonId, undefined, error);
    }

    try {
      await this.#gitWorktreeManager.assertWorkingTreeClean(repositoryRoot);
    } catch (error) {
      return this.#failPreparation(comparisonId, undefined, error);
    }

    let baseCommit: string;
    try {
      baseCommit = await this.#gitWorktreeManager.resolveHeadCommit(repositoryRoot);
    } catch (error) {
      return this.#failPreparation(comparisonId, undefined, error);
    }

    // Recorded only once we're past every rejection check above — kept
    // alive for the whole comparison lifetime; see the field's doc comment.
    this.#sourceRepositoryPaths.set(comparisonId, repositoryRoot);
    this.#internalPaths?.setSourceRepositoryPath(comparisonId, repositoryRoot);

    const detected = await detectRoutingCandidates(this.#registry);
    const trustByAdapterId = new Map(
      detected.map((candidate) => [candidate.adapterId, candidate.executionTrust]),
    );

    const createdWorktrees: { candidateId: string; worktreePath: string }[] = [];
    try {
      for (const candidate of [candidateA, candidateB]) {
        const { worktreePath } = await this.#gitWorktreeManager.createWorktree({
          repositoryPath: repositoryRoot,
          baseCommit,
          worktreeId: candidate.candidateId,
        });
        this.#worktreePaths.set(candidate.candidateId, worktreePath);
        this.#internalPaths?.setWorktreePath(candidate.candidateId, comparisonId, worktreePath);
        createdWorktrees.push({ candidateId: candidate.candidateId, worktreePath });
      }
    } catch (error) {
      for (const created of createdWorktrees) {
        this.#worktreePaths.delete(created.candidateId);
        this.#internalPaths?.deleteWorktreePath(created.candidateId);
        await this.#tryRemoveWorktree(repositoryRoot, created.worktreePath);
      }
      const failedCandidateId =
        createdWorktrees.length === 0
          ? candidateA.candidateId
          : createdWorktrees.length === 1
            ? candidateB.candidateId
            : undefined;
      return this.#failPreparation(comparisonId, failedCandidateId, error);
    }

    return this.#comparisonStore.setReady(comparisonId, {
      baseCommit,
      candidates: [candidateA, candidateB].map((candidate) => ({
        candidateId: candidate.candidateId,
        executionTrust: trustByAdapterId.get(candidate.adapterId) ?? "unavailable",
      })),
    });
  }

  /**
   * Explicit, operator-driven start of exactly one candidate. Re-runs a
   * fresh `detect()` and (if the comparison carries requirements)
   * `evaluateCandidateEligibility` — never trusts the eligibility
   * snapshot `prepareComparison` observed, which may be stale by the time
   * an operator actually clicks "start." Claims `runId`/`agentId`
   * atomically before this async re-check, exactly like
   * `TaskOrchestrator.startTask()` claims `runId` before `adapter.detect()`,
   * and rolls the claim back if the re-check fails.
   */
  async startCandidate(comparisonId: string, candidateId: string): Promise<AgentComparisonRecord> {
    const record = this.#comparisonStore.get(comparisonId);
    const candidate = record.candidates.find((entry) => entry.candidateId === candidateId);
    if (!candidate) {
      throw new ComparisonCandidateNotFoundError(comparisonId, candidateId);
    }

    const adapter = this.#resolveAdapter(candidate.adapterId);
    const runId = randomUUID();
    const agentId = adapter.descriptor.supportedAgent.agentId;

    // Atomic claim — no `await` before this call; see
    // `ComparisonStore.claimCandidateStart()`'s doc comment.
    this.#comparisonStore.claimCandidateStart(comparisonId, candidateId, runId, agentId);

    const detection = await adapter.detect();
    const executionTrust: ExecutionTrust = detection.executionTrust ?? "unavailable";
    const eligible = this.#isEligible(
      record,
      candidate.adapterId,
      adapter,
      detection,
      executionTrust,
    );

    if (!eligible) {
      // Known, accepted interleaving: if a `DELETE` (cleanup) claim lands
      // on this comparison while this `await adapter.detect()` was in
      // flight, this rollback still only ever touches in-memory candidate
      // status — it never itself performs filesystem I/O — so at worst a
      // candidate's status is reset to "prepared" after its worktree was
      // already removed by that concurrent cleanup. A subsequent start
      // attempt then fails safely (`worktreePath === undefined` below, or
      // on retry), never silently touching a removed or partially-removed
      // worktree. This case is intentionally not resolved with a second
      // claim/lock: it is rare, fails closed, and never corrupts state.
      this.#comparisonStore.clearCandidateStart(comparisonId, candidateId);
      throw new ComparisonCandidateNotEligibleError(
        candidate.adapterId,
        detection.availability !== "available"
          ? `adapter reported availability "${detection.availability}"`
          : "the adapter no longer satisfies this comparison's requirements",
      );
    }

    const worktreePath = this.#worktreePaths.get(candidateId);
    if (worktreePath === undefined) {
      this.#comparisonStore.clearCandidateStart(comparisonId, candidateId);
      throw new InternalServerError(
        `Candidate "${candidateId}" has no recorded worktree to run in.`,
      );
    }

    const hallTask = parseHallTask({
      taskId: candidateId,
      projectId: "hall.comparison",
      title: record.title,
      description: record.description,
      priority: record.priority,
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: record.createdAt,
      updatedAt: new Date().toISOString(),
      ...(record.requirements !== undefined ? { requirements: record.requirements } : {}),
    });

    const taskInput = parseAgentTaskInput({
      hallTask,
      agentIdentity: adapter.descriptor.supportedAgent,
      runId,
      workingDirectory: worktreePath,
    });

    this.#beginCandidateExecution(
      comparisonId,
      candidateId,
      adapter.descriptor.adapterId,
      taskInput,
    );

    return this.#comparisonStore.get(comparisonId);
  }

  /** Cancels one candidate: a `pending`/`prepared` candidate (never started) is cancelled directly and synchronously; a `running` candidate's cancellation is flagged and its execution's `AbortController` is aborted — mirrors `TaskOrchestrator.requestCancellation()`. */
  requestCandidateCancellation(
    comparisonId: string,
    candidateId: string,
  ): { alreadyRequested: boolean } {
    const record = this.#comparisonStore.get(comparisonId);
    const candidate = record.candidates.find((entry) => entry.candidateId === candidateId);
    if (!candidate) {
      throw new ComparisonCandidateNotFoundError(comparisonId, candidateId);
    }

    if (candidate.status === "pending" || candidate.status === "prepared") {
      this.#comparisonStore.cancelUnstartedCandidate(comparisonId, candidateId);
      return { alreadyRequested: false };
    }

    const result = this.#comparisonStore.setCandidateCancellationRequested(
      comparisonId,
      candidateId,
    );
    if (!result.alreadyRequested) {
      this.#activeControllers.get(candidateId)?.abort("cancellation requested via REST API");
    }
    return result;
  }

  /** Records or clears (`candidateId: null`) a non-merging operator preference. Never affects any candidate's status or triggers any action. */
  setPreference(comparisonId: string, rawRequest: unknown): AgentComparisonRecord {
    const parsed = this.#parsePreferenceRequest(rawRequest);
    const record = this.#comparisonStore.get(comparisonId);

    if (parsed.candidateId === null) {
      return this.#comparisonStore.setPreference(comparisonId, undefined);
    }

    const candidate = record.candidates.find((entry) => entry.candidateId === parsed.candidateId);
    if (!candidate) {
      throw new ComparisonCandidateNotFoundError(comparisonId, parsed.candidateId);
    }

    return this.#comparisonStore.setPreference(comparisonId, {
      candidateId: parsed.candidateId,
      note: parsed.note,
      recordedAt: new Date().toISOString(),
    });
  }

  /**
   * Tears the comparison down: claims cleanup atomically (which also
   * marks a still-in-progress comparison `cancelled`), aborts any
   * running candidates and waits (bounded by `cleanupGraceTimeoutMs`) for
   * them to actually terminate, then removes every worktree this
   * comparison created. Never throws on a partial failure — always
   * returns the record, with `cleanupStatus: "failed"` and a safe,
   * bounded `cleanupError` when at least one worktree could not be
   * removed, so the caller can retry via a second `DELETE`.
   */
  async cleanupComparison(comparisonId: string): Promise<AgentComparisonRecord> {
    const claimed = this.#comparisonStore.claimCleanup(comparisonId);

    for (const candidate of claimed.candidates) {
      if (candidate.status === "running") {
        this.#activeControllers.get(candidate.candidateId)?.abort("comparison cleanup requested");
      }
    }
    // Two-phase, both bounded by the same grace timeout: first wait for
    // any in-flight `runTask` execution to actually settle. Only once
    // that has happened (or the grace period elapsed) is it safe to read
    // `#activeFinalizations` — a candidate's terminal event synchronously
    // starts its finalization (which runs `git add`/`git diff` against
    // the worktree) before `runTask`'s own promise resolves, so a
    // finalization that was still ahead of us at the start of this method
    // is only guaranteed to have been *registered* once its execution has
    // settled. Reading both maps up front and waiting on them in a single
    // combined step would miss a finalization that starts mid-wait.
    const pendingExecutions = claimed.candidates
      .map((candidate) => this.#activeExecutions.get(candidate.candidateId))
      .filter((execution): execution is Promise<void> => execution !== undefined);
    if (pendingExecutions.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingExecutions),
        new Promise<void>((resolve) => {
          setTimeout(resolve, this.#cleanupGraceTimeoutMs);
        }),
      ]);
    }

    const pendingFinalizations = claimed.candidates
      .map((candidate) => this.#activeFinalizations.get(candidate.candidateId))
      .filter((finalization): finalization is Promise<void> => finalization !== undefined);
    if (pendingFinalizations.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingFinalizations),
        new Promise<void>((resolve) => {
          setTimeout(resolve, this.#cleanupGraceTimeoutMs);
        }),
      ]);
    }

    this.#comparisonStore.markCleaning(comparisonId);

    // Only ever unset when no worktree was ever created for this
    // comparison (preparation failed before or during repository
    // resolution) — in which case the loop below finds nothing in
    // `#worktreePaths` and this value is never actually read.
    const repositoryRoot = this.#sourceRepositoryPaths.get(comparisonId) ?? this.#workspaceRoot;

    const failedCandidateIds: string[] = [];
    for (const candidate of claimed.candidates) {
      const worktreePath = this.#worktreePaths.get(candidate.candidateId);
      if (worktreePath === undefined) continue;
      try {
        await this.#gitWorktreeManager.removeWorktree(repositoryRoot, worktreePath);
        this.#worktreePaths.delete(candidate.candidateId);
        this.#internalPaths?.deleteWorktreePath(candidate.candidateId);
      } catch (error) {
        console.error(
          `Failed to remove worktree for candidate "${candidate.candidateId}": ${formatUnknownError(error)}`,
        );
        failedCandidateIds.push(candidate.candidateId);
      }
    }

    if (failedCandidateIds.length > 0) {
      return this.#comparisonStore.setCleanupFailed(
        comparisonId,
        `Failed to remove ${String(failedCandidateIds.length)} of ${String(claimed.candidates.length)} candidate worktree(s). Retry cleanup once any active processes have fully exited.`,
      );
    }
    this.#sourceRepositoryPaths.delete(comparisonId);
    this.#internalPaths?.deleteSourceRepositoryPath(comparisonId);
    return this.#comparisonStore.setCleanupCompleted(comparisonId);
  }

  /** Aborts every active candidate run and waits (bounded by `timeoutMs`) for both execution and any resulting finalization to settle — for graceful server shutdown. Deliberately does NOT remove any worktree: shutdown preserves state for manual reconciliation on the next start, unlike `cleanupComparison`. Two-phase for the same reason `cleanupComparison` is — see its doc comment. */
  async shutdown(timeoutMs: number): Promise<void> {
    for (const controller of this.#activeControllers.values()) {
      controller.abort("server shutting down");
    }
    const pendingExecutions = Array.from(this.#activeExecutions.values());
    if (pendingExecutions.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingExecutions),
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);
    }

    const pendingFinalizations = Array.from(this.#activeFinalizations.values());
    if (pendingFinalizations.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingFinalizations),
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);
    }
  }

  #isEligible(
    record: AgentComparisonRecord,
    adapterId: string,
    adapter: AgentAdapter,
    detection: Awaited<ReturnType<AgentAdapter["detect"]>>,
    executionTrust: ExecutionTrust,
  ): boolean {
    if (detection.availability !== "available") return false;
    if (record.requirements === undefined) return true;
    return evaluateCandidateEligibility(record.requirements, {
      adapterId,
      displayName: adapter.descriptor.displayName,
      integrationLevel: adapter.descriptor.integrationLevel,
      availability: detection.availability,
      executionTrust,
      capabilityObservations: detection.capabilityObservations ?? [],
    }).eligible;
  }

  #beginCandidateExecution(
    comparisonId: string,
    candidateId: string,
    adapterId: string,
    taskInput: Parameters<typeof runTask>[0]["taskInput"],
  ): void {
    const controller = new AbortController();
    this.#activeControllers.set(candidateId, controller);

    const execution = this.#executeCandidate(
      comparisonId,
      candidateId,
      adapterId,
      taskInput,
      controller.signal,
    )
      .catch((error: unknown) => {
        this.#onExecutionError?.(candidateId, error);
        this.#failCandidateOnUnhandledExecutionError(comparisonId, candidateId, error);
      })
      .finally(() => {
        this.#activeControllers.delete(candidateId);
        this.#activeExecutions.delete(candidateId);
      });
    this.#activeExecutions.set(candidateId, execution);
  }

  async #executeCandidate(
    comparisonId: string,
    candidateId: string,
    adapterId: string,
    taskInput: Parameters<typeof runTask>[0]["taskInput"],
    signal: AbortSignal,
  ): Promise<void> {
    await runTask({
      registry: this.#registry,
      adapterId,
      taskInput,
      options: { signal },
      onEvent: (event) => {
        this.#handleCandidateEvent(comparisonId, candidateId, event);
      },
    });
  }

  #handleCandidateEvent(
    comparisonId: string,
    candidateId: string,
    event: NormalizedAgentEvent,
  ): void {
    let record: AgentComparisonRecord;
    try {
      record = this.#comparisonStore.get(comparisonId);
    } catch {
      return;
    }
    const candidate = record.candidates.find((entry) => entry.candidateId === candidateId);
    if (candidate?.runId === undefined || candidate.agentId === undefined) {
      console.error(
        `Received an event for candidate "${candidateId}" with no run recorded; ignoring.`,
      );
      return;
    }

    let appendResult;
    try {
      appendResult = this.#eventStore.append(candidateId, event, {
        runId: candidate.runId,
        taskId: candidateId,
        agentId: candidate.agentId,
      });
    } catch (error) {
      if (error instanceof EventStoreError) {
        this.#handleCandidateEventStoreFailure(comparisonId, candidateId, error);
        return;
      }
      throw error;
    }
    if (appendResult.duplicate) return;

    this.#eventBus.publish(candidateId, event);
    this.#comparisonStore.recordCandidateEventMeta(comparisonId, candidateId, event.sequence);

    if (isTerminalEventType(event.type)) {
      // `isTerminalEventType`'s type predicate narrows only the `event.type`
      // expression, not `event` itself (a discriminated union) — capture the
      // narrowed value here so it survives being passed across the call
      // boundary into `#finalizeCandidate`.
      const terminalEventType = event.type;
      // `#finalizeCandidate`'s own body already guards every step with its
      // own try/catch (see its doc comment) and should never actually
      // reject — but this is a fire-and-forget promise nothing
      // necessarily ever `await`s (cleanup only observes it if it is
      // still pending when cleanup happens to run), so a `.catch()` here
      // is a required safety net, not decoration: without it, any future
      // edit that adds an unguarded step would turn into a genuine
      // unhandled promise rejection instead of a caught, logged error —
      // mirrors `#beginCandidateExecution`'s identical `.catch()` before
      // `.finally()` for the exact same reason.
      const finalization = this.#finalizeCandidate(
        comparisonId,
        candidateId,
        event,
        terminalEventType,
      )
        .catch((error: unknown) => {
          console.error(
            `Unexpected error finalizing candidate "${candidateId}" on comparison "${comparisonId}": ${formatUnknownError(error)}`,
          );
        })
        .finally(() => {
          this.#activeFinalizations.delete(candidateId);
        });
      this.#activeFinalizations.set(candidateId, finalization);
    }
  }

  async #finalizeCandidate(
    comparisonId: string,
    candidateId: string,
    event: NormalizedAgentEvent,
    terminalEventType: TerminalEventType,
  ): Promise<void> {
    const worktreePath = this.#worktreePaths.get(candidateId);
    let resultEvidence;
    if (worktreePath !== undefined) {
      try {
        resultEvidence = await captureResultEvidence(worktreePath, this.#resultEvidenceOptions);
      } catch (error) {
        console.error(
          `Failed to capture result evidence for candidate "${candidateId}": ${formatUnknownError(error)}`,
        );
      }
    }

    const failure = event.type === "run.failed" ? event.payload.failure : undefined;
    try {
      this.#comparisonStore.setCandidateCompleted(comparisonId, candidateId, {
        completedAt: event.timestamp,
        terminalEventType,
        failure,
        resultEvidence,
      });
    } catch (error) {
      console.error(
        `Failed to finalize candidate "${candidateId}" on comparison "${comparisonId}": ${formatUnknownError(error)}`,
      );
    }
  }

  #handleCandidateEventStoreFailure(
    comparisonId: string,
    candidateId: string,
    error: EventStoreError,
  ): void {
    try {
      const record = this.#comparisonStore.get(comparisonId);
      const candidate = record.candidates.find((entry) => entry.candidateId === candidateId);
      if (candidate?.status !== "running") return;
      this.#failCandidateWithInfrastructureFailure(
        comparisonId,
        candidateId,
        candidate,
        error.code,
        error.message,
        error.message,
      );
    } catch (unexpected) {
      console.error(
        `Hall Core failed to finalize candidate "${candidateId}" after an event-store error: ${formatUnknownError(unexpected)}`,
      );
    }
  }

  #failCandidateOnUnhandledExecutionError(
    comparisonId: string,
    candidateId: string,
    error: unknown,
  ): void {
    try {
      const record = this.#comparisonStore.get(comparisonId);
      const candidate = record.candidates.find((entry) => entry.candidateId === candidateId);
      if (candidate?.status !== "running") return;
      this.#failCandidateWithInfrastructureFailure(
        comparisonId,
        candidateId,
        candidate,
        "CANDIDATE_EXECUTION_FAILED",
        "Hall Core could not complete this candidate's run due to an unexpected internal error.",
        formatUnknownError(error),
      );
    } catch (unexpected) {
      console.error(
        `Hall Core failed to finalize candidate "${candidateId}" after an unhandled execution error: ${formatUnknownError(unexpected)}`,
      );
    }
  }

  #failCandidateWithInfrastructureFailure(
    comparisonId: string,
    candidateId: string,
    candidate: ComparisonCandidateRecord,
    code: string,
    clientSafeMessage: string,
    serverLogDetail: string,
  ): void {
    if (candidate.runId === undefined || candidate.agentId === undefined) {
      console.error(
        `Hall Core cannot record an infrastructure failure for candidate "${candidateId}": it has no run recorded.`,
      );
      return;
    }

    this.#activeControllers.get(candidateId)?.abort(`Hall Core infrastructure failure: ${code}`);
    console.error(
      `Candidate "${candidateId}" failed at the Hall Core infrastructure level (${code}): ${serverLogDetail}`,
    );

    const failureEvent = buildInfrastructureFailureEvent({
      runId: candidate.runId,
      taskId: candidateId,
      agentId: candidate.agentId,
      sequence: this.#eventStore.nextSequence(candidateId),
      code,
      message: clientSafeMessage,
    });

    try {
      const result = this.#eventStore.append(candidateId, failureEvent, {
        runId: candidate.runId,
        taskId: candidateId,
        agentId: candidate.agentId,
      });
      if (result.stored) {
        this.#eventBus.publish(candidateId, failureEvent);
        this.#comparisonStore.recordCandidateEventMeta(
          comparisonId,
          candidateId,
          failureEvent.sequence,
        );
      }
    } catch (storeError) {
      console.error(
        `Candidate "${candidateId}": could not store the synthetic infrastructure-failure event: ${formatUnknownError(storeError)}`,
      );
    }

    try {
      this.#comparisonStore.setCandidateCompleted(comparisonId, candidateId, {
        completedAt: failureEvent.timestamp,
        terminalEventType: "run.failed",
        failure: failureEvent.payload.failure,
      });
    } catch (error) {
      console.error(
        `Failed to mark candidate "${candidateId}" failed after an infrastructure failure: ${formatUnknownError(error)}`,
      );
    }
  }

  #failPreparation(
    comparisonId: string,
    failedCandidateId: string | undefined,
    error: unknown,
  ): AgentComparisonRecord {
    console.error(`Comparison "${comparisonId}" preparation failed: ${formatUnknownError(error)}`);
    const { code, safeReason } = this.#describePreparationFailure(error);
    return this.#comparisonStore.setPrepareFailed(
      comparisonId,
      failedCandidateId,
      code,
      safeReason,
    );
  }

  /**
   * Maps every preparation-time failure to a stable code and a safe,
   * bounded, path-free reason — never the raw error message, which may
   * embed an absolute filesystem path (see `git-worktree-errors.ts` and
   * `source-repository-errors.ts`'s own doc comments on why that's safe to
   * log but not to return). Order matters: `SourceWorkingDirectoryRequiredError`
   * and `NotAGitRepositoryError` are also `Error` instances but are checked
   * before the generic `GitWorktreeError` fallback since they need their
   * own distinct codes.
   */
  #describePreparationFailure(error: unknown): { code: string; safeReason: string } {
    if (error instanceof SourceWorkingDirectoryRequiredError) {
      return {
        code: "COMPARISON_SOURCE_WORKING_DIRECTORY_REQUIRED",
        safeReason:
          "The source task has no working directory set; comparisons require one to locate the source repository.",
      };
    }
    if (error instanceof WorkingDirectoryOutsideWorkspaceError) {
      return {
        code: "COMPARISON_SOURCE_OUTSIDE_WORKSPACE",
        safeReason: "The source task's working directory is outside the configured workspace root.",
      };
    }
    if (error instanceof InvalidWorkingDirectoryError) {
      return {
        code: "COMPARISON_SOURCE_WORKING_DIRECTORY_INVALID",
        safeReason: "The source task's working directory does not exist or is not a directory.",
      };
    }
    if (error instanceof NotAGitRepositoryError) {
      return {
        code: "COMPARISON_SOURCE_NOT_GIT_REPOSITORY",
        safeReason: "The source task's working directory is not inside a Git repository.",
      };
    }
    if (error instanceof SourceRepositoryNotCleanError) {
      return {
        code: "COMPARISON_SOURCE_REPOSITORY_DIRTY",
        safeReason:
          "The source repository has uncommitted changes; comparisons require a clean working tree.",
      };
    }
    if (error instanceof GitWorktreeError) {
      return { code: "COMPARISON_PREPARE_FAILED", safeReason: "Git worktree preparation failed." };
    }
    return {
      code: "COMPARISON_PREPARE_FAILED",
      safeReason: "Comparison preparation failed due to an unexpected internal error.",
    };
  }

  async #tryRemoveWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
    try {
      await this.#gitWorktreeManager.removeWorktree(repositoryRoot, worktreePath);
    } catch (error) {
      console.error(`Failed to roll back worktree "${worktreePath}": ${formatUnknownError(error)}`);
    }
  }

  #resolveAdapter(adapterId: string): AgentAdapter {
    try {
      return this.#registry.resolve(adapterId);
    } catch {
      throw new ComparisonAdapterNotFoundError(adapterId);
    }
  }

  #buildInitialCandidate(
    adapterId: string,
    adapter: AgentAdapter,
    now: string,
  ): ComparisonCandidateRecord {
    return {
      candidateId: randomUUID(),
      adapterId,
      displayName: adapter.descriptor.displayName,
      status: "pending",
      executionTrust: undefined,
      runId: undefined,
      agentId: undefined,
      createdAt: now,
      preparedAt: undefined,
      startedAt: undefined,
      completedAt: undefined,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      resultEvidence: undefined,
      safeFailureReason: undefined,
    };
  }

  #parseCreateRequest(rawRequest: unknown): CreateComparisonRequest {
    const result = createComparisonRequestSchema.safeParse(rawRequest);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      throw new InvalidRequestError("Invalid create-comparison request.", issues);
    }
    return result.data;
  }

  #parsePreferenceRequest(rawRequest: unknown): SetComparisonPreferenceRequest {
    const result = setComparisonPreferenceRequestSchema.safeParse(rawRequest);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      throw new InvalidRequestError("Invalid set-preference request.", issues);
    }
    return result.data;
  }
}
