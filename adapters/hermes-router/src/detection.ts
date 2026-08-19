import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { type PlatformPath } from "node:path";
import { fileURLToPath } from "node:url";
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
export const HERMES_RUNTIME_DIRECTORY = "runtime";
export const DEFAULT_HERMES_PYTHON = "python";
export const DEFAULT_HERMES_DETECTION_TIMEOUT_MS = 5000;
export const MAX_HERMES_DETECTION_OUTPUT_BYTES = 16_384;
export const HERMES_EXECUTION_DISABLED_MESSAGE =
  "Hermes task execution requires Hall durable isolated-worktree execution.";

const ROOT_NOT_FOUND_MESSAGE = "Hall's bundled Hermes execution runtime was not found.";
const RUNNER_NOT_FOUND_MESSAGE = "Hall's bundled Hermes execution runner was not found.";
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
    /**
     * Optional, additive: whether the detected Hermes runtime's configured
     * router currently has an available vision-capable model (a live,
     * bounded check against the router's own `/status`, reusing its
     * existing model-capability data — see `hermes_agent`'s `detect`
     * command). `.optional()` so an older Hermes runtime that predates
     * this field still parses; its absence is treated the same as `false`
     * — `vision.image` is then never reported `verified` (fail closed).
     */
    vision_available: z.boolean().optional(),
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
  isDirectory?(directoryPath: string): boolean;
}

export const realFileSystemProbe: FileSystemProbe = {
  isFile(filePath) {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  },
  isDirectory(directoryPath) {
    try {
      return statSync(directoryPath).isDirectory();
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
  readonly isolatedExecutionEnabled: boolean;
  /** Test-only override for the Hall-owned runtime package root. */
  readonly runtimeRoot?: string;
}

export type HermesRuntimeConfigurationResolution =
  | {
      readonly ok: true;
      readonly pythonExecutable: string;
      readonly runnerPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: "root_not_found" | "runner_not_found";
    };

function bundledRuntimeRoot(platform: NodeJS.Platform): string {
  const pathApi = pathApiForPlatform(platform);
  return pathApi.resolve(
    pathApi.dirname(fileURLToPath(import.meta.url)),
    "..",
    HERMES_RUNTIME_DIRECTORY,
  );
}

export function resolveHermesRuntimeConfiguration(
  options: Pick<HermesDetectionOptions, "platform" | "parentEnv" | "fs" | "runtimeRoot">,
): HermesRuntimeConfigurationResolution {
  const pathApi = pathApiForPlatform(options.platform);
  // Hall owns this runtime. HALL_HERMES_ROUTER_ROOT is accepted only during
  // migration for installations that still carry the former external runner.
  const configuredRoot = options.parentEnv.HALL_HERMES_ROUTER_ROOT?.trim();
  const runtimeRoot =
    configuredRoot !== undefined && configuredRoot.length > 0 && pathApi.isAbsolute(configuredRoot)
      ? configuredRoot
      : (options.runtimeRoot ?? bundledRuntimeRoot(options.platform));
  if (options.fs.isDirectory !== undefined && !options.fs.isDirectory(runtimeRoot)) {
    return { ok: false, reason: "root_not_found" };
  }

  const runnerPath = pathApi.resolve(runtimeRoot, HERMES_RUNNER_FILENAME);
  if (!options.fs.isFile(runnerPath)) return { ok: false, reason: "runner_not_found" };

  const configuredPython = options.parentEnv.HALL_HERMES_PYTHON?.trim();
  return {
    ok: true,
    runnerPath,
    pythonExecutable:
      configuredPython === undefined || configuredPython.length === 0
        ? DEFAULT_HERMES_PYTHON
        : configuredPython,
  };
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

function available(
  detectedVersion: string,
  capabilityObservations: readonly CapabilityObservation[],
): AgentDetectionResult {
  return result({
    installed: true,
    availability: "available",
    detectedVersion,
    executionTrust: "isolated",
    capabilityObservations: [...capabilityObservations],
  });
}

function declaredCapabilityObservations(): CapabilityObservation[] {
  return HERMES_RUNTIME_CAPABILITIES.map((capability) => ({
    capability,
    status: "declared",
    safeSummary: "Declared by the detected Hermes runtime.",
    evidence: "declared_only",
  }));
}

/**
 * `vision.image` is deliberately not part of `HERMES_RUNTIME_CAPABILITIES`
 * (whose exact-match schema pins the Python `detect` command's own fixed
 * `capabilities` list) — unlike those, this is never merely `declared`:
 * every other Hermes capability above is stamped `"declared"` regardless
 * of live state, which would never satisfy a required capability under
 * routing's "only verified counts" rule (see `routing-policy.ts`). Real
 * vision support instead depends on whether the router currently has an
 * available vision-capable model — `document.vision_available`, computed
 * by the Python side from a live, bounded `/status` check, never a
 * hardcoded model or provider name. `undefined` (an older runtime that
 * predates this field) is treated the same as `false` — fail closed, no
 * observation at all, which routing-policy already treats as "missing".
 */
function visionCapabilityObservation(
  visionAvailable: boolean | undefined,
): CapabilityObservation | undefined {
  if (visionAvailable !== true) return undefined;
  return {
    capability: "vision.image",
    status: "verified",
    safeSummary:
      "Verified: the configured Hermes Router currently has an available vision-capable model.",
    evidence: "environment_probe",
  };
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
  const configuration = resolveHermesRuntimeConfiguration(options);
  if (!configuration.ok) {
    const diagnosticMessage =
      configuration.reason === "root_not_found" ? ROOT_NOT_FOUND_MESSAGE : RUNNER_NOT_FOUND_MESSAGE;
    return unavailable(diagnosticMessage);
  }
  const processResult = await options.processRunner.run({
    executablePath: configuration.pythonExecutable,
    args: [configuration.runnerPath, "detect"],
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

  const capabilityObservations = declaredCapabilityObservations();
  if (!options.isolatedExecutionEnabled) {
    return unsupported(
      HERMES_EXECUTION_DISABLED_MESSAGE,
      document.runtime_version,
      capabilityObservations,
    );
  }
  const visionObservation = visionCapabilityObservation(document.vision_available);
  return available(
    document.runtime_version,
    visionObservation === undefined
      ? capabilityObservations
      : [...capabilityObservations, visionObservation],
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
    isolatedExecutionEnabled: overrides.isolatedExecutionEnabled ?? false,
    ...(overrides.runtimeRoot === undefined ? {} : { runtimeRoot: overrides.runtimeRoot }),
  };
}
