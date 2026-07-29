import type { FastifyInstance, FastifyReply } from "fastify";
import { PROTOCOL_VERSION } from "@hall-of-wisdom/protocol";

/** A shared, mutable ref the caller holds onto and flips — see `HealthRouteDeps.readiness`. */
export interface ReadinessRef {
  ready: boolean;
}

export interface HealthRouteDeps {
  readonly startedAt: number;
  /**
   * Phase 13.2, kickoff §3/§10 — when supplied, `.ready` is checked on
   * every request: once a displaced instance's `runControlledShutdown`
   * flips it to `false` (the very first thing that function does — see
   * `server.ts`), this route immediately starts returning `503`/
   * `"not_ready"` instead of `200`/`"ok"`, for as long as this process
   * keeps running through its (possibly multi-second) shutdown sequence.
   * `undefined` (the default — every existing caller and test) means
   * this process never reports anything but ready, unchanged from
   * pre-Phase-13.2 behavior.
   */
  readonly readiness?: ReadinessRef | undefined;
}

/** Never includes local paths, environment data, or dependency versions/secrets — only bounded, safe status fields. */
export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get("/api/v1/health", (_request, reply: FastifyReply) => {
    const ready = deps.readiness?.ready ?? true;
    if (!ready) {
      reply.status(503);
    }
    return {
      status: ready ? "ok" : "not_ready",
      application: "hall-core",
      protocolVersion: PROTOCOL_VERSION,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    };
  });
}
