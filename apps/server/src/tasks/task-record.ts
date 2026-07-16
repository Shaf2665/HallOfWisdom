import type { HallTask, StructuredFailure } from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";

/**
 * Everything Hall Core keeps about one task. Deliberately excludes
 * anything unsafe or internal-only: no `AbortController`, no
 * `AgentRunHandle`, no raw `Error` objects, and — critically — no
 * canonical absolute working directory (that lives only in
 * `TaskOrchestrator`'s private sidecar map; see "Assignment and Start
 * separation" in `docs/architecture/0006-kanban-board.md`). Every field
 * here is safe to serialize directly as an HTTP response body.
 *
 * `runId`/`adapterId`/`agentId` are `undefined` for a planning task that
 * has not been assigned (backlog/ready) or started (assigned, before
 * `POST .../start`) — a deferred task is a real `TaskRecord` from the
 * moment it's created, just one with no run yet. They are never set to an
 * empty string as a substitute for "not yet known".
 */
export interface TaskRecord {
  task: HallTask;
  runId: string | undefined;
  adapterId: string | undefined;
  agentId: string | undefined;
  eventCount: number;
  lastSequence: number | undefined;
  terminalEventType: TerminalEventType | undefined;
  failure: StructuredFailure | undefined;
  cancellationRequested: boolean;
  readonly createdAt: string;
  startedAt: string | undefined;
  completedAt: string | undefined;
}
