import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { AgentExecutionArtifactCorruptRecordError } from "./agent-execution-artifact-errors.js";
import {
  artifactInput,
  runAgentExecutionArtifactStoreContractTests,
} from "./agent-execution-artifact-store.contract.js";
import { SqliteAgentExecutionArtifactStore } from "./sqlite-agent-execution-artifact-store.js";

const openDbs: HallDatabase[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function buildStore(): SqliteAgentExecutionArtifactStore {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDbs.push(db);
  return new SqliteAgentExecutionArtifactStore({ db });
}

runAgentExecutionArtifactStoreContractTests("durable", buildStore);

describe("SqliteAgentExecutionArtifactStore durability and corruption behavior", () => {
  it("survives database close and reopen", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-exec-artifacts-db-"));
    tempDirs.push(dataDir);
    const firstDb = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    runMigrations(firstDb);
    new SqliteAgentExecutionArtifactStore({ db: firstDb }).create(artifactInput());
    firstDb.close();

    const secondDb = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    openDbs.push(secondDb);
    const reopened = new SqliteAgentExecutionArtifactStore({ db: secondDb });
    const record = reopened.get("artifact-1");
    expect(record.hallAgentRunId).toBe("run-1");
    expect(record.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(record.changedFilesTruncated).toBe(false);
    expect(record.finalSummaryTruncated).toBe(false);
  });

  it("rejects corrupt outcome values", () => {
    const { db, store } = corruptibleStore();
    store.create(artifactInput());
    db.exec("PRAGMA ignore_check_constraints = ON;");
    db.prepare(
      "UPDATE agent_execution_artifacts SET terminal_outcome = ? WHERE artifact_id = ?",
    ).run("teleported", "artifact-1");
    expect(() => store.get("artifact-1")).toThrow(AgentExecutionArtifactCorruptRecordError);
  });

  it("rejects corrupt changed-files JSON", () => {
    const { db, store } = corruptibleStore();
    store.create(artifactInput());
    db.prepare(
      "UPDATE agent_execution_artifacts SET changed_files_json = ? WHERE artifact_id = ?",
    ).run("{not json", "artifact-1");
    expect(() => store.get("artifact-1")).toThrow(AgentExecutionArtifactCorruptRecordError);
  });

  it("rejects wrong changed-files JSON types", () => {
    const { db, store } = corruptibleStore();
    store.create(artifactInput());
    db.prepare(
      "UPDATE agent_execution_artifacts SET changed_files_json = ? WHERE artifact_id = ?",
    ).run(JSON.stringify({ path: "src/a.ts" }), "artifact-1");
    expect(() => store.get("artifact-1")).toThrow(AgentExecutionArtifactCorruptRecordError);
  });

  it("rejects corrupt boolean values", () => {
    const { db, store } = corruptibleStore();
    store.create(artifactInput());
    db.exec("PRAGMA ignore_check_constraints = ON;");
    db.prepare(
      "UPDATE agent_execution_artifacts SET changed_files_truncated = ? WHERE artifact_id = ?",
    ).run(2, "artifact-1");
    expect(() => store.get("artifact-1")).toThrow(AgentExecutionArtifactCorruptRecordError);
  });

  it("rejects impossible terminal invariants", () => {
    const { db, store } = corruptibleStore();
    store.create(artifactInput());
    db.prepare(
      "UPDATE agent_execution_artifacts SET terminal_reason_code = ? WHERE artifact_id = ?",
    ).run("BAD_FOR_COMPLETED", "artifact-1");
    expect(() => store.get("artifact-1")).toThrow(AgentExecutionArtifactCorruptRecordError);
  });

  it("never returns a partial or malformed stored row as valid", () => {
    const { db, store } = corruptibleStore();
    store.create(artifactInput());
    db.prepare("UPDATE agent_execution_artifacts SET adapter_id = ? WHERE artifact_id = ?").run(
      "",
      "artifact-1",
    );
    expect(() => store.list()).toThrow(AgentExecutionArtifactCorruptRecordError);
  });
});

function corruptibleStore(): {
  readonly db: HallDatabase;
  readonly store: SqliteAgentExecutionArtifactStore;
} {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDbs.push(db);
  const store = new SqliteAgentExecutionArtifactStore({ db });
  return { db, store };
}
