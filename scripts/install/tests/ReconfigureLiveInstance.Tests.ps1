<#
.SYNOPSIS
    Verify-before-promote must fail closed when a LIVE Hall Core instance
    holds the candidate's data directory.
.DESCRIPTION
    Uses the REAL binaries (apps/server/dist/server.js and
    packages/hall-config/dist/cli.js), not the fake fixtures
    Reconfigure.Tests.ps1 uses - the whole point is the real
    InstanceOwnershipConflictError path inside run-verify-only.ts, which no
    fake can produce.

    A live instance holding the data directory makes --verify-only skip the
    durable storage/fingerprint checks (correct and deliberate: it must
    never fence out a running instance). Before the
    EXIT_VERIFICATION_INCOMPLETE fix, that skip returned exit 0, which is
    indistinguishable from full success - so Invoke-HallReconfigure
    promoted a candidate whose compatibility with the already-recorded
    fingerprint had never been checked, overwriting the active config.json
    of a running Hall.

    This test starts a real durable Hall Core against <shared>, then asks
    Invoke-HallReconfigure to promote a candidate pointing at a DIFFERENT
    workspace/worktree root but the SAME <shared> data dir, and asserts the
    candidate is rejected and the active config.json is byte-for-byte
    untouched.

    Cheap enough for the fast run-tests.ps1 suite (it builds nothing; it
    only starts an already-built server for a few seconds), so it lives
    here rather than alongside end-to-end-smoke-test.ps1, with the same
    graceful "dist not built" skip HallConfigStdinEncoding.Tests.ps1 uses.
#>
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "HallConfigCli.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Verification.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Reconfigure.ps1")

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$serverDist = Join-Path $repoRoot "apps/server/dist/server.js"
$configCli = Join-Path $repoRoot "packages/hall-config/dist/cli.js"
if (-not (Test-Path -LiteralPath $serverDist) -or -not (Test-Path -LiteralPath $configCli)) {
    Write-Host "  (ReconfigureLiveInstance.Tests.ps1: SKIPPED - the real dist/ binaries are not built."
    Write-Host "   Run 'pnpm build' to enable this test.)" -ForegroundColor Yellow
    return
}

function Get-HallFreeTcpPort {
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $listener.Start()
    try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-live-reconfigure-$([guid]::NewGuid())"
$workspaceA = Join-Path $tempRoot "workspace-a"
$workspaceB = Join-Path $tempRoot "workspace-b"
$sharedDataDir = Join-Path $tempRoot "shared-data"
$worktreeA = Join-Path $tempRoot "worktrees-a"
$worktreeB = Join-Path $tempRoot "worktrees-b"
$configDir = Join-Path $tempRoot "hall-config"
# Isolates the live server we spawn below from the machine's real active
# config: apps/server/src/server.ts calls tryLoadConfig() for any field not
# passed as an explicit flag, and an inherited comparisonRoot would be
# baked into the fingerprint this instance records.
$isolatedServerConfigDir = Join-Path $tempRoot "isolated-server-config"
# validateWorkspace requires the workspace directories to already exist;
# dataDir and agentWorktreeRoot are created by the server itself.
New-Item -ItemType Directory -Path $workspaceA, $workspaceB, $configDir, $isolatedServerConfigDir -Force | Out-Null

$configPath = Join-Path $configDir "config.json"
$liveProcess = $null
$previousHallConfigDir = $env:HALL_CONFIG_DIR
try {
    $port = Get-HallFreeTcpPort

    $env:HALL_CONFIG_DIR = $isolatedServerConfigDir
    $liveArgs = @(
        $serverDist,
        "--workspace-root", $workspaceA,
        "--data-dir", $sharedDataDir,
        "--agent-worktree-root", $worktreeA,
        "--mock-scenario", "success",
        "--port", $port
    )
    # Start-Process joins -ArgumentList with spaces and does NOT quote,
    # so every element must be quoted here or a temp path containing a
    # space (e.g. under "C:\Users\Mohammed Shafiq\") splits into
    # positional arguments the server rejects. None of these values can
    # end in a backslash, so a trailing-backslash escape is not a concern.
    $quotedLiveArgs = @($liveArgs | ForEach-Object { '"' + $_ + '"' })
    $liveProcess = Start-Process -FilePath "node" -ArgumentList $quotedLiveArgs -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $tempRoot "live-stdout.log") `
        -RedirectStandardError (Join-Path $tempRoot "live-stderr.log")
    $env:HALL_CONFIG_DIR = $previousHallConfigDir

    # Wait until the live instance genuinely holds the data directory's
    # ownership lock - a test that raced ahead of startup would exercise
    # the ordinary fresh-data-dir path and prove nothing.
    $healthUrl = "http://127.0.0.1:$port/api/v1/health"
    $deadline = (Get-Date).AddSeconds(60)
    $live = $false
    while (-not $live -and (Get-Date) -lt $deadline) {
        if ($liveProcess.HasExited) {
            throw "the live Hall Core process exited early (code $($liveProcess.ExitCode)): $(Get-Content -LiteralPath (Join-Path $tempRoot 'live-stderr.log') -Raw -ErrorAction SilentlyContinue)"
        }
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -eq 200) { $live = $true }
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    Assert-True $live "the real Hall Core instance must come up and hold '$sharedDataDir' before this test means anything"

    # The currently active configuration, matching the live instance.
    # -Encoding ascii deliberately: every path here is ASCII, and Windows
    # PowerShell 5.1's Set-Content -Encoding utf8 writes a BOM that would
    # make the byte-for-byte comparison below depend on the host.
    $activeConfig = [PSCustomObject]@{
        schemaVersion     = 1
        workspaceRoot     = $workspaceA
        dataDir           = $sharedDataDir
        agentWorktreeRoot = $worktreeA
        comparisonRoot    = $null
        hallCorePort      = $port
        hallWebPort       = 3000
        codexTrustedLocal = $false
    }
    Set-Content -LiteralPath $configPath -Value ($activeConfig | ConvertTo-Json -Depth 10) -Encoding ascii
    $originalContent = Get-Content -LiteralPath $configPath -Raw

    # An INCOMPATIBLE candidate: different workspace/worktree roots, same
    # data directory. Its compatibility with the fingerprint already
    # recorded in <shared> cannot be checked while the live instance holds
    # the lock, so it must never be promoted.
    $candidate = [PSCustomObject]@{
        schemaVersion     = 1
        workspaceRoot     = $workspaceB
        dataDir           = $sharedDataDir
        agentWorktreeRoot = $worktreeB
        comparisonRoot    = $null
        hallCorePort      = $port
        hallWebPort       = 3000
        codexTrustedLocal = $false
    }
    $result = Invoke-HallReconfigure -RepoRoot $repoRoot -ConfigPath $configPath -Candidate $candidate

    Assert-False $result.Success "a candidate whose durable compatibility could not be verified (live instance holds the data dir) must never be promoted"
    Assert-Equal "verify-only" $result.Stage "the failure stage must be reported as verify-only"
    $errorText = ($result.Errors -join " ")
    Assert-True ($errorText -like "*currently running against this data directory*") "the operator must be told a live Hall Core instance is holding the data directory (got: '$errorText')"
    Assert-True ($errorText -like "*Stop Hall Core*") "the operator must be told to stop Hall Core and retry (got: '$errorText')"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config.json must be byte-for-byte untouched - the candidate must not have been promoted"

    # Sanity check on the wrapper's own reporting, straight from the real
    # binary: exit 5 / Success false / Incomplete true.
    $verify = Invoke-HallVerifyOnly -RepoRoot $repoRoot -WorkspaceRoot $workspaceB -DataDir $sharedDataDir `
        -AgentWorktreeRoot $worktreeB -Port $port -HallWebPort 3000
    Assert-Equal 5 $verify.ExitCode "the real --verify-only must report EXIT_VERIFICATION_INCOMPLETE (5), never 0, when a live instance holds the data dir"
    Assert-False $verify.Success "an incomplete verification must not be reported as success"
    Assert-True $verify.Incomplete "Invoke-HallVerifyOnly must surface exit 5 as Incomplete"
} finally {
    $env:HALL_CONFIG_DIR = $previousHallConfigDir
    if ($liveProcess -and -not $liveProcess.HasExited) {
        Stop-Process -Id $liveProcess.Id -Force -ErrorAction SilentlyContinue
        # Wait for the handle on the SQLite file to actually be released,
        # or Remove-Item below fails and leaks the temp tree.
        $liveProcess.WaitForExit(15000) | Out-Null
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "  (ReconfigureLiveInstance.Tests.ps1: all assertions passed)"
