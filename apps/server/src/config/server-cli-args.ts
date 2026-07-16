import { parseArgs } from "node:util";
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";

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

  const candidate = {
    workspaceRoot: values["workspace-root"],
    port: parseOptionalInteger(values.port, "port"),
    mockScenario: values["mock-scenario"],
    mockStepDelayMs: parseOptionalInteger(values["mock-step-delay-ms"], "mock-step-delay-ms"),
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
