import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import type { AgentAdapter } from "@hall-of-wisdom/agent-adapter-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdapterRoutes } from "./adapters.js";

function buildFakeAdapter(overrides: {
  adapterId: string;
  displayName?: string;
  provider?: string;
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
      integrationLevel: "native",
      supportedOperatingSystems: ["windows", "macos", "linux"],
    },
    detect: overrides.detect as AgentAdapter["detect"],
    startTask: () => Promise.reject(new Error("not used in this test")),
  };
}

async function buildApp(registry: AgentRegistry): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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
  readonly availability: string;
  readonly executablePath?: string;
  readonly diagnosticMessage?: string;
  readonly limitationNotice?: string;
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
            diagnosticMessage: "This should never reach the client.",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.body).not.toContain("This should never reach the client.");
    const body = response.json<{ adapters: AdapterSummaryJson[] }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.unsupported-agent");
    expect(adapter?.limitationNotice).toBeUndefined();
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
});
