import { randomUUID } from "node:crypto";
import { parseAgentTaskInput, type AgentTaskInput } from "@hall-of-wisdom/agent-adapter-sdk";
import type { AgentIdentity } from "@hall-of-wisdom/protocol";
import type { CliOptions } from "./cli-args.js";
import type { ValidatedWorkspace } from "./workspace-validation.js";

export interface BuildTaskInputParams {
  readonly cliOptions: CliOptions;
  readonly validatedWorkspace: ValidatedWorkspace;
  readonly agentIdentity: AgentIdentity;
  readonly runId: string;
  readonly taskId?: string;
  readonly now?: string;
}

/**
 * Builds the validated `AgentTaskInput` the CLI passes to an adapter.
 *
 * Uses `validatedWorkspace.workingDirectory` — the canonicalized,
 * symlink-resolved, containment-checked path `validateWorkspace()`
 * returned — rather than the raw `cliOptions.workingDirectory` string the
 * user typed. An earlier version of this file used the raw value, which
 * meant the path Hall Runner actually validated and the path an adapter
 * actually received could differ; see
 * `docs/architecture/0003-hall-runner-boundary.md` ("What this does and
 * does not guarantee") for what canonicalization does and does not
 * protect against.
 *
 * Extracted from `cli.ts` specifically so this step is unit-testable
 * without spawning a process or exercising the full CLI argument-parsing
 * and signal-handling machinery.
 */
export function buildTaskInput(params: BuildTaskInputParams): AgentTaskInput {
  const now = params.now ?? new Date().toISOString();
  return parseAgentTaskInput({
    hallTask: {
      taskId: params.taskId ?? randomUUID(),
      projectId: "hall-runner-dev",
      title: params.cliOptions.title,
      description: params.cliOptions.description ?? "",
      priority: "normal",
      status: "running",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
    },
    agentIdentity: params.agentIdentity,
    runId: params.runId,
    workingDirectory: params.validatedWorkspace.workingDirectory,
  });
}
