import type { AgentWorktreeLifecycleStatus } from "./agent-worktree-record.js";

const MAX_SAFE_DETAIL_CHARS = 500;
const SAFE_CODE_PATTERN = /^[A-Z0-9_:-]{1,80}$/;

export abstract class AgentWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AgentWorktreeNotFoundError extends AgentWorktreeError {
  constructor(worktreeId: string) {
    super(`No agent worktree found with id "${worktreeId}".`);
  }
}

export class AgentWorktreeConflictError extends AgentWorktreeError {}

export class AgentWorktreeInvalidTransitionError extends AgentWorktreeError {
  constructor(
    worktreeId: string,
    from: AgentWorktreeLifecycleStatus,
    to: AgentWorktreeLifecycleStatus,
  ) {
    super(`Invalid agent worktree lifecycle transition for "${worktreeId}": ${from} -> ${to}.`);
  }
}

export class AgentWorktreeCorruptRecordError extends AgentWorktreeError {
  constructor(worktreeId: string) {
    super(`Agent worktree "${worktreeId}" contains invalid stored data.`);
  }
}

export class AgentWorktreePathError extends AgentWorktreeError {}

export class AgentWorktreeSourceNotCleanError extends AgentWorktreeError {
  constructor() {
    super("Isolated execution currently requires a clean source repository.");
  }
}

export class AgentWorktreeGitOperationError extends AgentWorktreeError {
  readonly safeFailureCode: string;
  readonly safeFailureSummary: string;

  constructor(safeFailureCode: string, safeFailureSummary: string) {
    super(`${sanitizeFailureCode(safeFailureCode)}: ${boundSafeSummary(safeFailureSummary)}`);
    this.safeFailureCode = sanitizeFailureCode(safeFailureCode);
    this.safeFailureSummary = boundSafeSummary(safeFailureSummary);
  }
}

export function sanitizeFailureCode(code: string): string {
  const normalized = code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_");
  if (SAFE_CODE_PATTERN.test(normalized)) return normalized;
  return "AGENT_WORKTREE_FAILURE";
}

export function boundSafeSummary(summary: string): string {
  const trimmed = summary.replace(/\s+/g, " ").trim();
  if (trimmed.length <= MAX_SAFE_DETAIL_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SAFE_DETAIL_CHARS)}…`;
}
