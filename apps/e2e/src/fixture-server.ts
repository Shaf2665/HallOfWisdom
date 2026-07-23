import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHallCoreApp,
  TaskOrchestrator,
  TaskStore,
  EventStore,
  EventBus,
  BoardStore,
  MessageStore,
  MessageBus,
  DEFAULT_LIMITS,
  LOCAL_ONLY_HOST,
} from "@hall-of-wisdom/hall-core";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { createAllFixtureAdapters } from "./fixture-adapters.js";

/**
 * A standalone Hall Core process for Playwright E2E verification only —
 * never imported by `server.ts` or any real composition path
 * (`server-composition.ts`), and never reachable through any production
 * CLI flag. Built entirely from `@hall-of-wisdom/hall-core`'s own public
 * package entry (`createHallCoreApp`, `TaskOrchestrator`, `TaskStore`,
 * ...) — the exact same building blocks any other external consumer of
 * that package would use — plus this package's own deterministic fixture
 * adapters (`fixture-adapters.ts`) instead of real
 * Claude-Code/Codex-spawning ones. This is what "a test-only Hall Core
 * composition launched by the Playwright suite" (Phase 11.1) means
 * concretely: a separate script, not a flag on the real server.
 *
 * Binds to `127.0.0.1` only, exactly like the real server
 * (`LOCAL_ONLY_HOST`) — never reachable from the network.
 */
async function main(): Promise<void> {
  const port = Number(process.env.HALL_CORE_E2E_PORT ?? "4310");
  const webOrigin = process.env.HALL_CORE_E2E_WEB_ORIGIN ?? "http://127.0.0.1:3000";
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-e2e-workspace-"));

  const limits = DEFAULT_LIMITS;
  const registry = new AgentRegistry();
  for (const adapter of createAllFixtureAdapters()) {
    registry.register(adapter);
  }

  const taskStore = new TaskStore({ maxTasks: limits.maxTasks });
  const eventStore = new EventStore({ maxEventsPerTask: limits.maxEventsPerTask });
  const eventBus = new EventBus({ maxSubscribersPerTask: limits.maxSubscribersPerTask });

  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot,
    onExecutionError: (taskId, error) => {
      console.error(`[e2e fixture server] task ${taskId} execution failed:`, error);
    },
  });

  const boardStore = new BoardStore({ maxBoards: limits.maxBoards, taskStore });
  const messageStore = new MessageStore({ maxMessagesPerBoard: limits.maxMessagesPerBoard });
  const messageBus = new MessageBus({ maxSubscribersPerBoard: limits.maxSubscribersPerBoard });
  const generalBoard = boardStore.seedGeneralBoard(new Date().toISOString());
  messageStore.registerBoard(generalBoard.boardId);

  const app = await createHallCoreApp({
    orchestrator,
    taskStore,
    eventStore,
    eventBus,
    boardStore,
    messageStore,
    messageBus,
    registry,
    webOrigin,
    limits,
  });

  await app.listen({ port, host: LOCAL_ONLY_HOST });
  console.log(
    `[e2e fixture server] listening on http://${LOCAL_ONLY_HOST}:${String(port)} (webOrigin=${webOrigin}, workspaceRoot=${workspaceRoot})`,
  );

  const shutdown = (): void => {
    void (async () => {
      await orchestrator.shutdown(2000);
      await app.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error("[e2e fixture server] failed to start:", error);
  process.exitCode = 1;
});
