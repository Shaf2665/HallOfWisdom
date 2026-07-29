import type { FastifyInstance } from "fastify";
import type { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";

export interface TaskRoutesDeps {
  readonly orchestrator: TaskOrchestrator;
  readonly taskStore: TaskStorePort;
}

interface TaskIdParams {
  readonly taskId: string;
}

interface TransitionRequestBody {
  readonly targetStatus?: unknown;
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRoutesDeps): void {
  app.post("/api/v1/tasks", async (request, reply) => {
    const { task, runId } = deps.orchestrator.createTask(request.body);
    // Same shape as GET /api/v1/tasks/:taskId (the TaskRecord, which
    // already carries its own `task`/`runId` fields) plus one convenience
    // field — deliberately not double-wrapped under an extra `task` key.
    // A deferred (planning-only) task has no run yet: no `eventsPath`,
    // and `201 Created` rather than `202 Accepted` (nothing was accepted
    // for asynchronous execution).
    const body =
      runId === undefined
        ? deps.taskStore.get(task.taskId)
        : { ...deps.taskStore.get(task.taskId), eventsPath: `/api/v1/tasks/${task.taskId}/events` };
    await reply.status(runId === undefined ? 201 : 202).send(body);
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

  /**
   * Manual planning-state transition. Only ever moves a task between
   * planning columns (backlog/ready/assigned/blocked) or to `cancelled`
   * from one of those — see `TaskOrchestrator.transitionTask()` and
   * `tasks/task-status-transitions.ts`'s `MANUAL_TRANSITIONS` for the
   * exact allowed edges. Never starts, cancels an active run, or emits
   * any event.
   */
  app.post<{ Params: TaskIdParams; Body: TransitionRequestBody }>(
    "/api/v1/tasks/:taskId/transition",
    (request) => {
      return deps.orchestrator.transitionTask(request.params.taskId, request.body);
    },
  );

  /**
   * Assigns (or, before start, reassigns) an adapter to a `ready` task —
   * validates adapter existence/availability and the working directory,
   * but starts nothing. See `TaskOrchestrator.assignTask()`.
   */
  app.post<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId/assign", async (request) => {
    return deps.orchestrator.assignTask(request.params.taskId, request.body);
  });

  /**
   * Starts execution for a task already assigned via `.../assign` — the
   * explicit action Kanban drag-and-drop is never allowed to trigger on
   * its own. Response shape matches `POST /api/v1/tasks` (immediate
   * mode): the updated `TaskRecord` plus `eventsPath`, `202 Accepted`.
   */
  app.post<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId/start", async (request, reply) => {
    const { task } = await deps.orchestrator.startTask(request.params.taskId);
    await reply.status(202).send({
      ...deps.taskStore.get(task.taskId),
      eventsPath: `/api/v1/tasks/${task.taskId}/events`,
    });
  });
}
