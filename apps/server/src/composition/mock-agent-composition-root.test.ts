import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import { ServerCliError } from "../config/server-cli-args.js";
import { waitUntil } from "../test-support.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { createMockAgentServerComposition } from "./mock-agent-composition-root.js";
import { createServerComposition } from "./server-composition.js";

const tempDirs: string[] = [];
const dbs: HallDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * `--mock-scenario` is parsed as an unbounded-but-length-limited string by
 * `parseServerCliArguments` (it has no enum concept of its own — see the
 * comment on `mockScenario` in `server-cli-args.ts`); the actual
 * success/failure/cancellable validation happens here, in
 * `resolveScenario`, the moment the composition root turns that raw string
 * into a real `MockAgentAdapter`. This is the only place that rejection
 * path is exercised.
 */
describe("createMockAgentServerComposition", () => {
  function buildOptions(mockScenario?: string) {
    return {
      workspaceRoot: process.cwd(),
      mockScenario,
      limits: DEFAULT_LIMITS,
    };
  }

  it("defaults to the success scenario when --mock-scenario is omitted", () => {
    const composition = createMockAgentServerComposition(buildOptions(undefined));
    expect(composition.registry.listDescriptors()).toHaveLength(1);
  });

  it.each(["success", "failure", "cancellable"])(
    "accepts the documented scenario value %s",
    (scenario) => {
      expect(() => createMockAgentServerComposition(buildOptions(scenario))).not.toThrow();
    },
  );

  it("rejects an unrecognized --mock-scenario value with a clear, safe error", () => {
    expect(() => createMockAgentServerComposition(buildOptions("bogus"))).toThrow(ServerCliError);
    try {
      createMockAgentServerComposition(buildOptions("bogus"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerCliError);
      expect((error as ServerCliError).message).toContain("success");
      expect((error as ServerCliError).message).toContain("failure");
      expect((error as ServerCliError).message).toContain("cancellable");
      expect((error as ServerCliError).message).toContain("bogus");
    }
  });

  it("registers exactly one adapter under the mock agent's own adapter id", () => {
    const composition = createMockAgentServerComposition(buildOptions("success"));
    const [descriptor] = composition.registry.listDescriptors();
    expect(descriptor?.adapterId).toBe("hall.mock-agent");
  });

  it("rejects isolated execution policy when only in-memory stores are configured", () => {
    expect(() =>
      createMockAgentServerComposition({
        ...buildOptions("success"),
        isolatedAgentAdapterIds: ["hall.mock-agent"],
      }),
    ).toThrow(ServerCliError);
  });

  it("allows explicit test-only in-memory isolated execution opt-in", () => {
    expect(() =>
      createMockAgentServerComposition({
        ...buildOptions("success"),
        isolatedAgentAdapterIds: ["hall.mock-agent"],
        allowInMemoryAgentIsolation: true,
        agentWorktreeRoot: makeTempDir("hall-test-worktrees-"),
      }),
    ).not.toThrow();
  });

  it("rejects in-memory isolated execution when the explicit worktree root is missing", () => {
    expect(() =>
      createMockAgentServerComposition({
        ...buildOptions("success"),
        isolatedAgentAdapterIds: ["hall.mock-agent"],
        allowInMemoryAgentIsolation: true,
      }),
    ).toThrow(ServerCliError);
  });

  it("rejects SQLite isolated execution when the explicit worktree root is missing", () => {
    expect(() =>
      createMockAgentServerComposition({
        ...buildOptions("success"),
        db: openMigratedDatabase(),
        isolatedAgentAdapterIds: ["hall.mock-agent"],
      }),
    ).toThrow(ServerCliError);
  });

  it("allows durable server composition without deriving a Codex worktree root implicitly", () => {
    expect(() =>
      createServerComposition({
        ...buildOptions("success"),
        db: openMigratedDatabase(),
      }),
    ).not.toThrow();
  });

  it("allows SQLite isolated execution with an explicit worktree root", () => {
    expect(() =>
      createMockAgentServerComposition({
        ...buildOptions("success"),
        db: openMigratedDatabase(),
        isolatedAgentAdapterIds: ["hall.mock-agent"],
        agentWorktreeRoot: makeTempDir("hall-sqlite-worktrees-"),
      }),
    ).not.toThrow();
  });

  it("keeps normal ephemeral server composition non-isolated and does not create the fallback worktree root", async () => {
    const parent = makeTempDir("hall-ephemeral-parent-");
    const workspaceRoot = path.join(parent, "workspace");
    fs.mkdirSync(workspaceRoot);
    const fallbackRoot = path.join(parent, ".hall-agent-worktrees");
    const composition = createServerComposition({
      workspaceRoot: fs.realpathSync.native(workspaceRoot),
      mockScenario: "success",
      limits: DEFAULT_LIMITS,
    });

    expect(composition.registry.resolve("hall.codex")).toBeDefined();
    const { task, runId } = composition.orchestrator.createTask({
      projectId: "project-1",
      title: "Ephemeral task",
      adapterId: "hall.mock-agent",
    });
    await waitUntil(() => composition.taskStore.get(task.taskId).task.status === "completed");
    expect(
      composition.agentExecutionArtifactStore.getByHallAgentRunId(runId ?? "").worktreeId,
    ).toBeUndefined();
    expect(fs.existsSync(fallbackRoot)).toBe(false);
  });

  /**
   * Phase 15 — proves the real wiring, not a synthetic harness: the
   * scheduler's `onChildTaskMutated` must fire automatically via
   * `createCoreStoresComposition`'s `onTaskMutated` bridge
   * (`wrapTaskStoreWithMutationHook` -> composition's terminal-status
   * filter -> `schedulerRef.current`), never by test code calling it
   * directly (contrast `ceo-plan-execution-scheduler.test.ts`, whose
   * harness builds its own `CeoPlanExecutionScheduler` and calls
   * `onChildTaskMutated` by hand). If the bridge in
   * `createMockAgentServerComposition` were missing or miswired, this
   * run would sit at "running" forever.
   */
  it("wires the scheduler to the real task-mutation bridge: an autonomous run completes without any test code calling onChildTaskMutated", async () => {
    const composition = createMockAgentServerComposition(buildOptions("success"));
    // Mirrors `server.ts`: the bridge stays inert until explicitly armed
    // (normally right after Phase 15's own restart-recovery pass) — see
    // `activateAutonomousScheduling`'s doc comment on `ServerComposition`.
    composition.activateAutonomousScheduling();
    const now = new Date().toISOString();
    const taskId = "bridge-task-1";
    composition.taskStore.add({
      task: {
        taskId,
        projectId: "project-1",
        title: "Bridge test task",
        description: "Exercises the real onTaskMutated -> scheduler bridge.",
        priority: "normal",
        status: "assigned",
        dependencyTaskIds: [],
        createdAt: now,
        updatedAt: now,
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      },
      runId: undefined,
      adapterId: "hall.mock-agent",
      agentId: "mock-agent",
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: "simulated",
    });

    const runId = "bridge-run-1";
    const planId = "bridge-plan-1";
    const stepId = "step-1";
    composition.ceoExecution.planRunStore.configureRun({
      runId,
      planId,
      planVersion: 1,
      executionMode: "autonomous",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now,
      steps: [{ stepId, childTaskId: taskId, dependencyStepIds: [] }],
    });
    composition.ceoExecution.scheduler.registerDependencyIndex(runId, [
      { id: stepId, dependencies: [] },
    ]);
    composition.ceoExecution.planRunStore.startRun({ runId, now });
    await composition.ceoExecution.scheduler.enqueueSignal({
      planRunId: runId,
      planStepId: stepId,
      reason: "execution_started",
    });

    await waitUntil(
      () => composition.ceoExecution.planRunStore.getRun(runId).status === "completed",
    );
    expect(composition.taskStore.get(taskId).task.status).toBe("completed");
  });

  /**
   * Phase 15.1 — a real, reproduced defect, found only by driving this
   * exact real bridge (not the synthetic `ceo-plan-execution-scheduler
   * .test.ts` harness, which calls `onChildTaskMutated` once, by hand,
   * well after `TaskOrchestrator` has already finished applying an
   * event). `TaskOrchestrator#handleEvent`'s `"run.failed"` case used to
   * call `taskStore.updateStatus(taskId, "failed")` BEFORE
   * `taskStore.setCompleted(taskId, ..., failure)` — two independent
   * `wrapTaskStoreWithMutationHook`-wrapped calls, each notifying on its
   * own. The first notification fired with `record.task.status` already
   * `"failed"` (so the bridge's `isTerminalTaskStatus` check forwarded
   * it) but `record.task.failure` still `undefined` — so
   * `CeoPlanExecutionScheduler#handleChildTaskFailure` fell back to
   * `{retryable: false}` and classified a genuinely transient,
   * `retryable: true` failure as `"permanent"`. The step then landed on
   * `"failed"`, which is one of `onChildTaskMutated`'s own idempotency-
   * guard terminal statuses — so the SECOND notification (after
   * `setCompleted`, with the correct `retryable: true`) was silently
   * discarded, and automatic retry never had a chance to run at all. This
   * test proves the fix (`setCompleted` now runs before `updateStatus`)
   * by asserting the step lands on `"retry_wait"`, not `"failed"`.
   */
  it("a transient (retryable) failure reaches the scheduler correctly classified through the real bridge — never misclassified as permanent by a stale pre-setCompleted notification", async () => {
    const composition = createMockAgentServerComposition({
      ...buildOptions("failure"),
      mockFailureRetryable: true,
    });
    composition.activateAutonomousScheduling();
    const now = new Date().toISOString();
    const taskId = "retry-bridge-task-1";
    composition.taskStore.add({
      task: {
        taskId,
        projectId: "project-1",
        title: "Retry bridge test task",
        description:
          "Exercises the real onTaskMutated -> scheduler bridge for a transient failure.",
        priority: "normal",
        status: "assigned",
        dependencyTaskIds: [],
        createdAt: now,
        updatedAt: now,
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      },
      runId: undefined,
      adapterId: "hall.mock-agent",
      agentId: "mock-agent",
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: "simulated",
    });

    const runId = "retry-bridge-run-1";
    const planId = "retry-bridge-plan-1";
    const stepId = "step-1";
    composition.ceoExecution.planRunStore.configureRun({
      runId,
      planId,
      planVersion: 1,
      executionMode: "autonomous",
      policy: {
        ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        allowAutomaticTransientRetry: true,
        maxAttemptsPerStep: 3,
        retryBackoffSeconds: 300,
      },
      now,
      steps: [{ stepId, childTaskId: taskId, dependencyStepIds: [] }],
    });
    composition.ceoExecution.scheduler.registerDependencyIndex(runId, [
      { id: stepId, dependencies: [] },
    ]);
    composition.ceoExecution.planRunStore.startRun({ runId, now });
    await composition.ceoExecution.scheduler.enqueueSignal({
      planRunId: runId,
      planStepId: stepId,
      reason: "execution_started",
    });

    await waitUntil(() => composition.taskStore.get(taskId).task.status === "failed");
    expect(composition.taskStore.get(taskId).failure?.retryable).toBe(true);
    await waitUntil(() => {
      const step = composition.ceoExecution.planRunStore.getStepExecution(runId, stepId);
      return step.status === "retry_wait" || step.status === "failed";
    });
    const step = composition.ceoExecution.planRunStore.getStepExecution(runId, stepId);
    expect(step.status).toBe("retry_wait");
  });

  /**
   * Phase 15.3 regression guard — a real E2E run once observed a step's
   * attempt row stuck at `"running"` (never finalized to `"failed"`) even
   * though the step itself correctly reached `"retry_wait"`, which wedges
   * governed retry forever (`prepareTaskRetryIfEligible`'s "previous
   * attempt terminal" precondition can never pass against a `"running"`
   * attempt). Mirrors the real `/start` route topology exactly (3
   * sequential steps, ONE plan-level `execution_started` signal with
   * `planStepId: undefined`, so `#resolveTargetSteps` walks all three
   * steps in a single `#processSignal` call) and the real
   * `wrapTaskStoreWithMutationHook` bridge (not a synthetic harness that
   * calls `onChildTaskMutated` by hand). Looped because this was never
   * reproduced deterministically in this composition (600+ iterations
   * across two topologies, 0 failures) — see
   * `docs/architecture/0015-...md`, "Known Phase-15 limitations" for the
   * full investigation notes. Kept as a standing regression guard for the
   * attempt-finalization invariant even though it is currently green.
   */
  it("attempt row must never be stuck at 'running' once its step reaches retry_wait", async () => {
    for (let i = 0; i < 20; i += 1) {
      const composition = createMockAgentServerComposition({
        ...buildOptions("failure"),
        mockFailureRetryable: true,
      });
      composition.activateAutonomousScheduling();
      const now = new Date().toISOString();
      const [investigateStepId, implementStepId, verifyStepId] = [
        "investigate",
        "implement",
        "verify",
      ] as const;
      const investigateTaskId = `diag-race-investigate-${String(i)}`;
      const implementTaskId = `diag-race-implement-${String(i)}`;
      const verifyTaskId = `diag-race-verify-${String(i)}`;
      for (const taskId of [investigateTaskId, implementTaskId, verifyTaskId]) {
        composition.taskStore.add({
          task: {
            taskId,
            projectId: "project-1",
            title: "Diagnostic race task",
            description: "Reproduces the mark-running/mark-failed race server-side.",
            priority: "normal",
            status: "assigned",
            dependencyTaskIds: [],
            createdAt: now,
            updatedAt: now,
            requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
          },
          runId: undefined,
          adapterId: "hall.mock-agent",
          agentId: "mock-agent",
          eventCount: 0,
          lastSequence: undefined,
          terminalEventType: undefined,
          failure: undefined,
          cancellationRequested: false,
          createdAt: now,
          startedAt: undefined,
          completedAt: undefined,
          assignedExecutionTrust: "simulated",
        });
      }

      const runId = `diag-race-run-${String(i)}`;
      composition.ceoExecution.planRunStore.configureRun({
        runId,
        planId: `diag-race-plan-${String(i)}`,
        planVersion: 1,
        executionMode: "autonomous",
        policy: {
          ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
          allowAutomaticTransientRetry: true,
          maxAttemptsPerStep: 3,
          retryBackoffSeconds: 300,
        },
        now,
        steps: [
          { stepId: investigateStepId, childTaskId: investigateTaskId, dependencyStepIds: [] },
          {
            stepId: implementStepId,
            childTaskId: implementTaskId,
            dependencyStepIds: [investigateStepId],
          },
          {
            stepId: verifyStepId,
            childTaskId: verifyTaskId,
            dependencyStepIds: [implementStepId],
          },
        ],
      });
      composition.ceoExecution.scheduler.registerDependencyIndex(runId, [
        { id: investigateStepId, dependencies: [] },
        { id: implementStepId, dependencies: [investigateStepId] },
        { id: verifyStepId, dependencies: [implementStepId] },
      ]);
      composition.ceoExecution.planRunStore.startRun({ runId, now });
      // Plan-level signal, matching the real `/start` route exactly
      // (`ceo-plan-runs.ts`: `enqueueSignal({planRunId, reason:
      // "execution_started"})`, no `planStepId`) — this walks all three
      // steps in one `#processSignal` call, unlike a step-targeted signal.
      await composition.ceoExecution.scheduler.enqueueSignal({
        planRunId: runId,
        reason: "execution_started",
      });

      const stepId = investigateStepId;
      await waitUntil(() => {
        const step = composition.ceoExecution.planRunStore.getStepExecution(runId, stepId);
        return step.status === "retry_wait" || step.status === "failed";
      });
      const step = composition.ceoExecution.planRunStore.getStepExecution(runId, stepId);
      expect.soft(step.status, `iteration ${String(i)}: step status`).toBe("retry_wait");
      expect
        .soft(step.activeAttemptId, `iteration ${String(i)}: step.activeAttemptId`)
        .toBeDefined();
      if (step.activeAttemptId !== undefined) {
        const attempt = composition.ceoExecution.planRunStore.getAttempt(step.activeAttemptId);
        expect
          .soft(attempt.status, `iteration ${String(i)}: attempt ${attempt.id} status`)
          .toBe("failed");
      }
    }
  });

  /**
   * Phase 15.3 — proves the retry-due wake mechanism itself: a step
   * parked in `retry_wait` reaches attempt 2 on its own, with NO further
   * signal, nudge, or manual Pause/Resume of any kind after the initial
   * `execution_started` signal that launched attempt 1. Before this
   * session, nothing woke a `retry_wait` step once `nextEligibleAt`
   * passed — it required some UNRELATED signal for the run to happen to
   * arrive (see the retry-circuit E2E spec's own history). `waitUntil`
   * here polls the STORE, not a timer — if the wake timer never fires,
   * this test times out rather than silently passing.
   */
  it("a retry_wait step reaches attempt 2 on its own once the backoff elapses, with no manual nudge of any kind", async () => {
    const composition = createMockAgentServerComposition({
      ...buildOptions("failure"),
      mockFailureRetryable: true,
    });
    composition.activateAutonomousScheduling();
    const now = new Date().toISOString();
    const taskId = "wake-task-1";
    composition.taskStore.add({
      task: {
        taskId,
        projectId: "project-1",
        title: "Wake mechanism test task",
        description: "Proves the retry-due wake timer relaunches without a manual nudge.",
        priority: "normal",
        status: "assigned",
        dependencyTaskIds: [],
        createdAt: now,
        updatedAt: now,
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      },
      runId: undefined,
      adapterId: "hall.mock-agent",
      agentId: "mock-agent",
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: "simulated",
    });

    const runId = "wake-run-1";
    const stepId = "step-1";
    composition.ceoExecution.planRunStore.configureRun({
      runId,
      planId: "wake-plan-1",
      planVersion: 1,
      executionMode: "autonomous",
      policy: {
        ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        allowAutomaticTransientRetry: true,
        maxAttemptsPerStep: 2,
        retryBackoffSeconds: 1,
      },
      now,
      steps: [{ stepId, childTaskId: taskId, dependencyStepIds: [] }],
    });
    composition.ceoExecution.scheduler.registerDependencyIndex(runId, [
      { id: stepId, dependencies: [] },
    ]);
    composition.ceoExecution.planRunStore.startRun({ runId, now });
    await composition.ceoExecution.scheduler.enqueueSignal({
      planRunId: runId,
      reason: "execution_started",
    });

    await waitUntil(() => {
      const step = composition.ceoExecution.planRunStore.getStepExecution(runId, stepId);
      return step.status === "retry_wait";
    });
    // No signal, resume, or retry call of any kind from here on — only
    // real elapsed time and the wake timer this session added.
    await waitUntil(() => {
      const attempts = composition.ceoExecution.planRunStore.listAttempts(runId, stepId);
      return attempts.length === 2;
    }, 5000);
    const attempts = composition.ceoExecution.planRunStore.listAttempts(runId, stepId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.id).not.toBe(attempts[1]?.id);
  });

  /**
   * Phase 15 — the other half of the previous test's guarantee: before
   * `activateAutonomousScheduling()` is called, the child task can finish
   * on its own (nothing here prevents `TaskOrchestrator` from running
   * normally), but the scheduler must never find out about it via the
   * bridge. This is what makes it safe for `runRestartRecovery`'s own
   * `reconcileTasks` step to mutate `taskStore` freely before Phase 15's
   * recovery pass has decided what to do with each previously-configured
   * run.
   */
  it("never lets the scheduler bridge react to a child-task completion before activateAutonomousScheduling() is called", async () => {
    const composition = createMockAgentServerComposition(buildOptions("success"));
    const now = new Date().toISOString();
    const taskId = "unarmed-bridge-task-1";
    composition.taskStore.add({
      task: {
        taskId,
        projectId: "project-1",
        title: "Unarmed bridge test task",
        description: "Proves the bridge stays inert before activation.",
        priority: "normal",
        status: "assigned",
        dependencyTaskIds: [],
        createdAt: now,
        updatedAt: now,
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      },
      runId: undefined,
      adapterId: "hall.mock-agent",
      agentId: "mock-agent",
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: "simulated",
    });

    const runId = "unarmed-bridge-run-1";
    const planId = "unarmed-bridge-plan-1";
    const stepId = "step-1";
    composition.ceoExecution.planRunStore.configureRun({
      runId,
      planId,
      planVersion: 1,
      executionMode: "autonomous",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now,
      steps: [{ stepId, childTaskId: taskId, dependencyStepIds: [] }],
    });
    composition.ceoExecution.scheduler.registerDependencyIndex(runId, [
      { id: stepId, dependencies: [] },
    ]);
    composition.ceoExecution.planRunStore.startRun({ runId, now });
    // Kick the scheduler directly (not through the bridge) so the task
    // actually starts and runs to completion.
    await composition.ceoExecution.scheduler.enqueueSignal({
      planRunId: runId,
      planStepId: stepId,
      reason: "execution_started",
    });

    await waitUntil(() => composition.taskStore.get(taskId).task.status === "completed");
    // Give any (incorrect) bridge notification a chance to have already
    // fired; the run must still be sitting at "running", never advanced
    // to "completed", since `activateAutonomousScheduling()` was never
    // called.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(composition.ceoExecution.planRunStore.getRun(runId).status).toBe("running");
  });

  it("Issue #23 — a CEO-delegated child task inherits its parent Gateway task's attachments through the real composition wiring (ref box + real CeoPlanStorePort, no fake)", async () => {
    const composition = createMockAgentServerComposition(buildOptions("success"));
    const { taskStore, boardStore, messageStore, ceoPlans, attachmentMaterializer } = composition;

    const now = "2026-08-15T00:00:00.000Z";
    const parentTaskId = "gateway-parent-task-1";
    taskStore.add({
      task: {
        taskId: parentTaskId,
        projectId: "project-1",
        title: "Analyze the attached file",
        description: "Describe what is in the attached file.",
        priority: "normal",
        status: "backlog",
        dependencyTaskIds: [],
        createdAt: now,
        updatedAt: now,
        source: "wisdom_gateway",
        // Matches MockAgentAdapter's own detect() output — this test is
        // about attachment inheritance (Part 2), not vision routing (Part
        // 3, covered elsewhere), so the attachment below is deliberately
        // non-image (kind: "file") — an image would bake `vision.image`
        // into the plan and make MockAgentAdapter ineligible, and no
        // child task would ever be created to check inheritance on.
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      },
      runId: undefined,
      adapterId: undefined,
      agentId: undefined,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: undefined,
    });

    const board = boardStore.ensureTaskBoard(parentTaskId, now).board;
    messageStore.registerBoard(board.boardId);
    const parentAttachment = {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "notes.txt",
      mimeType: "text/plain",
      byteSize: 12,
      kind: "file" as const,
    };
    messageStore.append(board.boardId, {
      messageId: "msg-1",
      boardId: board.boardId,
      author: { kind: "human", displayName: "Test User" },
      text: "here are some notes",
      attachments: [parentAttachment],
      createdAt: now,
    });

    // A direct (never-delegated) task must still see only its own board —
    // proven here, through the same real wiring, not a fake.
    const directTaskId = "direct-task-1";
    taskStore.add({
      task: {
        taskId: directTaskId,
        projectId: "project-1",
        title: "Unrelated direct task",
        description: "Not part of any CEO plan.",
        priority: "normal",
        status: "backlog",
        dependencyTaskIds: [],
        createdAt: now,
        updatedAt: now,
      },
      runId: undefined,
      adapterId: undefined,
      agentId: undefined,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: now,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: undefined,
    });
    expect(attachmentMaterializer.snapshotAttachments(directTaskId).attachments).toEqual([]);

    const { plan } = await ceoPlans.orchestrator.createPlan(parentTaskId, undefined);
    await ceoPlans.orchestrator.submit(plan.id, ceoPlans.orchestrator.getMutationToken(plan.id));
    const version = ceoPlans.orchestrator.getVersion(plan.id, 1);
    await ceoPlans.orchestrator.decideApproval(
      plan.id,
      ceoPlans.orchestrator.getMutationToken(plan.id),
      1,
      version.contentHash,
      "approve",
      undefined,
    );
    const delegated = await ceoPlans.orchestrator.delegate(
      plan.id,
      ceoPlans.orchestrator.getMutationToken(plan.id),
    );
    const childTaskId = delegated.childTasks[0]?.task.taskId;
    expect(childTaskId).toBeDefined();
    if (childTaskId === undefined) return;

    // The real end-to-end mechanism: findPlanIdByChildTaskId (InMemoryCeoPlanStore's
    // real reverse index, populated by a real recordDelegation call) →
    // getPlan(planId).parentTaskId → the parent's own board — reached only
    // through the ref box `createMockAgentServerComposition` wires between
    // `createCoreStoresComposition` and `createCeoPlanComposition`.
    const childSnapshot = attachmentMaterializer.snapshotAttachments(childTaskId);
    expect(childSnapshot.attachments).toEqual([parentAttachment]);
  });
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function openMigratedDatabase(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  dbs.push(db);
  return db;
}
