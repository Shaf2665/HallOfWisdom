import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  parseAgentAdapterDescriptor,
  type AgentAdapter,
  type AgentAdapterDescriptor,
  type AgentDetectionResult,
  type AvailabilityStatus,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import type {
  CapabilityObservation,
  ExecutionTrust,
  TaskRequirements,
} from "@hall-of-wisdom/protocol";
import { TaskStore } from "./task-store.js";
import { TaskOrchestrator, type StartTaskResult } from "./task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import {
  AdapterRequirementsMismatchError,
  AdapterUnavailableError,
  TaskStateConflictError,
  WorkspaceValidationFailedError,
} from "../errors/app-error.js";
import { buildTestApp, waitUntil } from "../test-support.js";

/**
 * Proves `TaskOrchestrator.startTask()`'s launch-time-eligibility TOCTOU
 * guard (see that method's own doc comment, ~task-orchestrator.ts line
 * 288) actually closes the race it claims to: `preCheck` snapshots task
 * state, `await adapter.detect()` runs (an interruption window Node can
 * run arbitrary other code during), then `TaskStore.startIfEligible()`
 * atomically re-validates the ENTIRE snapshot — revision plus the
 * four-field `status`/`runId`/`adapterId`/`agentId` struct — against the
 * store's live state, rejecting on any drift.
 *
 * Covers kickoff scenarios 1-12, 14, 15. Scenarios 13 (autonomous
 * scheduler entry point) and 16 (frozen durable owner) live in
 * `task-orchestrator-launch-toctou-entrypoints.test.ts` — both need a
 * materially different harness (a `CeoPlanExecutionScheduler` and a
 * SQLite-backed, ownership-fenced `SqliteTaskStore` respectively) that
 * would only dilute this file's shared `buildRaceHarness`/barrier-adapter
 * setup.
 *
 * Every "rejected" scenario below asserts the same shared safety
 * envelope: the adapter's `startTask()` is never called (0 calls — no
 * provider process, real or simulated, ever starts), no event is ever
 * recorded for the task, the task never reaches `"running"`, and the
 * thrown error is one of the already-safe `HallCoreError` subclasses with
 * an EXACT, fixed message — never a raw revision number, database path,
 * or absolute working-directory path. Exact-string assertions (not
 * `.not.toContain(...)`) are used deliberately: a substring-absence check
 * against a UUID task id is not a reliable leak detector (UUIDs contain
 * digits that can coincidentally match a revision number).
 */

const BASE_NOW = "2026-07-31T12:00:00.000Z";

const DEFAULT_CAPABILITY_OBSERVATIONS: readonly CapabilityObservation[] = [
  {
    capability: "project.read",
    status: "verified",
    safeSummary: "Verified by the barrier adapter fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "project.edit",
    status: "verified",
    safeSummary: "Verified by the barrier adapter fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "cancellation",
    status: "verified",
    safeSummary: "Verified by the barrier adapter fixture.",
    evidence: "deterministic_test",
  },
];

interface BarrierReleaseOverrides {
  readonly availability?: AvailabilityStatus;
  readonly executionTrust?: ExecutionTrust;
  readonly capabilityObservations?: readonly CapabilityObservation[];
}

interface BarrierAdapterController {
  readonly parkedCount: number;
  readonly startTaskCallCount: number;
  waitForParked(count: number, timeoutMs?: number): Promise<void>;
  release(overrides?: BarrierReleaseOverrides): void;
}

/**
 * A locally-built barrier `AgentAdapter`, deliberately NOT a reuse of
 * `test-support.ts`'s shared `createGatedAdapter` — that helper's
 * `release()` only accepts `availability` (no `executionTrust`/
 * `capabilityObservations`, both needed for scenarios 3/4/14/15 below),
 * and its `startTask()` always rejects (scenario 1 needs a genuinely
 * successful end-to-end run). `detect()` parks every call until
 * `release()` resolves it (or all currently-parked calls, on a shared
 * `release()`); `startTask()` delegates to a real `MockAgentAdapter`
 * instance so a successful launch can actually reach `"completed"`.
 */
function createBarrierAdapter(adapterId = "hall.barrier-agent"): {
  adapter: AgentAdapter;
  controller: BarrierAdapterController;
} {
  const delegate = new MockAgentAdapter({ scenario: "success", stepDelayMs: 0 });
  // Both the top-level descriptor fields AND `supportedAgent`'s must be
  // overridden together — a half-overridden descriptor (adapterId changed
  // but supportedAgent.agentId left as the delegate's own) is exactly the
  // regression `apps/e2e/src/fixture-adapters.ts`'s `withAdapterId` doc
  // comment warns about.
  const descriptor: AgentAdapterDescriptor = parseAgentAdapterDescriptor({
    ...delegate.descriptor,
    adapterId,
    displayName: "Barrier Test Agent",
    supportedAgent: {
      ...delegate.descriptor.supportedAgent,
      adapterId,
      agentId: adapterId,
      displayName: "Barrier Test Agent",
    },
  });

  let parked = 0;
  let releasers: ((result: AgentDetectionResult) => void)[] = [];
  let startTaskCallCount = 0;

  const controller: BarrierAdapterController = {
    get parkedCount() {
      return parked;
    },
    get startTaskCallCount() {
      return startTaskCallCount;
    },
    async waitForParked(count, timeoutMs = 2000) {
      const start = Date.now();
      while (parked < count) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `BarrierAdapterController.waitForParked: only ${String(parked)}/${String(count)} detect() calls parked within ${String(timeoutMs)}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    release(overrides = {}) {
      const toRelease = releasers;
      releasers = [];
      parked -= toRelease.length;
      for (const resolve of toRelease) {
        resolve({
          installed: true,
          availability: overrides.availability ?? "available",
          executionTrust: overrides.executionTrust ?? "isolated",
          capabilityObservations: [
            ...(overrides.capabilityObservations ?? DEFAULT_CAPABILITY_OBSERVATIONS),
          ],
        });
      }
    },
  };

  const adapter: AgentAdapter = {
    descriptor,
    detect(): Promise<AgentDetectionResult> {
      parked += 1;
      return new Promise((resolve) => {
        releasers.push(resolve);
      });
    },
    startTask(input, options) {
      startTaskCallCount += 1;
      return delegate.startTask(input, options);
    },
  };

  return { adapter, controller };
}

/** Directly seeds an already-`"assigned"`, not-yet-started task — bypasses `assignTask()` entirely, exactly like the same-named helper in `ceo-plan-execution-circuit-breaker-semantics.test.ts`, so each scenario's setup is a single synchronous call with no `detect()` gate of its own to manage. */
function addAssignedTask(
  taskStore: TaskStore,
  input: {
    readonly taskId: string;
    readonly adapterId: string;
    readonly agentId: string;
    readonly requirements?: TaskRequirements;
  },
): void {
  taskStore.add({
    task: {
      taskId: input.taskId,
      projectId: "project-1",
      title: `Task ${input.taskId}`,
      description: "A launch-time TOCTOU fixture task.",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
      ...(input.requirements !== undefined ? { requirements: input.requirements } : {}),
    },
    runId: undefined,
    adapterId: input.adapterId,
    agentId: input.agentId,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: BASE_NOW,
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: "isolated",
  });
}

interface RaceHarness {
  readonly orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
}

function buildRaceHarness(options: {
  readonly workspaceRoot: string;
  readonly adapters: readonly AgentAdapter[];
}): RaceHarness {
  const registry = new AgentRegistry();
  for (const adapter of options.adapters) registry.register(adapter);
  const taskStore = new TaskStore({ maxTasks: 100 });
  const eventStore = new EventStore({ maxEventsPerTask: 1000 });
  const eventBus = new EventBus({ maxSubscribersPerTask: 20 });
  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot: options.workspaceRoot,
  });
  return { orchestrator, taskStore, eventStore, eventBus };
}

type Settled = { readonly ok: StartTaskResult } | { readonly err: unknown };

/** Captures `startTask()`'s eventual settlement into a plain value BEFORE releasing the barrier, so no unhandled-rejection can ever occur regardless of scheduling — see this file's floating-promise-hygiene note. */
function settleStartTask(orchestrator: TaskOrchestrator, taskId: string): Promise<Settled> {
  return orchestrator.startTask(taskId).then(
    (result): Settled => ({ ok: result }),
    (error: unknown): Settled => ({ err: error }),
  );
}

function expectRejected(outcome: Settled): unknown {
  if (!("err" in outcome)) {
    throw new Error(`expected startTask() to reject, but it resolved: ${JSON.stringify(outcome)}`);
  }
  return outcome.err;
}

function startConflictMessage(taskId: string, status: string): string {
  return `Task "${taskId}" cannot be started while in status "${status}".`;
}

function unavailableMessage(adapterId: string, availability: string): string {
  return `Adapter "${adapterId}" is not available (status "${availability}").`;
}

const REQUIREMENTS_MISMATCH_MESSAGE =
  "The selected adapter does not satisfy this task's requirements.";
const WORKSPACE_INVALID_MESSAGE =
  "workingDirectory must resolve to the configured workspace root or a descendant of it.";

describe("TaskOrchestrator.startTask() — launch-time-eligibility TOCTOU guard", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-launch-toctou-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("1. normal eligible task starts, reaches running, and completes — the baseline no-mutation case", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-baseline";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
      requirements: {
        requiredCapabilities: ["project.read", "cancellation"],
        allowedExecutionTrust: ["isolated"],
      },
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    barrier.controller.release();
    const outcome = await settled;

    if (!("ok" in outcome)) {
      throw new Error(`expected startTask() to succeed, got rejection: ${String(outcome.err)}`);
    }
    expect(outcome.ok.runId).toBeTruthy();
    expect(taskStore.get(taskId).runId).toBe(outcome.ok.runId);

    // `TaskOrchestrator.startTask()`'s own eligibility `detect()` (just
    // released above) is NOT the only call this run makes against the
    // adapter: `#beginExecution()` kicks off `#execute()` fire-and-forget
    // on the next microtask after `startTask()` itself already resolved,
    // and hall-runner's own `runTask()` (runners/hall-runner/src/runner-service.ts)
    // performs a SECOND, independent `detect()` preflight against the
    // same adapter instance immediately before actually starting the run
    // — a real, legitimate second call this barrier adapter also parks,
    // not a bug. Release it too before the run can make any further
    // progress.
    await barrier.controller.waitForParked(1);
    barrier.controller.release();

    await waitUntil(() => taskStore.get(taskId).task.status === "completed");
    expect(taskStore.get(taskId).task.status).toBe("completed");
    expect(barrier.controller.startTaskCallCount).toBe(1);
    expect(barrier.controller.parkedCount).toBe(0);
  });

  it("2. adapter becomes unavailable — detect() itself resolves unavailable, rejects with AdapterUnavailableError", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-unavailable";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    barrier.controller.release({ availability: "unavailable" });
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(AdapterUnavailableError);
    expect((error as Error).message).toBe(unavailableMessage("hall.barrier-agent", "unavailable"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).lastSequence).toBeUndefined();
    expect(taskStore.get(taskId).task.status).toBe("assigned");
    expect(taskStore.get(taskId).runId).toBeUndefined();
    expect(barrier.controller.parkedCount).toBe(0);
  });

  it("3. capability evidence degrades — required capability is missing from detect()'s observations, rejects with AdapterRequirementsMismatchError", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-capability-degrade";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
      requirements: { requiredCapabilities: ["project.edit"], allowedExecutionTrust: ["isolated"] },
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    barrier.controller.release({
      capabilityObservations: [
        {
          capability: "project.read",
          status: "verified",
          safeSummary: "Only project.read verified — project.edit degraded away.",
          evidence: "deterministic_test",
        },
      ],
    });
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(AdapterRequirementsMismatchError);
    expect((error as Error).message).toBe(REQUIREMENTS_MISMATCH_MESSAGE);
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).task.status).toBe("assigned");
  });

  it("4. execution trust degrades — detect() resolves a trust not in allowedExecutionTrust, rejects with AdapterRequirementsMismatchError", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-trust-degrade";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["trusted_local"] },
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    barrier.controller.release({ executionTrust: "isolated" });
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(AdapterRequirementsMismatchError);
    expect((error as Error).message).toBe(REQUIREMENTS_MISMATCH_MESSAGE);
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
  });

  it("5. task requirements change concurrently — stale eligibility would still pass, but the store's revision check still rejects with TaskStateConflictError (not AdapterRequirementsMismatchError)", async () => {
    // There is no direct "setRequirements" mutator anywhere in
    // `TaskStorePort` — per `startTask()`'s own doc comment, "any
    // concurrent change to requirements always goes through
    // `assignIfEligible()`, which always bumps revision." This test
    // exercises that exact production path directly against the store (a
    // stand-in for a concurrent reassignment request), keeping
    // adapterId/agentId/status/runId all identical so requirements +
    // revision are the ONLY things that change — isolating this scenario
    // from scenarios 6-10 below, which each vary a different field.
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-requirements-change";
    const requirementsBefore: TaskRequirements = {
      requiredCapabilities: ["project.read"],
      allowedExecutionTrust: ["isolated"],
    };
    const requirementsAfter: TaskRequirements = {
      requiredCapabilities: ["command.execute"],
      allowedExecutionTrust: ["isolated"],
    };
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
      requirements: requirementsBefore,
    });
    const before = taskStore.get(taskId);
    const revisionBefore = taskStore.getRevision(taskId);

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    taskStore.assignIfEligible(
      taskId,
      revisionBefore,
      {
        status: before.task.status,
        runId: before.runId,
        adapterId: before.adapterId,
        agentId: before.agentId,
      },
      {
        adapterId: "hall.barrier-agent",
        agentId: "hall.barrier-agent",
        executionTrust: "isolated",
        requirements: requirementsAfter,
      },
    );
    expect(taskStore.get(taskId).task.requirements).toEqual(requirementsAfter);
    // The barrier's release satisfies the STALE (pre-mutation)
    // requirements — if `startTask()` re-evaluated eligibility against a
    // freshly-read `requirements`, this release would still look
    // eligible. It must be caught anyway, by revision, not by a
    // (never-run) second eligibility check.
    barrier.controller.release({
      capabilityObservations: [
        {
          capability: "project.read",
          status: "verified",
          safeSummary: "Satisfies the stale, pre-mutation requirements only.",
          evidence: "deterministic_test",
        },
      ],
    });
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(TaskStateConflictError);
    expect(error).not.toBeInstanceOf(AdapterRequirementsMismatchError);
    expect((error as Error).message).toBe(startConflictMessage(taskId, "assigned"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).task.status).toBe("assigned");
    expect(taskStore.get(taskId).runId).toBeUndefined();
  });

  it("6. task status changes concurrently (e.g. moved to blocked) — rejects with TaskStateConflictError reporting the live status", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-status-change";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    taskStore.updateStatus(taskId, "blocked");
    barrier.controller.release();
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(TaskStateConflictError);
    expect((error as Error).message).toBe(startConflictMessage(taskId, "blocked"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).task.status).toBe("blocked");
    expect(taskStore.get(taskId).runId).toBeUndefined();
  });

  it("7. assigned adapter changes concurrently (reassignment races the launch) — rejects, and the winning reassignment's adapterId is preserved untouched", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-adapter-change";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });
    const before = taskStore.get(taskId);
    const revisionBefore = taskStore.getRevision(taskId);

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    taskStore.assignIfEligible(
      taskId,
      revisionBefore,
      {
        status: before.task.status,
        runId: before.runId,
        adapterId: before.adapterId,
        agentId: before.agentId,
      },
      { adapterId: "hall.other-adapter", agentId: "other-agent", executionTrust: "isolated" },
    );
    barrier.controller.release();
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(TaskStateConflictError);
    expect((error as Error).message).toBe(startConflictMessage(taskId, "assigned"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    // No adapter substitution BY THE LOSING REQUEST: the final adapterId
    // is exactly the winning reassignment's own value, not the original
    // barrier adapter and not some third value.
    expect(taskStore.get(taskId).adapterId).toBe("hall.other-adapter");
    expect(taskStore.get(taskId).agentId).toBe("other-agent");
    expect(taskStore.get(taskId).runId).toBeUndefined();
  });

  it("8. assigned agent changes concurrently (same adapter, different agent identity) — rejects, and the winning reassignment's agentId is preserved untouched", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-agent-change";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });
    const before = taskStore.get(taskId);
    const revisionBefore = taskStore.getRevision(taskId);

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    taskStore.assignIfEligible(
      taskId,
      revisionBefore,
      {
        status: before.task.status,
        runId: before.runId,
        adapterId: before.adapterId,
        agentId: before.agentId,
      },
      {
        adapterId: "hall.barrier-agent",
        agentId: "a-different-agent-identity",
        executionTrust: "isolated",
      },
    );
    barrier.controller.release();
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(TaskStateConflictError);
    expect((error as Error).message).toBe(startConflictMessage(taskId, "assigned"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).adapterId).toBe("hall.barrier-agent");
    expect(taskStore.get(taskId).agentId).toBe("a-different-agent-identity");
    expect(taskStore.get(taskId).runId).toBeUndefined();
  });

  it("9. ABA: revision moves through assigned -> blocked -> ready -> assigned while status/runId/adapterId/agentId all return to their original values — still rejects, because the guard is revision-gated, not field-gated", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-aba";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });
    const before = taskStore.get(taskId);
    const revisionBefore = taskStore.getRevision(taskId);

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    taskStore.updateStatus(taskId, "blocked");
    taskStore.updateStatus(taskId, "ready");
    taskStore.updateStatus(taskId, "assigned");
    const afterMutations = taskStore.get(taskId);
    const revisionAfterMutations = taskStore.getRevision(taskId);

    // The ABA proof itself, BEFORE releasing the barrier: every
    // four-field-compare-visible field is back to its original value...
    expect(afterMutations.task.status).toBe(before.task.status);
    expect(afterMutations.runId).toBe(before.runId);
    expect(afterMutations.adapterId).toBe(before.adapterId);
    expect(afterMutations.agentId).toBe(before.agentId);
    // ...yet the monotonic revision counter still moved by exactly the 3
    // real mutations that happened, proving revision (not a same-shape
    // four-field compare, which a naive implementation could satisfy
    // here) is what a stale caller is actually checked against.
    expect(revisionAfterMutations).toBe(revisionBefore + 3);

    barrier.controller.release();
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(TaskStateConflictError);
    expect((error as Error).message).toBe(startConflictMessage(taskId, "assigned"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    // The rejection must not have silently bumped revision again.
    expect(taskStore.getRevision(taskId)).toBe(revisionAfterMutations);
  });

  it("10. another run ID appears concurrently (a second, winning start already claimed a runId) — rejects, and the winner's runId is untouched by the loser", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-runid-appears";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });
    const before = taskStore.get(taskId);
    const revisionBefore = taskStore.getRevision(taskId);

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    const winner = taskStore.startIfEligible(
      taskId,
      revisionBefore,
      {
        status: before.task.status,
        runId: before.runId,
        adapterId: before.adapterId,
        agentId: before.agentId,
      },
      "run-concurrent-winner",
    );
    expect(winner.runId).toBe("run-concurrent-winner");
    barrier.controller.release();
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(TaskStateConflictError);
    expect((error as Error).message).toBe(startConflictMessage(taskId, "assigned"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).runId).toBe("run-concurrent-winner");
    expect(taskStore.get(taskId).adapterId).toBe("hall.barrier-agent");
  });

  it("11. working directory becomes invalid while detect() is pending (workspace root removed from disk) — rejects with WorkspaceValidationFailedError, message never leaks the path", async () => {
    // `#resolveWorkingDirectory()` (`task-orchestrator.ts`) is only ever
    // reached with `undefined` (falling through to `.` resolved against
    // the configured workspace root) when no earlier `assignTask()` call
    // cached a validated `workingDirectory` for this task — exactly the
    // case here, since `addAssignedTask()` seeds the record directly.
    // `validateWorkspace()` (`runners/hall-runner`) requires the resolved
    // path to actually exist on disk (`fs.realpathSync.native`), so
    // deleting the configured root between the `detect()` snapshot and
    // this synchronous post-`detect()` resolution reproduces a genuine
    // TOCTOU failure at this specific guard step.
    const raceRoot = path.join(tempRoot, "race-workspace-11");
    fs.mkdirSync(raceRoot, { recursive: true });
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: raceRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-workspace-invalid";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    fs.rmSync(raceRoot, { recursive: true, force: true });
    barrier.controller.release();
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(WorkspaceValidationFailedError);
    expect((error as Error).message).toBe(WORKSPACE_INVALID_MESSAGE);
    expect((error as Error).message).not.toContain(raceRoot);
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).task.status).toBe("assigned");
    expect(taskStore.get(taskId).runId).toBeUndefined();
  });

  it("12. manual start (POST /api/v1/tasks/:taskId/start) goes through the SAME startIfEligible guard, not a separate weaker path", async () => {
    // `routes/tasks.ts`'s `/start` handler is a direct, no-extra-logic
    // passthrough: `const { task } = await deps.orchestrator.startTask(request.params.taskId);`
    // — this test exercises the real HTTP route (not a direct call to
    // `TaskOrchestrator`) so the proof covers the actual "human clicks
    // Start" entry point end-to-end, including Fastify's own error-handler
    // mapping of the thrown `TaskStateConflictError` to a bounded 409.
    const barrier = createBarrierAdapter();
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [barrier.adapter],
    });
    const taskId = "task-toctou-manual-start";
    addAssignedTask(harness.taskStore as TaskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
    });

    const startResponse = app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/start`,
    });
    await barrier.controller.waitForParked(1);
    harness.taskStore.updateStatus(taskId, "blocked");
    barrier.controller.release();
    const response = await startResponse;

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("TASK_STATE_CONFLICT");
    expect(body.error.message).toBe(startConflictMessage(taskId, "blocked"));
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(harness.taskStore.get(taskId).task.status).toBe("blocked");
    expect(harness.taskStore.get(taskId).runId).toBeUndefined();
    await app.close();
  });

  it("14. trusted-local is rejected for isolated-only requirements", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-isolated-only";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["isolated"] },
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    barrier.controller.release({ executionTrust: "trusted_local" });
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(AdapterRequirementsMismatchError);
    expect((error as Error).message).toBe(REQUIREMENTS_MISMATCH_MESSAGE);
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).task.status).toBe("assigned");
  });

  it("15. simulated execution is rejected when simulation is forbidden", async () => {
    const barrier = createBarrierAdapter();
    const { orchestrator, taskStore, eventStore } = buildRaceHarness({
      workspaceRoot: tempRoot,
      adapters: [barrier.adapter],
    });
    const taskId = "task-toctou-simulation-forbidden";
    addAssignedTask(taskStore, {
      taskId,
      adapterId: "hall.barrier-agent",
      agentId: "hall.barrier-agent",
      requirements: {
        requiredCapabilities: [],
        allowedExecutionTrust: ["isolated", "trusted_local"],
      },
    });

    const settled = settleStartTask(orchestrator, taskId);
    await barrier.controller.waitForParked(1);
    barrier.controller.release({ executionTrust: "simulated" });
    const error = expectRejected(await settled);

    expect(error).toBeInstanceOf(AdapterRequirementsMismatchError);
    expect((error as Error).message).toBe(REQUIREMENTS_MISMATCH_MESSAGE);
    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    expect(taskStore.get(taskId).task.status).toBe("assigned");
  });
});
