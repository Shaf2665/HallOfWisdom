import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";

export const HALL_CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_HALL_CORE_PORT = 4310;
export const DEFAULT_HALL_WEB_PORT = 3000;

const portSchema = z.number().int().min(1).max(65535);

export const HallConfigSchema = z
  .object({
    schemaVersion: z.literal(HALL_CONFIG_SCHEMA_VERSION),
    workspaceRoot: boundedNonBlankString(4096),
    dataDir: boundedNonBlankString(4096).optional(),
    agentWorktreeRoot: boundedNonBlankString(4096).optional(),
    // `null` means comparisons are explicitly disabled; a string is the
    // persisted comparison root. Always present as a key — never simply
    // absent — so intent is never ambiguous the way an omitted-vs-disabled
    // CLI flag would be.
    comparisonRoot: boundedNonBlankString(4096).nullable(),
    hallCorePort: portSchema.default(DEFAULT_HALL_CORE_PORT),
    hallWebPort: portSchema.default(DEFAULT_HALL_WEB_PORT),
    codexTrustedLocal: z.boolean().default(false),
  })
  .strict();

export type HallConfig = z.infer<typeof HallConfigSchema>;

export class HallConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HallConfigValidationError";
  }
}

export class UnsupportedHallConfigSchemaVersionError extends Error {
  constructor(foundVersion: number) {
    super(
      `Hall configuration schema version ${String(foundVersion)} is newer than the highest version this build supports (${String(HALL_CONFIG_SCHEMA_VERSION)}). Refusing to load it.`,
    );
    this.name = "UnsupportedHallConfigSchemaVersionError";
  }
}

function hasNewerSchemaVersion(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw)) return undefined;
  const value = raw.schemaVersion;
  return typeof value === "number" && value > HALL_CONFIG_SCHEMA_VERSION ? value : undefined;
}

export function parseHallConfig(raw: unknown): HallConfig {
  const newerVersion = hasNewerSchemaVersion(raw);
  if (newerVersion !== undefined) {
    throw new UnsupportedHallConfigSchemaVersionError(newerVersion);
  }
  const result = HallConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new HallConfigValidationError(`Invalid Hall configuration: ${issues}`);
  }
  return result.data;
}
