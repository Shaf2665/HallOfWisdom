import type { FastifyInstance } from "fastify";
import type { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import type { TaskStore } from "../tasks/task-store.js";

export interface TaskRoutesDeps {
  readonly orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStore;
}

interface TaskIdParams {
  readonly taskId: string;
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRoutesDeps): void {
  app.post("/api/v1/tasks", async (request, reply) => {
    const { task } = deps.orchestrator.createTask(request.body);
    // Same shape as GET /api/v1/tasks/:taskId (the TaskRecord, which
    // already carries its own `task`/`runId` fields) plus one convenience
    // field — deliberately not double-wrapped under an extra `task` key.
    await reply.status(202).send({
      ...deps.taskStore.get(task.taskId),
      eventsPath: `/api/v1/tasks/${task.taskId}/events`,
    });
  });

  app.get("/api/v1/tasks", () => {
    return { tasks: deps.taskStore.list() };
  });

  app.get<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId", (request) => {
    return deps.taskStore.get(request.params.taskId);
  });

  app.post<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId/cancel", async (request, reply) => {
    const result = deps.orchestrator.requestCancellation(request.params.taskId);
    await reply.status(202).send({
      taskId: request.params.taskId,
      cancellationRequested: true,
      alreadyRequested: result.alreadyRequested,
    });
  });
}
