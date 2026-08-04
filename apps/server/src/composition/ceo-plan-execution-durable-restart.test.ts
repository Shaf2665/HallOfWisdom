import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerComposition, type ServerComposition } from "./server-composition.js";
import { resolveDataDir } from "../persistence/database-config.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { runRestartRecovery } from "../recovery/restart-recovery.js";
import { recordBootStarted, recordCleanShutdown } from "../persistence/boot-repository.js";
import { runCeoPlanExecutionRecovery } from "../ceo-execution/ceo-plan-execution-recovery.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";

/**
 * Phase 15.1 — execution-specific durable restart coverage, mirroring
 * `ceo-plan-durable-restart.test.ts`'s own pattern of driving the real
 * `createServerComposition` entry point across a genuine `HallDatabase`
 * close/reopen, and reproducing `server.ts`'s own boot sequence exactly:
 * `runRestartRecovery` (Phase 13) -> `runCeoPlanExecutionRecovery`
 * (Phase 15) -> `composition.activateAutonomousScheduling()`. Never a
 * hand-built store or a parallel reimplementation of that ordering.
 */

function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitUntil: condition not met within timeout"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

const DEFAULT_POLICY = DEFAULT_CEO_PLAN_EXECUTION_POLICY;

describe("CEO plan execution durable restart via the real composition root (Phase 15.1)", () => {
  let tempRoot: string;
  const openDbs: HallDatabase[] = [];

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeTempRoot(prefix: string): { workspaceRoot: string; dataDirRaw: string } {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const workspaceDir = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceDir);
    return {
      workspaceRoot: fs.realpathSync.native(workspaceDir),
      dataDirRaw: path.join(tempRoot, "data"),
    };
  }

  function openDurableComposition(input: {
    readonly workspaceRoot: string;
    readonly dataDirRaw: string;
    readonly mockScenario?: string;
    readonly mockFailureRetryable?: boolean;
  }): { readonly db: HallDatabase; readonly composition: ServerComposition } {
    const dataDir = resolveDataDir({
      dataDir: input.dataDirRaw,
      workspaceRoot: input.workspaceRoot,
    });
    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    runMigrations(db);
    openDbs.push(db);
    const composition = createServerComposition({
      workspaceRoot: input.workspaceRoot,
      mockScenario: input.mockScenario ?? "success",
      mockStepDelayMs: 0,
      ...(input.mockFailureRetryable !== undefined
        ? { mockFailureRetryable: input.mockFailureRetryable }
        : {}),
      limits: DEFAULT_LIMITS,
      db,
      agentWorktreeRoot: path.join(dataDir, "agent-worktrees"),
    });
    return { db, composition };
  }

  /** Full create -> submit -> approve -> delegate -> configure(autonomous) -> start flow, entirely through the real composition's own orchestrators — never a hand-built store row. Returns the run id and the single step/task id. */
  async function delegateAndConfigureRun(
    composition: ServerComposition,
    now: string,
    policyOverrides: Partial<typeof DEFAULT_POLICY> = {},
  ): Promise<{ runId: string; planId: string; stepId: string; taskId: string }> {
    const created = composition.orchestrator.createTask({
      executionMode: "deferred",
      projectId: "proj-1",
      title: "Fix the login redirect",
      description: "Login redirects to /404 instead of /dashboard after SSO callback.",
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    });
    const parentTaskId = created.task.taskId;

    const { plan, version } = await composition.ceoPlans.orchestrator.createPlan(
      parentTaskId,
      undefined,
    );
    await composition.ceoPlans.orchestrator.submit(
      plan.id,
      composition.ceoPlans.orchestrator.getMutationToken(plan.id),
    );
    await composition.ceoPlans.orchestrator.decideApproval(
      plan.id,
      composition.ceoPlans.orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );
    await composition.ceoPlans.orchestrator.delegate(
      plan.id,
      composition.ceoPlans.orchestrator.getMutationToken(plan.id),
    );
    const links = composition.ceoPlans.orchestrator.listDelegationLinks(plan.id);
    const steps = links.map((link) => ({
      stepId: link.stepId,
      childTaskId: link.childTaskId,
      dependencyStepIds: [],
    }));

    // The plan's own step-level requirements are unset (a bare
    // `createPlan(taskId, undefined)`), so `recommendStepAdapter` may
    // have recommended a non-Mock adapter (Claude Code/Codex are also
    // registered in this real composition, unlike the isolated
    // in-process harness other test files use) — reassign each child
    // task to the deterministic Mock adapter explicitly, exactly the
    // same operator-driven reassignment `assignTask` already supports
    // for any not-yet-started task.
    for (const link of links) {
      await composition.orchestrator.assignTask(link.childTaskId, { adapterId: "hall.mock-agent" });
    }

    const runId = `run-${plan.id}`;
    composition.ceoExecution.planRunStore.configureRun({
      runId,
      planId: plan.id,
      planVersion: 1,
      executionMode: "autonomous",
      policy: { ...DEFAULT_POLICY, ...policyOverrides },
      now,
      steps,
    });
    composition.ceoExecution.scheduler.registerDependencyIndex(
      runId,
      steps.map((s) => ({ id: s.stepId, dependencies: s.dependencyStepIds })),
    );
    composition.ceoExecution.planRunStore.startRun({ runId, now });
    await composition.ceoExecution.scheduler.enqueueSignal({
      planRunId: runId,
      reason: "execution_started",
    });

    // `steps[0]` (== `links[0]`) — NOT `delegateResult.childTasks[0]`,
    // whose array order is not guaranteed to match `links`' — is the
    // step the scheduler actually starts first, since every
    // `dependencyStepIds` above was deliberately flattened to `[]` and
    // `index.allStepIds` (and therefore `#tryAdvanceStep`'s attempt
    // order) follows `steps`' own order.
    const firstStep = steps[0];
    if (!firstStep) throw new Error("expected at least one delegated child task");
    return {
      runId,
      planId: plan.id,
      stepId: firstStep.stepId,
      taskId: firstStep.childTaskId,
    };
  }

  it("clean restart: a completed step's run/attempt/event history survives byte-identical, is never rerun, and the recovery pass reports the run as already terminal", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-execution-restart-clean-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    recordBootStarted(first.db, "boot-1", new Date().toISOString());
    // Arms the task-mutation bridge exactly as a real first boot would
    // (a fresh DB has nothing for `runRestartRecovery`/
    // `runCeoPlanExecutionRecovery` to actually do) — without this,
    // nothing relays each child task's completion back into the
    // scheduler, and multi-step cascading never happens.
    first.composition.activateAutonomousScheduling();

    const now = new Date().toISOString();
    // maxConcurrentSteps set generously above this plan's auto-generated
    // step count (3) so every step starts together rather than queuing
    // on capacity — this test is about restart/recovery correctness,
    // not the scheduler's separate capacity-release notification path
    // for independent (non-dependent) sibling steps, which is its own
    // area entirely.
    const { runId, taskId } = await delegateAndConfigureRun(first.composition, now, {
      // Bounded 1-4 by the protocol schema — 4 covers this plan's
      // auto-generated step count (3) so every step starts together.
      maxConcurrentSteps: 4,
      // Per-adapter capacity is a SEPARATE gate from maxConcurrentSteps
      // (default 1 active run per adapter, regardless of plan-level
      // concurrency) — every auto-generated step was reassigned to the
      // same "hall.mock-agent" adapter above, so this override is what
      // actually lets all three start together.
      adapterConcurrencyOverrides: { "hall.mock-agent": 4 },
    });

    // scenario:"success" with the default 0ms step delay resolves near
    // immediately once genuinely started; the bridge above relays each
    // completion back into the scheduler.
    await waitUntil(() => first.composition.taskStore.get(taskId).task.status === "completed");
    await waitUntil(
      () => first.composition.ceoExecution.planRunStore.getRun(runId).status === "completed",
    );

    const runBeforeRestart = first.composition.ceoExecution.planRunStore.getRun(runId);
    const eventsBeforeRestart = first.composition.ceoExecution.planRunStore.listEvents(runId);
    const attemptsBeforeRestart = first.composition.ceoExecution.planRunStore.listAttempts(runId);
    // One attempt per this plan's auto-generated steps (3) — every
    // step completed exactly once, never retried or duplicated.
    expect(attemptsBeforeRestart).toHaveLength(3);
    // Phase 15.2 — previously a KNOWN LIMITATION: the attempt record's
    // own `status` field was only ever closed out by
    // `#handleStartFailure` (a start-time failure); neither
    // `onChildTaskMutated`'s completed branch nor `#handleChildTaskFailure`
    // ever called `updateAttempt` for a task that genuinely ran and
    // reached a terminal status, so every attempt row stayed stuck at
    // "running" forever even once its step and run were both terminal.
    // Fixed as part of closing the retry deadlock (governed retry's own
    // "previous attempt terminal" precondition depends on this being
    // accurate) — now asserted as correct.
    expect(attemptsBeforeRestart.every((a) => a.status === "completed")).toBe(true);

    // A genuinely clean shutdown this time (unlike the sibling unclean
    // test below) — `recordCleanShutdown` is what `server.ts`'s own
    // controlled-shutdown path calls.
    recordCleanShutdown(first.db, "boot-1", new Date().toISOString());
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });
    expect(recovery.summary.previousShutdown).toBe("clean");

    const executionRecoverySummary = await runCeoPlanExecutionRecovery({
      planRunStore: second.composition.ceoExecution.planRunStore,
      signalStore: second.composition.ceoExecution.signalStore,
      taskStore: second.composition.taskStore,
      scheduler: second.composition.ceoExecution.scheduler,
      planStore: second.composition.ceoPlans.planStore,
      postBoardAudit: second.composition.ceoExecution.postBoardAudit,
      previousShutdown: recovery.summary.previousShutdown,
      now: new Date().toISOString(),
      runAtomicUnit: second.composition.ceoExecution.runAtomicUnit,
    });
    second.composition.activateAutonomousScheduling();

    // The run was already "completed" (terminal) before the restart —
    // recovery's own running-runs scan never even considers it.
    expect(executionRecoverySummary.runsScanned).toBe(0);

    const runAfterRestart = second.composition.ceoExecution.planRunStore.getRun(runId);
    expect(runAfterRestart.status).toBe("completed");
    expect(runAfterRestart.completedAt).toBe(runBeforeRestart.completedAt);
    expect(second.composition.ceoExecution.planRunStore.listEvents(runId)).toEqual(
      eventsBeforeRestart,
    );
    // No rerun: still exactly the same attempts from before the restart.
    expect(second.composition.ceoExecution.planRunStore.listAttempts(runId)).toEqual(
      attemptsBeforeRestart,
    );
    expect(second.composition.taskStore.get(taskId).task.status).toBe("completed");
  }, 30000);

  it("unclean restart: a step left mid-flight is abandoned and moved to awaiting_intervention (never silently rerun), the run is recovery-paused, and exactly one Board summary is posted — repeating the boot changes nothing further", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-execution-restart-unclean-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    recordBootStarted(first.db, "boot-1", new Date().toISOString());

    const now = new Date().toISOString();
    const { runId, taskId } = await delegateAndConfigureRun(first.composition, now);

    // Genuinely mid-flight when the crash happens — real, in-progress
    // attempt against the real TaskOrchestrator (not a synthetic store
    // write), matching the kickoff's "use real child processes" spirit
    // as closely as the deterministic Mock Agent adapter allows.
    await waitUntil(() => first.composition.taskStore.get(taskId).runId !== undefined);
    const [stepBeforeCrash] = first.composition.ceoExecution.planRunStore.listStepExecutions(runId);
    if (!stepBeforeCrash) throw new Error("expected the step execution to exist");
    expect(["claimed", "starting", "running"]).toContain(stepBeforeCrash.status);

    // No `recordCleanShutdown` call before closing — the harder,
    // unclean case.
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });
    expect(recovery.summary.previousShutdown).toBe("unclean");

    const boardAudits: string[] = [];
    const executionRecoverySummary = await runCeoPlanExecutionRecovery({
      planRunStore: second.composition.ceoExecution.planRunStore,
      signalStore: second.composition.ceoExecution.signalStore,
      taskStore: second.composition.taskStore,
      scheduler: second.composition.ceoExecution.scheduler,
      planStore: second.composition.ceoPlans.planStore,
      postBoardAudit: (planId, text) => {
        boardAudits.push(text);
        second.composition.ceoExecution.postBoardAudit(planId, text);
      },
      previousShutdown: recovery.summary.previousShutdown,
      now: new Date().toISOString(),
      runAtomicUnit: second.composition.ceoExecution.runAtomicUnit,
    });
    second.composition.activateAutonomousScheduling();

    expect(executionRecoverySummary.runsPausedForUncleanRestart).toBe(1);
    expect(executionRecoverySummary.attemptsAbandoned).toBe(1);
    expect(boardAudits).toHaveLength(1);

    const runAfterRestart = second.composition.ceoExecution.planRunStore.getRun(runId);
    expect(runAfterRestart.status).toBe("awaiting_intervention");
    expect(runAfterRestart.recoveryClassification).toBe("unclean_paused");

    const [stepAfterRestart] =
      second.composition.ceoExecution.planRunStore.listStepExecutions(runId);
    if (!stepAfterRestart) throw new Error("expected the step execution to still exist");
    // The fix under test: the step itself moved off "running" — it is
    // never left permanently excluded from re-evaluation.
    expect(stepAfterRestart.status).toBe("awaiting_intervention");

    const [attemptAfterRestart] = second.composition.ceoExecution.planRunStore.listAttempts(runId);
    expect(attemptAfterRestart?.status).toBe("abandoned");

    // No automatic retry or rerun happened — the underlying task is
    // left exactly where the crash left it (Phase 13's own
    // `reconcileTasks` marks a non-terminal in-flight task "failed";
    // Phase 15 never starts a fresh run against it on its own).
    expect(second.composition.taskStore.get(taskId).task.status).toBe("failed");

    // Repeating the boot's recovery pass (simulating a second crash
    // before any operator ever intervened) must be a safe no-op: no
    // second pause, no second Board summary, no second abandon.
    const repeatSummary = await runCeoPlanExecutionRecovery({
      planRunStore: second.composition.ceoExecution.planRunStore,
      signalStore: second.composition.ceoExecution.signalStore,
      taskStore: second.composition.taskStore,
      scheduler: second.composition.ceoExecution.scheduler,
      planStore: second.composition.ceoPlans.planStore,
      postBoardAudit: (planId, text) => {
        boardAudits.push(text);
        second.composition.ceoExecution.postBoardAudit(planId, text);
      },
      previousShutdown: "unclean",
      now: new Date().toISOString(),
      runAtomicUnit: second.composition.ceoExecution.runAtomicUnit,
    });
    expect(repeatSummary.runsScanned).toBe(0);
    expect(boardAudits).toHaveLength(1);
  }, 30000);

  it("Phase 15.6 — explicit operator Resume then Retry step relaunches a step genuinely abandoned by unclean-restart recovery, on a FRESH scheduler instance that never configured this run itself", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-execution-restart-abandoned-retry-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    recordBootStarted(first.db, "boot-1", new Date().toISOString());

    const now = new Date().toISOString();
    const { runId, planId, stepId, taskId } = await delegateAndConfigureRun(
      first.composition,
      now,
      {
        // The abandoned attempt itself counts toward this budget (by
        // design — see `retryAbandonedStep`'s own doc comment); the
        // default policy's `maxAttemptsPerStep` is 1, which would leave no
        // room for the replacement attempt this test proves.
        maxAttemptsPerStep: 2,
      },
    );

    await waitUntil(() => first.composition.taskStore.get(taskId).runId !== undefined);
    const taskRunIdBeforeCrash = first.composition.taskStore.get(taskId).runId;
    if (taskRunIdBeforeCrash === undefined) {
      throw new Error("expected the task to have a run id before the crash");
    }

    // No `recordCleanShutdown` — a genuine unclean restart. Closing the
    // connection also severs `first.composition`'s own in-process mock
    // adapter execution from ever reaching the database again (any
    // further write attempt fails closed with `DatabaseClosedError`,
    // visible as benign stderr noise below) — this is what makes it safe
    // for a SECOND, independent composition to take over the same
    // durable state without risk of the first one's stray background
    // work corrupting it.
    first.db.close();

    // A SECOND, genuinely independent process/composition — its
    // scheduler has never seen this run, and critically, its
    // `#dependencyIndexes` map starts empty. This is the exact condition
    // Phase 15.5 found broken: without `/resume`'s dependency-index
    // rebuild (added this session), `retryAbandonedStep` below would
    // enqueue a signal `#processSignal` silently drops, and this test
    // would hang or fail with no attempt ever created.
    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });
    expect(recovery.summary.previousShutdown).toBe("unclean");

    await runCeoPlanExecutionRecovery({
      planRunStore: second.composition.ceoExecution.planRunStore,
      signalStore: second.composition.ceoExecution.signalStore,
      taskStore: second.composition.taskStore,
      scheduler: second.composition.ceoExecution.scheduler,
      planStore: second.composition.ceoPlans.planStore,
      postBoardAudit: second.composition.ceoExecution.postBoardAudit,
      previousShutdown: recovery.summary.previousShutdown,
      now: new Date().toISOString(),
      runAtomicUnit: second.composition.ceoExecution.runAtomicUnit,
    });
    second.composition.activateAutonomousScheduling();

    expect(second.composition.ceoExecution.planRunStore.getRun(runId).status).toBe(
      "awaiting_intervention",
    );
    const [abandonedAttempt] = second.composition.ceoExecution.planRunStore.listAttempts(
      runId,
      stepId,
    );
    expect(abandonedAttempt?.status).toBe("abandoned");
    expect(abandonedAttempt?.taskRunId).toBe(taskRunIdBeforeCrash);
    expect(second.composition.taskStore.get(taskId).task.status).toBe("failed");
    expect(second.composition.taskStore.get(taskId).failure?.code).toBe(
      "HALL_RESTART_INTERRUPTED_RUN",
    );

    // --- Explicit operator Resume — exactly what `routes/ceo-plan-runs.ts`'s
    // `/resume` handler does, replicated here since this test drives the
    // composition directly rather than over HTTP: resume the run, THEN
    // rebuild the dependency index from the run's exact approved plan
    // version (this is the Phase 15.6 fix under test).
    second.composition.ceoExecution.planRunStore.resumeRun({
      runId,
      now: new Date().toISOString(),
    });
    const version = second.composition.ceoPlans.planStore.getVersion(
      planId,
      second.composition.ceoExecution.planRunStore.getRun(runId).planVersion,
    );
    // `delegateAndConfigureRun` above deliberately flattens every step's
    // `dependencyStepIds` to `[]` at configure time (a test-file-only
    // convenience — see its own doc comment — so its OTHER scenarios can
    // start every step concurrently regardless of the CEO planner's real
    // Investigate -> Implement -> Verify chain). Rebuilding the index
    // here from the plan version's REAL dependencies — exactly what the
    // production `/resume` route does — would therefore make THIS
    // specific step appear to have an unsatisfied dependency it never
    // actually had at configure time, purely a self-inflicted
    // inconsistency of this test file's own shortcut, not something a
    // real `/resume` (which always reads real dependencies both at
    // configure and resume time, never flattened) could ever produce.
    // Matching the flattening here keeps this test internally
    // consistent; the "resume uses the real approved plan version"
    // fidelity is already covered by the REST-level and scheduler-unit
    // tests, and by this file's OTHER scenarios (e.g. the clean-restart
    // test above), which don't flatten.
    second.composition.ceoExecution.scheduler.registerDependencyIndex(
      runId,
      version.steps.map((step) => ({ id: step.id, dependencies: [] })),
    );

    // Resume alone starts nothing — the abandoned attempt is still the
    // only one on record.
    expect(second.composition.ceoExecution.planRunStore.listAttempts(runId, stepId)).toHaveLength(
      1,
    );
    expect(second.composition.taskStore.get(taskId).runId).toBe(taskRunIdBeforeCrash);

    // --- Explicit operator "Retry step" — the ONLY path that can
    // relaunch this specific abandoned step.
    await second.composition.ceoExecution.scheduler.retryAbandonedStep(runId, stepId);

    const attemptsAfterRetry = second.composition.ceoExecution.planRunStore.listAttempts(
      runId,
      stepId,
    );
    expect(attemptsAfterRetry).toHaveLength(2);
    const [attempt1, attempt2] = attemptsAfterRetry;
    // The abandoned attempt is preserved, untouched, in history.
    expect(attempt1?.id).toBe(abandonedAttempt?.id);
    expect(attempt1?.status).toBe("abandoned");
    expect(attempt1?.taskRunId).toBe(taskRunIdBeforeCrash);
    // The replacement attempt is genuinely new, with a genuinely new
    // task-run ID — never the interrupted run revived.
    expect(attempt2?.id).not.toBe(abandonedAttempt?.id);
    expect(attempt2?.taskRunId).toBeDefined();
    expect(attempt2?.taskRunId).not.toBe(taskRunIdBeforeCrash);
    const taskAfterRetry = second.composition.taskStore.get(taskId);
    expect(taskAfterRetry.runId).toBeDefined();
    expect(taskAfterRetry.runId).not.toBe(taskRunIdBeforeCrash);

    // Exactly one recovery event, attributed to the explicit operator.
    const events = second.composition.ceoExecution.planRunStore.listEvents(runId);
    const retryRequested = events.filter((e) => e.type === "ceo.execution.retry_requested");
    expect(retryRequested).toHaveLength(1);
    expect(retryRequested[0]?.actor).toBe("human:local-operator");
  }, 30000);

  it("clean restart: a retry_wait step is left untouched — same status, same nextEligibleAt, never force-reset or silently abandoned", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-execution-restart-retrywait-clean-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    recordBootStarted(first.db, "boot-1", new Date().toISOString());
    first.composition.activateAutonomousScheduling();

    const now = new Date().toISOString();
    // Default `maxConcurrentSteps` (1) so only the first step ever
    // starts — this test only cares about that one step's lifecycle.
    const { runId, stepId, taskId } = await delegateAndConfigureRun(first.composition, now, {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      retryBackoffSeconds: 3600,
      pauseOnAnyPermanentFailure: false,
    });

    await waitUntil(() => first.composition.taskStore.get(taskId).runId !== undefined);
    // A genuine transient failure, driven directly against the real
    // `TaskStore` (the deterministic Mock Agent adapter has no
    // composition-level knob for `failureRetryable`) — `updateStatus`
    // fires the real mutation-hook bridge exactly as a genuine adapter
    // failure would.
    first.composition.taskStore.setCompleted(taskId, new Date().toISOString(), "run.failed", {
      code: "PROVIDER_TIMEOUT",
      message: "simulated transient failure",
      retryable: true,
    });
    first.composition.taskStore.updateStatus(taskId, "failed");
    await waitUntil(
      () =>
        first.composition.ceoExecution.planRunStore.getStepExecution(runId, stepId).status ===
        "retry_wait",
    );
    const stepBeforeRestart = first.composition.ceoExecution.planRunStore.getStepExecution(
      runId,
      stepId,
    );
    expect(stepBeforeRestart.nextEligibleAt).toBeDefined();

    recordCleanShutdown(first.db, "boot-1", new Date().toISOString());
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });
    expect(recovery.summary.previousShutdown).toBe("clean");

    const executionRecoverySummary = await runCeoPlanExecutionRecovery({
      planRunStore: second.composition.ceoExecution.planRunStore,
      signalStore: second.composition.ceoExecution.signalStore,
      taskStore: second.composition.taskStore,
      scheduler: second.composition.ceoExecution.scheduler,
      planStore: second.composition.ceoPlans.planStore,
      postBoardAudit: second.composition.ceoExecution.postBoardAudit,
      previousShutdown: recovery.summary.previousShutdown,
      now: new Date().toISOString(),
      runAtomicUnit: second.composition.ceoExecution.runAtomicUnit,
    });
    second.composition.activateAutonomousScheduling();

    // Clean restart's own execution-recovery pass only rebuilds the
    // dependency index and enqueues one `startup_reconciliation` signal
    // — it never directly writes a step-execution row (see
    // `runCeoPlanExecutionRecovery`'s own doc comment), so a `retry_wait`
    // step is neither reset nor force-abandoned, unlike an unclean
    // restart's `claimed`/`starting`/`running` handling.
    expect(executionRecoverySummary.runsScanned).toBe(1);
    expect(executionRecoverySummary.runsContinuedAfterCleanRestart).toBe(1);
    expect(executionRecoverySummary.attemptsAbandoned).toBe(0);

    const stepAfterRestart = second.composition.ceoExecution.planRunStore.getStepExecution(
      runId,
      stepId,
    );
    expect(stepAfterRestart.status).toBe("retry_wait");
    expect(stepAfterRestart.nextEligibleAt).toBe(stepBeforeRestart.nextEligibleAt);
    expect(second.composition.ceoExecution.planRunStore.getRun(runId).status).toBe("running");
    // Phase 15.2 — the formerly-documented retry deadlock (a task that
    // already ran and reached a terminal status could never be
    // relaunched) is now closed by `TaskOrchestrator.prepareRetry()`
    // (see `ceo-plan-execution-retries.test.ts`'s governed-retry tests
    // for the end-to-end proof) — not re-derived here; this test's scope
    // is only that the restart itself never corrupts or discards the
    // pending retry.
  }, 30000);

  it("unclean restart: a retry_wait step's run is recovery-paused exactly like an actively-running step's would be, and nothing auto-relaunches it even once nextEligibleAt has passed — repeating the boot changes nothing further", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-execution-restart-retrywait-unclean-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    recordBootStarted(first.db, "boot-1", new Date().toISOString());
    first.composition.activateAutonomousScheduling();

    const now = new Date().toISOString();
    const { runId, stepId, taskId } = await delegateAndConfigureRun(first.composition, now, {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      // Zero backoff: `nextEligibleAt` is already in the past by the
      // time the second boot's `startup_reconciliation`-equivalent
      // signal could ever reach it — proving "past eligibility" doesn't
      // matter when the RUN itself isn't `"running"` any more.
      retryBackoffSeconds: 0,
      pauseOnAnyPermanentFailure: false,
    });

    await waitUntil(() => first.composition.taskStore.get(taskId).runId !== undefined);
    first.composition.taskStore.setCompleted(taskId, new Date().toISOString(), "run.failed", {
      code: "PROVIDER_TIMEOUT",
      message: "simulated transient failure",
      retryable: true,
    });
    first.composition.taskStore.updateStatus(taskId, "failed");
    await waitUntil(
      () =>
        first.composition.ceoExecution.planRunStore.getStepExecution(runId, stepId).status ===
        "retry_wait",
    );

    // No `recordCleanShutdown` — the crash happens while the step sits
    // in `retry_wait`, not while it is actively running.
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });
    expect(recovery.summary.previousShutdown).toBe("unclean");

    const boardAudits: string[] = [];
    const executionRecoverySummary = await runCeoPlanExecutionRecovery({
      planRunStore: second.composition.ceoExecution.planRunStore,
      signalStore: second.composition.ceoExecution.signalStore,
      taskStore: second.composition.taskStore,
      scheduler: second.composition.ceoExecution.scheduler,
      planStore: second.composition.ceoPlans.planStore,
      postBoardAudit: (planId, text) => {
        boardAudits.push(text);
        second.composition.ceoExecution.postBoardAudit(planId, text);
      },
      previousShutdown: recovery.summary.previousShutdown,
      now: new Date().toISOString(),
      runAtomicUnit: second.composition.ceoExecution.runAtomicUnit,
    });
    second.composition.activateAutonomousScheduling();

    expect(executionRecoverySummary.runsPausedForUncleanRestart).toBe(1);
    expect(boardAudits).toHaveLength(1);

    const runAfterRestart = second.composition.ceoExecution.planRunStore.getRun(runId);
    expect(runAfterRestart.status).toBe("awaiting_intervention");

    // The step itself is left exactly as it was — `retry_wait` is not
    // one of the statuses unclean recovery force-transitions (only
    // `claimed`/`starting`/`running`, which have no on-disk record of
    // their own eligibility gate the way `retry_wait` does).
    const stepAfterRestart = second.composition.ceoExecution.planRunStore.getStepExecution(
      runId,
      stepId,
    );
    expect(stepAfterRestart.status).toBe("retry_wait");

    // The run is no longer `"running"`, so `tick()`'s own active-run
    // filter excludes it entirely — no automatic relaunch, even though
    // `nextEligibleAt` (zero backoff) is already in the past.
    expect(second.composition.taskStore.get(taskId).task.status).toBe("failed");

    // Repeating the boot's recovery pass — a second crash before any
    // operator ever intervened — is a safe no-op: no second pause, no
    // second Board summary, no further state change (kickoff §6's
    // "repeated restart creates no retry loop").
    const repeatSummary = await runCeoPlanExecutionRecovery({
      planRunStore: second.composition.ceoExecution.planRunStore,
      signalStore: second.composition.ceoExecution.signalStore,
      taskStore: second.composition.taskStore,
      scheduler: second.composition.ceoExecution.scheduler,
      planStore: second.composition.ceoPlans.planStore,
      postBoardAudit: (planId, text) => {
        boardAudits.push(text);
        second.composition.ceoExecution.postBoardAudit(planId, text);
      },
      previousShutdown: "unclean",
      now: new Date().toISOString(),
      runAtomicUnit: second.composition.ceoExecution.runAtomicUnit,
    });
    expect(repeatSummary.runsScanned).toBe(0);
    expect(boardAudits).toHaveLength(1);
    expect(
      second.composition.ceoExecution.planRunStore.getStepExecution(runId, stepId).status,
    ).toBe("retry_wait");
  }, 30000);
});
