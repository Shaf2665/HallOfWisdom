import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { boundedNonBlankString } from "@hall-of-wisdom/protocol";
import { resolveHermesRouterSecretFilePath } from "./config-path.js";

const HermesRouterSecretSchema = z
  .object({
    schemaVersion: z.literal(1),
    routerApiKey: boundedNonBlankString(4096),
  })
  .strict();

export interface HermesRouterSecret {
  readonly routerApiKey: string;
}

export function tryLoadHermesRouterSecret(
  secretPath: string = resolveHermesRouterSecretFilePath(),
): HermesRouterSecret | undefined {
  if (!fs.existsSync(secretPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  } catch {
    throw new Error("The saved Hermes Router secret is invalid.");
  }
  const result = HermesRouterSecretSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("The saved Hermes Router secret is invalid.");
  }
  return { routerApiKey: result.data.routerApiKey };
}

export function saveHermesRouterSecret(
  secret: HermesRouterSecret,
  secretPath: string = resolveHermesRouterSecretFilePath(),
): void {
  const validated = HermesRouterSecretSchema.parse({ schemaVersion: 1, ...secret });
  const dir = path.dirname(secretPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.${path.basename(secretPath)}.tmp-${randomUUID()}`);

  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, secretPath);
    if (process.platform !== "win32") fs.chmodSync(secretPath, 0o600);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}
