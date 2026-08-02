import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AgentAdapter, AgentDetectionResult } from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { buildTestApp, validCreateTaskBody, waitUntil, type TestHarness } from "../test-support.js";
import type { createHallCoreApp } from "../app.js";

/**
 * Phase 15.7 — security-matrix scenario 28 ("Raw stderr leakage"), REST/WS
 * half. The CEO-execution half (run detail, execution events, Board
 * summary) lives in
 * `../ceo-execution/ceo-plan-execution-stderr-leakage.test.ts` — both
 * exercise the exact same underlying mechanism
 * (`TaskOrchestrator#failTaskOnUnhandledExecutionError`, which the CEO
 * scheduler's own launch path reuses unchanged), so this file covers the
 * plain-task REST/WebSocket surface specifically.
 *
 * `PRIVATE_STDERR_MARKER` stands in for raw provider stderr — a real
 * adapter's `startTask()` throwing mid-launch (a spawn failure, a crashed
 * child process, anything) is exactly this shape: an `Error` whose
 * `.message` is unsanitized and provider-controlled. No real provider is
 * ever invoked; this fixture adapter throws synchronously and
 * deterministically, in-process.
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
      // Shaped like a real spawn/process failure — the private marker
      // sits inside otherwise-plausible "stderr" text, exactly where a
      // real adapter's raw provider output would land.
      return Promise.reject(
        new Error(
          `spawn failed: fatal: could not start provider process: ${PRIVATE_STDERR_MARKER} (exit code 127)`,
        ),
      );
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

describe("Security matrix scenario 28 — raw stderr leakage (REST + WebSocket)", () => {
  let tempRoot: string;
  let app: HallCoreApp;
  let harness: TestHarness;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-stderr-leak-test-"));
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("a fixture adapter that throws with a private stderr marker embedded in its Error never leaks that marker into the created-task response, task detail, task events REST, or task events WebSocket — only the fixed, bounded TASK_EXECUTION_FAILED message ever appears", async () => {
    const built = await buildTestApp({
      workspaceRoot: tempRoot,
      additionalAdapters: [createStderrLeakAdapter()],
    });
    app = built.app;
    harness = built.harness;
    const address = await startEphemeral(app);
    const wsBaseUrl = address.replace("http://", "ws://");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validCreateTaskBody({ adapterId: STDERR_LEAK_ADAPTER_ID }),
    });
    // The immediate-mode creation response itself must never carry the
    // marker, however the adapter's throw is ultimately surfaced.
    expect(created.body).not.toContain(PRIVATE_STDERR_MARKER);
    const taskId = created.json<{ task: { taskId: string } }>().task.taskId;

    const socket = new WebSocket(`${wsBaseUrl}/api/v1/tasks/${taskId}/events`);
    const { rawFrames, events, closeCode } = collectMessages(socket);
    await waitForOpen(socket);

    await waitUntil(() => harness.taskStore.get(taskId).task.status === "failed");
    await waitUntil(() => events.some((e) => e.type === "run.failed"));
    socket.close();
    await closeCode;

    // 1. WebSocket payloads: raw frame text (not just the parsed object)
    // never contains the marker.
    for (const frame of rawFrames) {
      expect(frame).not.toContain(PRIVATE_STDERR_MARKER);
    }
    const failedEvent = events.find((e) => e.type === "run.failed");
    expect(failedEvent).toBeDefined();
    if (failedEvent) {
      expect(failedEvent.payload.failure.code).toBe("TASK_EXECUTION_FAILED");
      expect(failedEvent.payload.failure.message).toBe(
        "Hall Core could not complete this task due to an unexpected internal error.",
      );
    }

    // 2. REST error/detail responses: task detail over HTTP.
    const detailResponse = await app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(detailResponse.body).not.toContain(PRIVATE_STDERR_MARKER);
    const detail = detailResponse.json<{
      task: { status: string };
      failure?: { code: string; message: string };
    }>();
    expect(detail.task.status).toBe("failed");
    expect(detail.failure?.code).toBe("TASK_EXECUTION_FAILED");
    expect(detail.failure?.message).not.toContain(PRIVATE_STDERR_MARKER);

    // 3. REST task events replay endpoint.
    const eventsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}/events`,
    });
    expect(eventsResponse.body).not.toContain(PRIVATE_STDERR_MARKER);

    // 4. Serialized task failure projection, read directly from the store
    // (the same record REST/WS both derive from) — the safe bounded code
    // may appear; the raw marker must never appear anywhere in the record.
    const record = harness.taskStore.get(taskId);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_STDERR_MARKER);
    expect(record.failure?.code).toBe("TASK_EXECUTION_FAILED");
  });
});
