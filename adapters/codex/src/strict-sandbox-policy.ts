export const STRICT_CODEX_DISABLED_FEATURES = [
  "hooks",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "multi_agent",
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
] as const;

export const STRICT_CODEX_SANDBOX_POLICY = {
  execSandboxMode: "workspace-write",
  sandboxPermissionProfile: ":workspace",
  configOverrides: [
    'approval_policy="never"',
    "sandbox_workspace_write.network_access=false",
    'web_search="disabled"',
  ],
  disabledFeatures: STRICT_CODEX_DISABLED_FEATURES,
  networkDisabled: true,
} as const;

export interface StrictCodexSandboxEquivalenceInput {
  readonly execSandboxMode: string;
  readonly sandboxPermissionProfile: string;
  readonly establishedBy: "shared_constants" | "same_effective_sandbox_state";
}

export type StrictCodexSandboxEquivalenceResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        "CODEX_STRICT_SANDBOX_SELECTOR_MISMATCH" | "CODEX_STRICT_SANDBOX_EQUIVALENCE_UNPROVEN";
    };

export function strictCodexConfigArgs(): readonly string[] {
  return STRICT_CODEX_SANDBOX_POLICY.configOverrides.flatMap((override) => ["-c", override]);
}

export function strictCodexFeatureDisableArgs(): readonly string[] {
  return STRICT_CODEX_SANDBOX_POLICY.disabledFeatures.flatMap((feature) => ["--disable", feature]);
}

export function evaluateStrictCodexSandboxEquivalence(
  input: StrictCodexSandboxEquivalenceInput,
): StrictCodexSandboxEquivalenceResult {
  if (
    input.execSandboxMode !== STRICT_CODEX_SANDBOX_POLICY.execSandboxMode ||
    input.sandboxPermissionProfile !== STRICT_CODEX_SANDBOX_POLICY.sandboxPermissionProfile
  ) {
    return { ok: false, code: "CODEX_STRICT_SANDBOX_SELECTOR_MISMATCH" };
  }

  switch (input.establishedBy) {
    case "shared_constants":
    case "same_effective_sandbox_state":
      return { ok: false, code: "CODEX_STRICT_SANDBOX_EQUIVALENCE_UNPROVEN" };
  }
}
