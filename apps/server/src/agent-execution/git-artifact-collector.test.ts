import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import type { ValidatedAgentWorktreeHandle } from "../agent-worktrees/agent-worktree-manager.js";
import type {
  GitCommandResult,
  GitCommandRunner,
  GitCommandRunnerInput,
} from "../agent-worktrees/git-command-runner.js";
import { NodeGitCommandRunner } from "../agent-worktrees/git-command-runner.js";
import { compareArtifactStrings } from "../execution-artifacts/agent-execution-artifact-record.js";
import { GitArtifactCollectionError } from "./agent-execution-errors.js";
import { GitArtifactCollector } from "./git-artifact-collector.js";

const BASE_COMMIT = "a".repeat(40);
const FINAL_COMMIT = "b".repeat(40);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("GitArtifactCollector", () => {
  it("requires a strong worktree validator", () => {
    expect(
      () =>
        new GitArtifactCollector({
          gitRunner: new ScriptedGitRunner([]),
          worktreeValidator: undefined,
        }),
    ).toThrow(GitArtifactCollectionError);
  });

  it("collects final real-Git evidence without external diff or textconv execution", async () => {
    const ownedRoot = makeTempDir("hall owned ");
    const worktreePath = path.join(ownedRoot, "wt_worktree-1");
    fs.mkdirSync(worktreePath, { recursive: true });
    git(worktreePath, "init", "--initial-branch=main");
    git(worktreePath, "config", "user.email", "hall@example.invalid");
    git(worktreePath, "config", "user.name", "Hall Test");
    const externalDiffSentinel = path.join(ownedRoot, "external-diff-sentinel.txt");
    const textconvSentinel = path.join(ownedRoot, "textconv-sentinel.txt");
    git(
      worktreePath,
      "config",
      "diff.evil.command",
      `node -e "require('fs').writeFileSync(process.argv[1],'hit')" "${externalDiffSentinel}"`,
    );
    git(
      worktreePath,
      "config",
      "diff.textconv.textconv",
      `node -e "require('fs').writeFileSync(process.argv[1],'hit')" "${textconvSentinel}"`,
    );
    write(worktreePath, ".gitattributes", "*.bin binary\n*.evil diff=evil\n*.tc diff=textconv\n");
    write(worktreePath, ".gitignore", "ignored.log\n");
    for (const file of [
      "committed.txt",
      "staged.txt",
      "unstaged.txt",
      "deleted.txt",
      "binary.bin",
      "space name.txt",
      "தமிழ்.txt",
      "مرحبا.txt",
      "😀.txt",
      "hook.evil",
      "doc.tc",
    ]) {
      write(worktreePath, file, `base ${file}\n`);
    }
    git(worktreePath, "add", ".");
    git(worktreePath, "commit", "-m", "base");
    const baseCommit = git(worktreePath, "rev-parse", "HEAD").trim();

    write(worktreePath, "committed.txt", "base committed.txt\ncommitted change\n");
    git(worktreePath, "add", "committed.txt");
    git(worktreePath, "commit", "-m", "committed change");
    write(worktreePath, "staged.txt", "base staged.txt\nstaged change\n");
    git(worktreePath, "add", "staged.txt");
    write(worktreePath, "unstaged.txt", "base unstaged.txt\nunstaged change\n");
    fs.unlinkSync(path.join(worktreePath, "deleted.txt"));
    write(worktreePath, "binary.bin", Buffer.from([0, 1, 2, 3, 4, 5]));
    write(worktreePath, "space name.txt", "base space name.txt\nspace change\n");
    write(worktreePath, "தமிழ்.txt", "base Tamil\nTamil change\n");
    write(worktreePath, "مرحبا.txt", "base Arabic\nArabic change\n");
    write(worktreePath, "😀.txt", "base emoji\nemoji change\n");
    write(worktreePath, "hook.evil", "base hook.evil\nexternal diff should not run\n");
    write(worktreePath, "doc.tc", "base doc.tc\ntextconv should not run\n");
    write(worktreePath, "untracked file.txt", "untracked\n");
    write(worktreePath, "ignored.log", "ignored\n");

    const store = createReadyWorktreeStore({ worktreePath, baseCommit });
    const collector = new GitArtifactCollector({
      gitRunner: new NodeGitCommandRunner(),
      worktreeValidator: validatorForStore(store, ownedRoot, worktreePath),
    });

    const evidence = await collector.collect("worktree-1");

    const expectedChangedFiles = [
      "binary.bin",
      "committed.txt",
      "deleted.txt",
      "doc.tc",
      "hook.evil",
      "space name.txt",
      "staged.txt",
      "untracked file.txt",
      "unstaged.txt",
      "தமிழ்.txt",
      "مرحبا.txt",
      "😀.txt",
    ].sort(compareArtifactStrings);
    expect(evidence.baseCommit).toBe(baseCommit);
    expect(evidence.finalCommit).toBe(git(worktreePath, "rev-parse", "HEAD").trim());
    expect(evidence.changedFiles).toEqual(expectedChangedFiles);
    expect(evidence.diffSummary.filesChanged).toBe(expectedChangedFiles.length);
    expect(evidence.diffSummary.insertions).toBeGreaterThan(0);
    expect(evidence.diffSummary.deletions).toBeGreaterThan(0);
    expect(evidence.changedFiles).not.toContain("ignored.log");
    expect(fs.existsSync(externalDiffSentinel)).toBe(false);
    expect(fs.existsSync(textconvSentinel)).toBe(false);
  });

  it("uses fixed safe Git commands and returns sorted bounded evidence", async () => {
    const fixture = createReadyWorktree();
    const runner = new ScriptedGitRunner([
      ok(`${FINAL_COMMIT}\n`),
      okBytes(nul("src/a.ts", "😀.ts", "\uE000.ts")),
      okBytes(nul("untracked file.ts")),
      okBytes(nul("2\t1\tsrc/a.ts", "-\t-\t😀.ts")),
    ]);
    const collector = new GitArtifactCollector({
      gitRunner: runner,
      worktreeValidator: fixture.validator,
    });

    const evidence = await collector.collect("worktree-1");

    expect(evidence.finalCommit).toBe(FINAL_COMMIT);
    expect(evidence.changedFiles).toEqual(["src/a.ts", "untracked file.ts", "\uE000.ts", "😀.ts"]);
    expect(evidence.diffSummary).toEqual({ filesChanged: 4, insertions: 2, deletions: 1 });
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"],
      [
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        BASE_COMMIT,
        "--",
      ],
      ["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z", "--"],
      [
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        BASE_COMMIT,
        "--",
      ],
    ]);
  });

  it("fails closed on malformed numstat, invalid UTF-8, and bounded-output overflow", async () => {
    const malformed = createReadyWorktree();
    await expect(
      new GitArtifactCollector({
        gitRunner: new ScriptedGitRunner([
          ok(`${FINAL_COMMIT}\n`),
          okBytes(Buffer.alloc(0)),
          okBytes(Buffer.alloc(0)),
          okBytes(nul("not-a-num\t0\tsrc/a.ts")),
        ]),
        worktreeValidator: malformed.validator,
      }).collect("worktree-1"),
    ).rejects.toThrow(GitArtifactCollectionError);

    const invalidUtf8 = createReadyWorktree();
    await expect(
      new GitArtifactCollector({
        gitRunner: new ScriptedGitRunner([
          ok(`${FINAL_COMMIT}\n`),
          okBytes(Buffer.from([0xff, 0x00])),
          okBytes(Buffer.alloc(0)),
          okBytes(Buffer.alloc(0)),
        ]),
        worktreeValidator: invalidUtf8.validator,
      }).collect("worktree-1"),
    ).rejects.toThrow(GitArtifactCollectionError);

    const overflow = createReadyWorktree();
    await expect(
      new GitArtifactCollector({
        gitRunner: new ScriptedGitRunner([{ ...ok(`${FINAL_COMMIT}\n`), stdoutTruncated: true }]),
        worktreeValidator: overflow.validator,
      }).collect("worktree-1"),
    ).rejects.toThrow(GitArtifactCollectionError);
  });

  it("does not invoke Git when manager-owned worktree validation rejects identity or containment", async () => {
    const runner = new ScriptedGitRunner([ok(`${FINAL_COMMIT}\n`)]);
    const collector = new GitArtifactCollector({
      gitRunner: runner,
      worktreeValidator: {
        validateReadyWorktree() {
          return Promise.reject(
            new GitArtifactCollectionError("Worktree path is outside the Hall-owned root."),
          );
        },
      },
    });

    await expect(collector.collect("worktree-1")).rejects.toThrow(GitArtifactCollectionError);
    expect(runner.calls).toEqual([]);
  });
});

function createReadyWorktree(): {
  readonly store: InMemoryAgentWorktreeStore;
  readonly ownedRoot: string;
  readonly worktreePath: string;
  readonly validator: {
    readonly validateReadyWorktree: () => Promise<ValidatedAgentWorktreeHandle>;
  };
} {
  const ownedRoot = makeTempDir("hall-owned ");
  const worktreePath = path.join(ownedRoot, "wt_worktree-1");
  fs.mkdirSync(worktreePath, { recursive: true });
  const store = createReadyWorktreeStore({ worktreePath, baseCommit: BASE_COMMIT });
  return {
    store,
    ownedRoot,
    worktreePath,
    validator: validatorForStore(store, ownedRoot, worktreePath),
  };
}

function validatorForStore(
  store: InMemoryAgentWorktreeStore,
  ownedRoot: string,
  worktreePath: string,
): { readonly validateReadyWorktree: () => Promise<ValidatedAgentWorktreeHandle> } {
  return {
    validateReadyWorktree() {
      return Promise.resolve({
        record: store.get("worktree-1"),
        canonicalOwnedRoot: fs.realpathSync.native(ownedRoot),
        canonicalWorktreePath: fs.realpathSync.native(worktreePath),
        agentWorkingDirectory: fs.realpathSync.native(worktreePath),
      });
    },
  };
}

function createReadyWorktreeStore(input: {
  readonly worktreePath: string;
  readonly baseCommit: string;
}): InMemoryAgentWorktreeStore {
  const source = makeTempDir("hall-source ");
  const store = new InMemoryAgentWorktreeStore();
  store.createCreating({
    worktreeId: "worktree-1",
    hallTaskId: "task-1",
    hallAgentRunId: "run-1",
    canonicalSourceRepositoryRoot: source,
    sourceWorkingDirectoryRelativePath: ".",
    baseCommit: input.baseCommit,
    canonicalWorktreePath: fs.realpathSync.native(input.worktreePath),
    createdAt: "2026-08-03T10:00:00.000Z",
  });
  store.markReady({
    worktreeId: "worktree-1",
    expectedRevision: 0,
    readyAt: "2026-08-03T10:00:01.000Z",
  });
  return store;
}

class ScriptedGitRunner implements GitCommandRunner {
  readonly calls: GitCommandRunnerInput[] = [];
  readonly #results: GitCommandResult[];

  constructor(results: readonly GitCommandResult[]) {
    this.#results = [...results];
  }

  run(input: GitCommandRunnerInput): Promise<GitCommandResult> {
    this.calls.push(input);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("No scripted Git result.");
    return Promise.resolve(result);
  }
}

function ok(stdout: string): GitCommandResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, spawnError: undefined };
}

function okBytes(stdoutBytes: Buffer): GitCommandResult {
  return {
    ...ok(stdoutBytes.toString("utf8")),
    stdoutBytes,
  };
}

function nul(...entries: readonly string[]): Buffer {
  return Buffer.from(`${entries.join("\0")}\0`, "utf8");
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function write(root: string, relativePath: string, content: string | Buffer): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(cwd: string, ...args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}
