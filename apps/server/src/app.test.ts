import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@hall-of-wisdom/protocol";
import { buildTestApp } from "./test-support.js";
import { OwnershipLostError } from "./persistence/persistence-errors.js";
import { createHallAuthentication } from "./auth/hall-auth.js";

describe("createHallCoreApp", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-app-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("creates an app without automatically listening", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    expect(app.server.listening).toBe(false);
    await app.close();
  });

  it("registers the websocket plugin (decorates the instance) before any route uses it", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    expect(typeof app.websocketServer).toBe("object");
    await app.close();
  });

  it("can disable logging for tests", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, logger: false });
    expect(app.log).toBeDefined();
    await app.close();
  });

  it("returns a safe, bounded 404 for an unknown route", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const response = await app.inject({ method: "GET", url: "/no-such-route" });
    expect(response.statusCode).toBe(404);
    const body: unknown = response.json();
    expect(body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(JSON.stringify(body)).not.toContain(tempRoot);
    await app.close();
  });

  it("returns a bounded 500 for an unexpected internal error, without a stack trace", async () => {
    const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
    app.get("/__throw", () => {
      throw new Error("boom: something unexpected happened internally");
    });
    const response = await app.inject({ method: "GET", url: "/__throw" });
    expect(response.statusCode).toBe(500);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("boom");
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+:\d+/);
    void harness;
    await app.close();
  });

  // Phase 13.2, kickoff §10 — a mutation rejected by the durable
  // ownership fence maps to a dedicated bounded 503, never an unmapped
  // generic 500, and (like every other error path here) never leaks a
  // path or raw internal detail.
  it("returns a bounded 503 with code OWNERSHIP_LOST when a route throws OwnershipLostError", async () => {
    const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot });
    app.get("/__ownership-lost", () => {
      throw new OwnershipLostError();
    });
    const response = await app.inject({ method: "GET", url: "/__ownership-lost" });
    expect(response.statusCode).toBe(503);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("OWNERSHIP_LOST");
    expect(JSON.stringify(body)).not.toContain(tempRoot);
    void harness;
    await app.close();
  });

  // Phase 13.2, kickoff §3/§10 — "health must not report ready" once an
  // instance has lost durable ownership (or is otherwise mid-controlled-
  // shutdown). `readiness` is the same mutable ref `server.ts` flips as
  // the first step of its shared shutdown routine.
  it("GET /api/v1/health returns 503/not_ready once the shared readiness ref is flipped false", async () => {
    const readiness = { ready: true };
    const { app, harness } = await buildTestApp({ workspaceRoot: tempRoot, readiness });

    const beforeResponse = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(beforeResponse.statusCode).toBe(200);
    expect(beforeResponse.json<{ status: string }>().status).toBe("ok");

    readiness.ready = false;

    const afterResponse = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(afterResponse.statusCode).toBe(503);
    expect(afterResponse.json<{ status: string }>().status).toBe("not_ready");

    void harness;
    await app.close();
  });

  it("GET /api/v1/health returns 200 with safe, bounded fields", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      application: string;
      protocolVersion: string;
      uptimeSeconds: number;
    }>();
    expect(body.status).toBe("ok");
    expect(body.application).toBe("hall-core");
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(typeof body.uptimeSeconds).toBe("number");
    await app.close();
  });

  it("does not expose the workspace path or environment data through /health", async () => {
    process.env.HALL_CORE_TEST_SECRET = "should-not-leak-anywhere";
    try {
      const { app } = await buildTestApp({ workspaceRoot: tempRoot });
      const response = await app.inject({ method: "GET", url: "/api/v1/health" });
      const text = response.body;
      expect(text).not.toContain(tempRoot);
      expect(text).not.toContain("should-not-leak-anywhere");
      await app.close();
    } finally {
      delete process.env.HALL_CORE_TEST_SECRET;
    }
  });
});

describe("CORS", () => {
  let tempRoot: string;
  const ALLOWED_ORIGIN = "http://127.0.0.1:3000";
  const OTHER_ORIGIN = "http://evil.example.com";

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-cors-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("an allowed HTTP Origin receives CORS headers", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    await app.close();
  });

  it("a rejected HTTP Origin receives no CORS allow-origin header", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: OTHER_ORIGIN },
    });
    // The server still answers (CORS is a browser-side enforcement
    // mechanism) — it just never grants the disallowed origin permission
    // to read the response via the missing header.
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("OPTIONS preflight succeeds for an approved Origin", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/tasks",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    await app.close();
  });

  it("OPTIONS preflight grants no CORS permission for an unapproved Origin", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/tasks",
      headers: {
        origin: OTHER_ORIGIN,
        "access-control-request-method": "POST",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("an Origin-less request (PowerShell/curl-style) continues to work", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("defaults to the documented default web origin when --web-origin is not configured", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: "http://127.0.0.1:3000" },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
    await app.close();
  });

  it("does not use a wildcard origin", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
    await app.close();
  });

  it("enables CORS credentials for the signed session cookie", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("a remote HTTPS web origin (Cloudflare Tunnel, via --web-origin) receives CORS headers", async () => {
    const REMOTE_ORIGIN = "https://hall.example.com";
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: REMOTE_ORIGIN });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: REMOTE_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(REMOTE_ORIGIN);
    await app.close();
  });

  it("configuring a remote --web-origin stops granting the local loopback origin CORS access", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: "https://hall.example.com" });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("Hall authentication", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-core-auth-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function authentication() {
    return createHallAuthentication({
      username: "admin",
      password: "hallofwisdom",
      sessionSecret: "test-session-secret",
    });
  }

  it("keeps health and auth session public but protects Hall APIs", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      authentication: authentication(),
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session" })).json()).toEqual({
      authenticated: false,
    });
    const protectedResponse = await app.inject({ method: "GET", url: "/api/v1/tasks" });
    expect(protectedResponse.statusCode).toBe(401);
    expect(protectedResponse.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
    await app.close();
  });

  it("issues a signed session only for valid credentials and accepts it on later requests", async () => {
    const { app } = await buildTestApp({
      workspaceRoot: tempRoot,
      authentication: authentication(),
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "wrong" },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json<{ error: { message: string } }>().error.message).toBe(
      "Invalid username or password.",
    );

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "hallofwisdom" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.body).not.toContain("hallofwisdom");
    expect(login.body).not.toContain("test-session-secret");
    const cookie = login.headers["set-cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=604800");
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
    expect(cookieHeader).toBeDefined();
    expect(authentication().hasSession(cookieHeader)).toBe(true);

    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie },
    });
    expect(session.json()).toEqual({ authenticated: true });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/tasks", headers: { cookie } })).statusCode,
    ).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(logout.json()).toEqual({ authenticated: false });
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    await app.close();
  });
});
