import type { HallTask, StructuredFailure } from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";

/**
 * Everything Hall Core keeps about one task. Deliberately excludes
 * anything unsafe or internal-only: no `AbortController`, no
 * `AgentRunHandle`, no raw `Error` objects. Every field here is safe to
 * serialize directly as an HTTP response body.
 */
export interface TaskRecord {
  task: HallTask;
  readonly runId: string;
  readonly adapterId: string;
  readonly agentId: string;
  eventCount: number;
  lastSequence: number | undefined;
  terminalEventType: TerminalEventType | undefined;
  failure: StructuredFailure | undefined;
  cancellationRequested: boolean;
  readonly createdAt: string;
  startedAt: string | undefined;
  completedAt: string | undefined;
}
