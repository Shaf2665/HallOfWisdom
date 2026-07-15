import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  AgentDetectionResult,
  AgentExecutionOptions,
  AgentRunHandle,
  AgentTaskInput,
  AvailabilityStatus,
  RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";

/** Shared fixture builders for tests only — excluded from the build output. */
export function createTaskInput(overrides: Partial<AgentTaskInput> = {}): AgentTaskInput {
  return {
    hallTask: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Add login page",
      description: "Implement the login page per the design spec.",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
    },
    agentIdentity: {
      agentId: "fake-agent",
      displayName: "Fake Agent",
      adapterId: "hall.fake-agent",
      adapterVersion: "0.1.0",
    },
    runId: "run-1",
    workingDirectory: "C:\\Projects\\hall-of-wisdom",
    ...overrides,
  };
}

export function createFakeDescriptor(adapterId = "hall.fake-agent"): AgentAdapterDescriptor {
  return {
    adapterId,
    displayName: "Fake Agent",
    adapterVersion: "0.1.0",
    supportedAgent: {
      agentId: "fake-agent",
      displayName: "Fake Agent",
      adapterId,
      adapterVersion: "0.1.0",
    },
    capabilities: {
      streaming: true,
      cancellation: false,
      sessionResume: false,
      toolEvents: false,
      fileEditing: false,
      shellExecution: false,
      subagents: false,
      mcp: false,
      acp: false,
    },
    integrationLevel: "native",
    supportedOperatingSystems: ["windows", "macos", "linux"],
  };
}

/** Only used when a FakeAdapter is constructed with an empty event list, so `completion` still has something to resolve with. */
function makeFallbackCancelledEvent(): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: "fallback-event",
    runId: "run-1",
    taskId: "task-1",
    agentId: "fake-agent",
    timestamp: "2026-07-15T12:00:00.000Z",
    sequence: 0,
    type: "run.cancelled",
    payload: { cancelledBy: "system" },
  };
}

class FakeRunHandle implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly completion: Promise<NormalizedAgentEvent>;

  readonly currentState: RunTerminalState = "running";

  constructor(events: NormalizedAgentEvent[], runId = "run-1") {
    this.runId = runId;
    const terminal = events.find((event) =>
      ["run.completed", "run.failed", "run.cancelled"].includes(event.type),
    );
    const lastEvent = events.at(-1);
    this.completion = Promise.resolve(terminal ?? lastEvent ?? makeFallbackCancelledEvent());
    this.events = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<NormalizedAgentEvent>> {
            const value = events.at(index);
            if (value === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            index += 1;
            return Promise.resolve({ done: false, value });
          },
        };
      },
    };
  }

  cancel(): void {
    // no-op: the fake adapter's event list is fixed at construction time.
  }
}

/** Minimal, fully controllable `AgentAdapter` used only to test the runner service and registry in isolation from Mock Agent. */
export class FakeAdapter implements AgentAdapter {
  readonly descriptor: AgentAdapterDescriptor;
  #availability: AvailabilityStatus;
  #events: NormalizedAgentEvent[];
  detectCallCount = 0;

  constructor(options: {
    adapterId?: string;
    availability?: AvailabilityStatus;
    events?: NormalizedAgentEvent[];
  }) {
    this.descriptor = createFakeDescriptor(options.adapterId);
    this.#availability = options.availability ?? "available";
    this.#events = options.events ?? [];
  }

  detect(): Promise<AgentDetectionResult> {
    this.detectCallCount += 1;
    return Promise.resolve({ installed: true, availability: this.#availability });
  }

  startTask(_input: AgentTaskInput, _options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    return Promise.resolve(new FakeRunHandle(this.#events));
  }
}

function makeMinimalLifecycleEvents(input: AgentTaskInput): NormalizedAgentEvent[] {
  const envelope = {
    protocolVersion: "0.1" as const,
    runId: input.runId,
    taskId: input.hallTask.taskId,
    agentId: input.agentIdentity.agentId,
    timestamp: "2026-07-15T12:00:00.000Z",
  };
  return [
    { ...envelope, eventId: "capturing-event-0", sequence: 0, type: "run.started", payload: {} },
    {
      ...envelope,
      eventId: "capturing-event-1",
      sequence: 1,
      type: "run.completed",
      payload: {},
    },
  ];
}

/**
 * `AgentAdapter` used only to prove *what value actually reaches
 * `startTask()`* — every received `AgentTaskInput` is recorded verbatim in
 * `receivedInputs`, in call order, before a minimal valid two-event
 * lifecycle (`run.started` -> `run.completed`) is emitted. No filesystem,
 * network, process, or credential access of any kind: the emitted events
 * are built purely from fields already present on the received input.
 */
export class CapturingAdapter implements AgentAdapter {
  readonly descriptor: AgentAdapterDescriptor;
  readonly receivedInputs: AgentTaskInput[] = [];

  constructor(adapterId = "hall.capturing-agent") {
    this.descriptor = createFakeDescriptor(adapterId);
  }

  detect(): Promise<AgentDetectionResult> {
    return Promise.resolve({ installed: true, availability: "available" });
  }

  startTask(input: AgentTaskInput, _options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    this.receivedInputs.push(input);
    return Promise.resolve(new FakeRunHandle(makeMinimalLifecycleEvents(input), input.runId));
  }
}
