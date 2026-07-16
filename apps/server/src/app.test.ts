import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@hall-of-wisdom/protocol";
import { buildTestApp } from "./test-support.js";

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

  it("does not enable CORS credentials", async () => {
    const { app } = await buildTestApp({ workspaceRoot: tempRoot, webOrigin: ALLOWED_ORIGIN });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    await app.close();
  });
});
