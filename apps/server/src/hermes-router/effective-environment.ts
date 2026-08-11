import {
  tryLoadConfig,
  tryLoadHermesRouterSecret,
  type HermesRouterConfig,
} from "@hall-of-wisdom/hall-config";

const HERMES_ROOT_ENV = "HALL_HERMES_ROUTER_ROOT";
const HERMES_BASE_URL_ENV = "HERMES_ROUTER_BASE_URL";
const HERMES_API_KEY_ENV = "HERMES_ROUTER_API_KEY";
const HERMES_PYTHON_ENV = "HALL_HERMES_PYTHON";

const OVERRIDE_KEYS = [
  HERMES_ROOT_ENV,
  HERMES_BASE_URL_ENV,
  HERMES_API_KEY_ENV,
  HERMES_PYTHON_ENV,
] as const;

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export interface EffectiveHermesEnvironment {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly environmentOverrideNames: readonly string[];
  readonly savedConfig: HermesRouterConfig | undefined;
  readonly effectiveApiKeyConfigured: boolean;
}

export function readEffectiveHermesEnvironment(
  parentEnv: Readonly<NodeJS.ProcessEnv> = process.env,
): EffectiveHermesEnvironment {
  const savedConfig = tryLoadConfig()?.config.hermesRouter;
  const savedSecret = hasValue(parentEnv[HERMES_API_KEY_ENV])
    ? undefined
    : tryLoadHermesRouterSecret();
  const environment: NodeJS.ProcessEnv = { ...parentEnv };

  if (!hasValue(environment[HERMES_ROOT_ENV]) && savedConfig !== undefined) {
    environment[HERMES_ROOT_ENV] = savedConfig.runtimeRoot;
  }
  if (!hasValue(environment[HERMES_BASE_URL_ENV]) && savedConfig !== undefined) {
    environment[HERMES_BASE_URL_ENV] = savedConfig.routerBaseUrl;
  }
  if (!hasValue(environment[HERMES_API_KEY_ENV]) && savedSecret !== undefined) {
    environment[HERMES_API_KEY_ENV] = savedSecret.routerApiKey;
  }
  if (!hasValue(environment[HERMES_PYTHON_ENV]) && savedConfig?.pythonPath !== undefined) {
    environment[HERMES_PYTHON_ENV] = savedConfig.pythonPath;
  }

  return {
    environment,
    environmentOverrideNames: OVERRIDE_KEYS.filter((key) => hasValue(parentEnv[key])),
    savedConfig,
    effectiveApiKeyConfigured: hasValue(environment[HERMES_API_KEY_ENV]),
  };
}

export function createHermesEnvironmentProvider(
  parentEnv: Readonly<NodeJS.ProcessEnv> = process.env,
): () => Readonly<NodeJS.ProcessEnv> {
  return () => readEffectiveHermesEnvironment(parentEnv).environment;
}
