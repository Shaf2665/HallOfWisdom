import type { FastifyInstance } from "fastify";
import { PROTOCOL_VERSION } from "@hall-of-wisdom/protocol";

export interface HealthRouteDeps {
  readonly startedAt: number;
}

/** Never includes local paths, environment data, or dependency versions/secrets — only bounded, safe status fields. */
export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get("/api/v1/health", () => {
    return {
      status: "ok" as const,
      application: "hall-core",
      protocolVersion: PROTOCOL_VERSION,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    };
  });
}
