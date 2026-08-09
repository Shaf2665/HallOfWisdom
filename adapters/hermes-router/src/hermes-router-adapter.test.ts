import type { AgentTaskInput, AgentRunHandle } from "@hall-of-wisdom/agent-adapter-sdk";
import { describe, expect, it } from "vitest";
import type {
  HermesExecutionTransportOptions,
  HermesExecutionTransportRun,
} from "./execution-transport.js";
import { HermesRouterAdapter } from "./hermes-router-adapter.js";
import {
  HERMES_PROTOCOL_VERSION,
  type HermesRawEvent,
  type HermesRawTerminalEvent,
} from "./hermes-protocol.js";
import type { DetectionProcessRunner } from "./process-runner.js";

function taskInput(overrides: Partial<AgentTaskInput> = {}): AgentTaskInput {
  return {
    hallTask: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Fix the Hermes bridge",
      description: "Map the raw events.",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    },
    agentIdentity: {
      agentId: "hermes-router",
      displayName: "Hermes Coding Runtime",
      adapterId: "hall.hermes-router",
      adapterVersion: "0.1.0",
    },
    runId: "run-1",
    workingDirectory: "/worktrees/task one",
    ...overrides,
  };
}

function rawEvent(
  sequence: number,
  type: HermesRawEvent["type"],
  payload: Readonly<Record<string, unknown>> = {},
): HermesRawEvent {
  return {
    protocol: HERMES_PROTOCOL_VERSION,
    runtime_version: "0.1.0",
    run_id: "run-1",
    sequence,
    type,
    payload,
  };
}

function completedTransport(): HermesExecutionTransportRun {
  const events = [
    rawEvent(0, "run.started"),
    rawEvent(1, "message.delta", { text: "Done" }),
    rawEvent(2, "run.completed", { summary: "Complete" }),
  ];
  const terminalEvent = events[2] as HermesRawTerminalEvent;
  return {
    events: {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next() {
            const event = events[index];
            index += 1;
            return Promise.resolve(
              event === undefined
                ? { value: undefined, done: true }
                : { value: event, done: false },
            );
          },
        };
      },
    },
    completion: Promise.resolve({ terminalEvent, exitCode: 0, signal: null }),
    currentState: "exited",
    cancel() {
      // Already terminal in this fixture.
    },
  };
}

async function collect(handle: AgentRunHandle) {
  const events = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

describe("HermesRouterAdapter.startTask", () => {
  it("returns a lazy AgentRunHandle and passes trusted prompt/runId/cwd to raw transport", async () => {
    const calls: HermesExecutionTransportOptions[] = [];
    const parentEnv = {
      HALL_HERMES_ROUTER_ROOT: "/opt/Hermes Router",
      HALL_HERMES_PYTHON: "/opt/Python 3/python3",
      HERMES_ROUTER_API_KEY: "must-remain-inherited",
    };
    const adapter = new HermesRouterAdapter({
      platform: "linux",
      parentEnv,
      fs: { isFile: () => true },
      processRunner: { run: () => Promise.resolve({ status: "success", stdout: "{}" }) },
      startTransport(options) {
        calls.push(options);
        return completedTransport();
      },
    });

    const handle = await adapter.startTask(taskInput());
    expect(handle.runId).toBe("run-1");
    expect(handle.currentState).toBe("running");
    expect(calls).toHaveLength(0);

    const events = await collect(handle);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.completed",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      pythonExecutable: "/opt/Python 3/python3",
      runnerPath: "/opt/Hermes Router/hermes_agent_runner.py",
      workingDirectory: "/worktrees/task one",
      runId: "run-1",
      platform: "linux",
    });
    expect(calls[0]?.env).toBe(parentEnv);
    expect(calls[0]?.prompt).toContain("Task title: Fix the Hermes bridge");
    expect(calls[0]?.prompt).toContain("Map the raw events.");
    expect(await handle.completion).toBe(events[2]);
  });

  it("rejects session resumption without invoking transport", async () => {
    let startCount = 0;
    const adapter = new HermesRouterAdapter({
      platform: "linux",
      parentEnv: { HALL_HERMES_ROUTER_ROOT: "/opt/Hermes Router" },
      fs: { isFile: () => true },
      startTransport() {
        startCount += 1;
        return completedTransport();
      },
    });

    await expect(adapter.startTask(taskInput({ sessionId: "session-1" }))).rejects.toThrow(
      /does not support session resumption/u,
    );
    expect(startCount).toBe(0);
  });

  it("keeps detection unsupported after startTask becomes executable", async () => {
    const processRunner: DetectionProcessRunner = {
      run: () =>
        Promise.resolve({
          status: "success",
          stdout: JSON.stringify({
            protocol: "hermes-agent/v1",
            runtime_version: "0.1.0",
            available: true,
            capabilities: [
              "project.read",
              "project.edit",
              "command.execute",
              "structured.events",
              "cancellation",
            ],
            integration_level: "structured_cli",
            execution_trust: "trusted_local",
          }),
        }),
    };
    const adapter = new HermesRouterAdapter({
      platform: "linux",
      parentEnv: { HALL_HERMES_ROUTER_ROOT: "/opt/Hermes Router" },
      fs: { isFile: () => true },
      processRunner,
    });

    await expect(adapter.detect()).resolves.toMatchObject({
      availability: "unsupported",
      executionTrust: "unavailable",
    });
  });
});
