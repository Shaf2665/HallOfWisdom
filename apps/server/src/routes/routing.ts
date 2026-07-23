import type { FastifyInstance } from "fastify";
import type { TaskOrchestrator } from "../tasks/task-orchestrator.js";

export interface RoutingRoutesDeps {
  readonly orchestrator: TaskOrchestrator;
}

interface TaskIdParams {
  readonly taskId: string;
}

/**
 * Phase 11 — provider-neutral capability/trust routing. `routing-analysis`
 * is strictly read-only (never mutates `TaskStore`, never emits an event,
 * never starts or assigns anything); `route-and-assign` is the one
 * explicit, mutating action, and even it only ever assigns — starting a
 * run remains a separate, always-manual `POST .../start` call. See
 * `TaskOrchestrator.routingAnalysis()`/`routeAndAssign()` for the full
 * concurrency and requirements-resolution behavior.
 */
export function registerRoutingRoutes(app: FastifyInstance, deps: RoutingRoutesDeps): void {
  app.post<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId/routing-analysis", async (request) => {
    return deps.orchestrator.routingAnalysis(request.params.taskId, request.body);
  });

  app.post<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId/route-and-assign", async (request) => {
    const { record, routingExplanation, generatedAt } = await deps.orchestrator.routeAndAssign(
      request.params.taskId,
      request.body,
    );
    return { record, routingExplanation, generatedAt };
  });
}
