import type { FastifyInstance } from "fastify";
import type { ComparisonOrchestrator } from "../comparisons/comparison-orchestrator.js";
import type { ComparisonStore } from "../comparisons/comparison-store.js";

export interface ComparisonRoutesDeps {
  readonly orchestrator: ComparisonOrchestrator;
  readonly comparisonStore: ComparisonStore;
}

interface ComparisonIdParams {
  readonly comparisonId: string;
}

interface ComparisonCandidateParams extends ComparisonIdParams {
  readonly candidateId: string;
}

/**
 * Phase 12 — controlled multi-agent execution comparison. Every mutating
 * action here is explicit and operator-driven: creating a comparison
 * spends no filesystem/Git work (`ComparisonOrchestrator.createComparison`
 * is synchronous), preparing creates worktrees but starts nothing, and
 * starting a specific candidate is a separate call per candidate — there
 * is no endpoint that starts both candidates, runs any AI judging, or
 * merges/commits/pushes anything. See
 * `docs/architecture/0012-controlled-agent-comparison.md`.
 */
export function registerComparisonRoutes(app: FastifyInstance, deps: ComparisonRoutesDeps): void {
  app.post("/api/v1/comparisons", async (request, reply) => {
    const record = deps.orchestrator.createComparison(request.body);
    await reply.status(201).send(record);
  });

  app.get("/api/v1/comparisons", () => {
    return { comparisons: deps.comparisonStore.list() };
  });

  app.get<{ Params: ComparisonIdParams }>("/api/v1/comparisons/:comparisonId", (request) => {
    return deps.comparisonStore.get(request.params.comparisonId);
  });

  app.post<{ Params: ComparisonIdParams }>(
    "/api/v1/comparisons/:comparisonId/prepare",
    async (request) => {
      return deps.orchestrator.prepareComparison(request.params.comparisonId);
    },
  );

  app.post<{ Params: ComparisonCandidateParams }>(
    "/api/v1/comparisons/:comparisonId/candidates/:candidateId/start",
    async (request, reply) => {
      const record = await deps.orchestrator.startCandidate(
        request.params.comparisonId,
        request.params.candidateId,
      );
      await reply.status(202).send(record);
    },
  );

  app.post<{ Params: ComparisonCandidateParams }>(
    "/api/v1/comparisons/:comparisonId/candidates/:candidateId/cancel",
    async (request, reply) => {
      const result = deps.orchestrator.requestCandidateCancellation(
        request.params.comparisonId,
        request.params.candidateId,
      );
      await reply.status(202).send({
        comparisonId: request.params.comparisonId,
        candidateId: request.params.candidateId,
        cancellationRequested: true,
        alreadyRequested: result.alreadyRequested,
      });
    },
  );

  app.post<{ Params: ComparisonIdParams }>(
    "/api/v1/comparisons/:comparisonId/preference",
    (request) => {
      return deps.orchestrator.setPreference(request.params.comparisonId, request.body);
    },
  );

  app.delete<{ Params: ComparisonIdParams }>(
    "/api/v1/comparisons/:comparisonId",
    async (request) => {
      return deps.orchestrator.cleanupComparison(request.params.comparisonId);
    },
  );
}
