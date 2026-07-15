import { parseNormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { AgentExecutionOptions, AgentTaskInput } from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent, StructuredFailure } from "@hall-of-wisdom/protocol";
import type { AgentRegistry } from "./agent-registry.js";
import {
  EXIT_CODES,
  exitCodeForTerminalEvent,
  isTerminalEventType,
  type ExitCode,
  type TerminalEventType,
} from "./exit-codes.js";
import { NoTerminalEventError, UnexpectedRunnerStateError } from "./errors.js";

export interface RunTaskRequest {
  readonly registry: AgentRegistry;
  readonly adapterId: string;
  readonly taskInput: AgentTaskInput;
  readonly options?: AgentExecutionOptions;
  /** Invoked once per validated event, in stream order, before termination is checked. */
  readonly onEvent?: (event: NormalizedAgentEvent) => void;
}

export interface RunTaskResult {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly terminalEventType: TerminalEventType;
  readonly exitCode: ExitCode;
  readonly eventCount: number;
  readonly failure?: StructuredFailure;
}

/**
 * Runs one task through a registered adapter and returns a typed result.
 * Deliberately does not call `process.exit()` anywhere — only the CLI
 * entry point may end the process, so this function stays reusable by
 * anything else that wants to run a task programmatically (a future Hall
 * Core service, a test, another CLI).
 */
export async function runTask(request: RunTaskRequest): Promise<RunTaskResult> {
  const adapter = request.registry.resolve(request.adapterId);

  const detection = await adapter.detect();
  if (detection.availability !== "available") {
    return {
      runId: request.taskInput.runId,
      taskId: request.taskInput.hallTask.taskId,
      agentId: request.taskInput.agentIdentity.agentId,
      terminalEventType: "run.failed",
      exitCode: EXIT_CODES.failed,
      eventCount: 0,
      failure: {
        code: "ADAPTER_UNAVAILABLE",
        message: `Adapter "${request.adapterId}" is not available (status: ${detection.availability}).`,
        retryable: detection.availability === "busy" || detection.availability === "rate_limited",
      },
    };
  }

  const handle = await adapter.startTask(request.taskInput, request.options);

  let eventCount = 0;
  let terminalEvent: NormalizedAgentEvent | undefined;

  for await (const rawEvent of handle.events) {
    // Defense in depth: adapters are already required to emit only valid,
    // guard-ordered events, but the runner re-validates at this trust
    // boundary rather than assuming every adapter obeys that contract.
    const event = parseNormalizedAgentEvent(rawEvent);

    if (terminalEvent) {
      throw new UnexpectedRunnerStateError(
        `Received event "${event.type}" (sequence ${String(event.sequence)}) after terminal event "${terminalEvent.type}" for runId "${request.taskInput.runId}".`,
      );
    }

    eventCount += 1;
    request.onEvent?.(event);

    if (isTerminalEventType(event.type)) {
      terminalEvent = event;
    }
  }

  if (!terminalEvent) {
    throw new NoTerminalEventError(request.taskInput.runId);
  }

  return buildResult(request.taskInput, terminalEvent, eventCount);
}

function buildResult(
  taskInput: AgentTaskInput,
  terminalEvent: NormalizedAgentEvent,
  eventCount: number,
): RunTaskResult {
  if (!isTerminalEventType(terminalEvent.type)) {
    throw new UnexpectedRunnerStateError(
      `"${terminalEvent.type}" is not a recognized terminal event type.`,
    );
  }

  const base = {
    runId: taskInput.runId,
    taskId: taskInput.hallTask.taskId,
    agentId: taskInput.agentIdentity.agentId,
    terminalEventType: terminalEvent.type,
    exitCode: exitCodeForTerminalEvent(terminalEvent),
    eventCount,
  };

  if (terminalEvent.type === "run.failed") {
    return { ...base, failure: terminalEvent.payload.failure };
  }

  return base;
}
