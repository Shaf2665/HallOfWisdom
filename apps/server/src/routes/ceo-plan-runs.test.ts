import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTestApp,
  validDeferredTaskBody,
  type CreateTaskResponseJson,
} from "../test-support.js";
import { createHallCoreApp } from "../app.js";
import { createServerComposition } from "../composition/server-composition.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { acquireDatabaseEpoch } from "../persistence/database-ownership-fence.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import { reconcileTasks, RESTART_INTERRUPTED_RUN_CODE } from "../recovery/reconcile-tasks.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-ceo-plan-runs-routes-test-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function buildApp() {
  return buildTestApp({ workspaceRoot: tempRoot });
}

interface PlanJson {
  readonly id: string;
  readonly status: string;
  readonly activeVersion: number;
}
interface PlanVersionJson {
  readonly version: number;
  readonly contentHash: string;
}
interface RunJson {
  readonly id: string;
  readonly status: string;
  readonly executionMode: string;
  readonly activeGeneration: number;
}

const DEFAULT_POLICY = {
  maxConcurrentSteps: 1,
  maxAttemptsPerStep: 1,
  allowAutomaticTransientRetry: false,
  retryBackoffSeconds: 30,
  maxPlanElapsedSeconds: 3600,
  maxStepElapsedSeconds: 600,
  maxConsecutiveFailures: 2,
  maxNoProgressAttempts: 2,
  pauseOnAnyPermanentFailure: true,
};

/** Full create -> submit -> approve -> delegate happy path over HTTP, mirroring `ceo-plans.test.ts`'s own helper — returns the delegated plan's id. */
async function delegatePlan(app: Awaited<ReturnType<typeof buildApp>>["app"]): Promise<string> {
  const parent = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: validDeferredTaskBody({
      description: "Fix the login redirect: it goes to /404 instead of /dashboard.",
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    }),
  });
  const taskId = parent.json<CreateTaskResponseJson>().task.taskId;

  const created = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/ceo-plans`,
    payload: {},
  });
  const { plan } = created.json<{ plan: PlanJson; version: PlanVersionJson }>();

  const planDetail = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
  ).json<{ mutationToken: string }>();

  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plans/${plan.id}/submit`,
    payload: { expectedMutationToken: planDetail.mutationToken },
  });
  const tokenAfterSubmit = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
  ).json<{ mutationToken: string }>().mutationToken;
  expect(submitted.statusCode).toBe(200);

  const version = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}/versions/1` })
  ).json<PlanVersionJson>();

  const approved = await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plans/${plan.id}/approve`,
    payload: {
      expectedMutationToken: tokenAfterSubmit,
      planVersion: 1,
      contentHash: version.contentHash,
    },
  });
  expect(approved.statusCode).toBe(200);
  const tokenAfterApprove = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
  ).json<{ mutationToken: string }>().mutationToken;

  const delegated = await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plans/${plan.id}/delegate`,
    payload: { expectedMutationToken: tokenAfterApprove },
  });
  expect(delegated.statusCode).toBe(202);

  return plan.id;
}

describe("CEO plan-run execution REST routes", () => {
  it("full lifecycle over HTTP: configure -> start -> pause -> resume -> cancel, correct status codes throughout, and configure alone starts nothing", async () => {
    const { app, harness } = await buildApp();
    const planId = await delegatePlan(app);
    const tasksBeforeConfigure = harness.taskStore
      .list()
      .filter((t) => t.runId !== undefined).length;

    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "autonomous", policy: DEFAULT_POLICY },
    });
    expect(configured.statusCode).toBe(201);
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();
    expect(run.status).toBe("configured");
    expect(run.executionMode).toBe("autonomous");
    // Configuring alone must never start a task run.
    expect(harness.taskStore.list().filter((t) => t.runId !== undefined).length).toBe(
      tasksBeforeConfigure,
    );

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(started.statusCode).toBe(200);
    const afterStart = started.json<{ run: RunJson; mutationToken: string }>();
    expect(afterStart.run.status).toBe("running");

    const detail = await app.inject({ method: "GET", url: `/api/v1/ceo-plan-runs/${run.id}` });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<{ run: RunJson; stepExecutions: unknown[] }>();
    expect(detailBody.stepExecutions.length).toBeGreaterThan(0);

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/pause`,
      payload: { expectedMutationToken: afterStart.mutationToken },
    });
    expect(paused.statusCode).toBe(200);
    const afterPause = paused.json<{ run: RunJson; mutationToken: string }>();
    expect(afterPause.run.status).toBe("paused");

    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/resume`,
      payload: { expectedMutationToken: afterPause.mutationToken },
    });
    expect(resumed.statusCode).toBe(200);
    const afterResume = resumed.json<{ run: RunJson; mutationToken: string }>();
    expect(afterResume.run.status).toBe("running");
    expect(afterResume.run.activeGeneration).toBeGreaterThan(afterPause.run.activeGeneration);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/cancel`,
      payload: { expectedMutationToken: afterResume.mutationToken },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ run: RunJson }>().run.status).toBe("cancelled");

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plan-runs/${run.id}/events`,
    });
    expect(events.statusCode).toBe(200);
    const eventTypes = events
      .json<{ events: readonly { type: string }[] }>()
      .events.map((e) => e.type);
    expect(eventTypes).toContain("ceo.execution.configured");
    expect(eventTypes).toContain("ceo.execution.started");
    expect(eventTypes).toContain("ceo.execution.paused");
    expect(eventTypes).toContain("ceo.execution.resumed");
    expect(eventTypes).toContain("ceo.execution.cancelled");

    await app.close();
  });

  it("manual mode: configure -> start never starts a child task", async () => {
    const { app, harness } = await buildApp();
    const planId = await delegatePlan(app);

    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();

    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });

    expect(harness.taskStore.list().every((t) => t.runId === undefined)).toBe(true);
    await app.close();
  });

  it("Phase 15.7 — security matrix scenario 3: autonomous execution is never enabled by default at any stage, requires an explicit executionMode and a separate explicit start, and a missing executionMode is rejected rather than defaulted", async () => {
    const { app, harness } = await buildApp();

    // Create -> submit -> approve -> delegate: no execution run of any
    // kind exists yet, and no child task has ever been given a runId.
    const planId = await delegatePlan(app);
    const runsAfterDelegate = await app.inject({ method: "GET", url: "/api/v1/ceo-plan-runs" });
    expect(runsAfterDelegate.json<{ runs: readonly RunJson[] }>().runs).toHaveLength(0);
    expect(harness.taskStore.list().every((t) => t.runId === undefined)).toBe(true);

    // A configure request omitting `executionMode` is rejected outright —
    // never silently defaulted to "autonomous" server-side.
    const missingMode = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { policy: DEFAULT_POLICY },
    });
    expect(missingMode.statusCode).toBe(400);
    expect(missingMode.json<{ error: { code: string } }>().error.code).toBe("INVALID_REQUEST");
    const runsAfterRejectedConfigure = await app.inject({
      method: "GET",
      url: "/api/v1/ceo-plan-runs",
    });
    expect(runsAfterRejectedConfigure.json<{ runs: readonly RunJson[] }>().runs).toHaveLength(0);

    // Explicitly configuring "autonomous" creates a run, but starts
    // nothing on its own — the separate, explicit `/start` action (with
    // its own authorization checkbox in Hall Web) is still required.
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "autonomous", policy: DEFAULT_POLICY },
    });
    expect(configured.statusCode).toBe(201);
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();
    expect(run.status).toBe("configured");
    expect(run.executionMode).toBe("autonomous");
    expect(harness.taskStore.list().every((t) => t.runId === undefined)).toBe(true);

    // Positive control: explicit `/start` on this explicitly-autonomous,
    // already-configured run is what actually launches the eligible child
    // task — proving the checks above are real gates, not an inert path
    // that never launches anything under any circumstance.
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(harness.taskStore.list().some((t) => t.runId !== undefined)).toBe(true);

    await app.close();
  });

  it("Phase 15.7 — security matrix scenario 15: the execution DAG is derived only from the approved plan version, forged dependency data in a configure request is rejected by the strict schema, and the resulting step dependencies exactly match the approved plan", async () => {
    const { app, harness } = await buildApp();
    const planId = await delegatePlan(app);

    // The approved plan version is the one and only source of truth for
    // the DAG — read it directly for the assertions below.
    const version = (
      await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${planId}/versions/1` })
    ).json<{
      steps: readonly { id: string; title: string; dependencies: readonly string[] }[];
    }>();
    expect(version.steps).toHaveLength(3);
    const investigate = version.steps.find((s) => s.title.startsWith("Investigate:"));
    const implement = version.steps.find((s) => s.title.startsWith("Implement:"));
    const verify = version.steps.find((s) => s.title.startsWith("Verify:"));
    if (!investigate || !implement || !verify) throw new Error("expected 3 named steps");
    expect(investigate.dependencies).toEqual([]);
    expect(implement.dependencies).toEqual([investigate.id]);
    expect(verify.dependencies).toEqual([implement.id]);

    // A configure request carrying forged dependency-shaped data — the
    // schema has no `steps`/`dependencies` field in its accepted shape at
    // all, so this is rejected at parse time, before the route ever
    // derives anything.
    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: {
        executionMode: "autonomous",
        policy: DEFAULT_POLICY,
        steps: [
          { stepId: verify.id, childTaskId: "forged-task", dependencyStepIds: [] },
          { stepId: implement.id, childTaskId: "forged-task-2", dependencyStepIds: [] },
        ],
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json<{ error: { code: string } }>().error.code).toBe("INVALID_REQUEST");
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/ceo-plan-runs" })).json<{
        runs: readonly RunJson[];
      }>().runs,
    ).toHaveLength(0);

    // A genuine, unforged configure request — the route derives `steps`
    // and their dependencies itself, entirely server-side.
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "autonomous", policy: DEFAULT_POLICY },
    });
    expect(configured.statusCode).toBe(201);
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();

    const detailBefore = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plan-runs/${run.id}`,
    });
    const stepExecutionsBefore = detailBefore.json<{
      stepExecutions: readonly {
        planStepId: string;
        dependencySummary: { totalDependencies: number };
      }[];
    }>().stepExecutions;
    const findStep = (
      stepId: string,
    ): { planStepId: string; dependencySummary: { totalDependencies: number } } => {
      const found = stepExecutionsBefore.find((s) => s.planStepId === stepId);
      if (!found) throw new Error(`no step execution for ${stepId}`);
      return found;
    };
    // The dependency COUNT the server derived exactly matches the
    // approved plan's own declared dependency count for every step —
    // never the forged payload's shape above, which was rejected outright
    // and never reached this far.
    expect(findStep(investigate.id).dependencySummary.totalDependencies).toBe(0);
    expect(findStep(implement.id).dependencySummary.totalDependencies).toBe(1);
    expect(findStep(verify.id).dependencySummary.totalDependencies).toBe(1);

    // Functional proof, not just a count: starting the run launches only
    // the dependency-free step (Investigate); Implement/Verify — genuinely
    // gated on it in the real, server-derived DAG — never start until it
    // completes.
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    const investigateTask = harness.taskStore
      .list()
      .find((t) => t.task.title.startsWith("Investigate:"));
    const implementTask = harness.taskStore
      .list()
      .find((t) => t.task.title.startsWith("Implement:"));
    const verifyTask = harness.taskStore.list().find((t) => t.task.title.startsWith("Verify:"));
    expect(investigateTask?.runId).toBeDefined();
    expect(implementTask?.runId).toBeUndefined();
    expect(verifyTask?.runId).toBeUndefined();

    await app.close();
  });

  it("returns 422 (CEO_PLAN_EXECUTION_NOT_ELIGIBLE) when the plan is not yet delegated", async () => {
    const { app } = await buildApp();
    const parent = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validDeferredTaskBody({
        description: "Fix the login redirect.",
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      }),
    });
    const taskId = parent.json<CreateTaskResponseJson>().task.taskId;
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = created.json<{ plan: PlanJson }>();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "CEO_PLAN_EXECUTION_NOT_ELIGIBLE",
    );
    await app.close();
  });

  it("returns 404 (CEO_PLAN_NOT_FOUND) when configuring execution for an unknown planId", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ceo-plans/does-not-exist/execution/configure",
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CEO_PLAN_NOT_FOUND");
    await app.close();
  });

  it("returns 404 (CEO_PLAN_RUN_NOT_FOUND) for an unknown runId", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ceo-plan-runs/does-not-exist",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CEO_PLAN_RUN_NOT_FOUND");
    await app.close();
  });

  it("returns 409 (CEO_PLAN_RUN_TOKEN_INVALID) for a token from before a generation-bumping resume", async () => {
    const { app } = await buildApp();
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "autonomous", policy: DEFAULT_POLICY },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();

    // `pause` deliberately does not bump `activeGeneration` (see
    // `routes/ceo-plan-runs.ts`'s `issueRunToken` doc comment) — the
    // original token is still valid through start+pause. `resume` DOES
    // bump it, so the SAME original token is stale immediately afterward.
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/pause`,
      payload: { expectedMutationToken: mutationToken },
    });
    const firstResume = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/resume`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(firstResume.statusCode).toBe(200);

    const stalePause = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/pause`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(stalePause.statusCode).toBe(409);
    expect(stalePause.json<{ error: { code: string } }>().error.code).toBe(
      "CEO_PLAN_RUN_TOKEN_INVALID",
    );
    // The centralized error handler (`errors/error-handler.ts`) only ever
    // serializes `code`/`message`/`details` for a `HallCoreError` — this
    // proves that structural guarantee holds for a real ceo-execution error
    // response, not just for the emergency-stop success body checked below.
    expect(Object.keys(stalePause.json<{ error: object }>().error).sort()).toEqual([
      "code",
      "message",
    ]);
    const rawStalePause = JSON.stringify(stalePause.json());
    expect(rawStalePause).not.toContain(mutationToken);
    expect(rawStalePause.toLowerCase()).not.toContain(tempRoot.toLowerCase());
    await app.close();
  });

  it("emergency-stop: returns 202, requests cancellation for linked active tasks, and never exposes internal owner/lease/path fields", async () => {
    const { app } = await buildApp();
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "autonomous", policy: DEFAULT_POLICY },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/emergency-stop`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ result: { allSucceeded: boolean } } & Record<string, unknown>>();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ownerToken");
    expect(raw).not.toContain("claimLease");
    expect(raw).not.toContain("internalRevision");
    expect(raw.toLowerCase()).not.toContain(tempRoot.toLowerCase());
    await app.close();
  });

  it("POST .../steps/:stepId/retry: records a retry_step intervention, enqueues an operator_manual_retry signal, and rejects a step that isn't failed/awaiting_intervention", async () => {
    const { app, harness } = await buildApp();
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();
    const [firstStep] = harness.ceoExecution.planRunStore.listStepExecutions(run.id);
    if (!firstStep) throw new Error("expected at least one step execution");
    const stepId = firstStep.planStepId;

    // The step is freshly configured ("waiting_for_dependencies" or
    // "ready"), not yet failed — retry must be rejected.
    const tooEarly = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/steps/${stepId}/retry`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json<{ error: { code: string } }>().error.code).toBe(
      "CEO_PLAN_EXECUTION_STEP_RETRY_NOT_ELIGIBLE",
    );

    // `enqueueSignal` is a no-op for a non-"running" run, so start it
    // first — manual mode means this never auto-starts a child task.
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(started.statusCode).toBe(200);
    const { mutationToken: tokenAfterStart } = started.json<{ mutationToken: string }>();

    // Force the step into "failed" directly through the store — the
    // scheduler's own path to this state is covered by
    // ceo-plan-execution-scheduler.test.ts; this route test only needs
    // to verify the route's own contract (token check, eligibility
    // gate, intervention recorded, signal enqueued).
    harness.ceoExecution.planRunStore.upsertStepExecution({
      runId: run.id,
      planStepId: stepId,
      status: "failed",
      readinessReason: "adapter_ineligible",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
      lastFailureCode: "permanent",
    });

    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/steps/${stepId}/retry`,
      payload: { expectedMutationToken: tokenAfterStart },
    });
    expect(retried.statusCode).toBe(200);

    const interventions = harness.ceoExecution.planRunStore.listInterventions(run.id);
    expect(interventions.some((i) => i.type === "retry_step")).toBe(true);

    // Manual-mode runs are never claimed by `tick()` (see the
    // scheduler's own doc comment), so the signal this route enqueues
    // stays "pending" rather than being drained — this still proves the
    // route actually enqueued the retry signal rather than silently
    // doing nothing.
    const signalCounts = harness.ceoExecution.signalStore.countByState();
    expect(signalCounts.pending).toBeGreaterThan(0);

    await app.close();
  });

  it("POST .../steps/:stepId/retry: a step whose latest attempt is 'abandoned' (unclean-restart recovery) routes through the governed abandoned-recovery path over HTTP — Retry before Resume is rejected, Resume then Retry creates a genuine attempt 2 with a new task-run ID", async () => {
    // "cancellable"/5000ms — never completes on its own within this
    // test's lifetime, so the task is still genuinely "running" (a real
    // runId claimed) at the moment this test simulates the crash below,
    // exactly like `ceo-plan-execution-abandoned-retry.test.ts`'s own
    // harness does for the same reason.
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      mockAgentConfig: { scenario: "cancellable", stepDelayMs: 5000 },
    });
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: {
        executionMode: "autonomous",
        // The abandoned attempt itself counts toward `maxAttemptsPerStep`
        // (by design — see `retryAbandonedStep`'s own doc comment);
        // `DEFAULT_POLICY`'s value of 1 would leave no room for the
        // replacement attempt this test proves.
        policy: { ...DEFAULT_POLICY, maxAttemptsPerStep: 2 },
      },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();
    const [firstStep] = harness.ceoExecution.planRunStore.listStepExecutions(run.id);
    if (!firstStep) throw new Error("expected at least one step execution");
    const stepId = firstStep.planStepId;
    const taskId = firstStep.childTaskId;

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(started.statusCode).toBe(200);

    // Build the exact state unclean-restart recovery leaves behind — the
    // real `reconcileTasks()` (never a hand-rolled `taskStore.setCompleted`
    // call, which would leave `eventStore` out of sync and make the
    // later `prepareRetry()` reopen-check reject for a completely
    // different, wrong reason than the one this test means to exercise)
    // for the task side, and the same store-level primitives
    // `ceo-plan-execution-recovery.ts`'s unclean-restart branch uses for
    // the attempt/step/run side — mirroring
    // `ceo-plan-execution-abandoned-retry.test.ts`'s own harness pattern,
    // just driven over real HTTP here instead of directly against the
    // scheduler.
    const stepBeforeCrash = harness.ceoExecution.planRunStore.getStepExecution(run.id, stepId);
    const activeAttemptId = stepBeforeCrash.activeAttemptId;
    if (activeAttemptId === undefined) throw new Error("expected an active attempt");
    const taskRunIdBeforeCrash = harness.taskStore.get(taskId).runId;
    if (taskRunIdBeforeCrash === undefined) {
      throw new Error("expected the task to be genuinely running before the simulated crash");
    }
    reconcileTasks(harness.taskStore, harness.eventStore);
    expect(harness.taskStore.get(taskId).task.status).toBe("failed");
    expect(harness.taskStore.get(taskId).failure?.code).toBe(RESTART_INTERRUPTED_RUN_CODE);
    harness.ceoExecution.planRunStore.updateAttempt({
      attemptId: activeAttemptId,
      status: "abandoned",
      now: new Date().toISOString(),
    });
    harness.ceoExecution.planRunStore.upsertStepExecution({
      runId: run.id,
      planStepId: stepId,
      status: "awaiting_intervention",
      readinessReason: "operator_intervention",
      dependencySummary: stepBeforeCrash.dependencySummary,
    });
    harness.ceoExecution.planRunStore.recoveryPauseRun({
      runId: run.id,
      now: new Date().toISOString(),
      classification: "unclean_paused",
    });

    // Retry before Resume — the run is still "awaiting_intervention", not
    // "running" — is rejected, never a silent no-op, over HTTP.
    const tokenAfterPause = harness.ceoExecution.tokenIssuer.issue(
      run.id,
      harness.ceoExecution.planRunStore.getRun(run.id).activeGeneration,
    );
    const retryBeforeResume = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/steps/${stepId}/retry`,
      payload: { expectedMutationToken: tokenAfterPause },
    });
    expect(retryBeforeResume.statusCode).toBe(409);
    expect(retryBeforeResume.json<{ error: { code: string } }>().error.code).toBe(
      "CEO_PLAN_EXECUTION_ABANDONED_RETRY_NOT_ELIGIBLE",
    );
    expect(harness.ceoExecution.planRunStore.listAttempts(run.id, stepId)).toHaveLength(1);

    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/resume`,
      payload: { expectedMutationToken: tokenAfterPause },
    });
    expect(resumed.statusCode).toBe(200);
    const { mutationToken: tokenAfterResume } = resumed.json<{ mutationToken: string }>();
    // Resume alone starts nothing.
    expect(harness.ceoExecution.planRunStore.listAttempts(run.id, stepId)).toHaveLength(1);

    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/steps/${stepId}/retry`,
      payload: { expectedMutationToken: tokenAfterResume },
    });
    expect(retried.statusCode).toBe(200);

    const attemptsAfterRetry = harness.ceoExecution.planRunStore.listAttempts(run.id, stepId);
    expect(attemptsAfterRetry).toHaveLength(2);
    const [attempt1, attempt2] = attemptsAfterRetry;
    expect(attempt1?.status).toBe("abandoned");
    expect(attempt1?.taskRunId).toBe(taskRunIdBeforeCrash);
    expect(attempt2?.taskRunId).toBeDefined();
    expect(attempt2?.taskRunId).not.toBe(taskRunIdBeforeCrash);

    const interventions = harness.ceoExecution.planRunStore.listInterventions(run.id);
    expect(interventions.filter((i) => i.type === "retry_step")).toHaveLength(1);
    const events = harness.ceoExecution.planRunStore.listEvents(run.id);
    expect(events.filter((e) => e.type === "ceo.execution.retry_requested")).toHaveLength(1);

    await app.close();
  });

  it("returns 404 (CEO_PLAN_RUN_NOT_FOUND) when retrying a step on an unknown run", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ceo-plan-runs/does-not-exist/steps/some-step/retry",
      // A syntactically valid (43-char base64url) token is required to
      // pass body validation before the run lookup ever runs — this
      // confirms the run-lookup 404 fires ahead of a token-mismatch
      // 409, not that this specific token would ever verify.
      payload: { expectedMutationToken: "a".repeat(43) },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CEO_PLAN_RUN_NOT_FOUND");
    await app.close();
  });

  it("GET .../scheduler-status returns a bounded summary with no signal id, lease, owner token, or epoch", async () => {
    const { app } = await buildApp();
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "autonomous", policy: DEFAULT_POLICY },
    });
    const { run } = configured.json<{ run: RunJson }>();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plan-runs/${run.id}/scheduler-status`,
    });
    expect(response.statusCode).toBe(200);
    const raw = JSON.stringify(response.json());
    expect(raw).not.toContain("ownerToken");
    expect(raw).not.toContain("claimLease");
    expect(raw).not.toContain("signalId");
    await app.close();
  });

  it("GET /api/v1/ceo-plan-runs lists every configured run, including ones from other plans", async () => {
    const { app } = await buildApp();
    const planIdA = await delegatePlan(app);
    const planIdB = await delegatePlan(app);
    const configuredA = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planIdA}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    const configuredB = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planIdB}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    const runIdA = configuredA.json<{ run: RunJson }>().run.id;
    const runIdB = configuredB.json<{ run: RunJson }>().run.id;

    const response = await app.inject({ method: "GET", url: "/api/v1/ceo-plan-runs" });
    expect(response.statusCode).toBe(200);
    const ids = response.json<{ runs: readonly RunJson[] }>().runs.map((r) => r.id);
    expect(ids).toContain(runIdA);
    expect(ids).toContain(runIdB);
    await app.close();
  });

  it("returns 400 for a policy value outside its declared bounds (maxConcurrentSteps: 0)", async () => {
    const { app } = await buildApp();
    const planId = await delegatePlan(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: {
        executionMode: "manual",
        policy: { ...DEFAULT_POLICY, maxConcurrentSteps: 0 },
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 400 (never 500) for a configure request carrying an unexpected extra field — every request schema is `.strict()`", async () => {
    const { app } = await buildApp();
    const planId = await delegatePlan(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: {
        executionMode: "manual",
        policy: DEFAULT_POLICY,
        actor: "human:local-operator",
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 (CEO_PLAN_RUN_NOT_FOUND) when retrying an unknown step on a real, known run", async () => {
    const { app } = await buildApp();
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/steps/does-not-exist/retry`,
      payload: { expectedMutationToken: mutationToken },
    });
    // The step lookup itself throws `CeoPlanRunNotFoundError` for an
    // unrecognized step id — same error class/code the unknown-run case
    // uses, since a step is only ever addressed through its owning run.
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("a second Start on an already-running run is rejected, never silently re-starts it", async () => {
    const { app } = await buildApp();
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    // The run is no longer "configured" (the only status `startRun`
    // accepts), so a second call with the same pre-start token 409s —
    // never a silent no-op success and never a duplicate start.
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it("duplicate manual-retry requests for the same failed step coalesce into exactly one pending signal, never two", async () => {
    const { app, harness } = await buildApp();
    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();
    const [firstStep] = harness.ceoExecution.planRunStore.listStepExecutions(run.id);
    if (!firstStep) throw new Error("expected at least one step execution");
    const stepId = firstStep.planStepId;

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    const { mutationToken: tokenAfterStart } = started.json<{ mutationToken: string }>();

    harness.ceoExecution.planRunStore.upsertStepExecution({
      runId: run.id,
      planStepId: stepId,
      status: "failed",
      readinessReason: "adapter_ineligible",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
      lastFailureCode: "permanent",
    });

    const retryPayload = { expectedMutationToken: tokenAfterStart };
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/ceo-plan-runs/${run.id}/steps/${stepId}/retry`,
        payload: retryPayload,
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/ceo-plan-runs/${run.id}/steps/${stepId}/retry`,
        payload: retryPayload,
      }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    // Manual mode never drains signals (see the scheduler's own doc
    // comment), so both retry signals are still sitting in the store —
    // proving the coalescing key (`planRunId`+`planStepId`+`generation`)
    // merged them into exactly one pending signal, never two.
    const pendingForStep = harness.ceoExecution.signalStore
      .listSignalsForRun(run.id)
      .filter((s) => s.planStepId === stepId && s.state === "pending");
    expect(pendingForStep).toHaveLength(1);
    await app.close();
  });

  it("a mutation attempted after this instance's durable ownership fence has been superseded returns 503 OWNERSHIP_LOST, never a false success", async () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    const staleFence = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(staleFence);

    const composition = createServerComposition({
      workspaceRoot: tempRoot,
      mockScenario: "success",
      mockStepDelayMs: 0,
      limits: DEFAULT_LIMITS,
      db,
      agentWorktreeRoot: path.join(tempRoot, "agent-worktrees"),
    });
    composition.activateAutonomousScheduling();
    const app = await createHallCoreApp({
      orchestrator: composition.orchestrator,
      taskStore: composition.taskStore,
      eventStore: composition.eventStore,
      eventBus: composition.eventBus,
      boardStore: composition.boardStore,
      messageStore: composition.messageStore,
      messageBus: composition.messageBus,
      attachmentStore: composition.attachmentStore,
      attachmentBlobStore: composition.attachmentBlobStore,
      registry: composition.registry,
      limits: DEFAULT_LIMITS,
      ceoPlanOrchestrator: composition.ceoPlans.orchestrator,
      ceoExecution: composition.ceoExecution,
      logger: false,
      storageMode: "durable",
      authentication: false,
    });

    const planId = await delegatePlan(app);
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${planId}/execution/configure`,
      payload: { executionMode: "manual", policy: DEFAULT_POLICY },
    });
    // The configure call itself already ran under the (still current at
    // that point) stale fence and succeeded — ownership is taken over
    // strictly AFTER, so this proves the fence is re-checked on every
    // subsequent write, not just once at startup.
    expect(configured.statusCode).toBe(201);
    const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();

    // A second instance legitimately takes over — `db.ownershipFence` on
    // THIS still-open connection is deliberately never updated, exactly
    // matching a real frozen process that never re-reads it (see
    // `ceo-plan-execution-ownership-fencing.test.ts`'s own doc comment).
    acquireDatabaseEpoch(db, "owner-b");

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${run.id}/start`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(started.statusCode).toBe(503);
    expect(started.json<{ error: { code: string } }>().error.code).toBe("OWNERSHIP_LOST");
    // No partial state: the run is still exactly "configured", never
    // "running".
    const stillConfigured = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plan-runs/${run.id}`,
    });
    expect(stillConfigured.json<{ run: RunJson }>().run.status).toBe("configured");

    await app.close();
    db.close();
  });
});
