import { describe, expect, it } from "vitest";
import {
  AgentExecutionArtifactConflictError,
  AgentExecutionArtifactNotFoundError,
  AgentExecutionArtifactRunNotFoundError,
  AgentExecutionArtifactValidationError,
} from "./agent-execution-artifact-errors.js";
import type { CreateAgentExecutionArtifactInput } from "./agent-execution-artifact-record.js";
import type { AgentExecutionArtifactStorePort } from "./agent-execution-artifact-store-port.js";

const STARTED_AT = "2026-08-03T10:00:00.000Z";
const FINISHED_AT = "2026-08-03T10:01:00.000Z";

export function artifactInput(
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
    durationMs: 60_000,
    exitCode: 0,
    baseCommit: "a".repeat(40),
    finalCommit: "b".repeat(40),
    changedFiles: ["src/b.ts", "src/a.ts"],
    diffSummary: { filesChanged: 2, insertions: 3, deletions: 4 },
    finalSummary: "Done.",
    createdAt: "2026-08-03T10:01:01.000Z",
    ...overrides,
  };
}

export function runAgentExecutionArtifactStoreContractTests(
  label: string,
  buildStore: () => AgentExecutionArtifactStorePort,
): void {
  describe(`AgentExecutionArtifactStorePort contract — ${label}`, () => {
    it("creates and retrieves an artifact", () => {
      const store = buildStore();
      const created = store.create(artifactInput());
      expect(created.artifactId).toBe("artifact-1");
      expect(store.get("artifact-1")).toEqual(created);
    });

    it("retrieves by Hall agent-run ID", () => {
      const store = buildStore();
      const created = store.create(artifactInput());
      expect(store.getByHallAgentRunId("run-1")).toEqual(created);
      expect(store.findByHallAgentRunId("missing")).toBeUndefined();
      expect(() => store.getByHallAgentRunId("missing")).toThrow(
        AgentExecutionArtifactRunNotFoundError,
      );
    });

    it("throws typed not-found errors for missing artifacts", () => {
      const store = buildStore();
      expect(store.find("missing")).toBeUndefined();
      expect(() => store.get("missing")).toThrow(AgentExecutionArtifactNotFoundError);
    });

    it("lists deterministically by createdAt then artifactId", () => {
      const store = buildStore();
      for (const [index, artifactId] of [
        "artifact-\uE000",
        "artifact-😀",
        "artifact-Ω",
        "artifact-é",
        "artifact-a",
        "artifact-A",
      ].entries()) {
        store.create(
          artifactInput({
            artifactId,
            hallAgentRunId: `run-order-${String(index)}`,
            createdAt: "2026-08-03T10:01:01.000Z",
          }),
        );
      }
      expect(store.list().map((record) => record.artifactId)).toEqual([
        "artifact-A",
        "artifact-a",
        "artifact-é",
        "artifact-Ω",
        "artifact-\uE000",
        "artifact-😀",
      ]);
    });

    it("rejects duplicate artifact IDs", () => {
      const store = buildStore();
      store.create(artifactInput());
      expect(() => store.create(artifactInput({ hallAgentRunId: "run-2" }))).toThrow(
        AgentExecutionArtifactConflictError,
      );
    });

    it("rejects duplicate Hall agent-run IDs", () => {
      const store = buildStore();
      store.create(artifactInput());
      expect(() => store.create(artifactInput({ artifactId: "artifact-2" }))).toThrow(
        AgentExecutionArtifactConflictError,
      );
    });

    it("does not leave a readable record after invalid creation", () => {
      const store = buildStore();
      expect(() => store.create(artifactInput({ artifactId: "invalid", durationMs: -1 }))).toThrow(
        AgentExecutionArtifactValidationError,
      );
      expect(store.find("invalid")).toBeUndefined();
      expect(store.list()).toEqual([]);
    });

    it("returns immutable snapshots of arrays and nested diff summaries", () => {
      const store = buildStore();
      store.create(artifactInput());
      const retrieved = store.get("artifact-1");
      (retrieved.changedFiles as string[]).push("mutated.ts");
      (retrieved.diffSummary as { filesChanged: number }).filesChanged = 999;
      expect(store.get("artifact-1").changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
      expect(store.get("artifact-1").diffSummary.filesChanged).toBe(2);
    });

    it("stores immutable data even if the caller mutates input arrays later", () => {
      const store = buildStore();
      const changedFiles = ["src/a.ts"];
      store.create(
        artifactInput({
          changedFiles,
          diffSummary: { filesChanged: 1, insertions: 3, deletions: 4 },
        }),
      );
      changedFiles.push("src/b.ts");
      expect(store.get("artifact-1").changedFiles).toEqual(["src/a.ts"]);
    });
  });
}
