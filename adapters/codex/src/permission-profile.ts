/**
 * The fixed, non-negotiable sandbox and isolation profile every task
 * execution uses. Nothing here is derived from `AgentTaskInput`, browser
 * request data, or any task-controlled field except the already-validated
 * canonical working directory — it is a constant, reviewed once, and the
 * only thing a future change to it should come from is a deliberate edit
 * to this file. See `docs/architecture/0009-codex-adapter.md`, "Fixed
 * sandbox and approval profile", for the reasoning behind each flag,
 * including the exact `codex exec --help` behavior this was verified
 * against on the installed CLI (`codex-cli 0.144.4`) via a bounded,
 * zero-usage `--strict-config` config-parse probe during Phase 10
 * reconnaissance.
 *
 * Deliberate deviations from the Phase 10 kickoff's "conceptual" example
 * invocation, each confirmed against the real installed CLI before this
 * file was written (never assumed from documentation alone):
 *
 * 1. No `--ask-for-approval` CLI flag. `codex exec --help`'s own option
 *    list does not include `-a`/`--ask-for-approval` at all — it exists
 *    only on the root/interactive `codex` command. Passing it to `codex
 *    exec` fails immediately with `error: unexpected argument
 *    '--ask-for-approval' found` (confirmed live, exit code 2, before any
 *    config or model step).
 * 2. `-c approval_policy="never"` is used *instead* — a real,
 *    `--strict-config`-accepted config key (confirmed via the same
 *    zero-usage config-parse probe technique as the keys below) that is
 *    the `codex exec`-compatible equivalent of the interactive command's
 *    `-a/--ask-for-approval never`. This was not part of the original
 *    design: the first real isolated smoke run (see
 *    `docs/architecture/0009-codex-adapter.md`, "Real smoke-test
 *    results") completed its full lifecycle cleanly but the model's own
 *    final message reported every attempted shell command "rejected:
 *    blocked by policy", and no file was actually modified — `codex exec`
 *    without an explicit approval policy defaults to denying command
 *    execution rather than auto-approving everything the fixed `--sandbox
 *    workspace-write` profile would otherwise permit. There is still no
 *    human to prompt in a non-interactive run; `approval_policy="never"`
 *    is what makes that concretely mean "auto-resolve every approval
 *    decision within the sandbox's own bounds" rather than "deny
 *    everything that would otherwise need to ask". This adapter's own
 *    wall-clock run timeout (see `codex-run.ts`) remains the backstop
 *    against a hang; `approval_policy` never grants an escalation the
 *    `--sandbox workspace-write` / no-network / no-web-search profile
 *    below does not already independently allow.
 * 3. `-c sandbox_workspace_write.network_access=false` — confirmed as a
 *    real, `--strict-config`-accepted key (an invented key name in the
 *    same position produces `Error loading config.toml: unknown
 *    configuration field ... in -c/--config override`, so this
 *    demonstrates the key is real, not merely that it was silently
 *    ignored).
 * 4. `-c web_search="disabled"` — the value must be a quoted TOML string,
 *    not a bare boolean (`web_search=false` fails with `invalid type:
 *    unit variant, expected string only`); the accepted enum, confirmed
 *    from the resulting error message, is `disabled`/`cached`/`indexed`/
 *    `live`.
 *
 * Phase 10.1 addition — explicit feature disabling. `codex exec --help`
 * confirms `--json` means "Print events to stdout as JSONL" (the exact
 * wording, not an inference), which is the CLI's own documentation of the
 * stdout-only event-channel contract `codex-run.ts` now depends on. Free
 * inspection (`codex features list`, no model call) showed `hooks`,
 * `plugins`, `plugin_sharing`, `remote_plugin`, and `multi_agent` are all
 * `stable` and enabled (`true`) on the installed CLI — real, live
 * features this adapter must not merely hope `--ignore-user-config`
 * suppresses. `--disable <FEATURE>` (confirmed, via the same zero-usage
 * `--strict-config` technique, to parse cleanly alongside every other
 * flag here) is used as an explicit, defense-in-depth second layer on
 * top of `--ignore-user-config`/`--ignore-rules`: even if a future CLI
 * version's project-configuration behavior changes in a way that would
 * otherwise re-enable one of these from a project file, the fixed argv
 * itself already turns it off. See `docs/architecture/0009-codex-adapter.md`,
 * "Configuration, hook, skill, and plugin isolation".
 */
const DISABLED_FEATURES = [
  "hooks",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "multi_agent",
] as const;

const SANDBOX_MODE = "workspace-write";

/**
 * The complete, fixed `codex exec` argv, given only the already-validated
 * canonical working directory. The task prompt is never included here —
 * see `process-spawner.ts`/`codex-run.ts`: it is written to the child
 * process's stdin after spawn, and the trailing `"-"` below is Codex's
 * own convention (confirmed live) for "read the prompt from stdin rather
 * than from an argument". This is what keeps task-controlled content
 * (the prompt) fully out of the process argument list, matching the
 * `shell: false` / no-manually-concatenated-command-line discipline in
 * `process-spawner.ts`.
 */
export function buildCodexArgv(workingDirectory: string): readonly string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--sandbox",
    SANDBOX_MODE,
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--cd",
    workingDirectory,
    "-",
  ];
}
