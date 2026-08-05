import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { createServerComposition } from "../composition/server-composition.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Verifies the ONE cross-store ordering invariant durable mode actually
 * guarantees — see `reconcile-tasks.ts`'s doc comment. `TaskOrchestrator`
 * and `ComparisonOrchestrator` both call `eventStore.append()` (its own
 * committed SQLite transaction) and only then `eventBus.publish()`; the
 * `TaskStore`/`ComparisonStore` writes that follow (`eventCount`, status)
 * are projections reconciled at restart, deliberately NOT required to be
 * atomic with the event write. This test asserts exactly the invariant
 * that holds — the event is durably committed before any subscriber can
 * observe it — and nothing broader (it does not, and must not, assert
 * that `TaskStore`'s projection fields are committed before publish; that
 * would demand cross-store atomicity this architecture intentionally does
 * not provide).
 */
describe("persistence-before-publication (durable mode)", () => {
  let tempRoot: string;
  let db: HallDatabase | undefined;

  afterEach(() => {
    db?.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("every task event is durably committed before it is published on the task event bus", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-persist-before-publish-task-"));
    db = HallDatabase.openInMemory();
    runMigrations(db);

    const composition = createServerComposition({
      workspaceRoot: tempRoot,
      mockScenario: "success",
      mockStepDelayMs: 5,
      limits: DEFAULT_LIMITS,
      db,
      agentWorktreeRoot: path.join(tempRoot, "agent-worktrees"),
    });

    const created = composition.orchestrator.createTask({
      projectId: "proj-1",
      title: "Ordering check",
      executionMode: "immediate",
      adapterId: "hall.mock-agent",
    });
    const taskId = created.task.taskId;

    const observations: { publishedEventId: string; lastStoredEventId: string | undefined }[] = [];
    const unsubscribe = composition.eventBus.subscribe(taskId, (event: NormalizedAgentEvent) => {
      const stored = composition.eventStore.list(taskId);
      observations.push({
        publishedEventId: event.eventId,
        lastStoredEventId: stored.at(-1)?.eventId,
      });
    });

    await waitUntil(() => {
      const status = composition.taskStore.get(taskId).task.status;
      return status === "completed" || status === "failed";
    });
    unsubscribe();

    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      // By the time each subscriber callback ran, the SAME event it was
      // just handed was already the last row the durable event store
      // would return for this stream — proving append-then-publish
      // ordering empirically, not merely by reading the source.
      expect(observation.lastStoredEventId).toBe(observation.publishedEventId);
    }
  });
});
