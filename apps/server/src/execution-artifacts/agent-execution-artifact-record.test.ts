import { describe, expect, it } from "vitest";
import {
  AgentExecutionArtifactValidationError,
  AgentExecutionArtifactCorruptRecordError,
} from "./agent-execution-artifact-errors.js";
import {
  AGENT_EXECUTION_ARTIFACT_LIMITS,
  compareArtifactStrings,
  createAgentExecutionArtifactRecord,
  normalizeChangedPath,
  parseStoredAgentExecutionArtifactRecord,
  toPublicAgentExecutionArtifact,
  type CreateAgentExecutionArtifactInput,
  type PublicAgentExecutionArtifact,
} from "./agent-execution-artifact-record.js";

const STARTED_AT = "2026-08-03T10:00:00.000Z";
const FINISHED_AT = "2026-08-03T10:02:00.000Z";
const CREATED_AT = "2026-08-03T10:02:01.000Z";
const COMMIT_40 = "a".repeat(40);
const COMMIT_64 = "b".repeat(64);

function input(
  overrides: Partial<CreateAgentExecutionArtifactInput> = {},
): CreateAgentExecutionArtifactInput {
  return {
    artifactId: "artifact-1",
    hallTaskId: "task-1",
    hallAgentRunId: "run-1",
    adapterId: "codex",
    worktreeId: "wt-1",
    providerExecutionRef: "session-1",
    outcome: "completed",
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    durationMs: 120_000,
    exitCode: 0,
    baseCommit: COMMIT_40,
    finalCommit: COMMIT_64,
    changedFiles: ["src/a.ts"],
    diffSummary: { filesChanged: 1, insertions: 2, deletions: 3 },
    finalSummary: "Done.",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("AgentExecutionArtifact domain model", () => {
  it("accepts a valid completed artifact", () => {
    const record = createAgentExecutionArtifactRecord(input());
    expect(record.outcome).toBe("completed");
    expect(record.terminalReasonCode).toBeUndefined();
    expect(record.safeTerminalSummary).toBeUndefined();
  });

  it("accepts a valid failed artifact", () => {
    const record = createAgentExecutionArtifactRecord(
      input({
        outcome: "failed",
        exitCode: 1,
        terminalReasonCode: "PROVIDER:FAILED",
        safeTerminalSummary: "Agent failed safely.",
      }),
    );
    expect(record.outcome).toBe("failed");
    expect(record.terminalReasonCode).toBe("PROVIDER:FAILED");
  });

  it("accepts valid cancelled and abandoned artifacts", () => {
    expect(
      createAgentExecutionArtifactRecord(
        input({ outcome: "cancelled", terminalReasonCode: "USER_CANCELLED" }),
      ).outcome,
    ).toBe("cancelled");
    expect(
      createAgentExecutionArtifactRecord(
        input({ outcome: "abandoned", terminalReasonCode: "PROCESS:LOST" }),
      ).outcome,
    ).toBe("abandoned");
  });

  it("rejects a completed artifact with terminal failure details", () => {
    expect(() =>
      createAgentExecutionArtifactRecord(
        input({ terminalReasonCode: "SHOULD_NOT_EXIST", safeTerminalSummary: "failed" }),
      ),
    ).toThrow(AgentExecutionArtifactValidationError);
  });

  it("rejects a completed artifact with a nonzero exit code", () => {
    expect(() => createAgentExecutionArtifactRecord(input({ exitCode: 2 }))).toThrow(
      AgentExecutionArtifactValidationError,
    );
  });

  it("requires reason codes for non-completed outcomes", () => {
    expect(() => createAgentExecutionArtifactRecord(input({ outcome: "failed" }))).toThrow(
      AgentExecutionArtifactValidationError,
    );
  });

  it("rejects finish times before start times", () => {
    expect(() =>
      createAgentExecutionArtifactRecord(
        input({
          startedAt: FINISHED_AT,
          finishedAt: STARTED_AT,
        }),
      ),
    ).toThrow(AgentExecutionArtifactValidationError);
  });

  it("rejects negative duration", () => {
    expect(() => createAgentExecutionArtifactRecord(input({ durationMs: -1 }))).toThrow(
      AgentExecutionArtifactValidationError,
    );
  });

  it("rejects invalid ISO timestamps", () => {
    expect(() => createAgentExecutionArtifactRecord(input({ startedAt: "2026-08-03" }))).toThrow(
      AgentExecutionArtifactValidationError,
    );
  });

  it("rejects invalid commits", () => {
    expect(() => createAgentExecutionArtifactRecord(input({ baseCommit: "abc123" }))).toThrow(
      AgentExecutionArtifactValidationError,
    );
  });

  it("bounds oversized terminal summaries safely", () => {
    const record = createAgentExecutionArtifactRecord(
      input({
        outcome: "failed",
        terminalReasonCode: "FAILED",
        safeTerminalSummary: ` ${"x".repeat(600)}\n\nraw-ish text `,
      }),
    );
    expect(record.safeTerminalSummary).toHaveLength(
      AGENT_EXECUTION_ARTIFACT_LIMITS.safeTerminalSummary,
    );
    expect(record.safeTerminalSummary).not.toContain("\n");
  });

  it("truncates oversized final summaries and sets the flag", () => {
    const record = createAgentExecutionArtifactRecord(
      input({ finalSummary: "x".repeat(AGENT_EXECUTION_ARTIFACT_LIMITS.finalSummary + 1) }),
    );
    expect(record.finalSummary).toHaveLength(AGENT_EXECUTION_ARTIFACT_LIMITS.finalSummary);
    expect(record.finalSummaryTruncated).toBe(true);
  });

  it("does not mark a normal final summary as truncated", () => {
    const record = createAgentExecutionArtifactRecord(input({ finalSummary: "short" }));
    expect(record.finalSummary).toBe("short");
    expect(record.finalSummaryTruncated).toBe(false);
  });

  it("does not split a UTF-16 surrogate pair while truncating final summaries", () => {
    const record = createAgentExecutionArtifactRecord(
      input({
        finalSummary: `${"x".repeat(AGENT_EXECUTION_ARTIFACT_LIMITS.finalSummary - 1)}🙂`,
      }),
    );
    expect(record.finalSummaryTruncated).toBe(true);
    expect(record.finalSummary?.endsWith("\ud83d")).toBe(false);
  });

  it("rejects impossible stored combinations", () => {
    const record = createAgentExecutionArtifactRecord(input());
    expect(() =>
      parseStoredAgentExecutionArtifactRecord({
        ...record,
        outcome: "completed",
        terminalReasonCode: "BAD",
      }),
    ).toThrow(AgentExecutionArtifactCorruptRecordError);
  });

  it("uses fixed binary string ordering instead of locale-dependent ordering", () => {
    expect(["z", "A", "a", "Z"].sort(compareArtifactStrings)).toEqual(["A", "Z", "a", "z"]);
  });

  it("rejects changed-file and diff-summary count mismatches", () => {
    expect(() =>
      createAgentExecutionArtifactRecord(
        input({
          changedFiles: ["src/a.ts", "src/b.ts"],
          diffSummary: { filesChanged: 1, insertions: 2, deletions: 3 },
        }),
      ),
    ).toThrow(AgentExecutionArtifactValidationError);
  });

  it("requires truncated changed-file summaries to report omitted files", () => {
    const changedFiles = Array.from(
      { length: AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles + 1 },
      (_, index) => `file-${String(index).padStart(4, "0")}.ts`,
    );
    expect(() =>
      createAgentExecutionArtifactRecord(
        input({
          changedFiles,
          diffSummary: {
            filesChanged: AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles,
            insertions: 2,
            deletions: 3,
          },
        }),
      ),
    ).toThrow(AgentExecutionArtifactValidationError);
  });

  it("requires zero insertions and deletions when no files changed", () => {
    expect(() =>
      createAgentExecutionArtifactRecord(
        input({
          changedFiles: [],
          diffSummary: { filesChanged: 0, insertions: 1, deletions: 0 },
        }),
      ),
    ).toThrow(AgentExecutionArtifactValidationError);

    const record = createAgentExecutionArtifactRecord(
      input({
        changedFiles: [],
        diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      }),
    );
    expect(record.changedFiles).toEqual([]);
  });

  it("uses a safe bounded corruption label before artifact ID validation", () => {
    expect(() =>
      parseStoredAgentExecutionArtifactRecord({
        ...createAgentExecutionArtifactRecord(input()),
        artifactId: `C:\\outside\\${"x".repeat(300)}\u0001`,
      }),
    ).toThrow(/"redacted-path"/u);
  });
});

describe("AgentExecutionArtifact changed-file normalization", () => {
  it("normalizes slashes and backslashes", () => {
    expect(normalizeChangedPath("src/app.ts")).toBe("src/app.ts");
    expect(normalizeChangedPath("src\\app.ts")).toBe("src/app.ts");
  });

  it("sorts and deduplicates deterministically while preserving case", () => {
    const record = createAgentExecutionArtifactRecord(
      input({
        changedFiles: ["b.ts", "A.ts", "b.ts", "folder/Space Name.ts"],
        diffSummary: { filesChanged: 3, insertions: 2, deletions: 3 },
      }),
    );
    expect(record.changedFiles).toEqual(["A.ts", "b.ts", "folder/Space Name.ts"]);
  });

  it("allows spaces and .gitignore", () => {
    const record = createAgentExecutionArtifactRecord(
      input({
        changedFiles: ["docs/my file.md", ".gitignore", ".gitattributes", "docs/.git-example.md"],
        diffSummary: { filesChanged: 4, insertions: 2, deletions: 3 },
      }),
    );
    expect(record.changedFiles).toEqual([
      ".gitattributes",
      ".gitignore",
      "docs/.git-example.md",
      "docs/my file.md",
    ]);
  });

  it.each([
    ["/etc/passwd", "POSIX absolute"],
    ["C:\\repo\\file.ts", "Windows drive absolute"],
    ["C:folder\\file.ts", "Windows drive relative"],
    ["\\\\server\\share\\file.ts", "UNC"],
    ["src/../secret.ts", "traversal"],
    ["src/./file.ts", "dot segment"],
    [".git/config", "Git internals"],
    [".Git/config", "Git internals with mixed case"],
    [".GIT/config", "Git internals with uppercase"],
    ["src/\u0000file.ts", "NUL/control"],
  ])("rejects %s as %s", (changedPath) => {
    expect(() => normalizeChangedPath(changedPath)).toThrow(AgentExecutionArtifactValidationError);
  });

  it("enforces per-path length", () => {
    expect(() => normalizeChangedPath(`${"a".repeat(513)}.ts`)).toThrow(
      AgentExecutionArtifactValidationError,
    );
  });

  it("retains the maximum changed-file count and sets truncation correctly", () => {
    const changedFiles = Array.from(
      { length: AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles + 1 },
      (_, index) => `file-${String(index).padStart(4, "0")}.ts`,
    );
    const record = createAgentExecutionArtifactRecord(
      input({
        changedFiles,
        diffSummary: {
          filesChanged: AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles + 1,
          insertions: 2,
          deletions: 3,
        },
      }),
    );
    expect(record.changedFiles).toHaveLength(AGENT_EXECUTION_ARTIFACT_LIMITS.changedFiles);
    expect(record.changedFilesTruncated).toBe(true);
  });

  it("does not set changed-file truncation when normalization removes duplicates below the limit", () => {
    const record = createAgentExecutionArtifactRecord(input({ changedFiles: ["a.ts", "a.ts"] }));
    expect(record.changedFiles).toEqual(["a.ts"]);
    expect(record.changedFilesTruncated).toBe(false);
  });
});

describe("AgentExecutionArtifact public-safe projection", () => {
  it("excludes internal-only provider and worktree fields", () => {
    const record = createAgentExecutionArtifactRecord(input());
    const projected = toPublicAgentExecutionArtifact(record);
    type ProjectionKeys = keyof PublicAgentExecutionArtifact;
    const worktreeExcluded: "worktreeId" extends ProjectionKeys ? never : true = true;
    const providerExcluded: "providerExecutionRef" extends ProjectionKeys ? never : true = true;
    expect(worktreeExcluded).toBe(true);
    expect(providerExcluded).toBe(true);
    expect("providerExecutionRef" in projected).toBe(false);
    expect("worktreeId" in projected).toBe(false);
  });

  it("preserves bounded safe fields without raw-output or absolute-path fields", () => {
    const projected = toPublicAgentExecutionArtifact(
      createAgentExecutionArtifactRecord(input({ changedFiles: ["src/file.ts"] })),
    );
    expect(projected.finalSummary).toBe("Done.");
    expect(projected.changedFiles).toEqual(["src/file.ts"]);
    expect("stdout" in projected).toBe(false);
    expect("stderr" in projected).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("C:\\");
  });
});
