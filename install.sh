#!/usr/bin/env bash

set -Eeuo pipefail

original_dir="$(pwd -P)"
repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
config_cli="$repo_root/packages/hall-config/dist/cli.js"
server_dist="$repo_root/apps/server/dist/server.js"

die() {
  printf '\n[FAIL] %s\n' "$1" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  local install_hint="$2"
  local display_name="${3:-$command_name}"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '  [FAIL] %s was not found on PATH. %s\n' "$display_name" "$install_hint" >&2
    return 1
  fi
}

check_platform() {
  case "$(uname -s 2>/dev/null || true)" in
    Linux | Darwin) ;;
    *) die "This installer supports Linux and macOS. On Windows, run .\\install.ps1 in PowerShell." ;;
  esac
}

check_node_version() {
  local required_range="$1"
  local version_text
  local clean_version
  local min_major
  local min_minor
  local min_patch
  local max_major
  local major
  local minor
  local patch

  version_text="$(node --version 2>/dev/null || true)"
  if [[ ! "$required_range" =~ ^\>\=([0-9]+)\.([0-9]+)\.([0-9]+)[[:space:]]+\<([0-9]+)$ ]]; then
    die "The Node.js requirement '$required_range' in package.json has an unsupported format."
  fi
  min_major="${BASH_REMATCH[1]}"
  min_minor="${BASH_REMATCH[2]}"
  min_patch="${BASH_REMATCH[3]}"
  max_major="${BASH_REMATCH[4]}"

  clean_version="${version_text#v}"
  if [[ ! "$clean_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    printf '  [FAIL] Node.js returned an unrecognized version: %s\n' "$version_text" >&2
    return 1
  fi
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"

  if ((10#$major >= 10#$max_major || 10#$major < 10#$min_major)) ||
    ((10#$major == 10#$min_major && 10#$minor < 10#$min_minor)) ||
    ((10#$major == 10#$min_major && 10#$minor == 10#$min_minor && 10#$patch < 10#$min_patch)); then
    printf '  [FAIL] Node.js %s was found, but Hall requires %s.\n' "$version_text" "$required_range" >&2
    return 1
  fi

  printf '  [OK] Node.js (%s)\n' "$version_text"
}

check_prerequisites() {
  local failed=0
  local required_node_range
  local required_pnpm_version
  local actual_pnpm_version
  local required_path
  local node_available=0

  printf 'Checking your system...\n'

  if require_command node "Install Node.js using the version shown in README.md, then try again." "Node.js"; then
    node_available=1
    required_node_range="$(node -p "require('./package.json').engines.node" 2>/dev/null)" ||
      die "Could not read the Node.js requirement from package.json."
    check_node_version "$required_node_range" || failed=1
  else
    failed=1
  fi

  if require_command pnpm "Install pnpm using the version shown in README.md, then try again."; then
    if ((node_available == 0)); then
      printf '  [FAIL] pnpm could not be checked because Node.js is missing. Install Node.js first.\n' >&2
      failed=1
    else
      required_pnpm_version="$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '')" 2>/dev/null)" ||
        die "Could not read the pnpm requirement from package.json."
      actual_pnpm_version="$(pnpm --version 2>/dev/null || true)"
      if [[ "$actual_pnpm_version" == "$required_pnpm_version" ]]; then
        printf '  [OK] pnpm (%s)\n' "$actual_pnpm_version"
      else
        printf '  [FAIL] pnpm %s was found, but Hall is pinned to pnpm %s.\n' \
          "${actual_pnpm_version:-unknown}" "$required_pnpm_version" >&2
        failed=1
      fi
    fi
  else
    failed=1
  fi

  if require_command git "Install Git, then try again." "Git"; then
    if git worktree list --porcelain -z >/dev/null 2>&1; then
      printf '  [OK] Git (%s)\n' "$(git --version)"
    else
      printf '  [FAIL] Git does not support the worktree command Hall requires. Upgrade Git, then try again.\n' >&2
      failed=1
    fi
  else
    failed=1
  fi

  for required_path in package.json pnpm-workspace.yaml AGENTS.md apps/server packages/hall-config; do
    if [[ ! -e "$repo_root/$required_path" ]]; then
      printf '  [FAIL] The Hall checkout is incomplete; missing %s.\n' "$required_path" >&2
      failed=1
    fi
  done

  if ((failed != 0)); then
    die "Fix the prerequisite problems above, then run ./install.sh again."
  fi
  printf '  [OK] Hall repository structure looks intact.\n\n'
}

json_value() {
  node -e '
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], JSON.parse(process.argv[1]));
    if (value === null) process.stdout.write("__HALL_NULL__");
    else if (value === undefined) process.stdout.write("__HALL_UNDEFINED__");
    else process.stdout.write(typeof value === "string" ? value : String(value));
  ' "$1" "$2"
}

json_errors() {
  node -e '
    const payload = JSON.parse(process.argv[1]);
    const errors = Array.isArray(payload.errors) ? payload.errors : [payload.error ?? "Unknown configuration error."];
    process.stdout.write(errors.join("; "));
  ' "$1"
}

prompt_path() {
  local label="$1"
  local default_value="$2"
  local response

  if ! IFS= read -r -p "$label [$default_value]: " response; then
    die "Input ended before setup was complete. Run ./install.sh again in an interactive terminal."
  fi
  prompt_result="${response:-$default_value}"
}

prompt_comparison_root() {
  local default_value="$1"
  local response

  if [[ "$default_value" == "__HALL_NULL__" ]]; then
    if ! IFS= read -r -p "Comparison worktree location [disabled; enter an absolute path to enable]: " response; then
      die "Input ended before setup was complete. Run ./install.sh again in an interactive terminal."
    fi
    comparison_root="${response:-__HALL_NULL__}"
  else
    if ! IFS= read -r -p "Comparison worktree location [$default_value; enter - to disable]: " response; then
      die "Input ended before setup was complete. Run ./install.sh again in an interactive terminal."
    fi
    if [[ "$response" == "-" ]]; then
      comparison_root="__HALL_NULL__"
    else
      comparison_root="${response:-$default_value}"
    fi
  fi
}

make_candidate() {
  node -e '
    const comparisonRoot = process.argv[4] === "__HALL_NULL__" ? null : process.argv[4];
    const candidate = {
      schemaVersion: 1,
      workspaceRoot: process.argv[1],
      ...(process.argv[2] === "__HALL_UNDEFINED__" ? {} : { dataDir: process.argv[2] }),
      ...(process.argv[3] === "__HALL_UNDEFINED__" ? {} : { agentWorktreeRoot: process.argv[3] }),
      comparisonRoot,
      hallCorePort: Number(process.argv[5]),
      hallWebPort: Number(process.argv[6]),
      codexTrustedLocal: process.argv[7] === "true",
    };
    process.stdout.write(JSON.stringify(candidate));
  ' "$workspace_root" "$data_dir" "$agent_worktree_root" "$comparison_root" \
    "$hall_core_port" "$hall_web_port" "$codex_trusted_local"
}

validate_candidate() {
  local result
  if ! result="$(printf '%s' "$candidate_json" | node "$config_cli" validate --path "$config_path")"; then
    die "Configuration is not valid: $(json_errors "$result")"
  fi
}

save_candidate() {
  local result
  if ! result="$(printf '%s' "$candidate_json" | node "$config_cli" save --path "$config_path")"; then
    die "Could not save Hall configuration: $(json_errors "$result")"
  fi
  printf '  [OK] Configuration saved (%s)\n' "$config_path"
}

build_hall() {
  printf '\nChecking and building Hall...\n'
  if ! pnpm typecheck; then
    die "Hall's type check failed. Review the errors above, then run ./install.sh again."
  fi
  if ! pnpm build; then
    die "Hall's build failed. Review the errors above, then run ./install.sh again."
  fi
  printf '  [OK] Hall Core and Hall Web built.\n'
}

verify_candidate() {
  local isolated_config_dir
  local verify_code
  local verify_args

  [[ -f "$server_dist" ]] || die "Hall Core build not found at '$server_dist'."
  isolated_config_dir="$(mktemp -d "${TMPDIR:-/tmp}/hall-verify-only-isolated.XXXXXX")" ||
    die "Could not create a temporary directory for installation verification."

  verify_args=(
    "$server_dist"
    --workspace-root "$workspace_root"
    --port "$hall_core_port"
    --verify-only
    --web-origin "http://127.0.0.1:$hall_web_port"
  )
  if [[ "$data_dir" != "__HALL_UNDEFINED__" ]]; then
    verify_args+=(--data-dir "$data_dir")
  fi
  if [[ "$agent_worktree_root" != "__HALL_UNDEFINED__" ]]; then
    verify_args+=(--agent-worktree-root "$agent_worktree_root")
  fi
  if [[ "$comparison_root" != "__HALL_NULL__" ]]; then
    verify_args+=(--comparison-root "$comparison_root")
  fi
  if [[ "$codex_trusted_local" == "true" ]]; then
    verify_args+=(--enable-codex-trusted-local)
  fi

  if HALL_CONFIG_DIR="$isolated_config_dir" node "${verify_args[@]}"; then
    verify_code=0
  else
    verify_code=$?
  fi
  rmdir "$isolated_config_dir" 2>/dev/null || true

  if ((verify_code == 0)); then
    printf '  [OK] Installation verified.\n'
    return 0
  fi
  if ((verify_code == 5)); then
    return 5
  fi
  die "Installation verification failed. Review the errors above; your saved configuration was not changed."
}

load_candidate_from_status() {
  workspace_root="$(json_value "$status_json" config.workspaceRoot)"
  data_dir="$(json_value "$status_json" config.dataDir)"
  agent_worktree_root="$(json_value "$status_json" config.agentWorktreeRoot)"
  comparison_root="$(json_value "$status_json" config.comparisonRoot)"
  hall_core_port="$(json_value "$status_json" config.hallCorePort)"
  hall_web_port="$(json_value "$status_json" config.hallWebPort)"
  codex_trusted_local="$(json_value "$status_json" config.codexTrustedLocal)"
}

printf '\nHall of Wisdom Setup\n'
printf '%s\n\n' '----------------------------------------'

check_platform
cd "$repo_root"
check_prerequisites

printf 'Installing Hall dependencies...\n'
if ! pnpm install; then
  die "Dependency installation failed. Review the pnpm errors above, then run ./install.sh again."
fi
printf '  [OK] Dependencies installed.\n'

if ! pnpm --filter @hall-of-wisdom/hall-config run build; then
  die "The Hall configuration tool could not be built. Review the errors above, then run ./install.sh again."
fi

status_json="$(node "$config_cli" status)" || die "The Hall configuration tool could not read configuration status."
config_path="$(json_value "$status_json" path)"
config_exists="$(json_value "$status_json" exists)"
config_state="$(json_value "$status_json" config)"
mode="install"

if [[ "$config_exists" == "true" ]]; then
  if [[ "$config_state" == "__HALL_NULL__" ]]; then
    die "The existing Hall configuration at '$config_path' is invalid: $(json_value "$status_json" error). Fix or remove that file manually, then run ./install.sh again."
  fi

  printf '\nExisting Hall configuration found.\n'
  printf '  1. Keep current configuration and verify/repair installation\n'
  printf '  2. Reconfigure Hall\n'
  printf '  3. Cancel\n'
  while true; do
    if ! IFS= read -r -p "Choose an option [1]: " choice; then
      choice="1"
    fi
    case "$choice" in
      "" | 1) mode="keep"; break ;;
      2) mode="reconfigure"; break ;;
      3) printf 'Cancelled.\n'; exit 0 ;;
      *) printf 'Please enter 1, 2, or 3.\n' >&2 ;;
    esac
  done
fi

if [[ "$mode" == "keep" ]]; then
  load_candidate_from_status
  candidate_json="$(make_candidate)"
  build_hall
  if verify_candidate; then
    :
  else
    verify_code=$?
    if ((verify_code == 5)); then
      printf '  [INFO] Hall Core is already using this data directory; durable checks were skipped.\n'
    fi
  fi
  printf '\nHall of Wisdom is ready. Run ./start.sh to start it.\n'
  exit 0
fi

config_dir="$(node -e 'process.stdout.write(require("node:path").dirname(process.argv[1]))' "$config_path")"
if [[ "$mode" == "reconfigure" ]]; then
  load_candidate_from_status
  default_workspace_root="$workspace_root"
  if [[ "$data_dir" == "__HALL_UNDEFINED__" ]]; then
    default_data_dir="$config_dir/data"
  else
    default_data_dir="$data_dir"
  fi
  if [[ "$agent_worktree_root" == "__HALL_UNDEFINED__" ]]; then
    default_agent_worktree_root="$config_dir/agent-worktrees"
  else
    default_agent_worktree_root="$agent_worktree_root"
  fi
  default_comparison_root="$comparison_root"
else
  default_workspace_root="$original_dir"
  default_data_dir="$config_dir/data"
  default_agent_worktree_root="$config_dir/agent-worktrees"
  default_comparison_root="$config_dir/comparisons"
  hall_core_port=4310
  hall_web_port=3000
  codex_trusted_local=false
fi

printf '\nEnter absolute paths. Press Enter to accept each value shown in brackets.\n'
prompt_path "Projects/workspace folder" "$default_workspace_root"
workspace_root="$prompt_result"
prompt_path "Hall data location" "$default_data_dir"
data_dir="$prompt_result"
prompt_path "Agent worktree location" "$default_agent_worktree_root"
agent_worktree_root="$prompt_result"
prompt_comparison_root "$default_comparison_root"

candidate_json="$(make_candidate)"
validate_candidate
build_hall

if verify_candidate; then
  save_candidate
else
  verify_code=$?
  if ((verify_code == 5)); then
    if [[ "$mode" == "reconfigure" ]]; then
      die "Hall Core is using this data directory, so reconfiguration could not be fully verified. Stop Hall, then run ./install.sh again. The previous configuration was left untouched."
    fi
    printf '  [INFO] Hall Core is already using this data directory; durable checks were skipped.\n'
    save_candidate
  fi
fi

printf '\nHall of Wisdom is ready. Run ./start.sh to start it.\n'
