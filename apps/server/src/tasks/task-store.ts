import type {
  ExecutionTrust,
  StructuredFailure,
  TaskRequirements,
  TaskStatus,
} from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";
import {
  DuplicateTaskError,
  InvalidTaskTransitionError,
  TaskCapacityReachedError,
  TaskNotFoundError,
  TaskStateConflictError,
} from "../errors/app-error.js";
import { isValidTaskTransition } from "./task-status-transitions.js";
import type { TaskRecord } from "./task-record.js";
import type { TaskStorePort } from "./task-store-port.js";

export interface TaskStoreOptions {
  readonly maxTasks: number;
}

/** Opaque to every caller except `TaskStore` itself — see `snapshot()`'s doc comment. */
export interface TaskStoreSnapshot {
  readonly _brand: "TaskStoreSnapshot";
  readonly records: ReadonlyMap<string, TaskRecord>;
  readonly revisions: ReadonlyMap<string, number>;
  readonly workingDirectories: ReadonlyMap<string, string>;
}

/**
 * In-memory task storage — the ephemeral implementation of `TaskStorePort`
 * (Phase 13's durable sibling is `SqliteTaskStore`). `get`/`list` always
 * return `structuredClone`d copies — callers (routes, tests) can freely
 * read or even mutate what they get back without corrupting the store's
 * internal state, and without the store ever handing out a live
 * reference to something an external caller could use to bypass
 * `updateStatus`'s transition checks.
 */
export class TaskStore implements TaskStorePort {
  readonly #records = new Map<string, TaskRecord>();
  readonly #maxTasks: number;

  /**
   * Internal monotonic per-task revision counter (Phase 7.2), keyed by
   * `taskId` — deliberately NOT a field on `TaskRecord`. `TaskRecord` is
   * what `get()`/`list()`/every atomic-commit method return, and what
   * route handlers (`routes/tasks.ts`) serialize directly as an HTTP
   * response body — if revision lived on `TaskRecord`, keeping it out of
   * every response would depend on every current and future route
   * remembering to strip it, which is exactly the kind of encapsulation
   * this is meant to avoid weakening. Keeping it in a wholly separate,
   * never-serialized map makes "revision cannot reach the browser" true
   * by construction, not by discipline.
   *
   * Starts at `0` when a task is created (`add()`) — that is not counted
   * as a "mutation" (see `#bumpRevision`'s doc comment) — and increments
   * by exactly `1` on every subsequent successful mutation of that task's
   * record, across every mutating method below, never only assignment.
   * Never decremented, never reused, never derived from a timestamp: two
   * mutations issued within the same millisecond (a real possibility —
   * `updateStatus` and `setStarted` are both called from the same
   * `run.started` handler in `TaskOrchestrator#handleEvent`) still produce
   * two distinct, strictly increasing revisions, which a timestamp cannot
   * guarantee. See `assignIfEligible()`'s doc comment for why this is what
   * actually closes the ABA gap a same-content four-field compare cannot.
   */
  readonly #revisions = new Map<string, number>();

  /**
   * The raw, schema-validated (relative, never-absolute) `workingDirectory`
   * a task was created with — deliberately NOT a field on `TaskRecord` for
   * the exact same reason `#revisions` isn't: `TaskRecord` is serialized
   * directly as an HTTP response body. This is intentionally the *raw*
   * string as submitted, not a canonicalized absolute path — canonicalizing
   * requires a `workspaceRoot`, which `TaskStore` itself has no notion of;
   * each reader (`TaskOrchestrator`, `ComparisonOrchestrator`) canonicalizes
   * it against its own configured workspace root when it actually needs to
   * touch the filesystem.
   *
   * Unlike `TaskOrchestrator`'s own `#pendingWorkingDirectories` (which is
   * deleted the moment `startTask()` consumes it — a deliberately
   * once-only cache for the immediate next execution), this is set once at
   * task creation and never cleared: `ComparisonOrchestrator.prepareComparison`
   * may need to read a deferred task's working directory long after
   * creation, and potentially without the task ever going through
   * `TaskOrchestrator.assignTask()`/`startTask()` at all. See
   * `docs/architecture/0012-controlled-agent-comparison.md`, "Source
   * repository resolution."
   */
  readonly #workingDirectories = new Map<string, string>();

  constructor(options: TaskStoreOptions) {
    this.#maxTasks = options.maxTasks;
  }

  add(record: TaskRecord): void {
    if (this.#records.has(record.task.taskId)) {
      throw new DuplicateTaskError(record.task.taskId);
    }
    if (this.#records.size >= this.#maxTasks) {
      throw new TaskCapacityReachedError(this.#maxTasks);
    }
    this.#records.set(record.task.taskId, record);
    this.#revisions.set(record.task.taskId, 0);
  }

  remainingCapacity(): number {
    return Math.max(0, this.#maxTasks - this.#records.size);
  }

  /**
   * Records the raw (relative, unvalidated-against-any-workspace-root)
   * `workingDirectory` a task was created with — called at most once, by
   * `TaskOrchestrator` immediately after `add()`. A `undefined` argument
   * (no working directory supplied) is a no-op: `getWorkingDirectory` then
   * simply returns `undefined`, exactly as if this were never called.
   */
  setWorkingDirectory(taskId: string, workingDirectory: string | undefined): void {
    this.#mustGetLive(taskId);
    if (workingDirectory === undefined) return;
    this.#workingDirectories.set(taskId, workingDirectory);
  }

  /**
   * The raw working directory a task was created with, or `undefined` if
   * none was ever supplied — internal-only, never reachable from a route.
   * Callers must canonicalize and validate this themselves against their
   * own configured workspace root before touching the filesystem; this
   * store performs no validation of its own.
   */
  getWorkingDirectory(taskId: string): string | undefined {
    this.#mustGetLive(taskId);
    return this.#workingDirectories.get(taskId);
  }

  get(taskId: string): TaskRecord {
    const record = this.#records.get(taskId);
    if (!record) {
      throw new TaskNotFoundError(taskId);
    }
    return structuredClone(record);
  }

  /** Deterministic insertion order — a `Map` preserves insertion order in JavaScript. */
  list(): TaskRecord[] {
    return Array.from(this.#records.values(), (record) => structuredClone(record));
  }

  /**
   * The current internal revision for a task — used by
   * `TaskOrchestrator.assignTask()` to capture the revision it must still
   * match when it later calls `assignIfEligible()`, and by tests to assert
   * revision-increment behavior directly. This is a real, load-bearing
   * part of the production assignment flow (not a test-only shim); it is
   * simply never wired to any route, never part of `TaskRecord`, and never
   * reachable from a request body — see the field-level doc comment on
   * `#revisions` above for why revision lives here and not on the record.
   */
  getRevision(taskId: string): number {
    this.#mustGetLive(taskId);
    return this.#revisions.get(taskId) ?? 0;
  }

  updateStatus(taskId: string, nextStatus: TaskStatus): void {
    const record = this.#mustGetLive(taskId);
    if (!isValidTaskTransition(record.task.status, nextStatus)) {
      throw new InvalidTaskTransitionError(taskId, record.task.status, nextStatus);
    }
    record.task = { ...record.task, status: nextStatus, updatedAt: new Date().toISOString() };
    this.#bumpRevision(taskId);
  }

  recordEventMeta(taskId: string, sequence: number): void {
    const record = this.#mustGetLive(taskId);
    record.eventCount += 1;
    record.lastSequence = sequence;
    this.#bumpRevision(taskId);
  }

  setStarted(taskId: string, startedAt: string): void {
    this.#mustGetLive(taskId).startedAt = startedAt;
    this.#bumpRevision(taskId);
  }

  setCompleted(
    taskId: string,
    completedAt: string,
    terminalEventType: TerminalEventType,
    failure?: StructuredFailure,
  ): void {
    const record = this.#mustGetLive(taskId);
    record.completedAt = completedAt;
    record.terminalEventType = terminalEventType;
    record.failure = failure;
    this.#bumpRevision(taskId);
  }

  setCancellationRequested(taskId: string): void {
    this.#mustGetLive(taskId).cancellationRequested = true;
    this.#bumpRevision(taskId);
  }

  /**
   * Atomically re-validates and commits an assignment against the task's
   * CURRENT live state — this is what actually closes the check-then-act
   * race described in `docs/architecture/0006-kanban-board.md` ("Assignment
   * concurrency policy"): `TaskOrchestrator.assignTask()` reads a snapshot
   * (including the task's revision via `getRevision()`), `await`s
   * `adapter.detect()`, and only then calls this method with no further
   * `await` before it runs. JavaScript's single-threaded execution means
   * nothing else can run between this method's read and write, so whatever
   * eligibility this method observes is still true at the moment it
   * writes.
   *
   * `expectedRevision` is the PRIMARY concurrency token and the only check
   * that actually closes the ABA gap: a same-shape four-field compare
   * (`status`/`runId`/`adapterId`/`agentId`) cannot distinguish "nothing
   * changed" from "this task went Ready -> Blocked -> Ready while I was
   * awaiting `adapter.detect()`" — both leave those four fields reading
   * exactly as they did originally, but the task's real history differs,
   * and a manual transition or another assignment that happened in
   * between must not be silently overwritten. Revision cannot repeat or
   * go backwards (see the `#revisions` field doc comment), so any mutation
   * at all in between — even a round trip back to an outwardly identical
   * status — makes `expectedRevision` stale and this call rejects.
   *
   * `expected` (the same four-field snapshot Phase 7.1 introduced) is kept
   * as secondary defense-in-depth, per the Phase 7.2 request: revision
   * alone is sufficient and would already catch every case tested here,
   * but comparing the fields a client-visible response is actually built
   * from costs nothing extra and fails a little more descriptively if the
   * two checks were ever to disagree (which would itself indicate a bug
   * worth surfacing loudly, not silently).
   *
   * The commit proceeds only if:
   *
   * 1. The task still exists (`#mustGetLive` throws `TaskNotFoundError`
   *    otherwise).
   * 2. The live revision still equals `expectedRevision`.
   * 3. The live record's `status`/`runId`/`adapterId`/`agentId` still
   *    exactly match `expected`.
   * 4. The live status is independently still `"ready"` (first assignment)
   *    or `"assigned"` with no run (pre-start reassignment) — re-derived
   *    from the live record, not trusted from the caller, so this method
   *    is self-contained and correct even if a future caller skips
   *    `assignTask()`'s own fast-fail pre-check.
   *
   * Any mismatch throws `TaskStateConflictError` (409, reused rather than
   * a new dedicated code — see the ADR) — never last-write-wins. On
   * success, the revision is bumped exactly once, same as every other
   * mutating method.
   *
   * `assignment.requirements`/`assignment.executionTrust` (Phase 11) are
   * optional and, when supplied, are set on the commit exactly like
   * `adapterId`/`agentId` — used by `TaskOrchestrator.routeAndAssign()` to
   * persist whatever requirements it actually routed against (including
   * an ad hoc override that was never previously on the task) and a
   * snapshot of the winning adapter's execution trust, in the same atomic
   * commit as the assignment itself. Manual `POST .../assign` never passes
   * either, so its behavior is unchanged: `requirements` stays whatever it
   * already was, and `assignedExecutionTrust` is still set from the
   * caller-supplied snapshot so Task Details can show it regardless of
   * which endpoint performed the assignment.
   */
  assignIfEligible(
    taskId: string,
    expectedRevision: number,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
    assignment: {
      readonly adapterId: string;
      readonly agentId: string;
      readonly executionTrust: ExecutionTrust;
      readonly requirements?: TaskRequirements;
    },
  ): TaskRecord {
    const record = this.#mustGetLive(taskId);
    const currentRevision = this.#revisions.get(taskId) ?? 0;

    const isFirstAssignment = record.task.status === "ready";
    const isReassignment = record.task.status === "assigned" && record.runId === undefined;
    const stillMatchesExpectation =
      currentRevision === expectedRevision &&
      record.task.status === expected.status &&
      record.runId === expected.runId &&
      record.adapterId === expected.adapterId &&
      record.agentId === expected.agentId;

    if ((!isFirstAssignment && !isReassignment) || !stillMatchesExpectation) {
      throw new TaskStateConflictError(taskId, record.task.status, "assigned");
    }

    const now = new Date().toISOString();
    record.adapterId = assignment.adapterId;
    record.agentId = assignment.agentId;
    record.assignedExecutionTrust = assignment.executionTrust;
    record.task = isFirstAssignment
      ? {
          ...record.task,
          status: "assigned",
          updatedAt: now,
          ...(assignment.requirements !== undefined
            ? { requirements: assignment.requirements }
            : {}),
        }
      : {
          ...record.task,
          updatedAt: now,
          ...(assignment.requirements !== undefined
            ? { requirements: assignment.requirements }
            : {}),
        };
    this.#bumpRevision(taskId);

    return structuredClone(record);
  }

  /** Clears a planning task's assignment (used when a manual transition moves an assigned task back to ready/blocked). */
  clearAssignment(taskId: string): void {
    const record = this.#mustGetLive(taskId);
    record.adapterId = undefined;
    record.agentId = undefined;
    record.assignedExecutionTrust = undefined;
    this.#bumpRevision(taskId);
  }

  /**
   * Atomically claims `runId` for a task about to start execution:
   * operates on the live record (not a clone) and throws if a run was
   * already claimed, so two concurrent `POST .../start` calls for the
   * same task can never both succeed — see `TaskOrchestrator.startTask()`
   * for why this must run with no `await` between the read and the write.
   */
  setRunId(taskId: string, runId: string): void {
    const record = this.#mustGetLive(taskId);
    if (record.runId !== undefined) {
      throw new TaskStateConflictError(taskId, record.task.status, "started");
    }
    record.runId = runId;
    this.#bumpRevision(taskId);
  }

  /** Rolls back a `setRunId()` claim when starting execution fails before any event was ever produced. */
  clearRunId(taskId: string): void {
    this.#mustGetLive(taskId).runId = undefined;
    this.#bumpRevision(taskId);
  }

  /**
   * Phase 15.2 — atomically resets a genuinely terminal `"failed"` task
   * back to `"assigned"` for a governed retry
   * (`TaskOrchestrator.prepareRetry()`, called only after
   * `CeoPlanExecutionScheduler`'s own 13-precondition eligibility check
   * passes). Clears exactly the CURRENT-run projection a fresh
   * `startTask()` needs to be able to claim a new run —
   * `runId`/`terminalEventType`/`failure`/`completedAt`/`startedAt` —
   * and nothing else: `adapterId`/`agentId`/`requirements`/
   * `assignedExecutionTrust` stay exactly as they were, since this is a
   * retry of the SAME assignment, not a new one. Never deletes or
   * touches the prior run's own history — its events (already recorded
   * in `EventStore`, reopened separately by
   * `TaskOrchestrator.prepareRetry()`) and its `CeoPlanStepAttempt` row
   * (already marked terminal by the caller before this is ever invoked)
   * are untouched.
   *
   * Same revision + four-field-snapshot ABA-safety as `assignIfEligible()`/
   * `startIfEligible()` — see either's doc comment for why revision, not
   * a plain field compare, is what closes the race. Independently
   * re-derives the launch invariant from the LIVE record (status must be
   * `"failed"`) rather than trusting the caller. Any mismatch throws
   * `TaskStateConflictError` (409) — this single atomic commit is also
   * exactly what makes "no competing retry preparation already
   * succeeded" hold: only the first caller to commit wins; every other
   * concurrent caller's now-stale revision is rejected, never
   * last-write-wins.
   *
   * Deliberately bypasses `updateStatus()`/`isValidTaskTransition()`
   * entirely — `failed -> assigned` is NOT in `ALLOWED_TRANSITIONS` (see
   * that table's doc comment) and must never be: this method has its
   * own, much narrower, independently re-derived invariant
   * (`status === "failed"`) plus 12 further plan/attempt/circuit
   * preconditions its caller (`CeoPlanExecutionScheduler`) verifies
   * first — a generic transition table has no way to express any of
   * that. `updateStatus()` staying strict is what makes it structurally
   * impossible for any other caller, including `POST /transition`, to
   * reach this edge by accident.
   */
  prepareRetryIfEligible(
    taskId: string,
    expectedRevision: number,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
  ): TaskRecord {
    const record = this.#mustGetLive(taskId);
    const currentRevision = this.#revisions.get(taskId) ?? 0;

    const isRetryable = record.task.status === "failed";
    const stillMatchesExpectation =
      currentRevision === expectedRevision &&
      record.task.status === expected.status &&
      record.runId === expected.runId &&
      record.adapterId === expected.adapterId &&
      record.agentId === expected.agentId;

    if (!isRetryable || !stillMatchesExpectation) {
      throw new TaskStateConflictError(taskId, record.task.status, "assigned");
    }

    const now = new Date().toISOString();
    record.runId = undefined;
    record.terminalEventType = undefined;
    record.failure = undefined;
    record.cancellationRequested = false;
    record.completedAt = undefined;
    record.startedAt = undefined;
    record.task = { ...record.task, status: "assigned", updatedAt: now };
    this.#bumpRevision(taskId);

    return structuredClone(record);
  }

  /**
   * Phase 15.2 — the TOCTOU-safe successor to `setRunId()` as the launch
   * reservation `TaskOrchestrator.startTask()` commits with. `setRunId()`
   * only ever checked `runId === undefined`, which cannot detect a task
   * whose `status`/`adapterId`/`agentId` moved and moved back (an ABA
   * race) while the caller was awaiting a fresh `adapter.detect()` and a
   * re-run capability/execution-trust eligibility check. This method
   * closes that race the same way `assignIfEligible()` does: the caller
   * snapshots `expectedRevision` and the four-field `expected` struct
   * BEFORE its `await`s, then commits here in one synchronous call with
   * no further `await` in between.
   *
   * Re-validates:
   * 1. The live revision still equals `expectedRevision`.
   * 2. The live record's `status`/`runId`/`adapterId`/`agentId` still
   *    exactly match `expected`.
   * 3. The live status is independently still `"assigned"` with no run
   *    claimed yet — re-derived from the live record, not trusted from
   *    the caller, so this method is self-contained and correct even if
   *    a future caller skips `startTask()`'s own pre-checks.
   *
   * Any mismatch throws `TaskStateConflictError` (409) — never
   * last-write-wins, and never a second, weaker check that only catches
   * some of the ways the task could have drifted.
   *
   * Deliberately does NOT touch `assignedExecutionTrust` — that field is
   * documented (see `TaskRecord`) as an assignment-time snapshot that must
   * never silently drift; the freshly detected execution trust used for
   * this launch's eligibility re-check is a transient input to that
   * check, not a new persisted snapshot.
   */
  startIfEligible(
    taskId: string,
    expectedRevision: number,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
    runId: string,
  ): TaskRecord {
    const record = this.#mustGetLive(taskId);
    const currentRevision = this.#revisions.get(taskId) ?? 0;

    const isLaunchable = record.task.status === "assigned" && record.runId === undefined;
    const stillMatchesExpectation =
      currentRevision === expectedRevision &&
      record.task.status === expected.status &&
      record.runId === expected.runId &&
      record.adapterId === expected.adapterId &&
      record.agentId === expected.agentId;

    if (!isLaunchable || !stillMatchesExpectation) {
      throw new TaskStateConflictError(taskId, record.task.status, "started");
    }

    record.runId = runId;
    this.#bumpRevision(taskId);

    return structuredClone(record);
  }

  /**
   * Phase 14.1 — the ephemeral-mode analogue of `withTransaction`'s
   * durable-mode SAVEPOINT, used by `createEphemeralAtomicUnit` to give
   * in-memory CEO plan delegation genuine all-or-nothing semantics. This
   * is a deep clone (`structuredClone` per record), NOT a shallow `Map`
   * copy: several mutating methods above (`assignIfEligible`, `setRunId`,
   * `setCompleted`, ...) mutate an already-stored `TaskRecord`'s fields
   * in place rather than replacing the whole record object (this is a
   * deliberate, carefully-documented choice — see e.g.
   * `assignIfEligible`'s own doc comment on why its no-`await`-gap CAS
   * mutates the live record directly). A shallow clone's Map would still
   * point at those same live objects, so a later in-place mutation would
   * silently corrupt the "snapshot." `#revisions`/`#workingDirectories`
   * hold only primitives, so a shallow clone is correct for those.
   */
  snapshot(): TaskStoreSnapshot {
    return {
      _brand: "TaskStoreSnapshot",
      records: new Map(
        Array.from(this.#records, ([taskId, record]) => [taskId, structuredClone(record)]),
      ),
      revisions: new Map(this.#revisions),
      workingDirectories: new Map(this.#workingDirectories),
    };
  }

  /**
   * Replaces this store's entire state with `snapshot`'s. The snapshot's
   * records were already deep-cloned at `snapshot()` time and nothing
   * else holds a reference to them, so they can be adopted directly here
   * without cloning again. Fields are `readonly` `Map`s, so this clears
   * and repopulates each in place rather than reassigning them.
   */
  restore(snapshot: TaskStoreSnapshot): void {
    this.#records.clear();
    for (const [taskId, record] of snapshot.records) this.#records.set(taskId, record);
    this.#revisions.clear();
    for (const [taskId, revision] of snapshot.revisions) this.#revisions.set(taskId, revision);
    this.#workingDirectories.clear();
    for (const [taskId, workingDirectory] of snapshot.workingDirectories) {
      this.#workingDirectories.set(taskId, workingDirectory);
    }
  }

  #mustGetLive(taskId: string): TaskRecord {
    const record = this.#records.get(taskId);
    if (!record) {
      throw new TaskNotFoundError(taskId);
    }
    return record;
  }

  /**
   * Bumps `taskId`'s revision by exactly `1`. Called once, at the end,
   * from every method above that actually wrote to a live record — never
   * from a method that only reads, and never before the validity checks
   * that might still cause that method to throw instead (a rejected
   * mutation must not consume a revision number, or a legitimate later
   * caller's `expectedRevision` could be invalidated by a mutation that
   * never actually happened).
   */
  #bumpRevision(taskId: string): void {
    this.#revisions.set(taskId, (this.#revisions.get(taskId) ?? 0) + 1);
  }
}
