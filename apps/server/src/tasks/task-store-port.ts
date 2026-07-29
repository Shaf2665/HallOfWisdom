import type {
  ExecutionTrust,
  StructuredFailure,
  TaskRequirements,
  TaskStatus,
} from "@hall-of-wisdom/protocol";
import type { TerminalEventType } from "@hall-of-wisdom/hall-runner";
import type { TaskRecord } from "./task-record.js";

/**
 * Everything `TaskOrchestrator`, `ComparisonOrchestrator`, `BoardStore`,
 * and every route need from a task store — extracted, unchanged, from
 * `TaskStore`'s own existing public method signatures (Phase 13). The
 * existing `TaskStore` class satisfies this interface without any change
 * to its body; `SqliteTaskStore` is the durable-mode sibling. Every
 * consumer that used to depend on the concrete `TaskStore` type now
 * depends on this interface instead, so swapping backends at composition
 * time requires no change anywhere else. See
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Storage
 * ports."
 */
export interface TaskStorePort {
  setWorkingDirectory(taskId: string, workingDirectory: string | undefined): void;
  getWorkingDirectory(taskId: string): string | undefined;
  add(record: TaskRecord): void;
  get(taskId: string): TaskRecord;
  list(): TaskRecord[];
  getRevision(taskId: string): number;
  updateStatus(taskId: string, nextStatus: TaskStatus): void;
  recordEventMeta(taskId: string, sequence: number): void;
  setStarted(taskId: string, startedAt: string): void;
  setCompleted(
    taskId: string,
    completedAt: string,
    terminalEventType: TerminalEventType,
    failure?: StructuredFailure,
  ): void;
  setCancellationRequested(taskId: string): void;
  assignIfEligible(
    taskId: string,
    expectedRevision: number,
    expected: {
      readonly status: TaskStatus;
      readonly runId: string | undefined;
      readonly adapterId: string | undefined;
      readonly agentId: string | undefined;
    },
    assignment: {
      readonly adapterId: string;
      readonly agentId: string;
      readonly executionTrust: ExecutionTrust;
      readonly requirements?: TaskRequirements;
    },
  ): TaskRecord;
  clearAssignment(taskId: string): void;
  setRunId(taskId: string, runId: string): void;
  clearRunId(taskId: string): void;
}
