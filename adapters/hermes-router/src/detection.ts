import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { type PlatformPath } from "node:path";
import { z } from "zod";
import {
  parseAgentDetectionResult,
  type AgentDetectionResult,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { CapabilityObservation } from "@hall-of-wisdom/protocol";
import { HERMES_RUNTIME_CAPABILITIES } from "./descriptor.js";
import { HERMES_PROTOCOL_VERSION, hermesRuntimeVersionSchema } from "./hermes-protocol.js";
import { nodeDetectionProcessRunner, type DetectionProcessRunner } from "./process-runner.js";

export { HERMES_PROTOCOL_VERSION } from "./hermes-protocol.js";
export const HERMES_RUNNER_FILENAME = "hermes_agent_runner.py";
export const DEFAULT_HERMES_PYTHON = "python";
export const DEFAULT_HERMES_DETECTION_TIMEOUT_MS = 5000;
export const MAX_HERMES_DETECTION_OUTPUT_BYTES = 16_384;
export const HERMES_EXECUTION_DISABLED_MESSAGE =
  "Hermes coding runtime detected; Hall task execution is not enabled yet.";

const ROOT_NOT_CONFIGURED_MESSAGE = "Hermes Router runtime root is not configured.";
const RUNNER_NOT_FOUND_MESSAGE = "Hermes coding runtime runner was not found.";
const PROCESS_START_FAILED_MESSAGE = "Hermes coding runtime could not be started.";
const DETECTION_FAILED_MESSAGE = "Hermes coding runtime detection could not be verified.";
const ROUTER_UNAVAILABLE_MESSAGE =
  "Hermes coding runtime is installed but its configured router is unavailable.";

const capabilitySchema = z.enum(HERMES_RUNTIME_CAPABILITIES);
const exactCapabilitiesSchema = z
  .array(capabilitySchema)
  .length(HERMES_RUNTIME_CAPABILITIES.length)
  .refine(
    (capabilities) =>
      new Set(capabilities).size === HERMES_RUNTIME_CAPABILITIES.length &&
      HERMES_RUNTIME_CAPABILITIES.every((capability) => capabilities.includes(capability)),
  );

const detectBaseShape = {
  protocol: z.literal(HERMES_PROTOCOL_VERSION),
  runtime_version: hermesRuntimeVersionSchema,
};

const availableDetectDocumentSchema = z
  .object({
    ...detectBaseShape,
    available: z.literal(true),
    capabilities: exactCapabilitiesSchema,
    integration_level: z.literal("structured_cli"),
    execution_trust: z.literal("trusted_local"),
  })
  .strict();

const unavailableDetectDocumentSchema = z
  .object({
    ...detectBaseShape,
    available: z.literal(false),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
  })
  .strict();

const detectDocumentSchema = z.discriminatedUnion("available", [
  availableDetectDocumentSchema,
  unavailableDetectDocumentSchema,
]);

export interface FileSystemProbe {
  isFile(filePath: string): boolean;
}

export const realFileSystemProbe: FileSystemProbe = {
  isFile(filePath) {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
};

export interface HermesDetectionOptions {
  readonly platform: NodeJS.Platform;
  readonly parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly fs: FileSystemProbe;
  readonly processRunner: DetectionProcessRunner;
}

function result(input: AgentDetectionResult): AgentDetectionResult {
  return parseAgentDetectionResult(input);
}

function unavailable(diagnosticMessage: string): AgentDetectionResult {
  return result({
    installed: false,
    availability: "unavailable",
    diagnosticMessage,
    executionTrust: "unavailable",
    capabilityObservations: [],
  });
}

function unsupported(
  diagnosticMessage: string,
  detectedVersion?: string,
  capabilityObservations: readonly CapabilityObservation[] = [],
): AgentDetectionResult {
  return result({
    installed: true,
    availability: "unsupported",
    diagnosticMessage,
    executionTrust: "unavailable",
    capabilityObservations: [...capabilityObservations],
    ...(detectedVersion === undefined ? {} : { detectedVersion }),
  });
}

function declaredCapabilityObservations(): CapabilityObservation[] {
  return HERMES_RUNTIME_CAPABILITIES.map((capability) => ({
    capability,
    status: "declared",
    safeSummary: "Declared by the detected Hermes runtime; Hall execution is not enabled yet.",
    evidence: "declared_only",
  }));
}

function parseDetectDocument(stdout: string): z.infer<typeof detectDocumentSchema> | undefined {
  if (Buffer.byteLength(stdout, "utf8") > MAX_HERMES_DETECTION_OUTPUT_BYTES) return undefined;
  const document = stdout.trim();
  if (document.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(document);
    const validated = detectDocumentSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

function pathApiForPlatform(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

export async function detectHermesRouter(
  options: HermesDetectionOptions,
): Promise<AgentDetectionResult> {
  const configuredRoot = options.parentEnv.HALL_HERMES_ROUTER_ROOT?.trim();
  const pathApi = pathApiForPlatform(options.platform);
  if (
    configuredRoot === undefined ||
    configuredRoot.length === 0 ||
    !pathApi.isAbsolute(configuredRoot)
  ) {
    return unavailable(ROOT_NOT_CONFIGURED_MESSAGE);
  }

  const runnerPath = pathApi.resolve(configuredRoot, HERMES_RUNNER_FILENAME);
  if (!options.fs.isFile(runnerPath)) {
    return unavailable(RUNNER_NOT_FOUND_MESSAGE);
  }

  const configuredPython = options.parentEnv.HALL_HERMES_PYTHON?.trim();
  const pythonCommand =
    configuredPython === undefined || configuredPython.length === 0
      ? DEFAULT_HERMES_PYTHON
      : configuredPython;
  const processResult = await options.processRunner.run({
    executablePath: pythonCommand,
    args: [runnerPath, "detect"],
    cwd: tmpdir(),
    env: options.parentEnv,
    timeoutMs: DEFAULT_HERMES_DETECTION_TIMEOUT_MS,
    maxOutputBytes: MAX_HERMES_DETECTION_OUTPUT_BYTES,
  });

  if (processResult.status === "spawn_error") {
    return unavailable(PROCESS_START_FAILED_MESSAGE);
  }
  if (processResult.status !== "success") {
    return unsupported(DETECTION_FAILED_MESSAGE);
  }

  const document = parseDetectDocument(processResult.stdout);
  if (document === undefined) {
    return unsupported(DETECTION_FAILED_MESSAGE);
  }
  if (!document.available) {
    return unsupported(ROUTER_UNAVAILABLE_MESSAGE, document.runtime_version);
  }

  return unsupported(
    HERMES_EXECUTION_DISABLED_MESSAGE,
    document.runtime_version,
    declaredCapabilityObservations(),
  );
}

export function createDefaultHermesDetectionOptions(
  overrides: Partial<HermesDetectionOptions> = {},
): HermesDetectionOptions {
  return {
    platform: overrides.platform ?? process.platform,
    parentEnv: overrides.parentEnv ?? process.env,
    fs: overrides.fs ?? realFileSystemProbe,
    processRunner: overrides.processRunner ?? nodeDetectionProcessRunner,
  };
}
