# Remote access via Cloudflare Tunnel

Hall Core always binds to `127.0.0.1` only (`docs/architecture/0004-hall-core-server.md`,
"Local-only binding") — this never changes, and there is still no way to expose port 4310 directly
to the network. Remote access works by tunneling to that same loopback port, not by relaxing the
bind address.

## The problem this solves

Hall Web (the browser UI) and Hall Core (the API/WebSocket backend) are two separate local
services. By default Hall Web's browser-side code is built to call Hall Core at
`http://127.0.0.1:4310` — correct when Hall Web itself is loaded from `http://127.0.0.1:3000`, but
wrong the moment Hall Web is loaded remotely (e.g. through a Cloudflare Tunnel): the browser would
try to reach `127.0.0.1:4310` on the *visitor's own machine*, not the machine running Hall Core.
Login therefore fails with "Could not sign in. Make sure Hall Core is running." — even though Hall
Core is running fine and Cloudflare Tunnel already proxies WebSocket traffic correctly. No
WebSocket-passthrough configuration fixes this; the URL itself needs to be reachable.

## Setup

You need **two** hostnames on the same Cloudflare Tunnel, both under one domain you control:

| Hostname (example)         | Routes to (`cloudflared` ingress) | Serves       |
|-----------------------------|------------------------------------|--------------|
| `hall.example.com`          | `http://127.0.0.1:3000`            | Hall Web     |
| `core.hall.example.com`     | `http://127.0.0.1:4310`            | Hall Core    |

Both hostnames must share the same **registrable domain** (`example.com` in this example) — see
"Why two hostnames on one domain" below.

1. Add both hostnames to your tunnel's ingress rules (dashboard or `config.yml`), each pointing at
   the corresponding local port. No WebSocket-specific configuration is needed — Cloudflare Tunnel
   already proxies WebSocket upgrades over the same HTTP ingress rule.
2. Before starting Hall, set two environment variables in the shell that runs the launcher:

   PowerShell:
   ```powershell
   $env:NEXT_PUBLIC_HALL_CORE_URL = "https://core.hall.example.com"
   $env:HALL_WEB_ORIGIN = "https://hall.example.com"
   .\start.ps1
   ```

   Bash:
   ```bash
   export NEXT_PUBLIC_HALL_CORE_URL="https://core.hall.example.com"
   export HALL_WEB_ORIGIN="https://hall.example.com"
   ./start.sh
   ```

   `NEXT_PUBLIC_HALL_CORE_URL` is the URL the browser will use to reach Hall Core — it gets inlined
   into Hall Web's build (the launcher rebuilds automatically when this value changes, the same way
   it already does for a changed port). `HALL_WEB_ORIGIN` is passed to Hall Core as `--web-origin`,
   adding it to Hall Core's CORS and WebSocket-origin allowlist — see
   `docs/architecture/0004-hall-core-server.md`, "Exact-origin CORS policy".
3. Leave both variables unset for ordinary local development — every default stays exactly what it
   was (loopback URL, zero Hall Core CLI flags).

Both variables are opt-in and only need to be set in the shell that launches `start.ps1`/`start.sh`;
nothing is written to disk, and no persisted Hall configuration field changes.

## Why two hostnames on one domain

Hall's login session is a cookie (`SameSite=Lax`). A `SameSite=Lax` cookie set by Hall Core is only
sent back on requests from pages that are **same-site** with it — same registrable domain, any
subdomain. `hall.example.com` and `core.hall.example.com` are same-site (both under `example.com`),
so the cookie flows normally. Two hostnames on *unrelated* domains (or two random hostnames from a
free `*.trycloudflare.com` quick tunnel, which are typically treated as separate sites) would be
cross-site: login would appear to succeed but the session cookie would never reach Hall Core on the
next request. Use a named tunnel with hostnames you control under one domain.

## Running local and remote at the same time

Hall Core's CORS/WebSocket-origin allowlist only ever trusts one browser origin at a time
(`--web-origin`, defaulting to the local `http://127.0.0.1:<hallWebPort>`, or the remote
`HALL_WEB_ORIGIN` when set). Setting `HALL_WEB_ORIGIN` for a remote-access session means local
browser access to `http://127.0.0.1:<hallWebPort>` stops working for the duration of that session —
CORS will reject it. Restart without the two environment variables to go back to local-only access.
