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
    // Phase 12 — optional. When omitted, the multi-agent comparison
    // feature is not composed at all (no comparison routes, no
    // comparison store): comparisons are additive and every existing
    // startup command remains valid without this flag. Never settable
    // via any client input — process-startup-only, exactly like
    // `--workspace-root`.
    comparisonRoot: boundedNonBlankString(4096).optional(),
    // Phase 13 — optional. When omitted, Hall Core runs exactly as it did
    // before this phase: every store is purely in-memory and a restart
    // loses all state. Supplying it opts into SQLite-backed durable state
    // under this directory — see `persistence/database-config.ts` for the
    // actual filesystem validation (absolute, created if missing,
    // symlink-canonicalized, mutually non-contained with `workspaceRoot`
    // and `comparisonRoot`), which `server.ts` performs, not this schema.
    // Never settable via any client input — process-startup-only, exactly
    // like `--workspace-root`.
    dataDir: boundedNonBlankString(4096).optional(),
    agentWorktreeRoot: boundedNonBlankString(4096).optional(),
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
 * Strips exactly one leading standalone `--` from `argv`, if present.
 * `pnpm run <script> -- <args>` is documented to forward `<args>` after
 * the script's own command — but this pnpm version (10.33.0, pinned)
 * forwards the literal `--` separator token itself as the first
 * argument too. Node's own `parseArgs` treats a bare `--` as "end of
 * options: everything after this is positional" (matching the POSIX
 * convention), so an unstripped leading `--` turns every real flag that
 * follows into a rejected positional — this is what caused the
 * documented `pnpm --filter ... run dev -- --workspace-root ...` startup
 * command to fail with "Unexpected argument '--workspace-root'".
 *
 * Only a `--` in the very first position is stripped, and only once:
 * - A later, second `--` (e.g. a genuinely malformed `-- --
 *   --workspace-root ...`) is left for `parseArgs` to reject exactly as
 *   before — garbage input still fails loudly, it is never silently
 *   absorbed.
 * - A `--` occurring after real flags/values (not at index 0) is left
 *   untouched — this function only ever looks at `argv[0]`.
 * - A flag *value* that happens to contain two hyphens (e.g. a
 *   workspace-root path like `D:\Foo--Bar`) is never affected — this
 *   compares the whole first token for exact equality with `--`, never
 *   a substring.
 * - Direct `node dist/server.js --workspace-root ...` invocation (no
 *   leading `--`) is a no-op — `argv[0]` is already a real flag.
 */
export function stripLeadingScriptSeparator(argv: readonly string[]): string[] {
  const args = Array.from(argv);
  return args[0] === "--" ? args.slice(1) : args;
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
    ...(values["comparison-root"] === undefined
      ? {}
      : { comparisonRoot: values["comparison-root"] }),
    ...(values["data-dir"] === undefined ? {} : { dataDir: values["data-dir"] }),
    ...(values["agent-worktree-root"] === undefined
      ? {}
      : { agentWorktreeRoot: values["agent-worktree-root"] }),
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
