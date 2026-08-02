import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type { AgentAdapter, AgentDetectionResult } from "@hall-of-wisdom/agent-adapter-sdk";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { waitUntil } from "../test-support.js";
import { createEphemeralAtomicUnit } from "../ceo-plans/ephemeral-atomic-unit.js";
import { InMemoryCeoPlanRunStore } from "./in-memory-ceo-plan-run-store.js";
import { InMemoryExecutionSignalStore } from "./in-memory-execution-signal-store.js";
import { CeoPlanExecutionScheduler } from "./ceo-plan-execution-scheduler.js";

const WORKSPACE_ROOT = process.cwd();
const NOW = "2026-08-02T12:00:00.000Z";

/**
 * Phase 15.7 — security-matrix scenario 28 ("Raw stderr leakage"),
 * CEO-execution half. The plain-task REST/WebSocket half lives in
 * `../routes/stderr-leakage.test.ts` — both exercise the exact same
 * underlying mechanism (`TaskOrchestrator#failTaskOnUnhandledExecutionError`),
 * which the scheduler's own launch path (`#tryAdvanceStep` ->
 * `TaskOrchestrator.startTask()`) reuses unchanged; this file additionally
 * proves the marker never reaches a CEO plan run's own detail projection,
 * its durable execution-event log, or the dedup-gated Board summary a
 * permanent-failure pause posts.
 */
const PRIVATE_STDERR_MARKER = "PHASE15_PRIVATE_STDERR_MUST_NOT_LEAK";
const STDERR_LEAK_ADAPTER_ID = "hall.stderr-leak-fixture";

function createStderrLeakAdapter(): AgentAdapter {
  return {
    descriptor: {
      adapterId: STDERR_LEAK_ADAPTER_ID,
      displayName: "Stderr Leak Fixture",
      adapterVersion: "0.0.0",
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      supportedAgent: {
        agentId: "stderr-leak-agent",
        displayName: "Stderr Leak Fixture",
        adapterId: STDERR_LEAK_ADAPTER_ID,
        adapterVersion: "0.0.0",
      },
      capabilities: {
        streaming: true,
        cancellation: true,
        sessionResume: false,
        toolEvents: true,
        fileEditing: false,
        shellExecution: false,
        subagents: false,
        mcp: false,
        acp: false,
      },
      declaredCapabilities: [],
    },
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve({
        installed: true,
        availability: "available",
        executionTrust: "simulated",
      });
    },
    startTask(): Promise<never> {
      return Promise.reject(
        new Error(
          `spawn failed: fatal: could not start provider process: ${PRIVATE_STDERR_MARKER} (exit code 127)`,
        ),
      );
    },
  };
}

function buildHarness(boardAuditLog: string[]) {
  const registry = new AgentRegistry();
  registry.register(createStderrLeakAdapter());
  const taskStore = new TaskStore({ maxTasks: 100 });
  const eventStore = new EventStore({ maxEventsPerTask: 1000 });
  const eventBus = new EventBus({ maxSubscribersPerTask: 20 });
  const taskOrchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot: WORKSPACE_ROOT,
  });
  const planRunStore = new InMemoryCeoPlanRunStore();
  const signalStore = new InMemoryExecutionSignalStore();
  const scheduler = new CeoPlanExecutionScheduler({
    planRunStore,
    signalStore,
    taskStore,
    taskOrchestrator,
    now: () => NOW,
    ownerToken: "owner-1",
    leaseSeconds: 30,
    postBoardAudit: (_planId, text) => boardAuditLog.push(text),
    runAtomicUnit: createEphemeralAtomicUnit({ planRunStore, signalStore }),
  });
  return { taskStore, taskOrchestrator, planRunStore, signalStore, scheduler };
}

describe("Security matrix scenario 28 — raw stderr leakage (CEO plan execution)", () => {
  it("a step assigned to a fixture adapter that throws with a private stderr marker never leaks that marker into the run detail, step executions, attempts, durable execution events, or the permanent-failure Board summary", async () => {
    const boardAuditLog: string[] = [];
    const harness = buildHarness(boardAuditLog);

    harness.taskStore.add({
      task: {
        taskId: "task-a",
        projectId: "project-1",
        title: "Task task-a",
        description: "A step delegated by a CEO plan.",
        priority: "normal",
        status: "assigned",
        dependencyTaskIds: [],
        createdAt: NOW,
        updatedAt: NOW,
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      },
      runId: undefined,
      adapterId: STDERR_LEAK_ADAPTER_ID,
      agentId: "stderr-leak-agent",
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: NOW,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: "simulated",
    });

    harness.planRunStore.configureRun({
      runId: "run-1",
      planId: "plan-1",
      planVersion: 1,
      executionMode: "autonomous",
      // pauseOnAnyPermanentFailure ensures the fixed, bounded
      // "Autonomous execution paused..." Board summary is actually
      // exercised by this test, not merely reachable in theory.
      policy: { ...DEFAULT_CEO_PLAN_EXECUTION_POLICY, pauseOnAnyPermanentFailure: true },
      now: NOW,
      steps: [{ stepId: "step-a", childTaskId: "task-a", dependencyStepIds: [] }],
    });
    harness.scheduler.registerDependencyIndex("run-1", [{ id: "step-a", dependencies: [] }]);
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });

    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    await waitUntil(() => harness.planRunStore.getRun("run-1").status === "awaiting_intervention");

    // Run detail.
    const run = harness.planRunStore.getRun("run-1");
    expect(JSON.stringify(run)).not.toContain(PRIVATE_STDERR_MARKER);

    // Step executions.
    const stepExecutions = harness.planRunStore.listStepExecutions("run-1");
    expect(JSON.stringify(stepExecutions)).not.toContain(PRIVATE_STDERR_MARKER);
    // The step execution stores the bounded CLASSIFICATION ("permanent"),
    // never the raw task-level failure code or message.
    expect(stepExecutions[0]?.lastFailureCode).toBe("permanent");

    // Attempts.
    const attempts = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(JSON.stringify(attempts)).not.toContain(PRIVATE_STDERR_MARKER);

    // Durable execution events.
    const events = harness.planRunStore.listEvents("run-1");
    expect(JSON.stringify(events)).not.toContain(PRIVATE_STDERR_MARKER);

    // Board summary — fixed, bounded text only; the permanent-failure
    // pause path never embeds any per-failure detail at all.
    expect(boardAuditLog.length).toBeGreaterThan(0);
    for (const message of boardAuditLog) {
      expect(message).not.toContain(PRIVATE_STDERR_MARKER);
    }
    expect(boardAuditLog).toContain("Autonomous execution paused and requires operator attention.");

    // The underlying task's own failure projection, one more time from
    // the CEO-execution vantage point.
    const taskRecord = harness.taskStore.get("task-a");
    expect(JSON.stringify(taskRecord)).not.toContain(PRIVATE_STDERR_MARKER);
    expect(taskRecord.failure?.code).toBe("TASK_EXECUTION_FAILED");
    expect(taskRecord.failure?.message).toBe(
      "Hall Core could not complete this task due to an unexpected internal error.",
    );
  });
});
