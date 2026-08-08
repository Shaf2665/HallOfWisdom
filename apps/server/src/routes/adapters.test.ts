import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import type { AgentAdapter } from "@hall-of-wisdom/agent-adapter-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { installErrorHandler, installNotFoundHandler } from "../errors/error-handler.js";
import { registerAdapterRoutes } from "./adapters.js";

function buildFakeAdapter(overrides: {
  adapterId: string;
  displayName?: string;
  provider?: string;
  declaredCapabilities?: readonly string[];
  integrationLevel?: string;
  detect: () => Promise<{ installed: boolean; availability: string }>;
}): AgentAdapter {
  return {
    descriptor: {
      adapterId: overrides.adapterId,
      displayName: overrides.displayName ?? overrides.adapterId,
      adapterVersion: "1.0.0",
      supportedAgent: {
        agentId: `${overrides.adapterId}-agent`,
        displayName: `${overrides.adapterId} agent`,
        adapterId: overrides.adapterId,
        adapterVersion: "1.0.0",
        ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
      },
      capabilities: {
        streaming: true,
        cancellation: true,
        sessionResume: false,
        toolEvents: true,
        fileEditing: false,
        shellExecution: false,
        subagents: false,
        mcp: false,
        acp: false,
      },
      declaredCapabilities: overrides.declaredCapabilities ?? [],
      integrationLevel: overrides.integrationLevel ?? "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
    } as AgentAdapter["descriptor"],
    detect: overrides.detect as AgentAdapter["detect"],
    startTask: () => Promise.reject(new Error("not used in this test")),
  };
}

async function buildApp(registry: AgentRegistry): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  installNotFoundHandler(app);
  registerAdapterRoutes(app, { registry });
  await app.ready();
  return app;
}

interface AdapterSummaryJson {
  readonly adapterId: string;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly provider?: string;
  readonly integrationLevel: string;
  readonly supportedOperatingSystems: readonly string[];
  readonly capabilities: Record<string, boolean>;
  readonly installed: boolean;
  readonly availability: string;
  readonly executablePath?: string;
  readonly diagnosticMessage?: string;
  readonly limitationNotice?: string;
  readonly statusMessage?: string;
  readonly detectedVersion?: string;
}

describe("GET /api/v1/adapters", () => {
  it("returns one adapter with a safe, complete summary", async () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    expect(body.adapters).toHaveLength(1);
    const [adapter] = body.adapters;
    expect(adapter).toMatchObject({
      adapterId: "hall.mock-agent",
      displayName: "Mock Agent",
      agentId: "mock-agent",
      agentDisplayName: "Mock Agent",
      integrationLevel: "native",
      availability: "available",
    });
    expect(adapter?.provider).toBeUndefined();
    await app.close();
  });

  it("returns multiple adapters", async () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.other-agent",
        detect: () => Promise.resolve({ installed: true, availability: "available" }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    expect(body.adapters).toHaveLength(2);
    await app.close();
  });

  it("sorts adapters deterministically by adapterId", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.zzz-agent",
        detect: () => Promise.resolve({ installed: true, availability: "available" }),
      }),
    );
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.aaa-agent",
        detect: () => Promise.resolve({ installed: true, availability: "available" }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    expect(body.adapters.map((adapter) => adapter.adapterId)).toEqual([
      "hall.aaa-agent",
      "hall.zzz-agent",
    ]);
    await app.close();
  });

  it("isolates a detect() failure to just that one adapter", async () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-agent",
        detect: () => Promise.reject(new Error("simulated detection crash")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    expect(body.adapters).toHaveLength(2);
    const broken = body.adapters.find((adapter) => adapter.adapterId === "hall.broken-agent");
    expect(broken?.availability).toBe("unavailable");
    const healthy = body.adapters.find((adapter) => adapter.adapterId === "hall.mock-agent");
    expect(healthy?.availability).toBe("available");
    await app.close();
  });

  it("never exposes an executablePath field", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.leaky-agent",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "available",
            executablePath: "C:\\Users\\someone\\AppData\\leaky-agent.exe",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.body).not.toContain("executablePath");
    expect(response.body).not.toContain("AppData");
    await app.close();
  });

  it("never exposes a diagnosticMessage or raw detection error", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-agent",
        detect: () => Promise.reject(new Error("secret internal detail: TOKEN=abc123")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.body).not.toContain("diagnosticMessage");
    expect(response.body).not.toContain("TOKEN=abc123");
    expect(response.body).not.toContain("secret internal detail");
    await app.close();
  });

  it("never exposes environment-variable-shaped data", async () => {
    process.env.HALL_CORE_ADAPTERS_TEST_SECRET = "should-not-leak";
    try {
      const registry = new AgentRegistry();
      registry.register(new MockAgentAdapter());
      const app = await buildApp(registry);
      const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
      expect(response.body).not.toContain("should-not-leak");
      await app.close();
    } finally {
      delete process.env.HALL_CORE_ADAPTERS_TEST_SECRET;
    }
  });

  it("exposes limitationNotice (generically, no adapterId branching) when an available adapter's detect() attaches a diagnosticMessage", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.caveat-agent",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "available",
            diagnosticMessage: "Running in a reduced-trust mode.",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.caveat-agent");
    expect(adapter?.limitationNotice).toBe("Running in a reduced-trust mode.");
    await app.close();
  });

  it("never exposes limitationNotice when availability is not 'available', even if diagnosticMessage is present", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.unsupported-agent",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "unsupported",
            diagnosticMessage: "Adapter unsupported on this platform.",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.unsupported-agent");
    expect(adapter?.limitationNotice).toBeUndefined();
    // Phase 17.2: statusMessage now carries diagnosticMessage for all availability values
    expect(adapter?.statusMessage).toBe("Adapter unsupported on this platform.");
    await app.close();
  });

  it("returns an empty, valid list when no adapters are registered", async () => {
    const registry = new AgentRegistry();
    const app = await buildApp(registry);
    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ adapters: AdapterSummaryJson[] }>().adapters).toEqual([]);
    await app.close();
  });

  it("exposes installed, statusMessage, and detectedVersion regardless of availability", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.logged-out-agent",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "logged_out",
            diagnosticMessage: "Example Agent is installed but not logged in.",
            detectedVersion: "1.2.3",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{
      adapters: (AdapterSummaryJson & {
        installed?: boolean;
        statusMessage?: string;
        detectedVersion?: string;
      })[];
    }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.logged-out-agent");
    expect(adapter?.installed).toBe(true);
    expect(adapter?.statusMessage).toBe("Example Agent is installed but not logged in.");
    expect(adapter?.detectedVersion).toBe("1.2.3");
    // limitationNotice keeps its existing, narrower, available-only contract — unchanged.
    expect(adapter?.limitationNotice).toBeUndefined();
    await app.close();
  });

  it("still exposes limitationNotice for an available adapter, alongside the new statusMessage carrying the same text", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.caveat-agent-2",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "available",
            diagnosticMessage: "Running in a reduced-trust mode.",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{
      adapters: (AdapterSummaryJson & { statusMessage?: string })[];
    }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.caveat-agent-2");
    expect(adapter?.limitationNotice).toBe("Running in a reduced-trust mode.");
    expect(adapter?.statusMessage).toBe("Running in a reduced-trust mode.");
    await app.close();
  });

  it("defaults installed to false and omits statusMessage/detectedVersion when detect() throws", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-agent-2",
        detect: () => Promise.reject(new Error("simulated detection crash")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{
      adapters: (AdapterSummaryJson & {
        installed?: boolean;
        statusMessage?: string;
        detectedVersion?: string;
      })[];
    }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.broken-agent-2");
    expect(adapter?.installed).toBe(false);
    expect(adapter?.statusMessage).toBeUndefined();
    expect(adapter?.detectedVersion).toBeUndefined();
    await app.close();
  });

  it("never exposes a thrown error's message under statusMessage", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-agent-3",
        detect: () => Promise.reject(new Error("secret internal detail: TOKEN=xyz789")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.body).not.toContain("TOKEN=xyz789");
    expect(response.body).not.toContain("secret internal detail");
    await app.close();
  });
});

describe("GET /api/v1/adapters/:adapterId", () => {
  it("returns the same safe summary shape as the list route, for one adapter", async () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters/hall.mock-agent" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ adapter: AdapterSummaryJson }>();
    expect(body.adapter).toMatchObject({
      adapterId: "hall.mock-agent",
      displayName: "Mock Agent",
      availability: "available",
    });
    await app.close();
  });

  it("returns 404 ADAPTER_NOT_FOUND for an unregistered adapterId", async () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters/hall.does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ADAPTER_NOT_FOUND");
    await app.close();
  });

  it("isolates a detect() failure the same way the list route does", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-single",
        detect: () => Promise.reject(new Error("simulated detection crash")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/adapters/hall.broken-single",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ adapter: AdapterSummaryJson & { installed?: boolean } }>();
    expect(body.adapter.availability).toBe("unavailable");
    expect(body.adapter.installed).toBe(false);
    await app.close();
  });

  it("never exposes executablePath or a thrown error's message for the single-adapter route", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.leaky-single",
        detect: () => Promise.reject(new Error("secret internal detail: TOKEN=single456")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters/hall.leaky-single" });
    expect(response.body).not.toContain("TOKEN=single456");
    expect(response.body).not.toContain("executablePath");
    await app.close();
  });
});
