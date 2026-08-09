# Phase 17.3 — One-Command Hall Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.\start.ps1` loads the persisted Hall config, starts Hall Core and Hall Web on their
configured ports, waits until both are ready, opens the browser, and cleanly stops both (no orphan
processes) on Ctrl+C or on either child failing.

**Architecture:** A thin `start.ps1` driver (mirrors `install.ps1`'s shape) dot-sources four new
`scripts/launch/*.ps1` modules plus the existing `scripts/install/HallConfigCli.ps1`. Hall Core is
spawned with **zero CLI flags** — `apps/server/src/server.ts` already auto-loads the persisted
config via `tryLoadConfig()`. Hall Web's `NEXT_PUBLIC_HALL_CORE_URL` build-time inlining is proven
fresh via a launcher-owned marker file inside `.next`, never `.env.local`. Windows can't deliver a
real SIGINT to a child Node process, so Hall Core is stopped via the existing stdin `SHUTDOWN`
protocol; Hall Web (and Hall Core as a fallback) is stopped via `taskkill /T /F`.

**Tech Stack:** PowerShell 5.1 + PowerShell 7 (pwsh) compatible. `System.Diagnostics.Process` for
child process control. No new Node/TypeScript code — this phase is 100% PowerShell plus one ADR.

**Design doc:** `docs/superpowers/specs/2026-08-09-phase-17-3-one-command-launcher-design.md` — read
it first; this plan implements it exactly, including all four user-requested corrections (explicit
`next start --hostname/--port`, `.next` marker instead of `.env.local`, optional-`ConfigPath`
adaptation instead of duplicated path resolution, and the `CREATE_NEW_PROCESS_GROUP` +
`CTRL_BREAK_EVENT` technique for the automated Ctrl+C test).

## Global Constraints

- No admin requirement, `Invoke-Expression`, Windows services, tray app, autostart registration, or
  UI beyond opening the default browser.
- `start.ps1` never modifies `config.json` (the persisted Hall config). Writing/rewriting the
  `.next` build marker is not "persisted config" — it is launcher-owned build-freshness metadata.
- No `.env.local` is ever written. `NEXT_PUBLIC_HALL_CORE_URL` is passed only via process
  environment, to both the build and the `next start` process.
- Every argument to `node`/`taskkill`/other native commands is passed as a structured argument, not
  a hand-built shell string; no shell interpolation (AGENTS.md hard rule).
- Reuse existing code, never duplicate: `Get-HallServerDistPath` (Verification.ps1),
  `Invoke-HallConfigStatus` (HallConfigCli.ps1, adapted not duplicated), the stdin `SHUTDOWN`
  protocol (already implemented server-side — this plan only ever writes the *client* side of it),
  `TestHelpers.ps1`'s `Assert-*` functions (dot-sourced from `scripts/install/tests/`, never
  copied).
- Test convention: hand-rolled (no Pester), fixture-based, matching `scripts/install/tests/*`
  exactly. `scripts/launch/tests/*.Tests.ps1` collected by `scripts/launch/tests/run-tests.ps1`;
  `scripts/launch/tests/end-to-end-smoke-test.ps1` is real-binary, explicitly run, not
  auto-collected.
- Do not modify Hall Core's or Hall Web's own runtime behavior, routes, or config schema. Do not
  start Phase 17.4.
- Branch: `phase-17-3-one-command-launcher` (already created from `main` at
  `43da3a185c9f53a560e02c498f4493fef65fa1c2`). Commit and push only — no PR.

---

## File Structure

New:
- `start.ps1` — thin driver, repo root.
- `scripts/launch/ConfigLoad.ps1` — `Get-HallLauncherConfig`.
- `scripts/launch/PortCheck.ps1` — `Test-HallPortFree`.
- `scripts/launch/WebBuildEnv.ps1` — `Get-HallWebBuildMarkerPath`, `Get-HallWebBuildMarker`,
  `Invoke-HallWebBuildIfStale`.
- `scripts/launch/ProcessManagement.ps1` — `ConvertTo-HallProcessArgumentString`,
  `Start-HallCoreProcess`, `Start-HallWebProcess`, `Wait-HallServiceReady`,
  `Wait-HallCoreHealthy`, `Wait-HallWebReady`, `Stop-HallLauncherProcess`,
  `Register-HallLauncherCtrlCHandler`, `Test-HallLauncherShutdownRequested`,
  `Unregister-HallLauncherCtrlCHandler`.
- `scripts/launch/tests/TestHelpers.ps1` — thin re-export (dot-sources the install one; see Task 2).
- `scripts/launch/tests/run-tests.ps1`.
- `scripts/launch/tests/PortCheck.Tests.ps1`.
- `scripts/launch/tests/ConfigLoad.Tests.ps1`.
- `scripts/launch/tests/WebBuildEnv.Tests.ps1`.
- `scripts/launch/tests/ProcessManagement.Tests.ps1`.
- `scripts/launch/tests/ConsoleSignalHelper.ps1` — the `CREATE_NEW_PROCESS_GROUP` +
  `CTRL_BREAK_EVENT` P/Invoke helper, test-only.
- `scripts/launch/tests/end-to-end-smoke-test.ps1`.
- `docs/architecture/0019-one-command-hall-launcher.md`.

Modified:
- `scripts/install/HallConfigCli.ps1` — optional `-ConfigPath`.
- `scripts/install/tests/HallConfigCli.Tests.ps1` — one new test case.
- `README.md` — ADR link.

---

### Task 1: Make `HallConfigCli.ps1`'s `-ConfigPath` optional

**Files:**
- Modify: `scripts/install/HallConfigCli.ps1`
- Modify: `scripts/install/tests/HallConfigCli.Tests.ps1`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Invoke-HallConfigCli`/`Invoke-HallConfigStatus`/`Invoke-HallConfigValidate`/
  `Invoke-HallConfigSave` all accept `-ConfigPath` as **optional**. When omitted, `--path` is not
  passed to `node dist/cli.js` at all, letting `run-cli.ts`'s own `resolveHallConfigFilePath()`
  resolve it. Every existing call site continues to pass `-ConfigPath` explicitly and is unaffected.

- [ ] **Step 1: Write the failing test**

Read the current `scripts/install/tests/HallConfigCli.Tests.ps1` first (it already exists — confirm
line numbers match before editing). Add this test case right after the existing `$status` assertion
block (after the line asserting `Assert-Equal $configPath $status.path ...`):

```powershell
    $statusNoPath = Invoke-HallConfigStatus -RepoRoot $fixtureRoot
    Assert-Equal $null $statusNoPath.path "status without -ConfigPath must omit --path, letting the CLI resolve its own canonical path (the fake CLI echoes back $null when --path is absent)"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pwsh -NoProfile -File scripts/install/tests/HallConfigCli.Tests.ps1`
Expected: FAIL — `Invoke-HallConfigStatus` currently requires `-ConfigPath` as `[Parameter(Mandatory)]`,
so calling it without one throws a parameter-binding error, not the expected assertion failure.

- [ ] **Step 3: Make `-ConfigPath` optional**

In `scripts/install/HallConfigCli.ps1`, replace the `Invoke-HallConfigCli` function's param block and
argument-building line:

```powershell
function Invoke-HallConfigCli {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][ValidateSet("status", "validate", "save")][string]$Command,
        [string]$ConfigPath,
        [string]$CandidateJson
    )
    $cliPath = Get-HallConfigCliPath -RepoRoot $RepoRoot
    $arguments = @($cliPath, $Command)
    if ($ConfigPath) { $arguments += @("--path", $ConfigPath) }
```

(Everything else in the function body — the `$OutputEncoding` handling, the `try`/`finally`, the
result parsing — is unchanged; only the param's `Mandatory` attribute and the argument-array
construction change.)

Replace `Invoke-HallConfigStatus`, `Invoke-HallConfigValidate`, `Invoke-HallConfigSave`:

```powershell
function Invoke-HallConfigStatus {
    param([Parameter(Mandatory)][string]$RepoRoot, [string]$ConfigPath)
    (Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "status" -ConfigPath $ConfigPath).Result
}

function Invoke-HallConfigValidate {
    param([Parameter(Mandatory)][string]$RepoRoot, [string]$ConfigPath, [Parameter(Mandatory)]$Candidate)
    Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "validate" -ConfigPath $ConfigPath -CandidateJson ($Candidate | ConvertTo-Json -Depth 10)
}

function Invoke-HallConfigSave {
    param([Parameter(Mandatory)][string]$RepoRoot, [string]$ConfigPath, [Parameter(Mandatory)]$Candidate)
    Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "save" -ConfigPath $ConfigPath -CandidateJson ($Candidate | ConvertTo-Json -Depth 10)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pwsh -NoProfile -File scripts/install/tests/HallConfigCli.Tests.ps1`
Expected: PASS, including the new assertion.

- [ ] **Step 5: Run the full install test suite to confirm no regression**

Run: `pwsh -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: all test files pass — confirms `install.ps1`'s own call sites (which always pass
`-ConfigPath` explicitly) are unaffected.

- [ ] **Step 6: Run under Windows PowerShell 5.1 too**

Run: `powershell -NoProfile -File scripts/install/tests/run-tests.ps1`
Expected: all test files pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/install/HallConfigCli.ps1 scripts/install/tests/HallConfigCli.Tests.ps1
git commit -m "fix(install): make HallConfigCli.ps1's -ConfigPath optional, letting hall-config resolve its own canonical path"
```

---

### Task 2: Launch test scaffolding + `PortCheck.ps1`

**Files:**
- Create: `scripts/launch/tests/TestHelpers.ps1`
- Create: `scripts/launch/tests/run-tests.ps1`
- Create: `scripts/launch/PortCheck.ps1`
- Create: `scripts/launch/tests/PortCheck.Tests.ps1`

**Interfaces:**
- Produces: `Test-HallPortFree -Port <int> -ServiceName <string>` — throws if the port is already
  accepting TCP connections on `127.0.0.1`; returns (no output) if free.

- [ ] **Step 1: Create the test scaffolding**

`scripts/launch/tests/TestHelpers.ps1` — a thin re-export, not a copy (reuse, not duplication):

```powershell
# Re-exports scripts/install/tests/TestHelpers.ps1's Assert-* functions so
# every scripts/launch/tests/*.Tests.ps1 file can dot-source this ONE file
# instead of reaching across into scripts/install/tests/ with a relative
# path of its own.
. (Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "..") (Join-Path "install" (Join-Path "tests" "TestHelpers.ps1")))
```

`scripts/launch/tests/run-tests.ps1` — byte-identical in shape to
`scripts/install/tests/run-tests.ps1`:

```powershell
param()
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$testFiles = Get-ChildItem -Path $here -Filter "*.Tests.ps1" | Sort-Object Name
$failed = @()

foreach ($file in $testFiles) {
    Write-Host "Running $($file.Name)..." -NoNewline
    try {
        & $file.FullName
        Write-Host " PASS" -ForegroundColor Green
    } catch {
        Write-Host " FAIL" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        $failed += $file.Name
    }
}

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "$($failed.Count) test file(s) failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "All $($testFiles.Count) test file(s) passed." -ForegroundColor Green
exit 0
```

- [ ] **Step 2: Write the failing test for `PortCheck.ps1`**

`scripts/launch/tests/PortCheck.Tests.ps1`:

```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "PortCheck.ps1")

try {
    # An ephemeral free port: bind nothing, ask the OS for a port, then
    # immediately release it - there's a small theoretical race (another
    # process could grab it between release and the assertion below), but
    # this is the standard, accepted way to get a "probably free" port
    # number without hardcoding one that might collide with a real service
    # already running on the test machine.
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $freePort = $probe.LocalEndpoint.Port
    $probe.Stop()

    Test-HallPortFree -Port $freePort -ServiceName "Test Service"
    Write-Host "  (free port correctly reported as free)" -ForegroundColor DarkGray

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $occupiedPort = $listener.LocalEndpoint.Port
    try {
        Assert-Throws { Test-HallPortFree -Port $occupiedPort -ServiceName "Test Service" } "an occupied port must throw a clear error"
        try {
            Test-HallPortFree -Port $occupiedPort -ServiceName "Test Service"
        } catch {
            Assert-True ($_.Exception.Message -like "*$occupiedPort*") "the error message should name the occupied port"
            Assert-True ($_.Exception.Message -like "*Test Service*") "the error message should name which service needs the port"
        }
    } finally {
        $listener.Stop()
    }
} finally {
}

Write-Host "  (PortCheck.Tests.ps1: all assertions passed)"
```

- [ ] **Step 3: Run to verify it fails**

Run: `pwsh -NoProfile -File scripts/launch/tests/PortCheck.Tests.ps1`
Expected: FAIL — `scripts/launch/PortCheck.ps1` does not exist yet.

- [ ] **Step 4: Write `PortCheck.ps1`**

```powershell
<#
Checks whether a TCP port is already bound before the launcher spawns
anything that would try to bind it - failing here with a clear, specific
message beats a cryptic EADDRINUSE surfacing from deep inside Fastify or
Next.js several seconds later.
#>

function Test-HallPortFree {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$ServiceName
    )
    $client = New-Object System.Net.Sockets.TcpClient
    $isOpen = $false
    try {
        $connectTask = $client.ConnectAsync("127.0.0.1", $Port)
        try {
            $connectTask.Wait(500) | Out-Null
            $isOpen = $client.Connected
        } catch {
            # ConnectAsync's task faults (e.g. connection refused) when
            # nothing is listening on the port - that outcome IS "the port
            # is free," not an error to propagate.
            $isOpen = $false
        }
    } finally {
        $client.Close()
    }
    if ($isOpen) {
        throw "Port $Port is already in use (needed for $ServiceName). Stop whatever is using it, or reconfigure $ServiceName's port via .\install.ps1, then try again."
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pwsh -NoProfile -File scripts/launch/tests/PortCheck.Tests.ps1`
Expected: PASS.

- [ ] **Step 6: Run under Windows PowerShell 5.1 too**

Run: `powershell -NoProfile -File scripts/launch/tests/PortCheck.Tests.ps1`
Expected: PASS. `System.Net.Sockets.TcpClient`/`TcpListener` and `Task.Wait(int)` are all present in
.NET Framework 4.x, so no compatibility gap is expected here — confirm it empirically anyway.

- [ ] **Step 7: Commit**

```bash
git add scripts/launch/tests/TestHelpers.ps1 scripts/launch/tests/run-tests.ps1 scripts/launch/PortCheck.ps1 scripts/launch/tests/PortCheck.Tests.ps1
git commit -m "feat(launch): Test-HallPortFree + scripts/launch/tests scaffolding"
```

---

### Task 3: `ConfigLoad.ps1`

**Files:**
- Create: `scripts/launch/ConfigLoad.ps1`
- Create: `scripts/launch/tests/ConfigLoad.Tests.ps1`

**Interfaces:**
- Consumes: `Invoke-HallConfigStatus` (Task 1's adapted signature — called with no `-ConfigPath`).
- Produces: `Get-HallLauncherConfig -RepoRoot <string>` — returns the zod-normalized config object
  (same shape `install.ps1`'s `Invoke-HallConfigStatus` already returns — `.hallCorePort`,
  `.hallWebPort`, `.workspaceRoot`, etc.) or throws a clear, actionable error.

- [ ] **Step 1: Write the failing test**

`scripts/launch/tests/ConfigLoad.Tests.ps1` — mirrors `scripts/install/tests/HallConfigCli.Tests.ps1`'s
fake-CLI pattern, but the fake CLI here is driven by an env var so the same fixture can express all
three `status` outcomes without needing three separate fake files:

```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "..") (Join-Path "install" "HallConfigCli.ps1"))
. (Join-Path (Join-Path $PSScriptRoot "..") "ConfigLoad.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-configload-test-$([guid]::NewGuid())"
$cliDir = Join-Path $fixtureRoot "packages/hall-config/dist"
New-Item -ItemType Directory -Path $cliDir -Force | Out-Null

$fakeCli = @'
const mode = process.env.HALL_TEST_CONFIG_MODE || "valid";
if (mode === "missing") {
  console.log(JSON.stringify({ exists: false, path: "C:\\fake\\config.json", config: null, error: null }));
} else if (mode === "invalid") {
  console.log(JSON.stringify({ exists: true, path: "C:\\fake\\config.json", config: null, error: "schema validation failed" }));
} else {
  console.log(JSON.stringify({ exists: true, path: "C:\\fake\\config.json", config: { schemaVersion: 1, workspaceRoot: "D:\\HallOfWisdom", comparisonRoot: null, hallCorePort: 4310, hallWebPort: 3000, codexTrustedLocal: false }, error: null }));
}
process.exit(0);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

$previousMode = $env:HALL_TEST_CONFIG_MODE
try {
    $env:HALL_TEST_CONFIG_MODE = "missing"
    $missingError = $null
    try { Get-HallLauncherConfig -RepoRoot $fixtureRoot | Out-Null } catch { $missingError = $_ }
    Assert-True ($null -ne $missingError) "a missing config must throw"
    Assert-True ($missingError.Exception.Message -like "*install.ps1*") "a missing-config error must point the user at install.ps1"

    $env:HALL_TEST_CONFIG_MODE = "invalid"
    $invalidError = $null
    try { Get-HallLauncherConfig -RepoRoot $fixtureRoot | Out-Null } catch { $invalidError = $_ }
    Assert-True ($null -ne $invalidError) "an invalid config must throw"
    Assert-True ($invalidError.Exception.Message -like "*schema validation failed*") "an invalid-config error must include the underlying reason"

    $env:HALL_TEST_CONFIG_MODE = "valid"
    $config = Get-HallLauncherConfig -RepoRoot $fixtureRoot
    Assert-Equal 4310 $config.hallCorePort "a valid config's hallCorePort should round-trip"
    Assert-Equal 3000 $config.hallWebPort "a valid config's hallWebPort should round-trip"
} finally {
    $env:HALL_TEST_CONFIG_MODE = $previousMode
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (ConfigLoad.Tests.ps1: all assertions passed)"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pwsh -NoProfile -File scripts/launch/tests/ConfigLoad.Tests.ps1`
Expected: FAIL — `scripts/launch/ConfigLoad.ps1` does not exist yet.

- [ ] **Step 3: Write `ConfigLoad.ps1`**

```powershell
<#
Thin wrapper around scripts/install/HallConfigCli.ps1's Invoke-HallConfigStatus,
translating its three possible outcomes into either a normalized config
object or a clear, actionable thrown error. Deliberately calls
Invoke-HallConfigStatus with NO -ConfigPath, so the underlying hall-config
CLI resolves its own canonical path via resolveHallConfigFilePath() - the
exact same function apps/server/src/server.ts's tryLoadConfig() uses -
instead of this script recomputing it (design doc decision 3).
#>

function Get-HallLauncherConfig {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $status = Invoke-HallConfigStatus -RepoRoot $RepoRoot
    if (-not $status.exists) {
        throw "No persisted Hall configuration found at '$($status.path)'. Run .\install.ps1 first."
    }
    if (-not $status.config) {
        throw "The persisted Hall configuration at '$($status.path)' is invalid: $($status.error). Run .\install.ps1 and choose 'Reconfigure Hall', or fix that file manually."
    }
    $status.config
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pwsh -NoProfile -File scripts/launch/tests/ConfigLoad.Tests.ps1`
Expected: PASS.

- [ ] **Step 5: Run under Windows PowerShell 5.1 too**

Run: `powershell -NoProfile -File scripts/launch/tests/ConfigLoad.Tests.ps1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/launch/ConfigLoad.ps1 scripts/launch/tests/ConfigLoad.Tests.ps1
git commit -m "feat(launch): Get-HallLauncherConfig"
```

---

### Task 4: `WebBuildEnv.ps1`

**Files:**
- Create: `scripts/launch/WebBuildEnv.ps1`
- Create: `scripts/launch/tests/WebBuildEnv.Tests.ps1`

**Interfaces:**
- Produces: `Get-HallWebBuildMarkerPath -RepoRoot <string>`, `Get-HallWebBuildMarker -RepoRoot
  <string>` (returns `$null` if absent/unreadable, else an object with `.hallCoreUrl`),
  `Invoke-HallWebBuildIfStale -RepoRoot <string> -HallCoreUrl <string>` (rebuilds + rewrites the
  marker only if stale; throws on build failure, never writes the marker in that case).

This task's test fakes `pnpm` itself (not just a Node script) since `Invoke-HallWebBuildIfStale`
invokes `pnpm --filter ... run build` as a native command — the test prepends a fake `pnpm.cmd` to
`PATH` for the duration of the test.

- [ ] **Step 1: Write the failing test**

`scripts/launch/tests/WebBuildEnv.Tests.ps1`:

```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "WebBuildEnv.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-webbuild-test-$([guid]::NewGuid())"
$webNextDir = Join-Path $fixtureRoot "apps/web/.next"
New-Item -ItemType Directory -Path $webNextDir -Force | Out-Null

# A fake pnpm that only understands "--filter @hall-of-wisdom/web run build":
# records whether NEXT_PUBLIC_HALL_CORE_URL was present in ITS OWN process
# environment (never a file - design doc decision 2/3) and whether a
# .env.local was ever created, then exits 0, or exits 1 if the marker
# fixture directory below signals it should fail.
$fakePnpmDir = Join-Path $fixtureRoot "fake-bin"
New-Item -ItemType Directory -Path $fakePnpmDir -Force | Out-Null
$callLogPath = Join-Path $fixtureRoot "pnpm-calls.log"
$fakePnpmScript = @'
@echo off
echo CALLED>>"%HALL_TEST_CALL_LOG%"
echo NEXT_PUBLIC_HALL_CORE_URL=%NEXT_PUBLIC_HALL_CORE_URL%>>"%HALL_TEST_CALL_LOG%"
if exist "%HALL_TEST_ENV_LOCAL_CHECK%" (
  echo ENV_LOCAL_EXISTS>>"%HALL_TEST_CALL_LOG%"
)
if "%HALL_TEST_FORCE_BUILD_FAILURE%"=="1" exit /b 1
exit /b 0
'@
Set-Content -LiteralPath (Join-Path $fakePnpmDir "pnpm.cmd") -Value $fakePnpmScript -Encoding ascii

$previousPath = $env:PATH
$previousCallLog = $env:HALL_TEST_CALL_LOG
$previousEnvLocalCheck = $env:HALL_TEST_ENV_LOCAL_CHECK
$previousForceFailure = $env:HALL_TEST_FORCE_BUILD_FAILURE
try {
    $env:PATH = "$fakePnpmDir;$previousPath"
    $env:HALL_TEST_CALL_LOG = $callLogPath
    $env:HALL_TEST_ENV_LOCAL_CHECK = Join-Path $fixtureRoot "apps/web/.env.local"
    $env:HALL_TEST_FORCE_BUILD_FAILURE = "0"

    # --- marker absent: rebuild triggered ---
    Remove-Item -LiteralPath $callLogPath -ErrorAction SilentlyContinue
    Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:4310"
    $callLog = Get-Content -LiteralPath $callLogPath -Raw
    Assert-True ($callLog -like "*CALLED*") "a missing marker must trigger a rebuild"
    Assert-True ($callLog -like "*NEXT_PUBLIC_HALL_CORE_URL=http://127.0.0.1:4310*") "the build must receive NEXT_PUBLIC_HALL_CORE_URL in its own process environment"
    Assert-False ($callLog -like "*ENV_LOCAL_EXISTS*") "no .env.local must ever be written"
    $marker = Get-HallWebBuildMarker -RepoRoot $fixtureRoot
    Assert-Equal "http://127.0.0.1:4310" $marker.hallCoreUrl "a successful build must write the marker with the built URL"

    # --- marker present, matching: no rebuild ---
    Remove-Item -LiteralPath $callLogPath -ErrorAction SilentlyContinue
    Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:4310"
    Assert-False (Test-Path -LiteralPath $callLogPath) "a matching marker must skip the rebuild entirely"

    # --- marker present, different URL (hallCorePort changed): rebuild triggered ---
    Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:5000"
    $callLog2 = Get-Content -LiteralPath $callLogPath -Raw
    Assert-True ($callLog2 -like "*NEXT_PUBLIC_HALL_CORE_URL=http://127.0.0.1:5000*") "a changed hallCorePort must trigger a rebuild with the new URL"
    $marker2 = Get-HallWebBuildMarker -RepoRoot $fixtureRoot
    Assert-Equal "http://127.0.0.1:5000" $marker2.hallCoreUrl "the marker must be rewritten to the new URL"

    # --- failing build: clear error, marker untouched ---
    $env:HALL_TEST_FORCE_BUILD_FAILURE = "1"
    Assert-Throws { Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:6000" } "a failing build must throw"
    $markerAfterFailure = Get-HallWebBuildMarker -RepoRoot $fixtureRoot
    Assert-Equal "http://127.0.0.1:5000" $markerAfterFailure.hallCoreUrl "a failed build must not rewrite the marker to the URL that failed to build"
} finally {
    $env:PATH = $previousPath
    $env:HALL_TEST_CALL_LOG = $previousCallLog
    $env:HALL_TEST_ENV_LOCAL_CHECK = $previousEnvLocalCheck
    $env:HALL_TEST_FORCE_BUILD_FAILURE = $previousForceFailure
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (WebBuildEnv.Tests.ps1: all assertions passed)"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pwsh -NoProfile -File scripts/launch/tests/WebBuildEnv.Tests.ps1`
Expected: FAIL — `scripts/launch/WebBuildEnv.ps1` does not exist yet.

- [ ] **Step 3: Write `WebBuildEnv.ps1`**

```powershell
<#
Build-freshness for Hall Web's NEXT_PUBLIC_HALL_CORE_URL - see the design
doc, decision 2. NEXT_PUBLIC_HALL_CORE_URL is inlined into Hall Web's client
bundle at `next build` time; a stale bundle (built for a different
hallCorePort) would silently point the browser at the wrong Hall Core. The
marker file this module writes is the ONLY record of what URL a given
.next build was actually made with - .env.local is never read, written, or
trusted; NEXT_PUBLIC_HALL_CORE_URL is passed directly in the spawned build
(and, for consistency, the spawned `next start`) process's environment
instead.
#>

function Get-HallWebBuildMarkerPath {
    param([Parameter(Mandatory)][string]$RepoRoot)
    Join-Path $RepoRoot (Join-Path "apps" (Join-Path "web" (Join-Path ".next" "hall-launcher-build-marker.json")))
}

function Get-HallWebBuildMarker {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $markerPath = Get-HallWebBuildMarkerPath -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $markerPath)) { return $null }
    try {
        Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        # A corrupt/unreadable marker is treated exactly like a missing one
        # - rebuild rather than trust it.
        $null
    }
}

function Invoke-HallWebBuildIfStale {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$HallCoreUrl
    )
    $marker = Get-HallWebBuildMarker -RepoRoot $RepoRoot
    if ($marker -and $marker.hallCoreUrl -eq $HallCoreUrl) {
        return
    }

    Write-Host "Hall Web's build does not match the configured Hall Core URL ($HallCoreUrl) - rebuilding..."
    Push-Location $RepoRoot
    $previousHallCoreUrl = $env:NEXT_PUBLIC_HALL_CORE_URL
    try {
        $env:NEXT_PUBLIC_HALL_CORE_URL = $HallCoreUrl
        & pnpm --filter "@hall-of-wisdom/web" run build
        if ($LASTEXITCODE -ne 0) {
            throw "Building Hall Web failed (exit code $LASTEXITCODE)."
        }
    } finally {
        $env:NEXT_PUBLIC_HALL_CORE_URL = $previousHallCoreUrl
        Pop-Location
    }

    $markerPath = Get-HallWebBuildMarkerPath -RepoRoot $RepoRoot
    [PSCustomObject]@{ hallCoreUrl = $HallCoreUrl } | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding utf8
    Write-Host "  [OK] Hall Web rebuilt for $HallCoreUrl"
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pwsh -NoProfile -File scripts/launch/tests/WebBuildEnv.Tests.ps1`
Expected: PASS.

- [ ] **Step 5: Run under Windows PowerShell 5.1 too**

Run: `powershell -NoProfile -File scripts/launch/tests/WebBuildEnv.Tests.ps1`
Expected: PASS. Pay particular attention to the fake `pnpm.cmd` actually being found via `PATH`
prepending and `& pnpm ...` invocation on both hosts — batch-file resolution via `&` has had
PS5.1-specific surprises elsewhere in this project.

- [ ] **Step 6: Commit**

```bash
git add scripts/launch/WebBuildEnv.ps1 scripts/launch/tests/WebBuildEnv.Tests.ps1
git commit -m "feat(launch): Invoke-HallWebBuildIfStale — env-only NEXT_PUBLIC_HALL_CORE_URL, .next marker freshness proof"
```

---

### Task 5: `ProcessManagement.ps1`

**Files:**
- Create: `scripts/launch/ProcessManagement.ps1`
- Create: `scripts/launch/tests/ProcessManagement.Tests.ps1`

**Interfaces:**
- Consumes: `Get-HallServerDistPath` is NOT reused directly here (that function lives in
  `scripts/install/Verification.ps1` and throws if missing — this task's `Start-HallCoreProcess`
  performs its own `Test-Path` check with its own message so this module has no dependency on
  `scripts/install/*`, keeping `scripts/launch/` self-contained apart from `HallConfigCli.ps1`,
  which `ConfigLoad.ps1` already depends on for a different reason).
- Produces: `ConvertTo-HallProcessArgumentString`, `Start-HallCoreProcess -RepoRoot <string>` (returns
  a started `System.Diagnostics.Process` with redirected stdin), `Start-HallWebProcess -RepoRoot
  <string> -Port <int> -HallCoreUrl <string>` (returns a started `System.Diagnostics.Process`),
  `Wait-HallServiceReady -Url <string> -ServiceName <string> [-Process <Process>] [-TimeoutSeconds
  <int>]`, `Wait-HallCoreHealthy -Port <int> [-Process <Process>] [-TimeoutSeconds <int> = 30]`,
  `Wait-HallWebReady -Port <int> [-Process <Process>] [-TimeoutSeconds <int> = 60]`,
  `Stop-HallLauncherProcess -Process <Process> -ServiceName <string> [-GracefulTimeoutSeconds <int> =
  5]`, `Register-HallLauncherCtrlCHandler`, `Test-HallLauncherShutdownRequested`,
  `Unregister-HallLauncherCtrlCHandler`.

- [ ] **Step 1: Write the failing test**

`scripts/launch/tests/ProcessManagement.Tests.ps1` — uses two small fake Node fixtures (one
Core-shaped: opens a port, serves `/api/v1/health`, honors the `SHUTDOWN` stdin line; one
Web-shaped: opens a port, serves `/`, deliberately ignores stdin so the `taskkill` fallback path is
what actually stops it):

```powershell
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "ProcessManagement.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-processmgmt-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

function New-HallTestPort {
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = $probe.LocalEndpoint.Port
    $probe.Stop()
    $port
}

# A minimal HTTP server: opens $port, returns 200 for any GET, honors a
# "SHUTDOWN\n" line on stdin by exiting 0. Written with Node's bare `http`
# module (no dependency install needed in this fixture context).
$fakeCoreScript = @'
const http = require("http");
const port = Number(process.argv[2]);
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
server.listen(port, "127.0.0.1");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (buffer.includes("SHUTDOWN")) { server.close(() => process.exit(0)); }
});
process.stdin.resume();
'@
$fakeCorePath = Join-Path $fixtureRoot "fake-core.js"
Set-Content -LiteralPath $fakeCorePath -Value $fakeCoreScript -Encoding utf8

# Same shape but NEVER reacts to stdin - proves Stop-HallLauncherProcess's
# forced taskkill fallback is what actually stops a process like this
# (Hall Web has no stdin-shutdown protocol at all).
$fakeWebScript = @'
const http = require("http");
const port = Number(process.argv[2]);
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
server.listen(port, "127.0.0.1");
process.stdin.resume();
'@
$fakeWebPath = Join-Path $fixtureRoot "fake-web.js"
Set-Content -LiteralPath $fakeWebPath -Value $fakeWebScript -Encoding utf8

function Start-HallTestFixture {
    param([Parameter(Mandatory)][string]$ScriptPath, [Parameter(Mandatory)][int]$Port)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command node).Source
    $psi.Arguments = ConvertTo-HallProcessArgumentString -ArgumentList @($ScriptPath, [string]$Port)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $process.Start() | Out-Null
    $process
}

try {
    # --- Wait-HallServiceReady: succeeds once listening ---
    $corePort = New-HallTestPort
    $coreFixture = Start-HallTestFixture -ScriptPath $fakeCorePath -Port $corePort
    try {
        Wait-HallServiceReady -Url "http://127.0.0.1:$corePort/api/v1/health" -ServiceName "Fake Core" -Process $coreFixture -TimeoutSeconds 10
        Write-Host "  (fixture became ready within timeout)" -ForegroundColor DarkGray

        # --- Stop-HallLauncherProcess: graceful stdin path ---
        Stop-HallLauncherProcess -Process $coreFixture -ServiceName "Fake Core"
        Assert-True $coreFixture.HasExited "the Core-shaped fixture must exit after receiving the stdin SHUTDOWN command"
        $stillRunning = Get-Process -Id $coreFixture.Id -ErrorAction SilentlyContinue
        Assert-True ($null -eq $stillRunning) "no process with the fixture's PID should remain after a graceful stop"
    } finally {
        if (-not $coreFixture.HasExited) { $coreFixture.Kill() }
    }

    # --- Wait-HallServiceReady: fails fast when the process exits before opening its port ---
    $neverStartsScript = @'
process.exit(1);
'@
    $neverStartsPath = Join-Path $fixtureRoot "never-starts.js"
    Set-Content -LiteralPath $neverStartsPath -Value $neverStartsScript -Encoding utf8
    $deadPort = New-HallTestPort
    $deadFixture = Start-HallTestFixture -ScriptPath $neverStartsPath -Port $deadPort
    Start-Sleep -Milliseconds 500
    $waitError = $null
    try {
        Wait-HallServiceReady -Url "http://127.0.0.1:$deadPort/" -ServiceName "Dead Fixture" -Process $deadFixture -TimeoutSeconds 5
    } catch {
        $waitError = $_
    }
    Assert-True ($null -ne $waitError) "waiting on a process that already exited must fail, not hang for the full timeout"
    Assert-True ($waitError.Exception.Message -like "*Dead Fixture*") "the failure message should name the service"

    # --- Stop-HallLauncherProcess: forced taskkill fallback for a fixture that ignores stdin ---
    $webPort = New-HallTestPort
    $webFixture = Start-HallTestFixture -ScriptPath $fakeWebPath -Port $webPort
    try {
        Wait-HallServiceReady -Url "http://127.0.0.1:$webPort/" -ServiceName "Fake Web" -Process $webFixture -TimeoutSeconds 10
        Stop-HallLauncherProcess -Process $webFixture -ServiceName "Fake Web" -GracefulTimeoutSeconds 2
        Assert-True $webFixture.HasExited "the Web-shaped fixture (which ignores stdin) must still be reaped by the forced fallback"
        $stillRunningWeb = Get-Process -Id $webFixture.Id -ErrorAction SilentlyContinue
        Assert-True ($null -eq $stillRunningWeb) "no process with the fixture's PID should remain after the forced fallback"
    } finally {
        if (-not $webFixture.HasExited) { $webFixture.Kill() }
    }

    # --- Stop-HallLauncherProcess: idempotent on an already-exited process ---
    Stop-HallLauncherProcess -Process $webFixture -ServiceName "Fake Web"
    Write-Host "  (calling Stop-HallLauncherProcess twice on an exited process did not throw)" -ForegroundColor DarkGray

    # --- Ctrl+C flag plumbing (function-level, not a real console signal - see the dual-host smoke test for that) ---
    Register-HallLauncherCtrlCHandler
    try {
        Assert-False (Test-HallLauncherShutdownRequested) "the shutdown flag must start false"
        [Console]::CancelKeyPress # touch the event to confirm the type resolves under both hosts (no-op statement)
    } finally {
        Unregister-HallLauncherCtrlCHandler
    }
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (ProcessManagement.Tests.ps1: all assertions passed)"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pwsh -NoProfile -File scripts/launch/tests/ProcessManagement.Tests.ps1`
Expected: FAIL — `scripts/launch/ProcessManagement.ps1` does not exist yet.

- [ ] **Step 3: Write `ProcessManagement.ps1`**

```powershell
<#
Spawns and manages Hall Core and Hall Web as child processes, and handles
Ctrl+C/shutdown. Hall Core is spawned with a redirected stdin specifically
so the existing STDIN_SHUTDOWN_COMMAND protocol
(apps/server/src/process/signal-shutdown.ts) can gracefully stop it -
Windows cannot deliver a real SIGINT/SIGTERM to a child Node process (see
that file's doc comment). Hall Web has no such protocol, so it (and Hall
Core as a fallback if it doesn't honor the stdin command in time) is
stopped via `taskkill /T /F`, which kills the full process tree rather
than just the top process - required because `next start` can spawn its
own worker processes that a plain Stop-Process would never reach.
#>

function ConvertTo-HallProcessArgumentString {
    # Windows command-line quoting: wrap each argument in double quotes and
    # escape any embedded double quote. Kept as an explicit string builder
    # (rather than ProcessStartInfo.ArgumentList, which is not guaranteed
    # present on every .NET Framework version Windows PowerShell 5.1 might
    # be running against) so this works identically on both hosts.
    param([Parameter(Mandatory)][string[]]$ArgumentList)
    ($ArgumentList | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
}

function Start-HallCoreProcess {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $distPath = Join-Path $RepoRoot (Join-Path "apps" (Join-Path "server" (Join-Path "dist" "server.js")))
    if (-not (Test-Path -LiteralPath $distPath)) {
        throw "Hall Core build not found at '$distPath' - run .\install.ps1 first."
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "'node' was not found on PATH." }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeCommand.Source
    # Zero CLI flags: apps/server/src/server.ts's tryLoadConfig() already
    # auto-loads the persisted Hall configuration - see design doc §2.
    $psi.Arguments = ConvertTo-HallProcessArgumentString -ArgumentList @($distPath)
    $psi.WorkingDirectory = $RepoRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    if (-not $process.Start()) {
        throw "Failed to start Hall Core."
    }
    $process
}

function Start-HallWebProcess {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$HallCoreUrl
    )
    $webDir = Join-Path $RepoRoot (Join-Path "apps" "web")
    $nextBin = Join-Path $webDir (Join-Path "node_modules" (Join-Path "next" (Join-Path "dist" (Join-Path "bin" "next"))))
    if (-not (Test-Path -LiteralPath $nextBin)) {
        throw "Next.js binary not found at '$nextBin' - run 'pnpm install' first."
    }
    $nextDist = Join-Path $webDir ".next"
    if (-not (Test-Path -LiteralPath $nextDist)) {
        throw "Hall Web build not found at '$nextDist' - run .\install.ps1 first."
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "'node' was not found on PATH." }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeCommand.Source
    $psi.Arguments = ConvertTo-HallProcessArgumentString -ArgumentList @($nextBin, "start", "--hostname", "127.0.0.1", "--port", [string]$Port)
    $psi.WorkingDirectory = $webDir
    $psi.UseShellExecute = $false
    # Matches decision 3's env-only approach - no file is ever written for
    # this. Next's production server doesn't re-read NEXT_PUBLIC_* at
    # runtime (it's already inlined into the built client bundle), but
    # setting it here too costs nothing and keeps every spawned Hall Web
    # process's environment consistent.
    $psi.EnvironmentVariables["NEXT_PUBLIC_HALL_CORE_URL"] = $HallCoreUrl

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    if (-not $process.Start()) {
        throw "Failed to start Hall Web."
    }
    $process
}

function Wait-HallServiceReady {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$ServiceName,
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process -and $Process.HasExited) {
            throw "$ServiceName exited unexpectedly (exit code $($Process.ExitCode)) before becoming ready."
        }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch {
            # Connection refused / timeout / non-200 all just mean "not
            # ready yet, keep polling."
        }
        Start-Sleep -Milliseconds 250
    }
    throw "$ServiceName did not become ready within $TimeoutSeconds seconds (checked $Url)."
}

function Wait-HallCoreHealthy {
    param([Parameter(Mandatory)][int]$Port, [System.Diagnostics.Process]$Process, [int]$TimeoutSeconds = 30)
    Wait-HallServiceReady -Url "http://127.0.0.1:$Port/api/v1/health" -ServiceName "Hall Core" -Process $Process -TimeoutSeconds $TimeoutSeconds
}

function Wait-HallWebReady {
    param([Parameter(Mandatory)][int]$Port, [System.Diagnostics.Process]$Process, [int]$TimeoutSeconds = 60)
    Wait-HallServiceReady -Url "http://127.0.0.1:$Port/" -ServiceName "Hall Web" -Process $Process -TimeoutSeconds $TimeoutSeconds
}

function Stop-HallLauncherProcess {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory)][string]$ServiceName,
        [int]$GracefulTimeoutSeconds = 5
    )
    if ($Process.HasExited) { return }

    if ($Process.StartInfo.RedirectStandardInput) {
        try {
            $Process.StandardInput.WriteLine("SHUTDOWN")
            $Process.StandardInput.Flush()
        } catch {
            # The pipe may already be broken if the process is mid-exit -
            # fall through to the forced-kill path below.
        }
        $deadline = (Get-Date).AddSeconds($GracefulTimeoutSeconds)
        while (-not $Process.HasExited -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not $Process.HasExited) {
        Write-Host "  $ServiceName did not stop gracefully - forcing termination..."
        & taskkill /PID $Process.Id /T /F | Out-Null
        $Process.WaitForExit(5000) | Out-Null
    }
}

<#
Ctrl+C handling: Register-ObjectEvent's -Action block runs in a separate
event-processing context where calling back into functions/variables from
the registering scope is unreliable across PowerShell hosts. To sidestep
that entirely, the handler only ever sets a $global: flag (genuinely
global across the whole host process, unlike $script:, which is tied to a
specific runspace/scope chain) - the caller's own monitoring loop polls
that flag and performs the actual (synchronous, main-thread) cleanup
itself. $EventArgs.Cancel = $true stops the host from immediately
terminating the process on Ctrl+C/Ctrl+Break, exactly as a normal
CancelKeyPress handler is meant to.
#>
function Register-HallLauncherCtrlCHandler {
    $global:HallLauncherShutdownRequested = $false
    Register-ObjectEvent -InputObject ([Console]) -EventName CancelKeyPress -SourceIdentifier "HallLauncherCancelKeyPress" -Action {
        $EventArgs.Cancel = $true
        $global:HallLauncherShutdownRequested = $true
    } | Out-Null
}

function Test-HallLauncherShutdownRequested {
    [bool]$global:HallLauncherShutdownRequested
}

function Unregister-HallLauncherCtrlCHandler {
    Unregister-Event -SourceIdentifier "HallLauncherCancelKeyPress" -ErrorAction SilentlyContinue
    Remove-Job -Name "HallLauncherCancelKeyPress" -ErrorAction SilentlyContinue
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pwsh -NoProfile -File scripts/launch/tests/ProcessManagement.Tests.ps1`
Expected: PASS.

- [ ] **Step 5: Run under Windows PowerShell 5.1 too**

Run: `powershell -NoProfile -File scripts/launch/tests/ProcessManagement.Tests.ps1`
Expected: PASS. If `Register-ObjectEvent`/`$global:` flag propagation behaves differently on this
host, that is exactly the kind of divergence this task must catch and fix before proceeding — do
not treat a failure here as acceptable/deferred.

- [ ] **Step 6: Commit**

```bash
git add scripts/launch/ProcessManagement.ps1 scripts/launch/tests/ProcessManagement.Tests.ps1
git commit -m "feat(launch): spawn/wait/stop Hall Core and Hall Web, Ctrl+C flag handling"
```

---

### Task 6: `start.ps1`

**Files:**
- Create: `start.ps1`

**Interfaces:**
- Consumes: `Get-HallLauncherConfig` (Task 3), `Test-HallPortFree` (Task 2),
  `Invoke-HallWebBuildIfStale` (Task 4), `Start-HallCoreProcess`/`Start-HallWebProcess`/
  `Wait-HallCoreHealthy`/`Wait-HallWebReady`/`Stop-HallLauncherProcess`/
  `Register-HallLauncherCtrlCHandler`/`Test-HallLauncherShutdownRequested`/
  `Unregister-HallLauncherCtrlCHandler` (Task 5).
- Produces: `Invoke-HallLauncher -RepoRoot <string>` — the orchestrator, guarded by
  `HALL_START_PS1_UNDER_TEST` exactly like `install.ps1`'s own `Invoke-HallInstaller` guard, so this
  file can be dot-sourced for testing without immediately launching real processes.

This task has no dedicated unit test of its own (`Invoke-HallLauncher` is pure orchestration over
already-tested functions) — its correctness is verified by Task 7's real end-to-end smoke test,
matching how `install.ps1`'s own `Invoke-HallInstaller` has no unit test file, only the smoke test.

- [ ] **Step 1: Write `start.ps1`**

```powershell
<#
.SYNOPSIS
    Starts Hall of Wisdom: Hall Core and Hall Web, using the configuration
    saved by .\install.ps1, and opens it in your browser.
.DESCRIPTION
    See docs/architecture/0019-one-command-hall-launcher.md. Locates the
    repository via $PSScriptRoot, never the caller's working directory.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot

. (Join-Path $RepoRoot "scripts/install/HallConfigCli.ps1")
. (Join-Path $RepoRoot "scripts/launch/ConfigLoad.ps1")
. (Join-Path $RepoRoot "scripts/launch/PortCheck.ps1")
. (Join-Path $RepoRoot "scripts/launch/WebBuildEnv.ps1")
. (Join-Path $RepoRoot "scripts/launch/ProcessManagement.ps1")

function Invoke-HallLauncher {
    param([Parameter(Mandatory)][string]$RepoRoot)

    Write-Host ""
    Write-Host "Hall of Wisdom" -ForegroundColor Cyan
    Write-Host "----------------------------------------"
    Write-Host ""

    $config = Get-HallLauncherConfig -RepoRoot $RepoRoot

    Test-HallPortFree -Port $config.hallCorePort -ServiceName "Hall Core"
    Test-HallPortFree -Port $config.hallWebPort -ServiceName "Hall Web"

    $hallCoreUrl = "http://127.0.0.1:$($config.hallCorePort)"
    Invoke-HallWebBuildIfStale -RepoRoot $RepoRoot -HallCoreUrl $hallCoreUrl

    Write-Host "Starting Hall Core on port $($config.hallCorePort)..."
    $coreProcess = Start-HallCoreProcess -RepoRoot $RepoRoot
    try {
        Wait-HallCoreHealthy -Port $config.hallCorePort -Process $coreProcess
    } catch {
        Stop-HallLauncherProcess -Process $coreProcess -ServiceName "Hall Core"
        throw
    }
    Write-Host "  [OK] Hall Core is ready"

    Write-Host "Starting Hall Web on port $($config.hallWebPort)..."
    $webProcess = Start-HallWebProcess -RepoRoot $RepoRoot -Port $config.hallWebPort -HallCoreUrl $hallCoreUrl
    try {
        Wait-HallWebReady -Port $config.hallWebPort -Process $webProcess
    } catch {
        Stop-HallLauncherProcess -Process $webProcess -ServiceName "Hall Web"
        Stop-HallLauncherProcess -Process $coreProcess -ServiceName "Hall Core"
        throw
    }
    Write-Host "  [OK] Hall Web is ready"

    $webUrl = "http://127.0.0.1:$($config.hallWebPort)"
    Write-Host ""
    Write-Host "Hall of Wisdom is running at $webUrl" -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Cyan
    Start-Process $webUrl

    $failedService = $null
    Register-HallLauncherCtrlCHandler
    try {
        while (-not (Test-HallLauncherShutdownRequested)) {
            if ($coreProcess.HasExited) { $failedService = "Hall Core"; break }
            if ($webProcess.HasExited) { $failedService = "Hall Web"; break }
            Start-Sleep -Milliseconds 250
        }
    } finally {
        Unregister-HallLauncherCtrlCHandler
    }

    Write-Host ""
    if ($failedService) {
        Write-Host "$failedService exited unexpectedly - shutting down." -ForegroundColor Red
    } else {
        Write-Host "Shutting down..." -ForegroundColor Cyan
    }
    Stop-HallLauncherProcess -Process $webProcess -ServiceName "Hall Web"
    Stop-HallLauncherProcess -Process $coreProcess -ServiceName "Hall Core"
    Write-Host "Hall of Wisdom stopped." -ForegroundColor Cyan

    if ($failedService) { exit 1 }
}

# Guard so this file can be dot-sourced (for a testable subset, or by a
# smoke-test harness) without immediately launching real processes -
# mirrors install.ps1's HALL_INSTALL_PS1_UNDER_TEST guard exactly.
if (-not $env:HALL_START_PS1_UNDER_TEST) {
    Invoke-HallLauncher -RepoRoot $RepoRoot
}
```

- [ ] **Step 2: Typecheck-equivalent — PowerShell parse check**

Run: `pwsh -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('start.ps1', [ref]$null, [ref]$errors); if ($errors) { $errors; exit 1 }"`
Expected: no output, exit 0 (confirms no syntax errors before any real invocation).

- [ ] **Step 3: Manual smoke check (not yet the full dual-host suite — that's Task 7)**

With a real persisted config already present (e.g. from having run `.\install.ps1` earlier in this
session, or `HALL_CONFIG_DIR` pointed at a fixture), run `.\start.ps1` directly, confirm it starts
both processes, opens the browser, and that a real Ctrl+C in that terminal stops both cleanly (check
Task Manager / `Get-Process node` afterward — nothing should remain). Do this once now as a sanity
check; Task 7 automates the equivalent check under both hosts.

- [ ] **Step 4: Commit**

```bash
git add start.ps1
git commit -m "feat: start.ps1 — one-command Hall launcher"
```

---

### Task 7: Dual-host end-to-end smoke test with real Ctrl+Break

**Files:**
- Create: `scripts/launch/tests/ConsoleSignalHelper.ps1`
- Create: `scripts/launch/tests/end-to-end-smoke-test.ps1`

**Interfaces:**
- Produces: `scripts/launch/tests/ConsoleSignalHelper.ps1` exposes `Start-HallTestProcessGroup
  -ExePath <string> -Arguments <string> -WorkingDirectory <string>` (returns the new process's PID,
  spawned under `CREATE_NEW_PROCESS_GROUP`) and `Send-HallTestCtrlBreak -ProcessGroupId <int>`.

- [ ] **Step 1: Write `ConsoleSignalHelper.ps1`**

`GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)` cannot target an arbitrary process group on Windows —
`CTRL_C_EVENT` only ever reaches the caller's own console group (group ID `0`). The correct,
documented technique for delivering a *targeted* console signal from a test harness to a spawned
child is: create that child under `CREATE_NEW_PROCESS_GROUP`, then send `CTRL_BREAK_EVENT` to its
process group ID (which equals its own PID). `System.Console`'s `CancelKeyPress` event fires
identically for `ConsoleSpecialKey.ControlC` and `ControlBreak`, so this exercises the exact same
handler a real interactive Ctrl+C would.

```powershell
<#
Test-only Win32 P/Invoke helper: spawns a process under
CREATE_NEW_PROCESS_GROUP (System.Diagnostics.Process exposes no managed way
to set this creation flag) and sends it a targeted CTRL_BREAK_EVENT -
CTRL_C_EVENT cannot be targeted at an arbitrary process group on Windows,
only at the caller's own group (ID 0). See
docs/superpowers/specs/2026-08-09-phase-17-3-one-command-launcher-design.md,
decision 4.
#>

$hallConsoleSignalSource = @'
using System;
using System.Runtime.InteropServices;

public static class HallConsoleSignal
{
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CTRL_BREAK_EVENT = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName, string lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

    public static int StartInNewProcessGroup(string exePath, string arguments, string workingDirectory)
    {
        var startupInfo = new STARTUPINFO();
        startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION processInfo;
        string commandLine = "\"" + exePath + "\" " + arguments;
        bool ok = CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, workingDirectory, ref startupInfo, out processInfo);
        if (!ok)
        {
            throw new InvalidOperationException("CreateProcess failed, Win32 error " + Marshal.GetLastWin32Error());
        }
        return processInfo.dwProcessId;
    }

    public static void SendCtrlBreak(int processGroupId)
    {
        if (!GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, (uint)processGroupId))
        {
            throw new InvalidOperationException("GenerateConsoleCtrlEvent failed, Win32 error " + Marshal.GetLastWin32Error());
        }
    }
}
'@

if (-not ("HallConsoleSignal" -as [type])) {
    Add-Type -TypeDefinition $hallConsoleSignalSource
}

function Start-HallTestProcessGroup {
    param(
        [Parameter(Mandatory)][string]$ExePath,
        [Parameter(Mandatory)][string]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )
    [HallConsoleSignal]::StartInNewProcessGroup($ExePath, $Arguments, $WorkingDirectory)
}

function Send-HallTestCtrlBreak {
    param([Parameter(Mandatory)][int]$ProcessGroupId)
    [HallConsoleSignal]::SendCtrlBreak($ProcessGroupId)
}
```

- [ ] **Step 2: Write `end-to-end-smoke-test.ps1`**

```powershell
<#
.DESCRIPTION
    Real end-to-end launcher smoke test: builds Hall Core + Hall Web for
    real (if not already built), writes an isolated persisted config (its
    own HALL_CONFIG_DIR, never the real user profile), starts start.ps1 as
    a real child process on non-default ports, waits for both services to
    become ready, sends a real console signal (CREATE_NEW_PROCESS_GROUP +
    targeted CTRL_BREAK_EVENT), and confirms clean, orphan-free shutdown.
    Also covers one failure-injection case: Hall Web crashing immediately
    after Hall Core is already healthy, confirming Hall Core is torn down
    rather than left running alone.

    Run explicitly: pwsh -NoProfile -File scripts/launch/tests/end-to-end-smoke-test.ps1

    Deliberately NOT named *.Tests.ps1 - run-tests.ps1 only picks up that
    pattern for the fast fixture-based loop; this script builds the real
    workspace and takes minutes, mirroring
    scripts/install/tests/end-to-end-smoke-test.ps1's role and its
    dual-host pattern exactly.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path $PSScriptRoot "ConsoleSignalHelper.ps1")
. (Join-Path $RepoRoot "scripts/install/HallConfigCli.ps1")

function New-HallTestPort {
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = $probe.LocalEndpoint.Port
    $probe.Stop()
    $port
}

function Wait-HallTestReady {
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSeconds = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for $Url to become ready."
}

function Test-HallTestNoOrphanProcesses {
    param([Parameter(Mandatory)][int]$CorePort, [Parameter(Mandatory)][int]$WebPort)
    Start-Sleep -Seconds 1
    foreach ($port in @($CorePort, $WebPort)) {
        $client = New-Object System.Net.Sockets.TcpClient
        $stillOpen = $false
        try {
            $connectTask = $client.ConnectAsync("127.0.0.1", $port)
            try { $connectTask.Wait(500) | Out-Null; $stillOpen = $client.Connected } catch { $stillOpen = $false }
        } finally { $client.Close() }
        if ($stillOpen) { throw "Port $port is still accepting connections after shutdown - an orphan process was left running." }
    }
}

function Invoke-HallLauncherLifecycleSmokeTest {
    param([Parameter(Mandatory)][string]$Host)

    Write-Host "--- Lifecycle smoke test under host: $Host ---"

    $corePort = New-HallTestPort
    $webPort = New-HallTestPort
    $fakeConfigDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-e2e-$Host-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $fakeConfigDir -Force | Out-Null

    $previousHallConfigDir = $env:HALL_CONFIG_DIR
    $previousStartUnderTest = $env:HALL_START_PS1_UNDER_TEST
    try {
        $env:HALL_CONFIG_DIR = $fakeConfigDir
        if (Test-Path -LiteralPath env:HALL_START_PS1_UNDER_TEST) { Remove-Item -LiteralPath env:HALL_START_PS1_UNDER_TEST }

        $candidate = [PSCustomObject]@{
            schemaVersion     = 1
            workspaceRoot     = $RepoRoot
            comparisonRoot    = $null
            hallCorePort      = $corePort
            hallWebPort       = $webPort
            codexTrustedLocal = $false
        }
        $saved = Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath (Join-Path $fakeConfigDir "config.json") -Candidate $candidate
        if ($saved.ExitCode -ne 0) { throw "Failed to save the isolated test config: $($saved.Result.errors -join '; ')" }

        $hostCommand = Get-Command $Host -ErrorAction SilentlyContinue
        if (-not $hostCommand) { throw "Host '$Host' was not found on PATH - skipping this host's coverage is not acceptable; install it or run on a machine that has it." }

        $startPs1 = Join-Path $RepoRoot "start.ps1"
        $arguments = "-NoProfile -File `"$startPs1`""
        $pid = Start-HallTestProcessGroup -ExePath $hostCommand.Source -Arguments $arguments -WorkingDirectory $RepoRoot

        try {
            Wait-HallTestReady -Url "http://127.0.0.1:$corePort/api/v1/health" -TimeoutSeconds 60
            Wait-HallTestReady -Url "http://127.0.0.1:$webPort/" -TimeoutSeconds 90
            Write-Host "  [OK] both services became ready"

            Send-HallTestCtrlBreak -ProcessGroupId $pid
            $deadline = (Get-Date).AddSeconds(30)
            $childProcess = Get-Process -Id $pid -ErrorAction SilentlyContinue
            while ($childProcess -and (Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 250
                $childProcess = Get-Process -Id $pid -ErrorAction SilentlyContinue
            }
            if ($childProcess) { throw "start.ps1 (PID $pid) did not exit within 30s of receiving Ctrl+Break." }

            Test-HallTestNoOrphanProcesses -CorePort $corePort -WebPort $webPort
            Write-Host "  [OK] clean shutdown, no orphaned Hall Core/Hall Web process (host: $Host)" -ForegroundColor Green
        } finally {
            $stray = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($stray) { & taskkill /PID $pid /T /F 2>&1 | Out-Null }
        }
    } finally {
        $env:HALL_CONFIG_DIR = $previousHallConfigDir
        $env:HALL_START_PS1_UNDER_TEST = $previousStartUnderTest
        Remove-Item -LiteralPath $fakeConfigDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-HallLauncherFailureCleanupSmokeTest {
    Write-Host "--- Failure-cleanup smoke test: Hall Web crashes after Hall Core is healthy ---"
    $corePort = New-HallTestPort
    . (Join-Path $RepoRoot "scripts/launch/ProcessManagement.ps1")

    $coreProcess = Start-HallCoreProcessForTest -RepoRoot $RepoRoot -Port $corePort
    try {
        Wait-HallCoreHealthy -Port $corePort -Process $coreProcess -TimeoutSeconds 30
        Write-Host "  [OK] Hall Core is healthy"

        # A "Hall Web" that exits immediately with a non-zero code,
        # simulating a genuine startup crash - independent of port
        # occupancy, since the real port precheck already ran and passed
        # before Hall Core was even started (see design doc decision on
        # the cleanup-failure test).
        $crashScript = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-crash-$([guid]::NewGuid()).js"
        Set-Content -LiteralPath $crashScript -Value "process.exit(1);" -Encoding utf8
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = (Get-Command node).Source
        $psi.Arguments = ConvertTo-HallProcessArgumentString -ArgumentList @($crashScript)
        $psi.UseShellExecute = $false
        $webProcess = New-Object System.Diagnostics.Process
        $webProcess.StartInfo = $psi
        $webProcess.Start() | Out-Null

        $readyError = $null
        try {
            # The port passed here is arbitrary and never actually
            # checked - $crashScript exits before attempting to listen on
            # anything, so Wait-HallServiceReady's fail-fast-on-process-exit
            # check is what produces the error, not a failed connection
            # attempt.
            Wait-HallWebReady -Port (New-HallTestPort) -Process $webProcess -TimeoutSeconds 10
        } catch {
            $readyError = $_
        }
        Assert-True ($null -ne $readyError) "a crashing Hall Web must surface as a Wait-HallWebReady failure"

        Stop-HallLauncherProcess -Process $webProcess -ServiceName "Hall Web"
        Stop-HallLauncherProcess -Process $coreProcess -ServiceName "Hall Core"
        Assert-True $coreProcess.HasExited "Hall Core must be torn down after Hall Web fails to become ready, not left running alone"
        Write-Host "  [OK] Hall Core was cleaned up after Hall Web's simulated crash" -ForegroundColor Green
        Remove-Item -LiteralPath $crashScript -Force -ErrorAction SilentlyContinue
    } finally {
        if (-not $coreProcess.HasExited) { $coreProcess.Kill() }
    }
}

# Thin variant of Start-HallCoreProcess taking an explicit port override via
# an isolated HALL_CONFIG_DIR, used only by the failure-cleanup smoke test
# above so it does not depend on a real persisted config file on disk.
function Start-HallCoreProcessForTest {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][int]$Port)
    $fakeConfigDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-e2e-corefixture-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $fakeConfigDir -Force | Out-Null
    $candidate = [PSCustomObject]@{
        schemaVersion     = 1
        workspaceRoot     = $RepoRoot
        comparisonRoot    = $null
        hallCorePort      = $Port
        hallWebPort       = (New-HallTestPort)
        codexTrustedLocal = $false
    }
    Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath (Join-Path $fakeConfigDir "config.json") -Candidate $candidate | Out-Null
    $previousHallConfigDir = $env:HALL_CONFIG_DIR
    $env:HALL_CONFIG_DIR = $fakeConfigDir
    try {
        Start-HallCoreProcess -RepoRoot $RepoRoot
    } finally {
        $env:HALL_CONFIG_DIR = $previousHallConfigDir
    }
}

try {
    Write-Host "Ensuring Hall Core and Hall Web are built..."
    Push-Location $RepoRoot
    try {
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed - required before this smoke test can run." }
    } finally {
        Pop-Location
    }

    Invoke-HallLauncherFailureCleanupSmokeTest

    foreach ($hostName in @("pwsh", "powershell")) {
        if (Get-Command $hostName -ErrorAction SilentlyContinue) {
            Invoke-HallLauncherLifecycleSmokeTest -Host $hostName
        } else {
            Write-Host "Host '$hostName' not found on PATH - skipping (install it to get full dual-host coverage)." -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host ""
    Write-Host "SMOKE TEST FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "All launcher smoke tests passed." -ForegroundColor Green
exit 0
```

- [ ] **Step 3: Run it**

Run: `pwsh -NoProfile -File scripts/launch/tests/end-to-end-smoke-test.ps1`
Expected: `pnpm build` succeeds, the failure-cleanup case passes, and the lifecycle test passes under
both `pwsh` and `powershell` (if both are installed on the machine — if only one host is available,
this is a genuine environment gap to flag in the phase report, not silently ignore).

- [ ] **Step 4: Fix any host-specific divergence found**

If the `pwsh`-vs-`powershell` runs disagree (e.g. `Register-ObjectEvent`/`$global:` flag timing, or
`CreateProcess`/`GenerateConsoleCtrlEvent` P/Invoke marshaling differences), treat this as the exact
kind of PS5.1-specific bug this project has hit before in Phase 17.1 — fix `ProcessManagement.ps1`
or `ConsoleSignalHelper.ps1` as needed and re-run this step until both hosts pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/launch/tests/ConsoleSignalHelper.ps1 scripts/launch/tests/end-to-end-smoke-test.ps1
git commit -m "test(launch): real dual-host lifecycle/Ctrl+Break smoke test, failure-cleanup coverage"
```

---

### Task 8: ADR 0019

**Files:**
- Create: `docs/architecture/0019-one-command-hall-launcher.md`
- Modify: `README.md` (one line, matching the existing ADR-list convention)

- [ ] **Step 1: Write the ADR**

```markdown
# ADR 0019: One-Command Hall Launcher

## Status

Accepted (Phase 17.3).

## Context

A user who completed `.\install.ps1` still had to know Hall Core is `apps/server/dist/server.js`,
that Hall Web is `next start` on a hardcoded port, that the two must start in a specific order with
matching origins, and that stopping them cleanly on Windows is not as simple as Ctrl+C.

## Decision

`.\start.ps1` loads the persisted Hall configuration (`@hall-of-wisdom/hall-config`, reused as-is),
starts Hall Core and Hall Web on their configured ports, waits for both to become ready, opens the
default browser, and keeps both processes managed together until stopped.

Hall Core is spawned with **zero CLI flags** — `apps/server/src/server.ts` already calls
`tryLoadConfig()` unconditionally on every startup, so the launcher's only responsibility toward
Hall Core's configuration is confirming a valid persisted config exists, never passing its fields
through.

Hall Core is stopped via the existing stdin `SHUTDOWN` protocol
(`apps/server/src/process/signal-shutdown.ts`), reused verbatim — Windows cannot deliver a real
SIGINT/SIGTERM from a parent Node process to a child Node process, and this codebase already solved
that once. Hall Web (and Hall Core as a forced fallback) is stopped via `taskkill /T /F`, which
kills the full process tree rather than just the top process, since `next start` can spawn its own
worker processes a plain `Stop-Process` would never reach.

**Hall Web build freshness.** `NEXT_PUBLIC_HALL_CORE_URL` is inlined into Hall Web's client bundle
at `next build` time — it is not a runtime flag. The launcher never writes `.env.local`; it passes
the value directly in the environment of the spawned build (and `next start`) process. Because
nothing else records what URL a given `.next` build was actually made with, the launcher writes its
own marker file, `apps/web/.next/hall-launcher-build-marker.json`, immediately after a build it ran
completes successfully, and treats a missing or mismatched marker as proof a rebuild is needed
before starting Hall Web. The very first `.\start.ps1` run after `.\install.ps1` always triggers one
rebuild for this reason, even on the common default-port path — an unmarked `.next` build carries no
evidence of what it was built with, so trusting it unmarked would be unsound.

`scripts/install/HallConfigCli.ps1`'s `-ConfigPath` parameter became optional (previously
mandatory) so `start.ps1` can call `Invoke-HallConfigStatus` with no explicit path, letting
`packages/hall-config`'s own `resolveHallConfigFilePath()` resolve it — the identical function
`server.ts`'s `tryLoadConfig()` uses. `install.ps1` continues to pass `-ConfigPath` explicitly
(required there because it must run before any build exists) and is unaffected.

## Consequences

- A user who has run `install.ps1` once can start Hall with exactly one command.
- No new server-side flags, routes, or config fields were introduced — `start.ps1` only ever spawns
  existing built artifacts with the argument/environment shapes described above.
- The `.next` build marker is launcher-owned, gitignored (inside `.next`), and never treated as
  persisted Hall configuration — `config.json` is never written by `start.ps1`.
- A future macOS/Linux launcher can reuse `@hall-of-wisdom/hall-config` and the stdin shutdown
  protocol unchanged; only the process-spawning/Ctrl+C driver (`start.ps1`) is Windows-specific.
```

- [ ] **Step 2: Add the ADR to README's architecture list**

In `README.md`, add one line after the `0018` entry:
```markdown
- [`docs/architecture/0019-one-command-hall-launcher.md`](docs/architecture/0019-one-command-hall-launcher.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/0019-one-command-hall-launcher.md README.md
git commit -m "docs: add ADR 0019 for the one-command Hall launcher"
```

---

### Task 9: Full workspace verification, whole-branch review, push, completion report

**Files:** none created; runs the repository's quality gates end to end. Per CLAUDE.md, final
verification and the completion report are the main session's own responsibility — executed
directly, not dispatched.

- [ ] **Step 1: Run the full PowerShell test suites, both hosts**

```bash
pwsh -NoProfile -File scripts/install/tests/run-tests.ps1
powershell -NoProfile -File scripts/install/tests/run-tests.ps1
pwsh -NoProfile -File scripts/launch/tests/run-tests.ps1
powershell -NoProfile -File scripts/launch/tests/run-tests.ps1
pwsh -NoProfile -File scripts/launch/tests/end-to-end-smoke-test.ps1
```

- [ ] **Step 2: Run the Node/TS workspace gates**

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm verify:package-entry
git diff --check
```

(This phase adds no TypeScript, so these gates are a regression check, not new coverage — they must
still all pass, confirming Task 1's `HallConfigCli.ps1` change and any other edit didn't disturb
anything.)

- [ ] **Step 3: Manual real-world smoke check**

Run `.\start.ps1` for real against a real persisted config (default ports), confirm the browser
opens to `/`, confirm Ctrl+C in the terminal stops both processes cleanly (checked via `Get-Process
node` afterward). Then, if feasible, reconfigure to a non-default `hallCorePort`/`hallWebPort` (via
`hall-config`'s CLI directly, or hand-editing `config.json`) and confirm `start.ps1` rebuilds Hall
Web once and serves correctly on the new ports.

- [ ] **Step 4: Security self-review**

Confirm: no `Invoke-Expression` anywhere in `scripts/launch/*.ps1` or `start.ps1`; every native
command's arguments are structured (array/`ConvertTo-HallProcessArgumentString`), never
string-concatenated with untrusted input; `config.json` is never written by any file this phase
touches (`git diff --stat main...HEAD` should show no changes near `saveConfig`/`config-store.ts`);
no credential/secret handling anywhere (this phase has none by construction — no provider code
touched); `taskkill` is always invoked with an explicit `-PID` from a `System.Diagnostics.Process`
this script itself started, never a user-supplied or externally-discovered PID.

- [ ] **Step 5: Dispatch the final whole-branch review**

Per `superpowers:subagent-driven-development`'s Final Review step: generate the review package
(`git diff` from `main` merge-base to `HEAD`) and dispatch on the most capable available model,
using `superpowers:requesting-code-review`'s `code-reviewer.md` template. Fix any Critical/Important
findings in one consolidated pass, re-verify with a scoped re-review, and adjudicate any residuals
per that skill's breaker process.

- [ ] **Step 6: Push**

```bash
git status
git diff --stat main...HEAD
git push -u origin phase-17-3-one-command-launcher
```

Do not run `gh pr create` — no PR per this phase's kickoff.

- [ ] **Step 7: Write the phase completion report**

Per `AGENTS.md`'s required format: Phase Completed, What Was Implemented, Files Created or Changed,
Commands Executed, Test Results, Security and Bug Review, How to Verify, Expected Output, Git
Status, Next Proposed Phase, `STOPPED`. Explicitly confirm Phase 17.4 was not started.
