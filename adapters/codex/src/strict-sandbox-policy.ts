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

export function strictCodexConfigArgs(): readonly string[] {
  return STRICT_CODEX_SANDBOX_POLICY.configOverrides.flatMap((override) => ["-c", override]);
}

export function strictCodexFeatureDisableArgs(): readonly string[] {
  return STRICT_CODEX_SANDBOX_POLICY.disabledFeatures.flatMap((feature) => ["--disable", feature]);
}
