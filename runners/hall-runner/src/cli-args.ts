import { parseArgs } from "node:util";
import { z } from "zod";
import { boundedNonBlankString, nonEmptyIdSchema } from "@hall-of-wisdom/protocol";
import { InvalidCliInputError } from "./errors.js";

export const cliOptionsSchema = z
  .object({
    adapter: nonEmptyIdSchema,
    workspaceRoot: boundedNonBlankString(4096),
    workingDirectory: boundedNonBlankString(4096),
    title: boundedNonBlankString(200),
    description: z.string().max(20000).optional(),
    scenario: boundedNonBlankString(50).optional(),
    stepDelayMs: z.number().int().min(0).max(5000).optional(),
  })
  .strict();

export type CliOptions = z.infer<typeof cliOptionsSchema>;

/**
 * Parses and bounds-validates raw `argv` into typed, trustworthy CLI
 * options. Uses `node:util`'s built-in `parseArgs` (stable since Node 18)
 * rather than a third-party CLI framework — it is small, dependency-free,
 * and sufficient for this prototype's six flags.
 */
export function parseCliArguments(argv: readonly string[]): CliOptions {
  let raw: ReturnType<typeof parseArgs>;
  try {
    raw = parseArgs({
      args: Array.from(argv),
      options: {
        adapter: { type: "string" },
        "workspace-root": { type: "string" },
        "working-directory": { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        scenario: { type: "string" },
        "step-delay-ms": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    throw new InvalidCliInputError(
      error instanceof Error ? error.message : "failed to parse command-line arguments",
    );
  }

  const { values } = raw;

  let stepDelayMs: number | undefined;
  const rawStepDelay = values["step-delay-ms"];
  if (rawStepDelay !== undefined) {
    const rawStepDelayText = String(rawStepDelay);
    const parsed = Number(rawStepDelayText);
    if (!Number.isFinite(parsed)) {
      throw new InvalidCliInputError(
        `--step-delay-ms must be a finite number, got "${rawStepDelayText}"`,
      );
    }
    stepDelayMs = parsed;
  }

  const candidate = {
    adapter: values.adapter,
    workspaceRoot: values["workspace-root"],
    workingDirectory: values["working-directory"],
    title: values.title,
    description: values.description,
    scenario: values.scenario,
    stepDelayMs,
  };

  const result = cliOptionsSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InvalidCliInputError(`Invalid command-line arguments: ${issues}`);
  }
  return result.data;
}
