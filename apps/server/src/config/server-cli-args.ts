import { parseArgs } from "node:util";
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";
import { DEFAULT_WEB_ORIGIN } from "./server-config.js";
import { InvalidWebOriginError, parseWebOrigin } from "./web-origin.js";

export class ServerCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerCliError";
  }
}

const serverCliOptionsSchema = z
  .object({
    workspaceRoot: boundedNonBlankString(4096),
    port: z.number().int().min(1).max(65535).optional(),
    // Named after Mock Agent specifically because this whole CLI is a
    // development entry point (see composition/mock-agent-composition-root.ts) —
    // the generic parts of the server (app.ts, TaskOrchestrator, routes)
    // never see this value.
    mockScenario: boundedNonBlankString(50).optional(),
    mockStepDelayMs: z.number().int().min(0).max(5000).optional(),
    webOrigin: boundedNonBlankString(2048).default(DEFAULT_WEB_ORIGIN),
    // Phase 10.2 — process-startup-only. There is deliberately no way to
    // set this from Hall Web, a task, or any REST request body; see
    // docs/architecture/0010-paperclip-compatible-codex-mode.md.
    enableCodexTrustedLocal: z.boolean().default(false),
  })
  .strict();

export type ServerCliOptions = z.infer<typeof serverCliOptionsSchema>;

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
 * Parses and bounds-validates raw `argv` using `node:util`'s built-in
 * `parseArgs` — the same small, dependency-free approach used by Hall
 * Runner's CLI (`runners/hall-runner/src/cli-args.ts`).
 */
export function parseServerCliArguments(argv: readonly string[]): ServerCliOptions {
  let raw: ReturnType<typeof parseArgs>;
  try {
    raw = parseArgs({
      args: Array.from(argv),
      options: {
        "workspace-root": { type: "string" },
        port: { type: "string" },
        "mock-scenario": { type: "string" },
        "mock-step-delay-ms": { type: "string" },
        "web-origin": { type: "string" },
        "enable-codex-trusted-local": { type: "boolean" },
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
    workspaceRoot: values["workspace-root"],
    port: parseOptionalInteger(values.port, "port"),
    mockScenario: values["mock-scenario"],
    mockStepDelayMs: parseOptionalInteger(values["mock-step-delay-ms"], "mock-step-delay-ms"),
    ...(webOrigin === undefined ? {} : { webOrigin }),
    ...(values["enable-codex-trusted-local"] === undefined
      ? {}
      : { enableCodexTrustedLocal: values["enable-codex-trusted-local"] }),
  };

  const result = serverCliOptionsSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ServerCliError(`Invalid command-line arguments: ${issues}`);
  }
  return result.data;
}
