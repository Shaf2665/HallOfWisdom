export {
  hermesRouterDescriptor,
  HERMES_ROUTER_ADAPTER_ID,
  HERMES_ROUTER_AGENT_ID,
  HERMES_ROUTER_ADAPTER_VERSION,
  HERMES_RUNTIME_CAPABILITIES,
} from "./descriptor.js";
export { HermesRouterAdapter, type HermesRouterAdapterConfig } from "./hermes-router-adapter.js";
export {
  HERMES_PROTOCOL_VERSION,
  HERMES_RUNNER_FILENAME,
  HERMES_EXECUTION_DISABLED_MESSAGE,
  detectHermesRouter,
  resolveHermesRuntimeConfiguration,
  type FileSystemProbe,
  type HermesDetectionOptions,
  type HermesRuntimeConfigurationResolution,
} from "./detection.js";
export {
  nodeDetectionProcessRunner,
  type DetectionProcessOptions,
  type DetectionProcessResult,
  type DetectionProcessRunner,
  type DetectionProcessStatus,
} from "./process-runner.js";
export {
  HermesExecutionRun,
  startHermesExecutionTransport,
  MAX_HERMES_INPUT_BYTES,
  DEFAULT_HERMES_MAX_RUN_DURATION_MS,
  DEFAULT_HERMES_CLEANUP_GRACE_MS,
  DEFAULT_HERMES_FORCE_TERMINATION_TIMEOUT_MS,
  DEFAULT_HERMES_POST_EXIT_DRAIN_MS,
  type HermesExecutionCompletion,
  type HermesExecutionProcessState,
  type HermesExecutionTransportRun,
  type HermesExecutionTransportOptions,
} from "./execution-transport.js";
export {
  buildHermesNodeSpawnOptions,
  nodeHermesProcessSpawner,
  type HermesProcessSpawner,
  type HermesProcessSpawnOptions,
  type SpawnedHermesProcess,
} from "./execution-process.js";
export {
  HermesJsonlParser,
  HermesTransportError,
  HERMES_RAW_EVENT_TYPES,
  HERMES_TERMINAL_EVENT_TYPES,
  MAX_HERMES_EVENT_BYTES,
  DEFAULT_MAX_HERMES_EVENT_COUNT,
  DEFAULT_MAX_HERMES_TOTAL_OUTPUT_BYTES,
  type HermesJsonlParseResult,
  type HermesJsonlParserOptions,
  type HermesRawEvent,
  type HermesRawEventType,
  type HermesRawTerminalEvent,
  type HermesTerminalEventType,
  type HermesTransportErrorCode,
} from "./hermes-protocol.js";
export { HermesEventMapper, HermesEventMappingError } from "./event-mapper.js";
export {
  HERMES_TRANSPORT_FAILURE,
  HERMES_INVALID_EVENT,
  HERMES_EXECUTION_FAILED,
  buildHermesFailure,
} from "./failure-codes.js";
export {
  HermesRun,
  type HermesExecutionTransportStarter,
  type HermesRunOptions,
} from "./hermes-run.js";
export { buildHermesTaskPrompt, MAX_HERMES_PROMPT_LENGTH } from "./prompt-builder.js";
