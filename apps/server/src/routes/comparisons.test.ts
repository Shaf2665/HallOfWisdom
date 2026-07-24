import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  AgentDetectionResult,
  AgentExecutionOptions,
  AgentRunHandle,
  AgentTaskInput,
  RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import {
  buildTestApp,
  validDeferredTaskBody,
  waitUntil,
  type CreateTaskResponseJson,
  type ErrorResponseJson,
} from "../test-support.js";
import type { AgentComparisonRecord } from "../comparisons/comparison-record.js";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function initRepoWithCommit(repoPath: string): void {
  git(["init", "--quiet"], repoPath);
  git(["config", "user.email", "hall-of-wisdom-test@example.com"], repoPath);
  git(["config", "user.name", "Hall of Wisdom Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
}

/** A second, quick-completing fixture adapter — route tests only need *a* second real adapter id to exist; the deep prepare/start/finalize logic is already exhaustively covered by `comparisons/comparison-orchestrator.integration.test.ts`. */
class QuickAdapter implements AgentAdapter {
  readonly descriptor: AgentAdapterDescriptor;

  constructor(adapterId: string) {
    this.descriptor = {
      adapterId,
      displayName: adapterId,
      adapterVersion: "0.0.0-test",
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
      supportedAgent: {
        agentId: `${adapterId}-agent`,
        displayName: adapterId,
        adapterId,
        adapterVersion: "0.0.0-test",
      },
      capabilities: {
        streaming: true,
        cancellation: true,
        sessionResume: false,
        toolEvents: true,
        fileEditing: true,
        shellExecution: false,
        subagents: false,
        mcp: false,
        acp: false,
      },
      declaredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
    };
  }

  detect(): Promise<AgentDetectionResult> {
    return Promise.resolve({
      installed: true,
      availability: "available",
      executionTrust: "isolated",
    });
  }

  startTask(input: AgentTaskInput, _options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    const envelope = {
      protocolVersion: "0.1" as const,
      runId: input.runId,
      taskId: input.hallTask.taskId,
      agentId: input.agentIdentity.agentId,
      timestamp: new Date().toISOString(),
    };
    const startedEvent: NormalizedAgentEvent = {
      ...envelope,
      eventId: randomUUID(),
      sequence: 0,
      type: "run.started",
      payload: {},
    };
    const completedEvent: NormalizedAgentEvent = {
      ...envelope,
      eventId: randomUUID(),
      sequence: 1,
      type: "run.completed",
      payload: {},
    };
    const events: readonly NormalizedAgentEvent[] = [startedEvent, completedEvent];
    const currentState: RunTerminalState = "running";
    return Promise.resolve({
      runId: input.runId,
      currentState,
      completion: Promise.resolve(completedEvent),
      events: {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            next(): Promise<IteratorResult<NormalizedAgentEvent>> {
              const value = events.at(index);
              if (value === undefined) return Promise.resolve({ done: true, value: undefined });
              index += 1;
              return Promise.resolve({ done: false, value });
            },
          };
        },
      },
      cancel(): void {
        // no-op fixture.
      },
    });
  }
}

interface ComparisonsListJson {
  readonly comparisons: readonly AgentComparisonRecord[];
}

describe("REST comparison routes", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-comparison-routes-test-"));
    initRepoWithCommit(tempRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function buildComparisonApp() {
    return buildTestApp({
      workspaceRoot: tempRoot,
      withComparisons: true,
      additionalAdapters: [new QuickAdapter("hall.adapter-b")],
    });
  }

  /**
   * Phase 12.1 — every comparison must resolve its source repository from
   * the task's own stored working directory, never from `workspaceRoot`
   * implicitly. `workingDirectory: "."` means the task's repository IS
   * `workspaceRoot` itself, which `beforeEach` above already initializes
   * as a real Git repository (`initRepoWithCommit(tempRoot)`).
   */
  async function createSourceTask(
    app: Awaited<ReturnType<typeof buildComparisonApp>>["app"],
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: validDeferredTaskBody({ workingDirectory: "." }),
    });
    return response.json<CreateTaskResponseJson>().task.taskId;
  }

  it("returns 404 for every comparison route when the harness was not built with comparisons enabled", async () => {
    const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
    const response = await app.inject({ method: "GET", url: "/api/v1/comparisons" });
    expect(response.statusCode).toBe(404);
    await app.close();
    harness.cleanupComparisonRoot();
  });

  it("POST /api/v1/comparisons returns 400 for an invalid body (missing sourceTaskId)", async () => {
    const { app, harness } = await buildComparisonApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
    harness.cleanupComparisonRoot();
  });

  it("POST /api/v1/comparisons returns 400 when the two candidate adapters are the same", async () => {
    const { app, harness } = await buildComparisonApp();
    const taskId = await createSourceTask(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: {
        sourceTaskId: taskId,
        candidateAdapterIds: ["hall.mock-agent", "hall.mock-agent"],
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
    harness.cleanupComparisonRoot();
  });

  it("POST /api/v1/comparisons returns 404 (COMPARISON_SOURCE_TASK_NOT_FOUND) for an unknown sourceTaskId", async () => {
    const { app, harness } = await buildComparisonApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: {
        sourceTaskId: "does-not-exist",
        candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponseJson>().error.code).toBe("COMPARISON_SOURCE_TASK_NOT_FOUND");
    await app.close();
    harness.cleanupComparisonRoot();
  });

  it("POST /api/v1/comparisons returns 404 (COMPARISON_ADAPTER_NOT_FOUND) for an unknown adapter id", async () => {
    const { app, harness } = await buildComparisonApp();
    const taskId = await createSourceTask(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: {
        sourceTaskId: taskId,
        candidateAdapterIds: ["hall.mock-agent", "hall.does-not-exist"],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponseJson>().error.code).toBe("COMPARISON_ADAPTER_NOT_FOUND");
    await app.close();
    harness.cleanupComparisonRoot();
  });

  it("GET /api/v1/comparisons/:comparisonId returns 404 (COMPARISON_NOT_FOUND) for an unknown id", async () => {
    const { app, harness } = await buildComparisonApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/comparisons/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponseJson>().error.code).toBe("COMPARISON_NOT_FOUND");
    await app.close();
    harness.cleanupComparisonRoot();
  });

  it("POST .../prepare returns 409 (COMPARISON_STATE_CONFLICT) when called a second time", async () => {
    const { app, harness } = await buildComparisonApp();
    const taskId = await createSourceTask(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { sourceTaskId: taskId, candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"] },
    });
    const comparisonId = created.json<AgentComparisonRecord>().comparisonId;

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparisonId}/prepare`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<AgentComparisonRecord>().status).toBe("ready");

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparisonId}/prepare`,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<ErrorResponseJson>().error.code).toBe("COMPARISON_STATE_CONFLICT");

    await app.close();
    harness.cleanupComparisonRoot();
  }, 45000);

  it("POST .../candidates/:candidateId/start returns 404 for an unknown candidateId", async () => {
    const { app, harness } = await buildComparisonApp();
    const taskId = await createSourceTask(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { sourceTaskId: taskId, candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"] },
    });
    const comparisonId = created.json<AgentComparisonRecord>().comparisonId;
    await app.inject({ method: "POST", url: `/api/v1/comparisons/${comparisonId}/prepare` });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparisonId}/candidates/does-not-exist/start`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponseJson>().error.code).toBe("COMPARISON_CANDIDATE_NOT_FOUND");

    await app.close();
    harness.cleanupComparisonRoot();
  }, 45000);

  it("runs create -> prepare -> start -> preference -> cleanup end to end via HTTP, returning the expected status codes throughout", async () => {
    const { app, harness } = await buildComparisonApp();
    const taskId = await createSourceTask(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { sourceTaskId: taskId, candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"] },
    });
    expect(created.statusCode).toBe(201);
    const comparisonId = created.json<AgentComparisonRecord>().comparisonId;

    const prepared = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparisonId}/prepare`,
    });
    expect(prepared.statusCode).toBe(200);
    const [candidateA, candidateB] = prepared.json<AgentComparisonRecord>().candidates;

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparisonId}/candidates/${candidateA.candidateId}/start`,
    });
    expect(started.statusCode).toBe(202);

    await waitUntil(() => {
      const record = harness.comparison?.comparisonStore.get(comparisonId);
      return (
        record?.candidates.find((c) => c.candidateId === candidateA.candidateId)?.status ===
        "completed"
      );
    });

    const preference = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparisonId}/preference`,
      payload: { candidateId: candidateA.candidateId, note: "faster" },
    });
    expect(preference.statusCode).toBe(200);
    expect(preference.json<AgentComparisonRecord>().preference?.candidateId).toBe(
      candidateA.candidateId,
    );

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/api/v1/comparisons/${comparisonId}/candidates/${candidateB.candidateId}/cancel`,
    });
    expect(cancelResponse.statusCode).toBe(202);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/comparisons/${comparisonId}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<AgentComparisonRecord>().status).toBe("cleaned");

    await app.close();
    harness.cleanupComparisonRoot();
  }, 45000);

  it("GET /api/v1/comparisons returns 200 with an empty list before anything is created", async () => {
    const { app, harness } = await buildComparisonApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/comparisons" });
    expect(response.statusCode).toBe(200);
    expect(response.json<ComparisonsListJson>().comparisons).toEqual([]);
    await app.close();
    harness.cleanupComparisonRoot();
  });

  describe("Phase 12.1 — source repository resolution over HTTP", () => {
    async function createSourceTaskWithWorkingDirectory(
      app: Awaited<ReturnType<typeof buildComparisonApp>>["app"],
      workingDirectory?: string,
    ): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: validDeferredTaskBody(workingDirectory === undefined ? {} : { workingDirectory }),
      });
      return response.json<CreateTaskResponseJson>().task.taskId;
    }

    it("prepares successfully via HTTP when the Hall workspace has unrelated uncommitted changes but the task's own nested repository is clean", async () => {
      fs.writeFileSync(path.join(tempRoot, "unrelated-dirty-file.txt"), "uncommitted\n");
      const sourceRepo = path.join(tempRoot, "source-repo");
      fs.mkdirSync(sourceRepo);
      initRepoWithCommit(sourceRepo);
      const expectedHead = git(["rev-parse", "HEAD"], sourceRepo);

      const { app, harness } = await buildComparisonApp();
      const taskId = await createSourceTaskWithWorkingDirectory(app, "source-repo");
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/comparisons",
        payload: {
          sourceTaskId: taskId,
          candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"],
        },
      });
      const comparisonId = created.json<AgentComparisonRecord>().comparisonId;

      const prepared = await app.inject({
        method: "POST",
        url: `/api/v1/comparisons/${comparisonId}/prepare`,
      });
      expect(prepared.statusCode).toBe(200);
      const preparedRecord = prepared.json<AgentComparisonRecord>();
      expect(preparedRecord.status).toBe("ready");
      expect(preparedRecord.baseCommit).toBe(expectedHead);

      await app.close();
      harness.cleanupComparisonRoot();
    }, 45000);

    it("returns a safe COMPARISON_SOURCE_WORKING_DIRECTORY_REQUIRED failure, with no leaked path, when the source task has no working directory", async () => {
      const { app, harness } = await buildComparisonApp();
      const taskId = await createSourceTaskWithWorkingDirectory(app, undefined);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/comparisons",
        payload: {
          sourceTaskId: taskId,
          candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"],
        },
      });
      const comparisonId = created.json<AgentComparisonRecord>().comparisonId;

      const prepared = await app.inject({
        method: "POST",
        url: `/api/v1/comparisons/${comparisonId}/prepare`,
      });
      expect(prepared.statusCode).toBe(200);
      const record = prepared.json<AgentComparisonRecord>();
      expect(record.status).toBe("failed");
      expect(record.prepareFailureCode).toBe("COMPARISON_SOURCE_WORKING_DIRECTORY_REQUIRED");
      expect(prepared.body).not.toContain(tempRoot);

      await app.close();
      harness.cleanupComparisonRoot();
    }, 45000);

    it("returns a safe failure, with no leaked path, when the working directory is not inside a Git repository bounded by the workspace root", async () => {
      // A dedicated, NOT git-initialized workspace root for this one test —
      // `tempRoot` (used everywhere else in this file) is itself a Git
      // repository, so any subdirectory under it would resolve to
      // `tempRoot`'s own repository rather than proving this case.
      //
      // Which safe code this produces depends on whether the OS temp
      // directory itself happens to sit inside some unrelated ancestor Git
      // repository (environment-dependent, observed on at least one real
      // machine): if `git` finds no repository at all, that's
      // `COMPARISON_SOURCE_NOT_GIT_REPOSITORY`; if it finds one whose root
      // lies outside this test's `workspaceRoot`, the second containment
      // check correctly reports `COMPARISON_SOURCE_OUTSIDE_WORKSPACE`
      // instead — both are safe, bounded, path-free rejections, so this
      // test accepts either rather than being fragile to that ambient
      // detail. `source-repository-resolution.test.ts` covers the
      // `NotAGitRepositoryError` case deterministically with a fake `git`.
      const nonGitRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "hall-core-comparison-non-git-root-"),
      );
      fs.mkdirSync(path.join(nonGitRoot, "plain-directory"));
      try {
        const { app, harness } = await buildTestApp({
          workspaceRoot: nonGitRoot,
          withComparisons: true,
          additionalAdapters: [new QuickAdapter("hall.adapter-b")],
        });
        const taskId = await createSourceTaskWithWorkingDirectory(app, "plain-directory");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/comparisons",
          payload: {
            sourceTaskId: taskId,
            candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"],
          },
        });
        const comparisonId = created.json<AgentComparisonRecord>().comparisonId;

        const prepared = await app.inject({
          method: "POST",
          url: `/api/v1/comparisons/${comparisonId}/prepare`,
        });
        expect(prepared.statusCode).toBe(200);
        const record = prepared.json<AgentComparisonRecord>();
        expect(record.status).toBe("failed");
        expect([
          "COMPARISON_SOURCE_NOT_GIT_REPOSITORY",
          "COMPARISON_SOURCE_OUTSIDE_WORKSPACE",
        ]).toContain(record.prepareFailureCode);
        expect(prepared.body).not.toContain(nonGitRoot);

        await app.close();
        harness.cleanupComparisonRoot();
      } finally {
        fs.rmSync(nonGitRoot, { recursive: true, force: true });
      }
    }, 45000);

    it("returns a safe COMPARISON_SOURCE_REPOSITORY_DIRTY failure, with no leaked path, when the resolved source repository has uncommitted changes", async () => {
      const sourceRepo = path.join(tempRoot, "source-repo");
      fs.mkdirSync(sourceRepo);
      initRepoWithCommit(sourceRepo);
      fs.writeFileSync(path.join(sourceRepo, "README.md"), "modified\n");

      const { app, harness } = await buildComparisonApp();
      const taskId = await createSourceTaskWithWorkingDirectory(app, "source-repo");
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/comparisons",
        payload: {
          sourceTaskId: taskId,
          candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"],
        },
      });
      const comparisonId = created.json<AgentComparisonRecord>().comparisonId;

      const prepared = await app.inject({
        method: "POST",
        url: `/api/v1/comparisons/${comparisonId}/prepare`,
      });
      expect(prepared.statusCode).toBe(200);
      const record = prepared.json<AgentComparisonRecord>();
      expect(record.status).toBe("failed");
      expect(record.prepareFailureCode).toBe("COMPARISON_SOURCE_REPOSITORY_DIRTY");
      expect(prepared.body).not.toContain(tempRoot);

      await app.close();
      harness.cleanupComparisonRoot();
    }, 45000);

    it("rejects a create-comparison request that supplies an unexpected field such as a repository path or Git ref override", async () => {
      const { app, harness } = await buildComparisonApp();
      const taskId = await createSourceTask(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/comparisons",
        payload: {
          sourceTaskId: taskId,
          candidateAdapterIds: ["hall.mock-agent", "hall.adapter-b"],
          repositoryPath: "C:\\anywhere",
          baseCommit: "a".repeat(40),
        },
      });
      expect(response.statusCode).toBe(400);

      await app.close();
      harness.cleanupComparisonRoot();
    });
  });
});
