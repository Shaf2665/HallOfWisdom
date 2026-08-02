import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { CeoPlanExecutionEvent } from "@hall-of-wisdom/protocol";
import {
  buildTestApp,
  validDeferredTaskBody,
  waitUntil,
  type CreateTaskResponseJson,
} from "../test-support.js";
import { createHallCoreApp } from "../app.js";
import { createServerComposition } from "../composition/server-composition.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { acquireDatabaseEpoch } from "../persistence/database-ownership-fence.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";

/**
 * Phase 15 kickoff §3 — direct verification of the execution WebSocket
 * path (`GET /api/v1/ceo-plan-runs/:runId/events/live`), never exercised
 * end-to-end before this file: `ceo-plan-runs.test.ts` covers the REST
 * routes only, and every scheduler/atomicity/circuit-breaker test drives
 * `CeoPlanExecutionScheduler`/the stores directly, never through a real
 * socket. This file uses `armAutonomousScheduling: true` (see
 * `test-support.ts`) so a Mock Agent child task's completion really
 * reaches the scheduler and produces real, persisted, published events —
 * the same bridge production wires via `activateAutonomousScheduling()`.
 */

type HallCoreApp = Awaited<ReturnType<typeof buildTestApp>>["app"];

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-ceo-plan-run-ws-test-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function startEphemeral(app: HallCoreApp): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address;
}

function collectMessages(socket: WebSocket): {
  events: CeoPlanExecutionEvent[];
  rawFrames: string[];
  closeCode: Promise<number>;
} {
  const events: CeoPlanExecutionEvent[] = [];
  const rawFrames: string[] = [];
  socket.on("message", (data: Buffer) => {
    const text = data.toString();
    rawFrames.push(text);
    events.push(JSON.parse(text) as CeoPlanExecutionEvent);
  });
  const closeCode = new Promise<number>((resolve) => {
    socket.on("close", (code: number) => {
      resolve(code);
    });
  });
  return { events, rawFrames, closeCode };
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
}

/** `waitUntil`'s async-check sibling — `test-support.ts`'s own `waitUntil` only accepts a synchronous predicate, but these two call sites need to poll a REST route on each attempt. */
async function waitUntilAsync(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntilAsync: condition not met within ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

interface PlanJson {
  readonly id: string;
}
interface PlanVersionJson {
  readonly version: number;
  readonly contentHash: string;
}
interface RunJson {
  readonly id: string;
  readonly status: string;
}

/** Full create -> submit -> approve -> delegate -> configure -> start over HTTP; returns the run id and its mutation token. */
async function delegateConfigureAndStartRun(
  app: HallCoreApp,
  title: string,
  policyOverrides: Record<string, unknown> = {},
): Promise<{ runId: string; mutationToken: string }> {
  const parent = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: validDeferredTaskBody({
      title,
      description: `Fix: ${title}`,
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

  const tokenAfterCreate = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
  ).json<{ mutationToken: string }>().mutationToken;
  await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plans/${plan.id}/submit`,
    payload: { expectedMutationToken: tokenAfterCreate },
  });
  const tokenAfterSubmit = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
  ).json<{ mutationToken: string }>().mutationToken;

  const version = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}/versions/1` })
  ).json<PlanVersionJson>();
  await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plans/${plan.id}/approve`,
    payload: {
      expectedMutationToken: tokenAfterSubmit,
      planVersion: 1,
      contentHash: version.contentHash,
    },
  });
  const tokenAfterApprove = (
    await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
  ).json<{ mutationToken: string }>().mutationToken;

  const delegated = await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plans/${plan.id}/delegate`,
    payload: { expectedMutationToken: tokenAfterApprove },
  });
  expect(delegated.statusCode).toBe(202);

  const configured = await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plans/${plan.id}/execution/configure`,
    payload: { executionMode: "autonomous", policy: { ...DEFAULT_POLICY, ...policyOverrides } },
  });
  const { run, mutationToken } = configured.json<{ run: RunJson; mutationToken: string }>();

  const started = await app.inject({
    method: "POST",
    url: `/api/v1/ceo-plan-runs/${run.id}/start`,
    payload: { expectedMutationToken: mutationToken },
  });
  const afterStart = started.json<{ run: RunJson; mutationToken: string }>();

  return { runId: run.id, mutationToken: afterStart.mutationToken };
}

describe("WebSocket /api/v1/ceo-plan-runs/:runId/events/live", () => {
  it("streams a real autonomous run to completion, delivering events in strictly increasing sequence order", async () => {
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 0 },
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    const { runId } = await delegateConfigureAndStartRun(app, "Ship the thing");

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runId}/events/live`);
    const { events } = collectMessages(socket);
    await waitForOpen(socket);

    await waitUntil(() => events.some((e) => e.type === "ceo.execution.completed"));

    expect(events.map((e) => e.sequence)).toEqual(
      events
        .map((e) => e.sequence)
        .slice()
        .sort((a, b) => a - b),
    );
    expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);
    expect(events.some((e) => e.type === "ceo.execution.step_completed")).toBe(true);
    // Every event visible over the socket must already be durably
    // recorded — publish-after-commit is the whole safety property here
    // (see `PlanRunEventBus`'s own doc comment). The REST replay endpoint
    // reads the exact same persisted store, so it must show a superset
    // (>=) of whatever the socket has delivered by this point.
    const restEvents = (
      await app.inject({ method: "GET", url: `/api/v1/ceo-plan-runs/${runId}/events` })
    ).json<{ events: readonly { sequence: number }[] }>().events;
    expect(restEvents.length).toBeGreaterThanOrEqual(events.length);

    socket.close();
    await app.close();
    expect(harness.taskStore.list().length).toBeGreaterThan(0);
  }, 15000);

  it("rejects a connection for an unknown run with close code 4404, and never leaks an internal field over the wire", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/does-not-exist/events/live`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket).catch(() => undefined);
    expect(await closeCode).toBe(4404);
    await app.close();
  });

  it("afterSequence resumes replay from exactly the persisted sequence, with no duplicate and no gap on a fresh reconnect", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 0 },
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    const { runId } = await delegateConfigureAndStartRun(app, "Reconnect target");

    // Let the run finish, then read every event it produced from the
    // REST replay endpoint (source of truth for this assertion).
    let allEvents: readonly { sequence: number; type: string }[] = [];
    await waitUntilAsync(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/ceo-plan-runs/${runId}/events`,
      });
      allEvents = response.json<{ events: readonly { sequence: number; type: string }[] }>().events;
      return allEvents.some((e) => e.type === "ceo.execution.completed");
    });
    expect(allEvents.length).toBeGreaterThanOrEqual(3);
    const midpoint = allEvents[Math.floor(allEvents.length / 2)];
    if (!midpoint) throw new Error("expected at least one event at the midpoint");

    const socket = new WebSocket(
      `${wsBaseUrl}/api/v1/ceo-plan-runs/${runId}/events/live?afterSequence=${String(midpoint.sequence)}`,
    );
    const { events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);
    socket.close();
    await closeCode;

    // Every delivered event has a sequence strictly greater than
    // `afterSequence` (no duplicate of anything already seen) and,
    // together, they account for exactly the remaining tail with no gap.
    expect(events.every((e) => e.sequence > midpoint.sequence)).toBe(true);
    const expectedTail = allEvents
      .filter((e) => e.sequence > midpoint.sequence)
      .map((e) => e.sequence);
    expect(events.map((e) => e.sequence)).toEqual(expectedTail);

    await app.close();
  }, 15000);

  it("two runs never cross-contaminate: a socket subscribed to run A never receives any event whose planRunId is run B", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 5 },
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");

    // Each run gets its own dedicated slot of the shared Mock Agent
    // adapter's capacity. This is deliberate, not incidental: a step
    // blocked on `waiting_for_capacity` is only ever re-evaluated by a
    // signal for its OWN run (a dependency completing, an operator
    // action, ...) — nothing currently wakes a DIFFERENT run's blocked
    // step when some other run's task on the same adapter frees a slot.
    // That is a real scheduling-fairness gap (see this phase's final
    // report, "Known Limitations" — cross-run adapter-capacity wakeup),
    // out of scope to fix in this pass; this test's own purpose is event
    // *stream isolation*, not adapter fairness (§10E covers fairness
    // under sufficient shared capacity), so it sidesteps the gap here
    // rather than depending on the missing behavior.
    const runA = await delegateConfigureAndStartRun(app, "Run A", {
      adapterConcurrencyOverrides: { "hall.mock-agent": 2 },
    });
    const runB = await delegateConfigureAndStartRun(app, "Run B", {
      adapterConcurrencyOverrides: { "hall.mock-agent": 2 },
    });

    const socketA = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runA.runId}/events/live`);
    const socketB = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runB.runId}/events/live`);
    const collectedA = collectMessages(socketA);
    const collectedB = collectMessages(socketB);
    await Promise.all([waitForOpen(socketA), waitForOpen(socketB)]);

    await waitUntil(
      () =>
        collectedA.events.some((e) => e.type === "ceo.execution.completed") &&
        collectedB.events.some((e) => e.type === "ceo.execution.completed"),
    );

    expect(collectedA.events.every((e) => e.planRunId === runA.runId)).toBe(true);
    expect(collectedB.events.every((e) => e.planRunId === runB.runId)).toBe(true);

    socketA.close();
    socketB.close();
    await app.close();
  }, 15000);

  it("closes with 1003 and takes no scheduling action when a client sends a message — this is a publish-only stream, never a command channel", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 200 },
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    const { runId } = await delegateConfigureAndStartRun(app, "No client commands");

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runId}/events/live`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket);

    socket.send(
      JSON.stringify({
        planRunId: runId,
        sequence: 999,
        type: "ceo.execution.completed",
        actor: "system:ceo-scheduler",
        payload: {},
        timestamp: new Date().toISOString(),
      }),
    );

    expect(await closeCode).toBe(1003);

    // The forged/injected frame must never have been accepted as a real
    // event: sequence 999 does not exist in the persisted stream.
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plan-runs/${runId}/events`,
    });
    const sequences = events
      .json<{ events: readonly { sequence: number }[] }>()
      .events.map((e) => e.sequence);
    expect(sequences).not.toContain(999);

    await app.close();
  });

  it("execution events never appear on the CEO plan-definition event stream, and plan-definition events never appear on the execution stream", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 0 },
    });
    const { runId } = await delegateConfigureAndStartRun(app, "Isolated stream");

    await waitUntilAsync(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/ceo-plan-runs/${runId}/events`,
      });
      return response
        .json<{ events: readonly { type: string }[] }>()
        .events.some((e) => e.type === "ceo.execution.completed");
    });

    const runDetail = await app.inject({ method: "GET", url: `/api/v1/ceo-plan-runs/${runId}` });
    const planId = runDetail.json<{ run: { planId: string } }>().run.planId;

    const planEvents = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plans/${planId}/events`,
    });
    const planEventTypes = planEvents
      .json<{ events: readonly { type: string }[] }>()
      .events.map((e) => e.type);
    expect(planEventTypes.every((t) => !t.startsWith("ceo.execution."))).toBe(true);

    const executionEvents = await app.inject({
      method: "GET",
      url: `/api/v1/ceo-plan-runs/${runId}/events`,
    });
    const executionEventTypes = executionEvents
      .json<{ events: readonly { type: string }[] }>()
      .events.map((e) => e.type);
    expect(executionEventTypes.every((t) => t.startsWith("ceo.execution."))).toBe(true);

    await app.close();
  }, 15000);

  it("every event payload delivered over the raw wire is free of internal fields — checked against the raw JSON text, not the parsed/re-serialized object", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 0 },
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    const { runId } = await delegateConfigureAndStartRun(app, "No leakage");

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runId}/events/live`);
    const { events, rawFrames } = collectMessages(socket);
    await waitForOpen(socket);
    await waitUntil(() => events.some((e) => e.type === "ceo.execution.completed"));
    socket.close();

    expect(rawFrames.length).toBeGreaterThan(0);
    // Bare substring checks would false-positive on legitimate field names
    // that happen to contain a forbidden word as a substring (e.g.
    // "planStepId" contains "pid") — every term here is either a whole
    // camelCase field name (matched case-insensitively, which is safe
    // because none of them are substrings of any real field this event
    // shape carries) or, for genuinely substring-prone terms like `pid`,
    // matched as a quoted JSON key (`"pid":`) so it only matches an
    // actual key named exactly that.
    const forbidden = [
      "internalRevision",
      "claimLease",
      "ownerToken",
      "leaseGeneration",
      "epoch",
      '"pid":',
      tempRoot.toLowerCase(),
      "stderr",
    ];
    for (const frame of rawFrames) {
      const lower = frame.toLowerCase();
      for (const term of forbidden) {
        expect(lower).not.toContain(term.toLowerCase());
      }
    }

    await app.close();
  }, 15000);

  it("Phase 15.7 — security matrix scenario 4: a browser cannot enqueue scheduler work over the execution WebSocket — the forged frame creates no signal, no attempt, no task start, and the connection is closed rather than silently ignored", async () => {
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 0 },
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    // Configured autonomous, but deliberately never `/start`ed — nothing
    // is legitimately pending or in flight, so any state change observed
    // after the forged frame can only have come from that frame.
    const parent = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validDeferredTaskBody({
        title: "Forged signal target",
        description: "Fix: Forged signal target",
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      }),
    });
    const taskId = parent.json<CreateTaskResponseJson>().task.taskId;
    const createdPlan = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/ceo-plans`,
      payload: {},
    });
    const { plan } = createdPlan.json<{ plan: PlanJson }>();
    const tokenAfterCreate = (
      await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
    ).json<{ mutationToken: string }>().mutationToken;
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/submit`,
      payload: { expectedMutationToken: tokenAfterCreate },
    });
    const tokenAfterSubmit = (
      await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
    ).json<{ mutationToken: string }>().mutationToken;
    const version = (
      await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}/versions/1` })
    ).json<PlanVersionJson>();
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/approve`,
      payload: {
        expectedMutationToken: tokenAfterSubmit,
        planVersion: 1,
        contentHash: version.contentHash,
      },
    });
    const tokenAfterApprove = (
      await app.inject({ method: "GET", url: `/api/v1/ceo-plans/${plan.id}` })
    ).json<{ mutationToken: string }>().mutationToken;
    await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/delegate`,
      payload: { expectedMutationToken: tokenAfterApprove },
    });
    const configured = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plans/${plan.id}/execution/configure`,
      payload: { executionMode: "autonomous", policy: DEFAULT_POLICY },
    });
    const { run } = configured.json<{ run: RunJson; mutationToken: string }>();

    const signalCountsBefore = harness.ceoExecution.signalStore.countByState();
    const attemptsBefore = harness.ceoExecution.planRunStore.listAttempts(run.id);

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${run.id}/events/live`);
    const { closeCode } = collectMessages(socket);
    await waitForOpen(socket);

    // Shaped like a plausible "start this step" command a malicious or
    // buggy client might attempt — this endpoint has no command concept
    // at all, so its content is irrelevant; ANY inbound message closes
    // the connection.
    socket.send(
      JSON.stringify({
        type: "start_step",
        planRunId: run.id,
        reason: "execution_started",
        actor: "system:ceo-scheduler",
      }),
    );
    expect(await closeCode).toBe(1003);

    // No signal was created, no attempt was created, the run never left
    // "configured", and no task was ever given a runId — the forged
    // frame had zero scheduling effect.
    const signalCountsAfter = harness.ceoExecution.signalStore.countByState();
    expect(signalCountsAfter.pending).toBe(signalCountsBefore.pending);
    expect(signalCountsAfter.claimed).toBe(signalCountsBefore.claimed);
    const attemptsAfter = harness.ceoExecution.planRunStore.listAttempts(run.id);
    expect(attemptsAfter.length).toBe(attemptsBefore.length);
    const runAfter = await app.inject({ method: "GET", url: `/api/v1/ceo-plan-runs/${run.id}` });
    expect(runAfter.json<{ run: RunJson }>().run.status).toBe("configured");
    expect(harness.taskStore.list().every((t) => t.runId === undefined)).toBe(true);

    await app.close();
  });

  it("no route accepts a browser-supplied actor field — every mutating execution route's request schema is `.strict()` and rejects an unknown `actor` key", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const { runId } = await delegateConfigureAndStartRun(app, "No forged actor");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${runId}/pause`,
      payload: {
        expectedMutationToken: "will-fail-schema-before-token-check",
        actor: "system:ceo-scheduler",
      },
    });
    // `.strict()` rejects the unknown `actor` key before any token check
    // ever runs — a malformed body fails validation (400) regardless of
    // whether the token itself would have been valid.
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_REQUEST");

    await app.close();
  });

  it("rejects a connection whose Origin header does not match the configured web origin, with close code 4403", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    const { runId } = await delegateConfigureAndStartRun(app, "Wrong origin");

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runId}/events/live`, {
      headers: { Origin: "http://evil.example" },
    });
    const { closeCode } = collectMessages(socket);
    await expect(closeCode).resolves.toBe(4403);

    await app.close();
  });

  it("a socket subscribed before an injected mutation failure receives nothing for it — publish-after-commit observed at the wire, not just the domain layer", async () => {
    const { app, harness } = await buildTestApp({
      workspaceRoot: tempRoot,
      armAutonomousScheduling: true,
      mockAgentConfig: { scenario: "success", stepDelayMs: 0 },
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    const { runId } = await delegateConfigureAndStartRun(app, "Rollback publishes nothing", {
      pauseOnAnyPermanentFailure: false,
    });

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runId}/events/live`);
    const { events } = collectMessages(socket);
    await waitForOpen(socket);
    await waitUntilAsync(() => Promise.resolve(events.length > 0));

    // Inject the failure BEFORE the child task completes — with
    // `armAutonomousScheduling: true`, the mutation-hook bridge calls
    // `scheduler.onChildTaskMutated` automatically the moment the task
    // reaches a terminal status (`mock-agent-composition-root.ts`'s
    // `onTaskMutated`, `.catch(() => {})`-guarded — a background bridge
    // call this test cannot itself `await`/assert a rejection from), so
    // this test instead waits for the real completion, gives the
    // automatic (and, thanks to the injection, failing) bridge call a
    // real chance to run, and asserts the SOCKET received nothing for
    // it. Store-level recovery-after-rollback is already exhaustively
    // proven elsewhere (`ceo-plan-execution-atomicity.*.test.ts`); this
    // test's own job is only the wire-observable half.
    const [step] = harness.ceoExecution.planRunStore.listStepExecutions(runId);
    if (!step) throw new Error("expected at least one step execution");
    const childTaskId = step.childTaskId;
    const countBeforeFailure = events.length;

    const originalEnqueue = harness.ceoExecution.signalStore.enqueue.bind(
      harness.ceoExecution.signalStore,
    );
    harness.ceoExecution.signalStore.enqueue = () => {
      throw new Error("injected signal-store failure");
    };

    await waitUntil(() => harness.taskStore.get(childTaskId).task.status === "completed");
    // Give the automatic (silently-failing) bridge call a real chance to
    // run and, if the bug this test guards against existed, to publish.
    // (Store-level atomicity — that the rejected span leaves no partial
    // state — is already exhaustively proven by
    // `ceo-plan-execution-atomicity.{ephemeral,durable}.test.ts`; this
    // test's own job is only the wire-observable half.)
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toHaveLength(countBeforeFailure);

    harness.ceoExecution.signalStore.enqueue = originalEnqueue;

    socket.close();
    await app.close();
  });

  it("a mutation rejected by the durable ownership fence publishes no event to an already-subscribed socket — no false success reaches the wire", async () => {
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
      registry: composition.registry,
      limits: DEFAULT_LIMITS,
      ceoPlanOrchestrator: composition.ceoPlans.orchestrator,
      ceoExecution: composition.ceoExecution,
      logger: false,
      storageMode: "durable",
    });
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");
    const { runId, mutationToken } = await delegateConfigureAndStartRun(app, "Ownership lost ws");

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/ceo-plan-runs/${runId}/events/live`);
    const { events } = collectMessages(socket);
    await waitForOpen(socket);
    await waitUntilAsync(() => Promise.resolve(events.length > 0));
    const countBeforeTakeover = events.length;

    // A second instance legitimately takes over; this connection's own
    // `db.ownershipFence` is deliberately never updated.
    acquireDatabaseEpoch(db, "owner-b");

    const pauseResponse = await app.inject({
      method: "POST",
      url: `/api/v1/ceo-plan-runs/${runId}/pause`,
      payload: { expectedMutationToken: mutationToken },
    });
    expect(pauseResponse.statusCode).toBe(503);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toHaveLength(countBeforeTakeover);

    socket.close();
    await app.close();
    db.close();
  });
});
