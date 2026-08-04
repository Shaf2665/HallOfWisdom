import type { AgentTaskInput } from "@hall-of-wisdom/agent-adapter-sdk";
import {
  AgentWorktreeGitOperationError,
  AgentWorktreePathError,
} from "../agent-worktrees/agent-worktree-errors.js";
import type { CreateAgentWorktreeResult } from "../agent-worktrees/agent-worktree-manager.js";
import type { ValidatedAgentWorktreeHandle } from "../agent-worktrees/agent-worktree-manager.js";
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
    readonly sourceWorkingDirectory: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<CreateAgentWorktreeResult>;
}

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
        sourceWorkingDirectory,
        signal: input.signal,
      });
    } catch (error) {
      throw toPreparationError(error);
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
