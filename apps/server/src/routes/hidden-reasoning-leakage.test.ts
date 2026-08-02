import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type {
  AgentAdapter,
  AgentDetectionResult,
  AgentRunHandle,
  AgentTaskInput,
  RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { buildTestApp, validCreateTaskBody, waitUntil, type TestHarness } from "../test-support.js";
import type { createHallCoreApp } from "../app.js";

/**
 * Phase 15.7 — security-matrix scenario 29 ("Hidden reasoning
 * persistence"), end-to-end pipeline half. `../../packages/protocol/src/events.test.ts`
 * proves the schema itself rejects reasoning-shaped fields at parse time;
 * this file proves what actually happens when a MISBEHAVING adapter (real
 * plugin code Hall Core cannot fully trust at the type level — JavaScript
 * has no runtime enforcement of a TypeScript interface) tries to smuggle
 * one through anyway. `runTask()` (`@hall-of-wisdom/hall-runner`) already
 * re-validates every event via `parseNormalizedAgentEvent` at the
 * adapter/Hall-Core trust boundary, strictly BEFORE it ever reaches
 * `TaskOrchestrator#handleEvent`/`EventStore.append()` — so a forged event
 * is rejected outright (never partially accepted with the field silently
 * dropped), and the task fails through the exact same bounded,
 * safe-message infrastructure-failure path `../ceo-execution/ceo-plan-execution-stderr-leakage.test.ts`
 * and `./stderr-leakage.test.ts` already exercise. Only a synthetic
 * fixture marker is ever used as the forged field's value — no real
 * reasoning content is created, requested, or exposed.
 */
const HIDDEN_REASONING_MARKER = "PHASE15_HIDDEN_REASONING_MUST_NOT_PERSIST";
const HIDDEN_REASONING_ADAPTER_ID = "hall.hidden-reasoning-fixture";

function createHiddenReasoningAdapter(): AgentAdapter {
  return {
    descriptor: {
      adapterId: HIDDEN_REASONING_ADAPTER_ID,
      displayName: "Hidden Reasoning Fixture",
      adapterVersion: "0.0.0",
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      supportedAgent: {
        agentId: "hidden-reasoning-agent",
        displayName: "Hidden Reasoning Fixture",
        adapterId: HIDDEN_REASONING_ADAPTER_ID,
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
    startTask(input: AgentTaskInput): Promise<AgentRunHandle> {
      const runId = input.runId;
      const taskId = input.hallTask.taskId;
      const agentId = input.agentIdentity.agentId;

      async function* generate(): AsyncGenerator<NormalizedAgentEvent> {
        await Promise.resolve();
        yield {
          protocolVersion: "0.1",
          eventId: "event-1",
          runId,
          taskId,
          agentId,
          timestamp: new Date().toISOString(),
          sequence: 0,
          type: "run.started",
          payload: {},
        };
        // Deliberately malformed — a real adapter would never construct
        // this via `EventFactory` (its `messageDelta()` method has no
        // parameter for an extra field), but nothing at the JavaScript
        // runtime level stops a misbehaving or compromised plugin from
        // yielding an arbitrary object shape here. Cast through
        // `unknown` specifically to simulate that untrusted-plugin
        // boundary, not to bypass this file's own type-checking.
        yield {
          protocolVersion: "0.1",
          eventId: "event-2",
          runId,
          taskId,
          agentId,
          timestamp: new Date().toISOString(),
          sequence: 1,
          type: "message.delta",
          payload: { text: "Working...", reasoning: HIDDEN_REASONING_MARKER },
        } as unknown as NormalizedAgentEvent;
        // Never reached in practice — `runTask()`'s re-validation throws
        // on the event above before this generator is asked for another
        // value.
        yield {
          protocolVersion: "0.1",
          eventId: "event-3",
          runId,
          taskId,
          agentId,
          timestamp: new Date().toISOString(),
          sequence: 2,
          type: "run.completed",
          payload: {},
        };
      }

      const events = generate();
      const handle: AgentRunHandle = {
        runId,
        events,
        completion: new Promise(() => {
          // Never resolves in this fixture — the run always ends via the
          // re-validation throw, never a natural completion.
        }),
        get currentState(): RunTerminalState {
          return "running";
        },
        cancel(): void {
          // No-op — this fixture's run always ends via the schema
          // rejection path, never a cancellation.
        },
      };
      return Promise.resolve(handle);
    },
  };
}

type HallCoreApp = Awaited<ReturnType<typeof createHallCoreApp>>;

async function startEphemeral(app: HallCoreApp): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address;
}

function collectMessages(socket: WebSocket): {
  rawFrames: string[];
  events: NormalizedAgentEvent[];
  closeCode: Promise<number>;
} {
  const rawFrames: string[] = [];
  const events: NormalizedAgentEvent[] = [];
  socket.on("message", (data: Buffer) => {
    const text = data.toString();
    rawFrames.push(text);
    events.push(JSON.parse(text) as NormalizedAgentEvent);
  });
  const closeCode = new Promise<number>((resolve) => {
    socket.on("close", (code: number) => {
      resolve(code);
    });
  });
  return { rawFrames, events, closeCode };
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
}

describe("Security matrix scenario 29 — hidden reasoning persistence (REST + WebSocket)", () => {
  let tempRoot: string;
  let app: HallCoreApp;
  let harness: TestHarness;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-hidden-reasoning-test-"));
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("a misbehaving fixture adapter that yields an event with a forged reasoning field never gets that field accepted, persisted, or exposed — the event is rejected at the adapter/Hall-Core trust boundary and the task fails through the bounded, safe infrastructure-failure path", async () => {
    const built = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [createHiddenReasoningAdapter()],
    });
    app = built.app;
    harness = built.harness;
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody({ adapterId: HIDDEN_REASONING_ADAPTER_ID }),
    });
    // Not checked for the bare substring "reasoning" here or below: the
    // fixture's own `adapterId`/`agentId` legitimately contain it as a
    // self-descriptive identifier (a safe field), so that check would
    // false-positive on this test's own setup rather than detect a real
    // leak. `HIDDEN_REASONING_MARKER` — the forged VALUE — is the actual,
    // precise leak signal; the `message.delta` event-type absence checks
    // below are the structural proof that the forged event itself was
    // never accepted at all, field name included.
    expect(created.body).not.toContain(HIDDEN_REASONING_MARKER);
    const taskId = created.json<{ task: { taskId: string } }>().task.taskId;

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/tasks/${taskId}/events`);
    const { rawFrames, events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);

    await waitUntil(() => harness.taskStore.get(taskId).task.status === "failed");
    await waitUntil(() => events.some((e) => e.type === "run.failed"));
    socket.close();
    await closeCode;

    // The valid run.started event that preceded the forged one is still
    // delivered — only the forged event (and anything after it) is
    // rejected, never the whole stream silently dropped.
    expect(events.some((e) => e.type === "run.started")).toBe(true);
    // The forged message.delta event itself never reached any subscriber
    // — it was rejected before `onEvent` was ever called for it.
    expect(events.some((e) => e.type === "message.delta")).toBe(false);

    for (const frame of rawFrames) {
      expect(frame).not.toContain(HIDDEN_REASONING_MARKER);
    }

    const failedEvent = events.find((e) => e.type === "run.failed");
    expect(failedEvent).toBeDefined();
    if (failedEvent) {
      expect(failedEvent.payload.failure.code).toBe("TASK_EXECUTION_FAILED");
      expect(failedEvent.payload.failure.message).toBe(
        "Hall Core could not complete this task due to an unexpected internal error.",
      );
    }

    // Note: `GET /api/v1/tasks/:taskId/events` is a WebSocket-only route
    // for plain tasks (no separate REST replay endpoint, unlike CEO plan
    // runs) — already exercised above via the socket.
    const detailResponse = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(detailResponse.body).not.toContain(HIDDEN_REASONING_MARKER);

    const record = harness.taskStore.get(taskId);
    expect(JSON.stringify(record)).not.toContain(HIDDEN_REASONING_MARKER);
    expect(record.failure?.code).toBe("TASK_EXECUTION_FAILED");
  });
});
