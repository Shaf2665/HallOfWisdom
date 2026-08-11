import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthenticationInvalidCredentialsError } from "../errors/app-error.js";
import type { HallAuthentication } from "../auth/hall-auth.js";

const loginRequestSchema = z
  .object({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) })
  .strict();

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { readonly authentication: HallAuthentication },
): void {
  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    const cookie = parsed.success
      ? deps.authentication.authenticate(parsed.data.username, parsed.data.password)
      : undefined;
    if (cookie === undefined) throw new AuthenticationInvalidCredentialsError();
    reply.header("Set-Cookie", cookie);
    return { authenticated: true };
  });

  app.post("/api/v1/auth/logout", (_request, reply) => {
    reply.header("Set-Cookie", deps.authentication.clearSession());
    return { authenticated: false };
  });

  app.get("/api/v1/auth/session", (request) => ({
    authenticated: deps.authentication.hasSession(request.headers.cookie),
  }));
}
