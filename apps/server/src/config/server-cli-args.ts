import { parseArgs } from "node:util";
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";
import { InvalidWebOriginError, parseWebOrigin } from "./web-origin.js";

export class ServerCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerCliError";
  }
}

/**
 * Raw command-line overrides only — every field optional, including
 * `workspaceRoot`. Hall must be able to start from a persisted
 * `@hall-of-wisdom/hall-config` configuration alone, with zero flags; the
 * "workspaceRoot is actually required" rule is enforced one step later, on
 * the *merged* result, by `resolve-server-config.ts`'s
 * `resolvedServerConfigSchema`. This split is what lets an explicit CLI
 * flag win per-field over persisted config without a schema-level default
 * masking "not supplied" as "supplied with the default value."
 */
const serverCliOverridesSchema = z
  .object({
    workspaceRoot: boundedNonBlankString(4096).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    mockScenario: boundedNonBlankString(50).optional(),
    mockStepDelayMs: z.number().int().min(0).max(5000).optional(),
    webOrigin: boundedNonBlankString(2048).optional(),
    enableCodexTrustedLocal: z.boolean().optional(),
    comparisonRoot: boundedNonBlankString(4096).optional(),
    dataDir: boundedNonBlankString(4096).optional(),
    agentWorktreeRoot: boundedNonBlankString(4096).optional(),
    // Phase 17.1 — a side-effect-minimized configuration preflight. No
    // corresponding persisted-config field: it is a pure CLI-only mode
    // switch, so a schema default (rather than `.optional()`) is correct
    // here — there is no other source to defer to.
    verifyOnly: z.boolean().default(false),
  })
  .strict();

export type ServerCliOverrides = z.infer<typeof serverCliOverridesSchema>;

function parseOptionalInteger(raw: unknown, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  const parsed = Number(rawText);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ServerCliError(`--${flagName} must be an integer, got "${rawText}"`);
  }
  return parsed;
}

function parseOptionalWebOrigin(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    return parseWebOrigin(rawText);
  } catch (error) {
    if (error instanceof InvalidWebOriginError) {
      throw new ServerCliError(error.message);
    }
    throw error;
  }
}

/**
 * Strips exactly one leading standalone `--` from `argv`, if present — see
 * the historical note in git blame / Phase 11.1: pnpm 10.33.0's `run
 * <script> -- <args>` forwards the literal `--` separator token itself as
 * the first argument, which Node's `parseArgs` would otherwise treat as
 * "end of options."
 */
export function stripLeadingScriptSeparator(argv: readonly string[]): string[] {
  const args = Array.from(argv);
  return args[0] === "--" ? args.slice(1) : args;
}

/**
 * Parses and bounds-validates raw `argv` using `node:util`'s built-in
 * `parseArgs`. Produces `ServerCliOverrides` — raw, optional-everywhere
 * overrides; see that type's doc comment for why `workspaceRoot` is
 * optional here.
 */
export function parseServerCliArguments(argv: readonly string[]): ServerCliOverrides {
  let raw: ReturnType<typeof parseArgs>;
  try {
    raw = parseArgs({
      args: stripLeadingScriptSeparator(argv),
      options: {
        "workspace-root": { type: "string" },
        port: { type: "string" },
        "mock-scenario": { type: "string" },
        "mock-step-delay-ms": { type: "string" },
        "web-origin": { type: "string" },
        "enable-codex-trusted-local": { type: "boolean" },
        "comparison-root": { type: "string" },
        "data-dir": { type: "string" },
        "agent-worktree-root": { type: "string" },
        "verify-only": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new ServerCliError(
      error instanceof Error ? error.message : "failed to parse command-line arguments",
    );
  }

  const { values } = raw;

  const webOrigin = parseOptionalWebOrigin(values["web-origin"]);
  const candidate = {
    ...(values["workspace-root"] === undefined ? {} : { workspaceRoot: values["workspace-root"] }),
    port: parseOptionalInteger(values.port, "port"),
    mockScenario: values["mock-scenario"],
    mockStepDelayMs: parseOptionalInteger(values["mock-step-delay-ms"], "mock-step-delay-ms"),
    ...(webOrigin === undefined ? {} : { webOrigin }),
    ...(values["enable-codex-trusted-local"] === undefined
      ? {}
      : { enableCodexTrustedLocal: values["enable-codex-trusted-local"] }),
    ...(values["comparison-root"] === undefined ? {} : { comparisonRoot: values["comparison-root"] }),
    ...(values["data-dir"] === undefined ? {} : { dataDir: values["data-dir"] }),
    ...(values["agent-worktree-root"] === undefined
      ? {}
      : { agentWorktreeRoot: values["agent-worktree-root"] }),
    ...(values["verify-only"] === undefined ? {} : { verifyOnly: values["verify-only"] }),
  };

  const result = serverCliOverridesSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ServerCliError(`Invalid command-line arguments: ${issues}`);
  }
  return result.data;
}
