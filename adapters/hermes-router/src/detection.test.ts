import { describe, expect, it } from "vitest";
import { detectHermesRouter, MAX_HERMES_DETECTION_OUTPUT_BYTES } from "./detection.js";
import type {
  DetectionProcessOptions,
  DetectionProcessResult,
  DetectionProcessRunner,
} from "./process-runner.js";

const LINUX_ROOT = "/opt/Hermes Router";
const LINUX_RUNNER = "/opt/Hermes Router/hermes_agent_runner.py";

class RecordingProcessRunner implements DetectionProcessRunner {
  readonly calls: DetectionProcessOptions[] = [];

  constructor(private readonly processResult: DetectionProcessResult) {}

  run(options: DetectionProcessOptions): Promise<DetectionProcessResult> {
    this.calls.push(options);
    return Promise.resolve(this.processResult);
  }
}

function fakeFs(existingPaths: readonly string[]) {
  const paths = new Set(existingPaths);
  return { isFile: (filePath: string) => paths.has(filePath) };
}

function detectDocument(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol: "hermes-agent/v1",
    runtime_version: "0.1.0",
    available: true,
    capabilities: [
      "project.read",
      "project.edit",
      "command.execute",
      "structured.events",
      "cancellation",
    ],
    integration_level: "structured_cli",
    execution_trust: "trusted_local",
    ...overrides,
  });
}

function detectionOptions(
  runner: DetectionProcessRunner,
  overrides: {
    platform?: NodeJS.Platform;
    parentEnv?: Readonly<NodeJS.ProcessEnv>;
    existingPaths?: readonly string[];
    isolatedExecutionEnabled?: boolean;
  } = {},
) {
  return {
    platform: overrides.platform ?? "linux",
    parentEnv: overrides.parentEnv ?? { HALL_HERMES_ROUTER_ROOT: LINUX_ROOT },
    fs: fakeFs(overrides.existingPaths ?? [LINUX_RUNNER]),
    processRunner: runner,
    isolatedExecutionEnabled: overrides.isolatedExecutionEnabled ?? false,
  };
}

describe("detectHermesRouter", () => {
  it("reports unavailable when HALL_HERMES_ROUTER_ROOT is missing", async () => {
    const runner = new RecordingProcessRunner({ status: "success", stdout: detectDocument() });
    const result = await detectHermesRouter(
      detectionOptions(runner, { parentEnv: {}, existingPaths: [] }),
    );

    expect(result).toMatchObject({
      installed: false,
      availability: "unavailable",
      executionTrust: "unavailable",
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("reports unavailable when the configured root is not absolute", async () => {
    const runner = new RecordingProcessRunner({ status: "success", stdout: detectDocument() });
    const result = await detectHermesRouter(
      detectionOptions(runner, {
        parentEnv: { HALL_HERMES_ROUTER_ROOT: "relative/Hermes-router" },
        existingPaths: [],
      }),
    );

    expect(result.availability).toBe("unavailable");
    expect(runner.calls).toHaveLength(0);
  });

  it("reports unavailable when the runner is missing", async () => {
    const runner = new RecordingProcessRunner({ status: "success", stdout: detectDocument() });
    const result = await detectHermesRouter(detectionOptions(runner, { existingPaths: [] }));

    expect(result).toMatchObject({ installed: false, availability: "unavailable" });
    expect(runner.calls).toHaveLength(0);
  });

  it("reports unavailable with a fixed diagnostic when Python cannot spawn", async () => {
    const runner = new RecordingProcessRunner({ status: "spawn_error", stdout: "secret output" });
    const result = await detectHermesRouter(detectionOptions(runner));

    expect(result).toMatchObject({
      installed: false,
      availability: "unavailable",
      diagnosticMessage: "Hermes coding runtime could not be started.",
    });
    expect(JSON.stringify(result)).not.toContain("secret output");
  });

  it.each(["timed_out", "non_zero_exit"] as const)(
    "fails safely when detection ends with %s",
    async (status) => {
      const runner = new RecordingProcessRunner({ status, stdout: "credential-shaped output" });
      const result = await detectHermesRouter(detectionOptions(runner));

      expect(result).toMatchObject({
        installed: true,
        availability: "unsupported",
        diagnosticMessage: "Hermes coding runtime detection could not be verified.",
        executionTrust: "unavailable",
      });
      expect(JSON.stringify(result)).not.toContain("credential-shaped output");
    },
  );

  it.each([
    { name: "malformed JSON", stdout: "not-json" },
    { name: "multiple JSON documents", stdout: `${detectDocument()}\n${detectDocument()}` },
    { name: "oversized JSON", stdout: "x".repeat(MAX_HERMES_DETECTION_OUTPUT_BYTES + 1) },
  ])("rejects $name", async ({ stdout }) => {
    const runner = new RecordingProcessRunner({ status: "success", stdout });
    const result = await detectHermesRouter(detectionOptions(runner));

    expect(result.availability).toBe("unsupported");
    expect(result.detectedVersion).toBeUndefined();
  });

  it("rejects the wrong protocol", async () => {
    const runner = new RecordingProcessRunner({
      status: "success",
      stdout: detectDocument({ protocol: "hermes-agent/v2" }),
    });
    const result = await detectHermesRouter(detectionOptions(runner));

    expect(result.availability).toBe("unsupported");
    expect(result.detectedVersion).toBeUndefined();
  });

  it("rejects an invalid runtime version", async () => {
    const runner = new RecordingProcessRunner({
      status: "success",
      stdout: detectDocument({ runtime_version: "version from untrusted output" }),
    });
    const result = await detectHermesRouter(detectionOptions(runner));

    expect(result.availability).toBe("unsupported");
    expect(result.detectedVersion).toBeUndefined();
  });

  it("rejects unknown, missing, or duplicated runtime capabilities", async () => {
    const invalidCapabilities = [
      ["project.read", "project.edit", "command.execute", "structured.events", "network.access"],
      ["project.read", "project.edit", "command.execute", "structured.events"],
      ["project.read", "project.edit", "command.execute", "structured.events", "project.read"],
    ];

    for (const capabilities of invalidCapabilities) {
      const runner = new RecordingProcessRunner({
        status: "success",
        stdout: detectDocument({ capabilities }),
      });
      const result = await detectHermesRouter(detectionOptions(runner));
      expect(result.availability).toBe("unsupported");
    }
  });

  it("parses valid output but remains unsupported when Hall isolation is disabled", async () => {
    const parentEnv = {
      HALL_HERMES_ROUTER_ROOT: LINUX_ROOT,
      HALL_HERMES_PYTHON: "/usr/local/bin/python3",
      HERMES_ROUTER_API_KEY: "local-secret-not-for-results",
    };
    const runner = new RecordingProcessRunner({ status: "success", stdout: detectDocument() });
    const result = await detectHermesRouter(detectionOptions(runner, { parentEnv }));

    expect(result).toMatchObject({
      installed: true,
      availability: "unsupported",
      detectedVersion: "0.1.0",
      executionTrust: "unavailable",
      diagnosticMessage: "Hermes task execution requires Hall durable isolated-worktree execution.",
    });
    expect(result.capabilityObservations).toHaveLength(5);
    expect(
      result.capabilityObservations?.every((observation) => observation.status === "declared"),
    ).toBe(true);
    expect(
      result.capabilityObservations?.map((observation) => observation.capability),
    ).not.toContain("git.inspect");
    expect(
      result.capabilityObservations?.map((observation) => observation.capability),
    ).not.toContain("session.resume");
    expect(JSON.stringify(result)).not.toContain("local-secret-not-for-results");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      executablePath: "/usr/local/bin/python3",
      args: [LINUX_RUNNER, "detect"],
      env: parentEnv,
      timeoutMs: 5000,
      maxOutputBytes: 16_384,
    });
  });

  it("reports available with isolated trust when the healthy runtime is behind Hall isolation", async () => {
    const runner = new RecordingProcessRunner({ status: "success", stdout: detectDocument() });
    const result = await detectHermesRouter(
      detectionOptions(runner, { isolatedExecutionEnabled: true }),
    );

    expect(result).toMatchObject({
      installed: true,
      availability: "available",
      detectedVersion: "0.1.0",
      executionTrust: "isolated",
    });
    expect(result.diagnosticMessage).toBeUndefined();
    expect(result.capabilityObservations).toHaveLength(5);
    expect(
      result.capabilityObservations?.every(
        (observation) =>
          observation.status === "declared" && observation.evidence === "declared_only",
      ),
    ).toBe(true);
  });

  it("maps a valid unavailable router document to a safe unsupported result", async () => {
    const runner = new RecordingProcessRunner({
      status: "success",
      stdout: JSON.stringify({
        protocol: "hermes-agent/v1",
        runtime_version: "0.1.0",
        available: false,
        code: "HERMES_ROUTER_UNAVAILABLE",
        message: "raw router detail must not escape",
      }),
    });
    const result = await detectHermesRouter(
      detectionOptions(runner, { isolatedExecutionEnabled: true }),
    );

    expect(result).toMatchObject({
      installed: true,
      availability: "unsupported",
      executionTrust: "unavailable",
      detectedVersion: "0.1.0",
      diagnosticMessage:
        "Hermes coding runtime is installed but its configured router is unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain("raw router detail must not escape");
  });

  it("builds a Windows runner argv correctly for roots containing spaces", async () => {
    const windowsRoot = "C:\\Agent Runtimes\\Hermes-router";
    const windowsRunner = `${windowsRoot}\\hermes_agent_runner.py`;
    const runner = new RecordingProcessRunner({ status: "success", stdout: detectDocument() });
    const result = await detectHermesRouter(
      detectionOptions(runner, {
        platform: "win32",
        parentEnv: {
          HALL_HERMES_ROUTER_ROOT: windowsRoot,
          HALL_HERMES_PYTHON: "C:\\Python 3.13\\python.exe",
        },
        existingPaths: [windowsRunner],
      }),
    );

    expect(result.availability).toBe("unsupported");
    expect(runner.calls[0]).toMatchObject({
      executablePath: "C:\\Python 3.13\\python.exe",
      args: [windowsRunner, "detect"],
    });
  });
});
