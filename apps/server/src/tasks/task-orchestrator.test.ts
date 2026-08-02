import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import {
  EventFactory,
  type AgentAdapter,
  type AgentTaskInput,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { parseNormalizedAgentEvent, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { TaskStore } from "./task-store.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import {
  AdapterNotFoundError,
  InvalidRequestError,
  TaskStateConflictError,
  WorkspaceValidationFailedError,
} from "../errors/app-error.js";
import { validCreateTaskBody, waitUntil } from "../test-support.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { SqliteTaskStore } from "./sqlite-task-store.js";
import { SqliteEventStore } from "../events/sqlite-event-store.js";

/**
 * A deliberately non-cooperative fake adapter: its generator never checks
 * `signal.aborted` and keeps producing events regardless of what Hall Core
 * decided about an earlier one. Used only to prove Hall Core's own
 * `EventStore`/`TaskOrchestrator` defenses (not an adapter's good
 * behavior) are what actually stop a later event from overwriting an
 * already-recorded terminal outcome.
 */
function buildNonCooperativeAdapter(
  extraEvent: (factory: EventFactory) => NormalizedAgentEvent,
): AgentAdapter {
  return {
    descriptor: new MockAgentAdapter().descriptor,
    detect: () => Promise.resolve({ installed: true, availability: "available" }),
    startTask: (input: AgentTaskInput) => {
      const factory = new EventFactory({
        runId: input.runId,
        taskId: input.hallTask.taskId,
        agentId: input.agentIdentity.agentId,
      });
      async function* events(): AsyncGenerator<NormalizedAgentEvent> {
        await Promise.resolve();
        yield factory.runStarted();
        yield factory.messageDelta("progress 1");
        yield extraEvent(factory);
      }
      return Promise.resolve({
        runId: input.runId,
        events: events(),
        completion: new Promise<NormalizedAgentEvent>(() => {
          // Never resolves; runner-service.ts drives completion purely
          // from iterating `events`, so this is intentionally unused.
        }),
        currentState: "running" as const,
        cancel: (): void => {
          // Deliberately a no-op: this fake adapter never honors cancellation.
        },
      });
    },
  };
}

function buildOrchestrator(options: {
  workspaceRoot: string;
  scenario?: "success" | "failure" | "cancellable";
  progressMessageCount?: number;
  stepDelayMs?: number;
  maxEventsPerTask?: number;
  onExecutionError?: (taskId: string, error: unknown) => void;
}): {
  orchestrator: TaskOrchestrator;
  taskStore: TaskStore;
  eventStore: EventStore;
  eventBus: EventBus;
} {
  const registry = new AgentRegistry();
  registry.register(
    new MockAgentAdapter({
      scenario: options.scenario ?? "success",
      progressMessageCount: options.progressMessageCount ?? 1,
      stepDelayMs: options.stepDelayMs ?? 0,
    }),
  );
  const taskStore = new TaskStore({ maxTasks: 100 });
  const eventStore = new EventStore({ maxEventsPerTask: options.maxEventsPerTask ?? 1000 });
  const eventBus = new EventBus({ maxSubscribersPerTask: 20 });
  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot: options.workspaceRoot,
    onExecutionError: options.onExecutionError,
  });
  return { orchestrator, taskStore, eventStore, eventBus };
}

describe("TaskOrchestrator", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-orchestrator-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates a task in 'assigned' status and returns promptly (before the run finishes)", () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      stepDelayMs: 50,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    expect(task.status).toBe("assigned");
    // The run cannot have finished yet — stepDelayMs=50 guarantees this synchronous check runs first.
    expect(taskStore.get(task.taskId).task.status).not.toBe("completed");
  });

  it("defaults priority to normal", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    expect(task.priority).toBe("normal");
  });

  it("defaults workingDirectory to the workspace root when omitted", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({ workspaceRoot: tempRoot });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    expect(taskStore.get(task.taskId).task.status).toBe("completed");
  });

  it("accepts a valid relative nested working directory", async () => {
    const nested = path.join(tempRoot, "packages", "protocol");
    fs.mkdirSync(nested, { recursive: true });
    const { orchestrator, taskStore } = buildOrchestrator({ workspaceRoot: tempRoot });
    const { task } = orchestrator.createTask(
      validCreateTaskBody({ workingDirectory: "packages/protocol" }),
    );
    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    expect(taskStore.get(task.taskId).task.status).toBe("completed");
  });

  it("rejects an absolute request working directory", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() =>
      orchestrator.createTask(validCreateTaskBody({ workingDirectory: tempRoot })),
    ).toThrow(WorkspaceValidationFailedError);
  });

  it("rejects a working directory that traverses outside the workspace root", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() =>
      orchestrator.createTask(validCreateTaskBody({ workingDirectory: "../../etc" })),
    ).toThrow(WorkspaceValidationFailedError);
  });

  it("rejects unknown request fields", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() => orchestrator.createTask(validCreateTaskBody({ unexpectedField: "nope" }))).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects an empty title", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() => orchestrator.createTask(validCreateTaskBody({ title: "" }))).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects an invalid priority", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() => orchestrator.createTask(validCreateTaskBody({ priority: "urgent-ish" }))).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects an unknown adapter", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() =>
      orchestrator.createTask(validCreateTaskBody({ adapterId: "hall.nonexistent" })),
    ).toThrow(AdapterNotFoundError);
  });

  it("generates a unique taskId and runId per call", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    const first = orchestrator.createTask(validCreateTaskBody());
    const second = orchestrator.createTask(validCreateTaskBody());
    expect(first.task.taskId).not.toBe(second.task.taskId);
    expect(first.runId).not.toBe(second.runId);
  });

  it("transitions assigned -> running -> completed for the success scenario", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    expect(taskStore.get(task.taskId).task.status).toBe("completed");
    expect(taskStore.get(task.taskId).startedAt).toBeDefined();
    expect(taskStore.get(task.taskId).completedAt).toBeDefined();
  });

  it("transitions assigned -> running -> failed for the failure scenario", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "failure",
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    const record = taskStore.get(task.taskId);
    expect(record.task.status).toBe("failed");
    expect(record.failure?.code).toBe("MOCK_EXECUTION_FAILED");
  });

  it("stores exactly one terminal event's worth of information (terminalEventType set once)", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    expect(taskStore.get(task.taskId).terminalEventType).toBe("run.completed");
  });

  it("a terminal task cannot be restarted (createTask always makes a new task)", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({ workspaceRoot: tempRoot });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    expect(() => taskStore.get(task.taskId).task.status === "assigned").not.toThrow();
    // There is no "restart" API at all — attempting to cancel a terminal task is rejected instead.
    expect(() => orchestrator.requestCancellation(task.taskId)).toThrow(TaskStateConflictError);
  });

  it("removes active-run resources after completion (no leaked controller/promise)", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({ workspaceRoot: tempRoot });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    // shutdown() with pending===0 resolves immediately; if the controller/promise
    // weren't cleaned up, this would hang waiting on an already-settled promise
    // that's still tracked (harmless) or, worse, an uncleared controller.
    await expect(orchestrator.shutdown(50)).resolves.toBeUndefined();
  });

  it("does not report a mismatched run/task/agent identity error out of createTask (defense-in-depth lives in EventStore, exercised elsewhere)", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() => orchestrator.createTask(validCreateTaskBody())).not.toThrow();
  });
});

describe("TaskOrchestrator cancellation", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-cancel-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("requesting cancellation on an active task returns alreadyRequested: false and eventually reaches cancelled", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 30,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).eventCount >= 1);
    const result = orchestrator.requestCancellation(task.taskId);
    expect(result.alreadyRequested).toBe(false);
    await waitUntil(() => taskStore.get(task.taskId).task.status === "cancelled");
    expect(taskStore.get(task.taskId).task.status).toBe("cancelled");
  });

  it("does not immediately mark the task cancelled — cancellationRequested is set first, status flips only on run.cancelled", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 30,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).eventCount >= 1);
    orchestrator.requestCancellation(task.taskId);
    const immediatelyAfter = taskStore.get(task.taskId);
    expect(immediatelyAfter.cancellationRequested).toBe(true);
    expect(immediatelyAfter.task.status).not.toBe("cancelled");
  });

  it("repeated cancellation while pending is idempotent (alreadyRequested: true, no duplicate cancelled event)", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 30,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).eventCount >= 1);
    orchestrator.requestCancellation(task.taskId);
    const second = orchestrator.requestCancellation(task.taskId);
    expect(second.alreadyRequested).toBe(true);
    await waitUntil(() => taskStore.get(task.taskId).task.status === "cancelled");
    expect(taskStore.get(task.taskId).task.status).toBe("cancelled");
  });

  it("cancelling an unknown task raises TaskNotFoundError-derived behavior via the store", () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    expect(() => orchestrator.requestCancellation("nonexistent")).toThrow();
  });

  it("cancelling a completed task returns a 409-mapped conflict, not a silent no-op", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    expect(() => orchestrator.requestCancellation(task.taskId)).toThrow(TaskStateConflictError);
  });

  it("cancelling a failed task returns a conflict", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "failure",
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    expect(() => orchestrator.requestCancellation(task.taskId)).toThrow(TaskStateConflictError);
  });

  it("cancelling an already-cancelled task returns a conflict", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 20,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).eventCount >= 1);
    orchestrator.requestCancellation(task.taskId);
    await waitUntil(() => taskStore.get(task.taskId).task.status === "cancelled");
    expect(() => orchestrator.requestCancellation(task.taskId)).toThrow(TaskStateConflictError);
  });

  it("cancellation reaches Hall Runner through an AbortSignal (the run actually stops early)", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "cancellable",
      progressMessageCount: 20,
      stepDelayMs: 200,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).eventCount >= 1);
    const start = Date.now();
    orchestrator.requestCancellation(task.taskId);
    await waitUntil(() => taskStore.get(task.taskId).task.status === "cancelled", 3000);
    // 20 steps * 200ms would take ~4000ms if cancellation didn't actually interrupt the run.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("stores exactly one run.cancelled event's worth of information (no duplicate)", async () => {
    const { orchestrator, taskStore, eventStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 20,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).eventCount >= 1);
    orchestrator.requestCancellation(task.taskId);
    orchestrator.requestCancellation(task.taskId);
    await waitUntil(() => taskStore.get(task.taskId).task.status === "cancelled");
    const cancelledEvents = eventStore
      .list(task.taskId)
      .filter((event) => event.type === "run.cancelled");
    expect(cancelledEvents).toHaveLength(1);
  });
});

describe("TaskOrchestrator shutdown", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-shutdown-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("shutdown() cancels active runs and resolves within the bound", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "cancellable",
      progressMessageCount: 20,
      stepDelayMs: 500,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).eventCount >= 1);
    const start = Date.now();
    await orchestrator.shutdown(1000);
    expect(Date.now() - start).toBeLessThan(1200);
  });

  it("shutdown() resolves immediately when there are no active runs", async () => {
    const { orchestrator } = buildOrchestrator({ workspaceRoot: tempRoot });
    const start = Date.now();
    await orchestrator.shutdown(5000);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("invokes onExecutionError when an adapter's startTask rejects, without throwing out of createTask", async () => {
    const onExecutionError = vi.fn();
    const registry = new AgentRegistry();
    registry.register({
      descriptor: new MockAgentAdapter().descriptor,
      detect: () => Promise.resolve({ installed: true, availability: "available" }),
      startTask: () => Promise.reject(new Error("simulated adapter startTask failure")),
    });
    const taskStore = new TaskStore({ maxTasks: 10 });
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore: new EventStore({ maxEventsPerTask: 100 }),
      eventBus: new EventBus({ maxSubscribersPerTask: 10 }),
      registry,
      workspaceRoot: tempRoot,
      onExecutionError,
    });

    const { task } = orchestrator.createTask(validCreateTaskBody());
    expect(taskStore.get(task.taskId).task.status).toBe("assigned");

    await waitUntil(() => onExecutionError.mock.calls.length > 0);
    expect(onExecutionError).toHaveBeenCalledWith(task.taskId, expect.any(Error));

    // Logging the error is not enough on its own — the task must not be
    // left stuck in "assigned" forever just because runTask() rejected
    // for a reason #handleEvent never saw.
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    const record = taskStore.get(task.taskId);
    expect(record.failure?.code).toBe("TASK_EXECUTION_FAILED");
    expect(record.terminalEventType).toBe("run.failed");
  });
});

describe("TaskOrchestrator event-capacity failure", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-capacity-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates exactly one deterministic terminal failure with code EVENT_CAPACITY_REACHED", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      stepDelayMs: 0,
      maxEventsPerTask: 2,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    const record = taskStore.get(task.taskId);
    expect(record.failure?.code).toBe("EVENT_CAPACITY_REACHED");
    expect(record.terminalEventType).toBe("run.failed");
  });

  it("the task ends in failed state and does not remain running", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      maxEventsPerTask: 2,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    expect(taskStore.get(task.taskId).task.status).toBe("failed");
  });

  it("the terminal event passes parseNormalizedAgentEvent and uses the next contiguous sequence", async () => {
    const { orchestrator, taskStore, eventStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      maxEventsPerTask: 2,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    const events = eventStore.list(task.taskId);
    expect(events).toHaveLength(2); // reserved-capacity: run.started + the synthetic terminal
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
    for (const event of events) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
    const terminal = events[1];
    expect(terminal?.type).toBe("run.failed");
  });

  it("exactly one terminal event is stored", async () => {
    const { orchestrator, taskStore, eventStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      maxEventsPerTask: 2,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    const terminalEvents = eventStore
      .list(task.taskId)
      .filter(
        (event) =>
          event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled",
      );
    expect(terminalEvents).toHaveLength(1);
  });

  it("subscribers receive the terminal capacity-failure event", async () => {
    const { orchestrator, taskStore, eventBus } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      maxEventsPerTask: 2,
    });
    const received: NormalizedAgentEvent[] = [];
    const { task } = orchestrator.createTask(validCreateTaskBody());
    eventBus.subscribe(task.taskId, (event) => received.push(event));
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    expect(received.some((event) => event.type === "run.failed")).toBe(true);
  });

  it("capacity exhaustion requests cancellation/abortion of the active adapter execution (the run actually stops early)", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 20,
      stepDelayMs: 200,
      maxEventsPerTask: 3,
    });
    const start = Date.now();
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed", 3000);
    // 20 steps * 200ms would take ~4000ms if the capacity failure didn't
    // actually abort the adapter's execution.
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("active-run resources are removed after a capacity failure (no leaked controller/promise)", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      maxEventsPerTask: 2,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    await expect(orchestrator.shutdown(50)).resolves.toBeUndefined();
  });

  it("safe API responses do not expose raw internal event-store errors, stack traces, or absolute paths", async () => {
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      maxEventsPerTask: 2,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    const record = taskStore.get(task.taskId);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(tempRoot);
    expect(serialized).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack-trace-shaped text
    expect(record.failure?.message.length).toBeLessThanOrEqual(2000);
  });

  it("no unhandled rejection occurs while a capacity failure is being processed", async () => {
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    const { orchestrator, taskStore } = buildOrchestrator({
      workspaceRoot: tempRoot,
      scenario: "success",
      progressMessageCount: 5,
      maxEventsPerTask: 2,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    await orchestrator.shutdown(50);
    // Give any late microtask a chance to surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandled);
  });

  it("later adapter completion cannot replace the capacity failure", async () => {
    const registry = new AgentRegistry();
    registry.register(buildNonCooperativeAdapter((factory) => factory.runCompleted()));
    const taskStore = new TaskStore({ maxTasks: 10 });
    const eventStore = new EventStore({ maxEventsPerTask: 2 });
    const eventBus = new EventBus({ maxSubscribersPerTask: 10 });
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore,
      eventBus,
      registry,
      workspaceRoot: tempRoot,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    // Give the ignored late event a chance to have (wrongly) taken effect.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const record = taskStore.get(task.taskId);
    expect(record.task.status).toBe("failed");
    expect(record.failure?.code).toBe("EVENT_CAPACITY_REACHED");
    expect(record.terminalEventType).toBe("run.failed");
  });

  it("later adapter failure cannot replace the capacity failure", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildNonCooperativeAdapter((factory) =>
        factory.runFailed({
          code: "LATE_MOCK_FAILURE",
          message: "a later, different failure",
          retryable: false,
        }),
      ),
    );
    const taskStore = new TaskStore({ maxTasks: 10 });
    const eventStore = new EventStore({ maxEventsPerTask: 2 });
    const eventBus = new EventBus({ maxSubscribersPerTask: 10 });
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore,
      eventBus,
      registry,
      workspaceRoot: tempRoot,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const record = taskStore.get(task.taskId);
    expect(record.failure?.code).toBe("EVENT_CAPACITY_REACHED");
  });

  it("later adapter cancellation cannot replace the capacity failure", async () => {
    const registry = new AgentRegistry();
    registry.register(buildNonCooperativeAdapter((factory) => factory.runCancelled("system")));
    const taskStore = new TaskStore({ maxTasks: 10 });
    const eventStore = new EventStore({ maxEventsPerTask: 2 });
    const eventBus = new EventBus({ maxSubscribersPerTask: 10 });
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore,
      eventBus,
      registry,
      workspaceRoot: tempRoot,
    });
    const { task } = orchestrator.createTask(validCreateTaskBody());
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const record = taskStore.get(task.taskId);
    expect(record.task.status).toBe("failed");
    expect(record.failure?.code).toBe("EVENT_CAPACITY_REACHED");
  });
});

describe("TaskOrchestrator — governed retry across a simulated restart (Phase 15.2)", () => {
  let tempRoot: string;
  const openDbs: HallDatabase[] = [];

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-orchestrator-retry-restart-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const db of openDbs.splice(0)) db.close();
  });

  it("a fresh TaskOrchestrator instance (simulating a durable restart) still computes the correct event-sequence offset for a governed retry — no EVENT_SEQUENCE_CONFLICT", async () => {
    // `TaskOrchestrator#runSequenceBase` (the offset that lets a second
    // run's adapter-local, 0-based event sequence continue a task's
    // cumulative sequence space) is in-memory only — freshly reconstructed
    // on every process boot. This test proves that's safe by constructing
    // TWO separate `TaskOrchestrator` instances (fresh `#runSequenceBase`,
    // fresh `#pendingWorkingDirectories`, fresh `#activeControllers` —
    // exactly what a real process restart produces) sharing the SAME
    // durable `SqliteTaskStore`/`SqliteEventStore` backed by one SQLite
    // database, exactly as `server.ts` would after a real restart:
    // `startTask()` always re-derives the offset fresh from
    // `eventStore.nextSequence(taskId)`, which reads the PERSISTED table,
    // so a governed retry triggered by the SECOND instance still gets the
    // correct offset — never colliding at sequence 0 with attempt 1's
    // already-persisted events.
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDbs.push(db);

    const taskStore = new SqliteTaskStore({ db, maxTasks: 100 });
    const eventStore = new SqliteEventStore({ db, streamKind: "task", maxEventsPerStream: 1000 });
    const eventBus = new EventBus({ maxSubscribersPerTask: 20 });

    const registryBefore = new AgentRegistry();
    registryBefore.register(
      new MockAgentAdapter({ scenario: "failure", stepDelayMs: 0, failureRetryable: true }),
    );
    const before = new TaskOrchestrator({
      taskStore,
      eventStore,
      eventBus,
      registry: registryBefore,
      workspaceRoot: tempRoot,
    });

    const { task } = before.createTask({
      executionMode: "deferred",
      projectId: "project-1",
      title: "Task that fails once, then retries after a restart",
    });
    // Deferred tasks start "backlog" — move to "ready" before assigning,
    // exactly like the manual planning-transition route would.
    taskStore.updateStatus(task.taskId, "ready");
    await before.assignTask(task.taskId, { adapterId: "hall.mock-agent" });
    await before.startTask(task.taskId);
    await waitUntil(() => taskStore.get(task.taskId).task.status === "failed");

    const eventsBeforeRestart = eventStore.list(task.taskId);
    expect(eventsBeforeRestart.length).toBeGreaterThan(0);
    const firstRunId = eventsBeforeRestart[0]?.runId;
    expect(firstRunId).toBeDefined();

    // Simulate the restart boundary: a brand-new orchestrator instance,
    // registered with a NEW (successful) adapter instance under the same
    // adapter id, sharing nothing in-process with `before`.
    const registryAfter = new AgentRegistry();
    registryAfter.register(new MockAgentAdapter({ scenario: "success", stepDelayMs: 0 }));
    const after = new TaskOrchestrator({
      taskStore,
      eventStore,
      eventBus,
      registry: registryAfter,
      workspaceRoot: tempRoot,
    });

    const prepared = after.prepareRetry(task.taskId);
    expect(prepared.task.status).toBe("assigned");
    expect(prepared.runId).toBeUndefined();

    const started = await after.startTask(task.taskId);
    expect(started.runId).not.toBe(firstRunId);

    await waitUntil(() => taskStore.get(task.taskId).task.status === "completed");
    const finalRecord = taskStore.get(task.taskId);
    // Never the synthetic infrastructure-failure path
    // (`EVENT_SEQUENCE_CONFLICT` would drive this to `"failed"` instead).
    expect(finalRecord.terminalEventType).toBe("run.completed");

    const eventsAfterRetry = eventStore.list(task.taskId);
    const sequences = eventsAfterRetry.map((e) => e.sequence);
    // Strictly increasing from 0, no gaps, no duplicates — a genuinely
    // continuous per-task sequence even across the simulated restart.
    expect(sequences).toEqual(sequences.map((_, i) => i));
    expect(eventsAfterRetry.length).toBeGreaterThan(eventsBeforeRestart.length);
    // Attempt 1's own events remain in history, byte-identical, at the
    // front — never rewritten or renumbered by the retry.
    expect(eventsAfterRetry.slice(0, eventsBeforeRestart.length)).toEqual(eventsBeforeRestart);
  });
});
