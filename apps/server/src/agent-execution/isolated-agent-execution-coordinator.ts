import type { AgentTaskInput } from "@hall-of-wisdom/agent-adapter-sdk";
import {
  AgentWorktreeGitOperationError,
  AgentWorktreePathError,
} from "../agent-worktrees/agent-worktree-errors.js";
import type { CreateAgentWorktreeResult } from "../agent-worktrees/agent-worktree-manager.js";
import type { ValidatedAgentWorktreeHandle } from "../agent-worktrees/agent-worktree-manager.js";
import type { AgentWorktreeRecord } from "../agent-worktrees/agent-worktree-record.js";
import type { AgentWorktreeStorePort } from "../agent-worktrees/agent-worktree-store-port.js";
import { canonicalizeExistingDirectory } from "../agent-worktrees/path-safety.js";
import { AgentExecutionWorktreePreparationError } from "./agent-execution-errors.js";
import {
  noAgentExecutionIsolationPolicy,
  type AgentExecutionIsolationPolicy,
} from "./isolation-policy.js";

export interface IsolatedAgentExecutionCoordinatorOptions {
  readonly isolationPolicy?: AgentExecutionIsolationPolicy | undefined;
  readonly worktreeManager?: AgentWorktreeCreator | undefined;
  readonly worktreeStore?: AgentWorktreeStorePort | undefined;
  readonly worktreeValidator?: AgentWorktreeValidator | undefined;
}

export interface AgentWorktreeCreator {
  createWorktree(input: {
    readonly hallTaskId: string;
    readonly hallAgentRunId: string;
    readonly adapterId?: string | undefined;
    readonly agentId?: string | undefined;
    readonly sourceWorkingDirectory: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<CreateAgentWorktreeResult>;
  /**
   * Phase 16.5 — optional so every existing fake `worktreeManager` in tests
   * (which only ever implements `createWorktree`) keeps compiling unchanged.
   * `cleanupWorktree` on the real `AgentWorktreeManager` already implements
   * the full safe reconstruct/validate/`git worktree remove --force`
   * sequence — this coordinator never reimplements it.
   */
  cleanupWorktree?(worktreeId: string, signal?: AbortSignal): Promise<AgentWorktreeRecord>;
}

export type WorktreeCleanupResult =
  { readonly ok: true } | { readonly ok: false; readonly code: string };

export interface AgentWorktreeValidator {
  validateReadyWorktree(input: {
    readonly worktreeId: string;
    readonly hallTaskId?: string | undefined;
    readonly hallAgentRunId?: string | undefined;
    readonly sourceWorkingDirectory?: string | undefined;
    readonly requireHeadAtBase?: boolean | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ValidatedAgentWorktreeHandle>;
}

export interface PrepareAgentExecutionInput {
  readonly taskInput: AgentTaskInput;
  readonly adapterId: string;
  readonly approvedSourceWorkingDirectory: string;
  readonly signal?: AbortSignal | undefined;
}

export interface PreparedAgentExecution {
  readonly taskInput: AgentTaskInput;
  readonly isolation: "none" | "worktree";
  readonly worktreeId: string | undefined;
}

export class IsolatedAgentExecutionCoordinator {
  readonly #isolationPolicy: AgentExecutionIsolationPolicy;
  readonly #worktreeManager: AgentWorktreeCreator | undefined;
  readonly #worktreeStore: AgentWorktreeStorePort | undefined;
  readonly #worktreeValidator: AgentWorktreeValidator | undefined;

  constructor(options: IsolatedAgentExecutionCoordinatorOptions = {}) {
    this.#isolationPolicy = options.isolationPolicy ?? noAgentExecutionIsolationPolicy;
    this.#worktreeManager = options.worktreeManager;
    this.#worktreeStore = options.worktreeStore;
    this.#worktreeValidator = options.worktreeValidator;
  }

  async prepare(input: PrepareAgentExecutionInput): Promise<PreparedAgentExecution> {
    const requiresIsolation = this.#isolationPolicy.requiresIsolation({
      adapterId: input.adapterId,
      hallTaskId: input.taskInput.hallTask.taskId,
      hallAgentRunId: input.taskInput.runId,
    });
    if (!requiresIsolation) {
      return { taskInput: input.taskInput, isolation: "none", worktreeId: undefined };
    }
    if (
      this.#worktreeManager === undefined ||
      this.#worktreeStore === undefined ||
      this.#worktreeValidator === undefined
    ) {
      throw new AgentExecutionWorktreePreparationError(
        "Isolated execution is configured, but worktree services are not available.",
      );
    }

    const sourceWorkingDirectory = canonicalizeExistingDirectory(
      input.approvedSourceWorkingDirectory,
      "approved source working directory",
    );
    const existing = this.#worktreeStore.findActiveByAgentRunId(input.taskInput.runId);
    const prepared =
      existing === undefined
        ? await this.#createWorktree(this.#worktreeManager, input, sourceWorkingDirectory)
        : await this.#reuseWorktree(input, sourceWorkingDirectory);

    return {
      taskInput: {
        ...input.taskInput,
        workingDirectory: prepared.agentWorkingDirectory,
      },
      isolation: "worktree",
      worktreeId: prepared.record.worktreeId,
    };
  }

  async #createWorktree(
    worktreeManager: AgentWorktreeCreator,
    input: PrepareAgentExecutionInput,
    sourceWorkingDirectory: string,
  ): Promise<CreateAgentWorktreeResult> {
    try {
      return await worktreeManager.createWorktree({
        hallTaskId: input.taskInput.hallTask.taskId,
        hallAgentRunId: input.taskInput.runId,
        adapterId: input.adapterId,
        agentId: input.taskInput.agentIdentity.agentId,
        sourceWorkingDirectory,
        signal: input.signal,
      });
    } catch (error) {
      throw toPreparationError(error);
    }
  }

  /**
   * Phase 16.5 runtime cleanup — called by `TaskOrchestrator` only after
   * the execution artifact for this exact worktree's run has already been
   * durably persisted (or confirmed as an idempotent match), and only ever
   * with a real, non-`undefined` worktree ID — `TaskOrchestrator` never
   * calls this at all for a non-isolated execution (no worktree ID),
   * which is the case this method has no opinion about and never needs
   * to. Deliberately fail-soft: cleanup failure is bounded and returned,
   * never thrown, so a caller can log it without ever letting it change a
   * task's already-recorded terminal outcome. A REAL worktree ID with no
   * cleaner available (a coordinator built without a worktree manager, or
   * one whose manager does not implement `cleanupWorktree`) is itself a
   * failure to report, never a silent success — claiming a worktree was
   * cleaned when nothing actually attempted to clean it would leave a
   * real Git worktree behind while every durable record believed it was
   * gone.
   */
  async cleanupWorktree(worktreeId: string, signal?: AbortSignal): Promise<WorktreeCleanupResult> {
    if (this.#worktreeManager?.cleanupWorktree === undefined) {
      return { ok: false, code: "AGENT_WORKTREE_CLEANER_UNAVAILABLE" };
    }
    try {
      const record = await this.#worktreeManager.cleanupWorktree(worktreeId, signal);
      return record.status === "cleaned"
        ? { ok: true }
        : { ok: false, code: "AGENT_WORKTREE_CLEANUP_INCOMPLETE" };
    } catch (error) {
      if (error instanceof AgentWorktreeGitOperationError) {
        return { ok: false, code: error.safeFailureCode };
      }
      return { ok: false, code: "AGENT_WORKTREE_CLEANUP_FAILED" };
    }
  }

  async #reuseWorktree(
    input: PrepareAgentExecutionInput,
    sourceWorkingDirectory: string,
  ): Promise<CreateAgentWorktreeResult> {
    const record = this.#worktreeStore?.findActiveByAgentRunId(input.taskInput.runId);
    if (record === undefined || this.#worktreeValidator === undefined) {
      throw new AgentExecutionWorktreePreparationError(
        "Existing worktree record does not match this execution.",
      );
    }
    if (
      record.hallTaskId !== input.taskInput.hallTask.taskId ||
      record.hallAgentRunId !== input.taskInput.runId ||
      record.status !== "ready"
    ) {
      throw new AgentExecutionWorktreePreparationError(
        "Existing worktree record does not match this execution.",
      );
    }
    try {
      const handle = await this.#worktreeValidator.validateReadyWorktree({
        worktreeId: record.worktreeId,
        hallTaskId: input.taskInput.hallTask.taskId,
        hallAgentRunId: input.taskInput.runId,
        sourceWorkingDirectory,
        requireHeadAtBase: true,
        signal: input.signal,
      });
      return { record: handle.record, agentWorkingDirectory: handle.agentWorkingDirectory };
    } catch (error) {
      throw toPreparationError(error);
    }
  }
}

function toPreparationError(error: unknown): AgentExecutionWorktreePreparationError {
  if (error instanceof AgentExecutionWorktreePreparationError) return error;
  if (error instanceof AgentWorktreeGitOperationError) {
    return new AgentExecutionWorktreePreparationError(error.safeFailureSummary);
  }
  if (error instanceof AgentWorktreePathError) {
    return new AgentExecutionWorktreePreparationError(error.message);
  }
  return new AgentExecutionWorktreePreparationError();
}
