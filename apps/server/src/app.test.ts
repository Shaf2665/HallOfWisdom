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
