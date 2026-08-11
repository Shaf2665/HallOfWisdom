import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  HERMES_EXECUTION_DISABLED_MESSAGE,
  HERMES_ROUTER_ADAPTER_ID,
} from "@hall-of-wisdom/hermes-router-adapter";
import {
  HermesRouterConfigSchema,
  saveConfig,
  saveHermesRouterSecret,
  tryLoadConfig,
  tryLoadHermesRouterSecret,
} from "@hall-of-wisdom/hall-config";
import { InvalidRequestError, type RequestValidationIssue } from "../errors/app-error.js";
import { readEffectiveHermesEnvironment } from "../hermes-router/effective-environment.js";

const saveHermesSettingsSchema = HermesRouterConfigSchema.extend({
  apiKey: boundedNonBlankString(4096).optional(),
});

export interface HermesSettingsRouteDeps {
  readonly registry: AgentRegistry;
}

function validationIssues(error: z.ZodError): RequestValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

function friendlyDetectionMessage(message: string | undefined): string {
  if (message === HERMES_EXECUTION_DISABLED_MESSAGE) {
    return "Hermes needs Hall's durable data folder and agent worktree folder. Re-run Hall setup if either is missing.";
  }
  return (
    message ?? "Hall could not verify Hermes Router. Check the technical details and try again."
  );
}

async function buildStatus(deps: HermesSettingsRouteDeps) {
  let effective: ReturnType<typeof readEffectiveHermesEnvironment>;
  try {
    effective = readEffectiveHermesEnvironment();
  } catch {
    const savedConfig = tryLoadConfig()?.config.hermesRouter;
    return {
      configured: savedConfig !== undefined,
      ready: false,
      apiKeyConfigured: false,
      environmentOverrideActive: false,
      message: "The saved Hermes Router setup could not be read. Open setup and save it again.",
      ...(savedConfig === undefined
        ? {}
        : {
            runtimeRoot: savedConfig.runtimeRoot,
            routerBaseUrl: savedConfig.routerBaseUrl,
            ...(savedConfig.pythonPath === undefined ? {} : { pythonPath: savedConfig.pythonPath }),
          }),
    };
  }
  const configured = effective.savedConfig !== undefined;
  const base = {
    configured,
    apiKeyConfigured: effective.effectiveApiKeyConfigured,
    environmentOverrideActive: effective.environmentOverrideNames.length > 0,
    ...(effective.savedConfig === undefined
      ? {}
      : {
          runtimeRoot: effective.savedConfig.runtimeRoot,
          routerBaseUrl: effective.savedConfig.routerBaseUrl,
          ...(effective.savedConfig.pythonPath === undefined
            ? {}
            : { pythonPath: effective.savedConfig.pythonPath }),
        }),
  };

  if (!configured && effective.environmentOverrideNames.length === 0) {
    return {
      ...base,
      ready: false,
      message: "Enter your Hermes Router setup details to get started.",
    };
  }
  if (!effective.effectiveApiKeyConfigured) {
    return {
      ...base,
      ready: false,
      message: "Enter your Hermes Router proxy/client API key.",
    };
  }

  try {
    const detection = await deps.registry.resolve(HERMES_ROUTER_ADAPTER_ID).detect();
    const ready = detection.availability === "available";
    return {
      ...base,
      ready,
      message: ready
        ? "Hermes Router is installed, reachable, and ready to use."
        : friendlyDetectionMessage(detection.diagnosticMessage),
      ...(detection.detectedVersion === undefined
        ? {}
        : { detectedVersion: detection.detectedVersion }),
      ...(detection.diagnosticMessage === undefined
        ? {}
        : { technicalMessage: detection.diagnosticMessage }),
    };
  } catch {
    return {
      ...base,
      ready: false,
      message: "Hall could not verify Hermes Router. Check the technical details and try again.",
    };
  }
}

export function registerHermesSettingsRoutes(
  app: FastifyInstance,
  deps: HermesSettingsRouteDeps,
): void {
  app.get("/api/v1/settings/hermes-router", async () => buildStatus(deps));

  app.post<{ Body: unknown }>("/api/v1/settings/hermes-router", async (request) => {
    const parsed = saveHermesSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new InvalidRequestError(
        "Check the Hermes Router setup fields and try again.",
        validationIssues(parsed.error),
      );
    }

    const runtimeRoot = parsed.data.runtimeRoot.trim();
    if (!path.isAbsolute(runtimeRoot)) {
      throw new InvalidRequestError("Check the Hermes Router setup fields and try again.", [
        { path: "runtimeRoot", message: "must be an absolute folder path" },
      ]);
    }

    const loaded = tryLoadConfig();
    if (loaded === undefined) {
      throw new InvalidRequestError(
        "Complete Hall's main installation setup before configuring Hermes Router.",
      );
    }
    const currentSecret =
      parsed.data.apiKey === undefined ? tryLoadHermesRouterSecret() : undefined;
    if (parsed.data.apiKey === undefined && currentSecret === undefined) {
      const effective = readEffectiveHermesEnvironment();
      if (!effective.effectiveApiKeyConfigured) {
        throw new InvalidRequestError("Enter your Hermes Router proxy/client API key.", [
          { path: "apiKey", message: "is required the first time you set up Hermes" },
        ]);
      }
    }

    const updatedConfig = {
      ...loaded.config,
      hermesRouter: {
        runtimeRoot,
        routerBaseUrl: parsed.data.routerBaseUrl.trim(),
        ...(parsed.data.pythonPath === undefined
          ? {}
          : { pythonPath: parsed.data.pythonPath.trim() }),
      },
    };

    saveConfig(updatedConfig);
    if (parsed.data.apiKey !== undefined) {
      try {
        saveHermesRouterSecret({ routerApiKey: parsed.data.apiKey.trim() });
      } catch (error) {
        saveConfig(loaded.config);
        throw error;
      }
    }

    return buildStatus(deps);
  });
}
