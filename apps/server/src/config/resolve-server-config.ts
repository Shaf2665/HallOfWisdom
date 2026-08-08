import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";
import { DEFAULT_HALL_WEB_PORT, type HallConfig } from "@hall-of-wisdom/hall-config";
import { DEFAULT_PORT } from "./server-config.js";
import { InvalidWebOriginError, parseWebOrigin } from "./web-origin.js";
import { ServerCliError, type ServerCliOverrides } from "./server-cli-args.js";

const resolvedServerConfigSchema = z
  .object({
    workspaceRoot: boundedNonBlankString(4096),
    port: z.number().int().min(1).max(65535),
    webOrigin: boundedNonBlankString(2048),
    mockScenario: boundedNonBlankString(50).optional(),
    mockStepDelayMs: z.number().int().min(0).max(5000).optional(),
    enableCodexTrustedLocal: z.boolean(),
    comparisonRoot: boundedNonBlankString(4096).optional(),
    dataDir: boundedNonBlankString(4096).optional(),
    agentWorktreeRoot: boundedNonBlankString(4096).optional(),
    verifyOnly: z.boolean(),
  })
  .strict();

export type ResolvedServerConfig = z.infer<typeof resolvedServerConfigSchema>;

/**
 * Per-field precedence: an explicitly supplied CLI override always wins;
 * otherwise the persisted Hall configuration's value; otherwise the
 * existing built-in default. `workspaceRoot` has no built-in default — if
 * neither source supplies it, this throws `ServerCliError`, exactly like
 * the previous "missing --workspace-root" behavior did, just one step
 * later (`--workspace-root` is optional at the raw-CLI-parsing stage now,
 * so Hall can start from persisted config alone).
 *
 * `webOrigin`: an explicit `--web-origin` always wins. Otherwise it is
 * *derived* from the resolved `hallWebPort`
 * (`http://127.0.0.1:<hallWebPort>`) — never a flat stored default — so a
 * persisted `hallWebPort` change can never silently create a
 * CORS/WebSocket-origin mismatch against Hall Core's own allowlist.
 */
export function resolveServerConfig(
  overrides: ServerCliOverrides,
  persisted: HallConfig | undefined,
): ResolvedServerConfig {
  const workspaceRoot = overrides.workspaceRoot ?? persisted?.workspaceRoot;
  if (workspaceRoot === undefined) {
    throw new ServerCliError(
      "--workspace-root was not supplied and no persisted Hall configuration was found. Run install.ps1, or pass --workspace-root explicitly.",
    );
  }

  const port = overrides.port ?? persisted?.hallCorePort ?? DEFAULT_PORT;

  let webOrigin: string;
  if (overrides.webOrigin !== undefined) {
    webOrigin = overrides.webOrigin;
  } else {
    const hallWebPort = persisted?.hallWebPort ?? DEFAULT_HALL_WEB_PORT;
    try {
      webOrigin = parseWebOrigin(`http://127.0.0.1:${String(hallWebPort)}`);
    } catch (error) {
      throw error instanceof InvalidWebOriginError ? new ServerCliError(error.message) : error;
    }
  }

  const enableCodexTrustedLocal = overrides.enableCodexTrustedLocal ?? persisted?.codexTrustedLocal ?? false;
  const dataDir = overrides.dataDir ?? persisted?.dataDir;
  const agentWorktreeRoot = overrides.agentWorktreeRoot ?? persisted?.agentWorktreeRoot;
  const persistedComparisonRoot = persisted?.comparisonRoot === null ? undefined : persisted?.comparisonRoot;
  const comparisonRoot = overrides.comparisonRoot ?? persistedComparisonRoot;

  const candidate = {
    workspaceRoot,
    port,
    webOrigin,
    enableCodexTrustedLocal,
    verifyOnly: overrides.verifyOnly,
    ...(overrides.mockScenario === undefined ? {} : { mockScenario: overrides.mockScenario }),
    ...(overrides.mockStepDelayMs === undefined ? {} : { mockStepDelayMs: overrides.mockStepDelayMs }),
    ...(comparisonRoot === undefined ? {} : { comparisonRoot }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(agentWorktreeRoot === undefined ? {} : { agentWorktreeRoot }),
  };

  const result = resolvedServerConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ServerCliError(`Invalid resolved server configuration: ${issues}`);
  }
  return result.data;
}
