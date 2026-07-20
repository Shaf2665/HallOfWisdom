import { z } from "zod";

/**
 * Best-effort diagnostic category for *why* an auth status wasn't a
 * verified subscription — inferred from `authMethod`/`apiProvider`
 * substrings this adapter has never actually observed live (only
 * `claude.ai`/`firstParty`/a Pro subscription has been confirmed against
 * the real CLI). Never treat this field as authoritative on its own; the
 * only security-load-bearing field in `SafeAuthClassification` is
 * `subscriptionVerified`. See
 * `docs/architecture/0008-claude-code-adapter.md`, "Authentication output
 * hygiene".
 */
export type AuthenticationKind =
  "subscription" | "api_key" | "cloud_provider" | "gateway" | "ambiguous";

/**
 * The only shape any code outside this module is ever allowed to see for
 * an auth status result. Deliberately excludes every identifying field
 * (`email`, `orgId`, `orgName`, tokens, credential paths) even though the
 * raw `claude auth status` JSON may contain them — this type is
 * structurally incapable of carrying them.
 */
export interface SafeAuthClassification {
  readonly loggedIn: boolean;
  readonly authenticationKind: AuthenticationKind;
  /**
   * The only field `detectClaudeCode`/`startTask` may treat as a security
   * gate. True only for `loggedIn: true` with `authMethod: "claude.ai"`,
   * `apiProvider: "firstParty"`, and a recognized subscription tier — the
   * one combination actually verified against the real CLI.
   */
  readonly subscriptionVerified: boolean;
}

const MAX_AUTH_OUTPUT_LENGTH = 100_000;

const SUBSCRIPTION_COMPATIBLE_TYPES = new Set(["pro", "max", "team", "enterprise"]);
const CLOUD_PROVIDER_MARKERS = ["bedrock", "vertex", "foundry", "azure"];
const GATEWAY_MARKERS = ["gateway"];

const rawAuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().optional(),
    apiProvider: z.string().optional(),
    subscriptionType: z.string().optional(),
  })
  // Tolerant at this trust boundary: real `claude auth status` output also
  // includes email/orgId/orgName and possibly other fields — passthrough
  // lets validation succeed without enumerating every field this module
  // deliberately never reads. None of those extra fields are ever touched
  // below; the parsed object itself never escapes this function.
  .passthrough();

function classifyAuthenticationKind(
  authMethod: string | undefined,
  apiProvider: string | undefined,
  subscriptionType: string | undefined,
): AuthenticationKind {
  const method = (authMethod ?? "").toLowerCase();
  const provider = (apiProvider ?? "").toLowerCase();

  if (GATEWAY_MARKERS.some((marker) => method.includes(marker) || provider.includes(marker))) {
    return "gateway";
  }
  if (
    CLOUD_PROVIDER_MARKERS.some((marker) => method.includes(marker) || provider.includes(marker))
  ) {
    return "cloud_provider";
  }
  if (method === "claude.ai" && provider === "firstparty") {
    return subscriptionType !== undefined &&
      SUBSCRIPTION_COMPATIBLE_TYPES.has(subscriptionType.toLowerCase())
      ? "subscription"
      : "ambiguous";
  }
  if (provider === "firstparty" && method.length > 0) {
    return "api_key";
  }
  return "ambiguous";
}

/**
 * Parses and immediately reduces raw `claude auth status` stdout to a
 * `SafeAuthClassification` — or `undefined` if the output could not be
 * safely interpreted at all (oversized, malformed JSON, or schema
 * mismatch). `undefined` is a distinct outcome from a *successfully
 * parsed* `loggedIn: false` result: callers must map `undefined` to a
 * "could not verify" outcome (`unsupported`), never silently to
 * "logged out" — collapsing the two would misreport a CLI that produced
 * garbage output as merely logged out.
 *
 * The raw string and the parsed JSON value are both local to this
 * function and never returned, logged, or embedded in a thrown error —
 * they go out of scope (and become garbage-collectable) the moment this
 * function returns. No caller of this function ever receives anything
 * but the fixed, safe shape above.
 */
export function parseAuthStatusOutput(rawStdout: string): SafeAuthClassification | undefined {
  if (rawStdout.length > MAX_AUTH_OUTPUT_LENGTH) {
    return undefined;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawStdout) as unknown;
  } catch {
    return undefined;
  }

  const result = rawAuthStatusSchema.safeParse(parsedJson);
  if (!result.success) {
    return undefined;
  }

  const { loggedIn, authMethod, apiProvider, subscriptionType } = result.data;
  const authenticationKind = classifyAuthenticationKind(authMethod, apiProvider, subscriptionType);

  return {
    loggedIn,
    authenticationKind,
    subscriptionVerified: loggedIn && authenticationKind === "subscription",
  };
}
