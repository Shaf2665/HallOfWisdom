#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
config_cli="$repo_root/packages/hall-config/dist/cli.js"
server_dist="$repo_root/apps/server/dist/server.js"
web_dir="$repo_root/apps/web"
next_bin="$web_dir/node_modules/next/dist/bin/next"
web_marker="$web_dir/.next/hall-launcher-build-marker.json"
core_pid=""
web_pid=""
failed_service=""

die() {
  printf '\n[FAIL] %s\n' "$1" >&2
  exit 1
}

json_value() {
  node -e '
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], JSON.parse(process.argv[1]));
    if (value === null) process.stdout.write("__HALL_NULL__");
    else if (value !== undefined) process.stdout.write(typeof value === "string" ? value : String(value));
  ' "$1" "$2"
}

process_is_running() {
  [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null
}

group_is_running() {
  [[ -n "$1" ]] && kill -0 -- "-$1" 2>/dev/null
}

stop_process_group() {
  local pid="$1"
  local service_name="$2"
  local attempt

  if ! group_is_running "$pid"; then
    wait "$pid" 2>/dev/null || true
    return
  fi

  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! group_is_running "$pid"; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep 0.25
  done

  printf '  %s did not stop gracefully; forcing termination...\n' "$service_name"
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP

  if [[ -n "$web_pid" || -n "$core_pid" ]]; then
    printf '\n'
    if [[ -n "$failed_service" ]]; then
      printf '%s exited unexpectedly; shutting down.\n' "$failed_service" >&2
    else
      printf 'Shutting down...\n'
    fi
    [[ -z "$web_pid" ]] || stop_process_group "$web_pid" "Hall Web"
    [[ -z "$core_pid" ]] || stop_process_group "$core_pid" "Hall Core"
    printf 'Hall of Wisdom stopped.\n'
  fi

  exit "$exit_code"
}

handle_signal() {
  local exit_code="$1"
  exit "$exit_code"
}

trap cleanup EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

check_port_free() {
  local port="$1"
  local service_name="$2"

  if ! node -e '
    const net = require("node:net");
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      process.exit(code);
    };
    socket.once("connect", () => finish(1));
    socket.once("error", () => finish(0));
    setTimeout(() => finish(0), 500);
  ' "$port"; then
    die "Port $port is already in use (needed for $service_name). Stop the process using it, then try again."
  fi
}

wait_for_service() {
  local url="$1"
  local service_name="$2"
  local pid="$3"
  local timeout_seconds="$4"
  local wait_code

  if node -e '
    const [url, pidText, timeoutText] = process.argv.slice(1);
    const pid = Number(pidText);
    const deadline = Date.now() + Number(timeoutText) * 1000;
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const run = async () => {
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { process.exit(2); }
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
          if (response.status === 200) process.exit(0);
        } catch {}
        await delay(250);
      }
      process.exit(3);
    };
    void run();
  ' "$url" "$pid" "$timeout_seconds"; then
    return 0
  else
    wait_code=$?
  fi

  if ((wait_code == 2)); then
    die "$service_name exited before becoming ready. Review its output above."
  fi
  die "$service_name did not become ready within $timeout_seconds seconds (checked $url)."
}

web_build_matches() {
  local hall_core_url="$1"
  node -e '
    const fs = require("node:fs");
    try {
      const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(marker.hallCoreUrl === process.argv[2] ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$web_marker" "$hall_core_url"
}

write_web_marker() {
  node -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.argv[1], `${JSON.stringify({ hallCoreUrl: process.argv[2] }, null, 2)}\n`, "utf8");
  ' "$web_marker" "$1"
}

open_browser_if_supported() {
  local url="$1"
  local platform

  if [[ -n "${CI:-}" || -n "${SSH_CONNECTION:-}" || -n "${SSH_TTY:-}" ]]; then
    return
  fi

  platform="$(uname -s 2>/dev/null || true)"
  if [[ "$platform" == "Darwin" ]] && command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 &
  elif [[ "$platform" == "Linux" ]] && command -v xdg-open >/dev/null 2>&1 &&
    [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
    xdg-open "$url" >/dev/null 2>&1 &
  fi
}

printf '\nHall of Wisdom\n'
printf '%s\n\n' '----------------------------------------'

case "$(uname -s 2>/dev/null || true)" in
  Linux | Darwin) ;;
  *) die "This launcher supports Linux and macOS. On Windows, run .\\start.ps1 in PowerShell." ;;
esac

command -v node >/dev/null 2>&1 || die "Node.js was not found on PATH. Run ./install.sh first."
[[ -f "$config_cli" ]] || die "Hall's configuration tool is missing. Run ./install.sh first."
[[ -f "$server_dist" ]] || die "Hall Core's build is missing. Run ./install.sh first."
[[ -f "$next_bin" ]] || die "Hall Web's dependencies are missing. Run ./install.sh first."

cd "$repo_root"
status_json="$(node "$config_cli" status)" || die "Hall configuration could not be loaded. Run ./install.sh again."
config_path="$(json_value "$status_json" path)"
if [[ "$(json_value "$status_json" exists)" != "true" ]]; then
  die "No Hall configuration was found at '$config_path'. Run ./install.sh first."
fi
if [[ "$(json_value "$status_json" config)" == "__HALL_NULL__" ]]; then
  die "The Hall configuration at '$config_path' is invalid: $(json_value "$status_json" error). Run ./install.sh again."
fi

# True when $1 is unset, empty, or contains only whitespace - matches
# start.ps1's [string]::IsNullOrWhiteSpace so a "   " env var is treated as
# unset on both platforms rather than passed through as a bogus origin.
is_blank() {
  [[ ! "$1" =~ [^[:space:]] ]]
}

hall_core_port="$(json_value "$status_json" config.hallCorePort)"
hall_web_port="$(json_value "$status_json" config.hallWebPort)"
# Readiness polling always targets the local port directly, regardless of
# any remote-access override below - Hall Core/Hall Web are started and
# supervised on this machine, and a Cloudflare Tunnel hostname may not even
# resolve yet at the moment they're starting up.
hall_core_local_url="http://127.0.0.1:$hall_core_port"
hall_web_local_url="http://127.0.0.1:$hall_web_port"
# Remote access via Cloudflare Tunnel (see docs/remote-access.md) is opt-in:
# unset (the default), both env vars are blank and every line below behaves
# exactly as before - loopback URL, zero Hall Core CLI flags.
# NEXT_PUBLIC_HALL_CORE_URL reuses the exact env var name Hall Web's build
# already reads below; HALL_WEB_ORIGIN is the public Hall Web origin Hall
# Core should additionally trust for CORS/WebSocket-origin checks (see
# server-cli-args.ts's --web-origin). Both feed the Hall Web build/marker and
# the announced/opened URL only - never the readiness checks above.
if is_blank "${NEXT_PUBLIC_HALL_CORE_URL:-}"; then
  hall_core_url="$hall_core_local_url"
else
  hall_core_url="$NEXT_PUBLIC_HALL_CORE_URL"
fi
# Once HALL_WEB_ORIGIN is set, Hall Core's CORS/WebSocket-origin allowlist
# only trusts that origin (see docs/remote-access.md) - the loopback URL
# would load but fail to sign in, reproducing issue #22. Announce/open the
# origin that will actually work.
if is_blank "${HALL_WEB_ORIGIN:-}"; then
  hall_web_url="$hall_web_local_url"
else
  hall_web_url="$HALL_WEB_ORIGIN"
fi

check_port_free "$hall_core_port" "Hall Core"
check_port_free "$hall_web_port" "Hall Web"

if ! web_build_matches "$hall_core_url"; then
  printf "Hall Web's build does not match %s; rebuilding...\n" "$hall_core_url"
  if ! NEXT_PUBLIC_HALL_CORE_URL="$hall_core_url" pnpm --filter @hall-of-wisdom/web run build; then
    die "Hall Web could not be rebuilt. Review the errors above, then run ./install.sh again."
  fi
  write_web_marker "$hall_core_url"
  printf '  [OK] Hall Web rebuilt.\n'
fi

# Job control gives each background service its own process group. Cleanup can
# then stop Next.js workers as well as the top-level Node processes.
set -m

printf 'Starting Hall Core on port %s...\n' "$hall_core_port"
core_args=("$server_dist")
if ! is_blank "${HALL_WEB_ORIGIN:-}"; then
  core_args+=(--web-origin "$HALL_WEB_ORIGIN")
fi
node "${core_args[@]}" </dev/null &
core_pid=$!
wait_for_service "$hall_core_local_url/api/v1/health" "Hall Core" "$core_pid" 30
printf '  [OK] Hall Core is ready.\n'

printf 'Starting Hall Web on port %s...\n' "$hall_web_port"
(
  cd "$web_dir"
  NEXT_PUBLIC_HALL_CORE_URL="$hall_core_url" exec node "$next_bin" start --hostname 127.0.0.1 --port "$hall_web_port"
) </dev/null &
web_pid=$!
wait_for_service "$hall_web_local_url/" "Hall Web" "$web_pid" 60
printf '  [OK] Hall Web is ready.\n'

printf '\nHall of Wisdom is running at %s\n' "$hall_web_url"
printf 'Press Ctrl+C to stop.\n'
open_browser_if_supported "$hall_web_url"

while process_is_running "$core_pid" && process_is_running "$web_pid"; do
  sleep 0.5
done

if ! process_is_running "$core_pid"; then
  failed_service="Hall Core"
else
  failed_service="Hall Web"
fi
exit 1
