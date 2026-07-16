import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { parseHallTask, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { TaskStore } from "../tasks/task-store.js";
import type { TaskRecord } from "../tasks/task-record.js";
import {
  handleTaskEventsConnection,
  CLOSE_CODE_CLIENT_TOO_SLOW,
  type TaskEventsSocket,
  type TaskEventsRouteDeps,
} from "./task-events.js";
import {
  buildTestApp,
  validCreateTaskBody,
  waitUntil,
  type CreateTaskResponseJson,
  type TestHarness,
} from "../test-support.js";
import type { createHallCoreApp } from "../app.js";

type HallCoreApp = Awaited<ReturnType<typeof createHallCoreApp>>;

async function startEphemeral(app: HallCoreApp): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address;
}

function collectMessages(socket: WebSocket): {
  events: NormalizedAgentEvent[];
  closeCode: Promise<number>;
} {
  const events: NormalizedAgentEvent[] = [];
  socket.on("message", (data: Buffer) => {
    events.push(JSON.parse(data.toString()) as NormalizedAgentEvent);
  });
  const closeCode = new Promise<number>((resolve) => {
    socket.on("close", (code: number) => {
      resolve(code);
    });
  });
  return { events, closeCode };
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
}

describe("WebSocket /api/v1/tasks/:taskId/events", () => {
  let tempRoot: string;
  let app: HallCoreApp;
  let harness: TestHarness;
  let baseUrl: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-ws-test-"));
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function setup(
    mockAgentConfig: Parameters<typeof buildTestApp>[0]["mockAgentConfig"],
  ): Promise<void> {
    const built = await buildTestApp({ workspaceRoot: tempRoot, mockAgentConfig });
    app = built.app;
    harness = built.harness;
    const address = await startEphemeral(app);
    baseUrl = address.replace("http://", "ws://");
  }

  it("connects successfully for a known task and replays + streams to completion", async () => {
    await setup({ scenario: "success", progressMessageCount: 2 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();

    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);

    const code = await closeCode;
    expect(code).toBe(1000);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("rejects a connection for an unknown task", async () => {
    await setup({ scenario: "success" });
    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/nonexistent/events`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket).catch(() => undefined);
    const code = await closeCode;
    expect(code).toBe(4404);
  });

  it("replays stored events for a task that has already finished before the client connects", async () => {
    await setup({ scenario: "success", progressMessageCount: 1, stepDelayMs: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "completed");

    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);
    await closeCode;
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.length).toBeGreaterThan(0);
  });

  it("afterSequence filters replay to only events with a greater sequence", async () => {
    await setup({ scenario: "success", progressMessageCount: 2, stepDelayMs: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "completed");

    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events?afterSequence=2`);
    const { events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);
    await closeCode;
    expect(events.every((event) => event.sequence > 2)).toBe(true);
    expect(events[0]?.sequence).toBe(3);
  });

  it("a client omitting afterSequence receives all stored events", async () => {
    await setup({ scenario: "success", progressMessageCount: 1, stepDelayMs: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "completed");

    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);
    await closeCode;
    expect(events[0]?.sequence).toBe(0);
  });

  it("rejects an invalid (negative) afterSequence", async () => {
    await setup({ scenario: "success" });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events?afterSequence=-1`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket).catch(() => undefined);
    const code = await closeCode;
    expect(code).toBe(4400);
  });

  it("rejects a non-numeric afterSequence", async () => {
    await setup({ scenario: "success" });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    const socket = new WebSocket(
      `${baseUrl}/api/v1/tasks/${task.taskId}/events?afterSequence=not-a-number`,
    );
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket).catch(() => undefined);
    const code = await closeCode;
    expect(code).toBe(4400);
  });

  it("closes with a documented policy code if the client sends application data", async () => {
    await setup({ scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 100 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    await waitForOpen(socket);
    const { closeCode } = collectMessages(socket);
    socket.send("this endpoint does not accept client input");
    const code = await closeCode;
    expect(code).toBe(1003);
  });

  it("removing the subscription on client disconnect: EventBus subscriber count drops to 0", async () => {
    await setup({ scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 100 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    await waitUntil(() => harness.taskStore.get(task.taskId).eventCount >= 1);

    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    await waitForOpen(socket);
    await waitUntil(() => harness.eventBus.subscriberCount(task.taskId) === 1);
    socket.close();
    await waitUntil(() => harness.eventBus.subscriberCount(task.taskId) === 0);
  });

  it("removes the subscription once the task reaches a terminal state (server-side close)", async () => {
    await setup({ scenario: "success", progressMessageCount: 1, stepDelayMs: 20 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket);
    await closeCode;
    expect(harness.eventBus.subscriberCount(task.taskId)).toBe(0);
  });

  it("enforces the configured subscriber limit", async () => {
    const built = await buildTestApp({
      workspaceRoot: tempRoot,
      mockAgentConfig: { scenario: "cancellable", progressMessageCount: 5, stepDelayMs: 200 },
      limits: { maxSubscribersPerTask: 1 },
    });
    app = built.app;
    harness = built.harness;
    const address = await startEphemeral(app);
    baseUrl = address.replace("http://", "ws://");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    await waitUntil(() => harness.taskStore.get(task.taskId).eventCount >= 1);

    const first = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    await waitForOpen(first);
    await waitUntil(() => harness.eventBus.subscriberCount(task.taskId) === 1);

    const second = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { closeCode } = collectMessages(second);
    await waitForOpen(second).catch((): void => undefined);
    const code = await closeCode;
    expect(code).toBe(4503);
    first.close();
  });

  it("delivers no duplicate and no gap across the replay-to-live transition", async () => {
    // A slower scenario keeps the run in progress long enough for the
    // client to connect mid-stream, exercising the real replay+subscribe
    // ordering rather than a fully-finished-before-connect case.
    await setup({ scenario: "success", progressMessageCount: 3, stepDelayMs: 15 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();
    await waitUntil(() => harness.taskStore.get(task.taskId).eventCount >= 1);

    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);
    await closeCode;

    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences[0]).toBe(0);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("reconnecting with afterSequence after a client-initiated disconnect replays the missed events with no gap", async () => {
    await setup({ scenario: "success", progressMessageCount: 3, stepDelayMs: 30 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();

    const first = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { events: firstEvents } = collectMessages(first);
    await waitForOpen(first);
    await waitUntil(() => firstEvents.length >= 2);
    const lastReceived = firstEvents.at(-1)?.sequence;
    expect(lastReceived).toBeDefined();
    first.close();
    await waitUntil(() => harness.eventBus.subscriberCount(task.taskId) === 0);

    // Let the run keep progressing/finish while this client is disconnected.
    await waitUntil(() => harness.taskStore.get(task.taskId).task.status === "completed");

    const second = new WebSocket(
      `${baseUrl}/api/v1/tasks/${task.taskId}/events?afterSequence=${String(lastReceived)}`,
    );
    const { events: secondEvents, closeCode } = collectMessages(second);
    await waitForOpen(second);
    await closeCode;

    expect(secondEvents.every((event) => event.sequence > (lastReceived ?? -1))).toBe(true);
    expect(secondEvents.at(-1)?.type).toBe("run.completed");

    // The real invariant this proves is "no gap on reconnect" — the union of
    // distinct sequences received across both connections is contiguous
    // from 0. A *duplicate* across the two connections (e.g. a frame that
    // landed on `first` in the async window between capturing lastReceived
    // and the client actually disconnecting) is contract-permitted, not a
    // bug: delivery is documented as at-least-once across a reconnect (see
    // docs/architecture/0004-hall-core-server.md, "WebSocket delivery
    // guarantee") — clients are expected to dedupe by sequence/eventId, so
    // asserting zero duplicates here would both contradict that contract
    // and make this test flaky on timing.
    const allSequences = [...firstEvents, ...secondEvents].map((event) => event.sequence);
    const distinctSorted = [...new Set(allSequences)].sort((a, b) => a - b);
    expect(distinctSorted).toEqual(Array.from({ length: distinctSorted.length }, (_, i) => i));
  });

  it("server shutdown closes remaining open WebSocket connections", async () => {
    await setup({ scenario: "cancellable", progressMessageCount: 20, stepDelayMs: 200 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody(),
    });
    const { task } = created.json<CreateTaskResponseJson>();

    const socket = new WebSocket(`${baseUrl}/api/v1/tasks/${task.taskId}/events`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket);

    await app.close();
    const code = await closeCode;
    expect(typeof code).toBe("number");
  });
});

/**
 * Uses a controlled fake socket (not a real network connection) to drive
 * `bufferedAmount` deterministically — a real OS/browser socket's
 * `bufferedAmount` cannot be forced into a "slow client" state on demand
 * without an elaborate, flaky setup. See `task-events.test.ts`'s main
 * describe block above for the real-socket reconnect/replay coverage this
 * intentionally does not duplicate.
 */
class FakeSocket implements TaskEventsSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: { code: number | undefined; reason: string | undefined }[] = [];
  readonly #listeners = new Map<string, Set<() => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  on(event: "message" | "close" | "error", listener: () => void): unknown {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  emit(event: "message" | "close" | "error"): void {
    for (const listener of this.#listeners.get(event) ?? []) listener();
  }
}

function buildTaskRecord(taskId: string, runId: string, agentId: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: parseHallTask({
      taskId,
      projectId: "project-1",
      title: "backpressure test task",
      description: "",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
    }),
    runId,
    adapterId: "hall.mock-agent",
    agentId,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: now,
    startedAt: undefined,
    completedAt: undefined,
  };
}

function makeEvent(
  sequence: number,
  runId: string,
  taskId: string,
  agentId: string,
): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId,
    taskId,
    agentId,
    timestamp: new Date().toISOString(),
    sequence,
    type: "message.delta",
    payload: { text: `progress ${String(sequence)}` },
  };
}

describe("handleTaskEventsConnection WebSocket backpressure (fake socket)", () => {
  const RUN_ID = "run-1";
  const AGENT_ID = "agent-1";

  function buildHarness(maxBufferedBytes: number): {
    deps: TaskEventsRouteDeps;
    taskStore: TaskStore;
    eventStore: EventStore;
    eventBus: EventBus;
  } {
    const taskStore = new TaskStore({ maxTasks: 10 });
    const eventStore = new EventStore({ maxEventsPerTask: 100 });
    const eventBus = new EventBus({ maxSubscribersPerTask: 20 });
    return {
      deps: { taskStore, eventStore, eventBus, maxBufferedBytes },
      taskStore,
      eventStore,
      eventBus,
    };
  }

  /** Mirrors what TaskOrchestrator does: store, then publish. */
  function appendAndPublish(
    eventStore: EventStore,
    eventBus: EventBus,
    taskId: string,
    event: NormalizedAgentEvent,
  ): void {
    eventStore.append(taskId, event, { runId: RUN_ID, taskId, agentId: AGENT_ID });
    eventBus.publish(taskId, event);
  }

  it("a healthy client (bufferedAmount within threshold) receives the event", () => {
    const { deps, taskStore, eventStore, eventBus } = buildHarness(1024);
    const taskId = "task-1";
    taskStore.add(buildTaskRecord(taskId, RUN_ID, AGENT_ID));
    const socket = new FakeSocket();
    handleTaskEventsConnection(socket, { taskId, afterSequenceRaw: undefined }, deps);

    appendAndPublish(eventStore, eventBus, taskId, makeEvent(0, RUN_ID, taskId, AGENT_ID));

    expect(socket.sent).toHaveLength(1);
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("closes a client whose bufferedAmount exceeds the threshold with the documented close code, and unsubscribes it", () => {
    const { deps, taskStore, eventStore, eventBus } = buildHarness(10);
    const taskId = "task-1";
    taskStore.add(buildTaskRecord(taskId, RUN_ID, AGENT_ID));
    const socket = new FakeSocket();
    socket.bufferedAmount = 999;
    handleTaskEventsConnection(socket, { taskId, afterSequenceRaw: undefined }, deps);
    expect(eventBus.subscriberCount(taskId)).toBe(1);

    appendAndPublish(eventStore, eventBus, taskId, makeEvent(0, RUN_ID, taskId, AGENT_ID));

    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(CLOSE_CODE_CLIENT_TOO_SLOW);
    expect(eventBus.subscriberCount(taskId)).toBe(0);
  });

  it("sends no later frames to a client already closed for being too slow", () => {
    const { deps, taskStore, eventStore, eventBus } = buildHarness(10);
    const taskId = "task-1";
    taskStore.add(buildTaskRecord(taskId, RUN_ID, AGENT_ID));
    const socket = new FakeSocket();
    socket.bufferedAmount = 999;
    handleTaskEventsConnection(socket, { taskId, afterSequenceRaw: undefined }, deps);

    appendAndPublish(eventStore, eventBus, taskId, makeEvent(0, RUN_ID, taskId, AGENT_ID));
    expect(socket.closeCalls).toHaveLength(1);

    // The subscriber is already gone, so a second stored/published event
    // never even reaches this socket's listener again.
    appendAndPublish(eventStore, eventBus, taskId, makeEvent(1, RUN_ID, taskId, AGENT_ID));
    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("other subscribers continue receiving events after one slow client is disconnected", () => {
    const { deps, taskStore, eventStore, eventBus } = buildHarness(10);
    const taskId = "task-1";
    taskStore.add(buildTaskRecord(taskId, RUN_ID, AGENT_ID));

    const slow = new FakeSocket();
    slow.bufferedAmount = 999;
    handleTaskEventsConnection(slow, { taskId, afterSequenceRaw: undefined }, deps);

    const healthy = new FakeSocket();
    handleTaskEventsConnection(healthy, { taskId, afterSequenceRaw: undefined }, deps);

    appendAndPublish(eventStore, eventBus, taskId, makeEvent(0, RUN_ID, taskId, AGENT_ID));

    expect(slow.closeCalls).toHaveLength(1);
    expect(healthy.sent).toHaveLength(1);
    expect(healthy.closeCalls).toHaveLength(0);
    expect(eventBus.subscriberCount(taskId)).toBe(1);
  });

  it("the underlying task is unaffected by a slow-client disconnect (this route never touches TaskStore status)", () => {
    const { deps, taskStore, eventStore, eventBus } = buildHarness(10);
    const taskId = "task-1";
    taskStore.add(buildTaskRecord(taskId, RUN_ID, AGENT_ID));
    const socket = new FakeSocket();
    socket.bufferedAmount = 999;
    handleTaskEventsConnection(socket, { taskId, afterSequenceRaw: undefined }, deps);

    appendAndPublish(eventStore, eventBus, taskId, makeEvent(0, RUN_ID, taskId, AGENT_ID));

    expect(taskStore.get(taskId).task.status).toBe("assigned");
  });

  it("the event remains stored even though the slow client was closed, so a reconnect can replay it", () => {
    const { deps, taskStore, eventStore, eventBus } = buildHarness(10);
    const taskId = "task-1";
    taskStore.add(buildTaskRecord(taskId, RUN_ID, AGENT_ID));
    const socket = new FakeSocket();
    socket.bufferedAmount = 999;
    handleTaskEventsConnection(socket, { taskId, afterSequenceRaw: undefined }, deps);

    const event = makeEvent(0, RUN_ID, taskId, AGENT_ID);
    appendAndPublish(eventStore, eventBus, taskId, event);

    expect(eventStore.list(taskId)).toEqual([event]);

    // A reconnect with afterSequence=-1 (nothing received yet) replays it.
    const reconnected = new FakeSocket();
    handleTaskEventsConnection(reconnected, { taskId, afterSequenceRaw: undefined }, deps);
    expect(reconnected.sent).toHaveLength(1);
    expect(JSON.parse(reconnected.sent[0] ?? "{}")).toMatchObject({ sequence: 0 });
  });

  it("repeated slow-client connections do not leak listeners", () => {
    const { deps, taskStore, eventStore, eventBus } = buildHarness(10);
    const taskId = "task-1";
    taskStore.add(buildTaskRecord(taskId, RUN_ID, AGENT_ID));

    for (let i = 0; i < 5; i += 1) {
      const socket = new FakeSocket();
      socket.bufferedAmount = 999;
      handleTaskEventsConnection(socket, { taskId, afterSequenceRaw: undefined }, deps);
    }
    expect(eventBus.subscriberCount(taskId)).toBe(5);

    appendAndPublish(eventStore, eventBus, taskId, makeEvent(0, RUN_ID, taskId, AGENT_ID));

    // Every slow subscriber was closed and unsubscribed by the one publish.
    expect(eventBus.subscriberCount(taskId)).toBe(0);
  });
});
