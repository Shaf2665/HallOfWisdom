<#
.SYNOPSIS
    Phase 17 release verification: the complete real user flow, chained,
    against fully disposable configuration.
.DESCRIPTION
    Run explicitly: pwsh -NoProfile -File scripts/launch/tests/phase-17-release-verification.ps1

    Deliberately NOT named *.Tests.ps1 - run-tests.ps1 only picks up that
    pattern for its fast fixture-based loop; this script runs the real
    install.ps1 -NonInteractive pipeline (pnpm install/typecheck/build) and
    then a real start.ps1, genuinely minutes end to end.

    Proves what neither existing smoke test proves alone: that a config
    install.ps1 ACTUALLY WROTE is what start.ps1 ACTUALLY CONSUMES (the
    ports are deliberately pinned to non-default values immediately after
    install.ps1 writes the file, since install.ps1 itself exposes no port
    parameter to request non-default ones directly - everything else in
    the file is exactly what install.ps1 persisted, unmodified), all the
    way through to a browser-reachable Hall Web and its Providers page,
    then a clean, orphan-free shutdown. install.ps1's own dual-host
    correctness is already proven by scripts/install/tests/end-to-end-smoke-test.ps1
    (which itself runs a second pass under a different host); start.ps1's
    own dual-host Ctrl+Break/cleanup correctness is already proven by
    scripts/launch/tests/end-to-end-smoke-test.ps1. This script's only new
    surface is the install-to-launch handoff and the Providers page - not
    a reason to re-run install.ps1's own multi-minute pnpm build under a
    second host here too. Runs under pwsh only; Windows PowerShell 5.1's
    `Set-Content -Encoding utf8` writes a BOM that hall-config's JSON.parse
    would reject, so this script's own config-mutation step deliberately
    uses .NET's BOM-free UTF8 encoding instead (see below) - but the
    script as a whole is not part of this project's dual-host PowerShell
    test matrix.

    Isolation: a fake LOCALAPPDATA and an explicit HALL_CONFIG_DIR override
    (checked first by both install.ps1 and hall-config), matching
    scripts/install/tests/end-to-end-smoke-test.ps1's own isolation - the
    real user profile's Hall configuration is never read or written.

    Note: this leaves apps/web/.next rebuilt for the non-default port this
    script uses, so your next real .\start.ps1 will rebuild once more for
    your own configured port - that's the marker mechanism (ADR 0019)
    self-healing exactly as designed, not a defect.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot "ConsoleSignalHelper.ps1")

function Wait-HallReleaseVerificationReady {
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSeconds = 90)
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

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-phase17-release-verification-$([guid]::NewGuid())"
$fakeLocalAppData = Join-Path $tempRoot "LocalAppData"
$fakeHallConfigDir = Join-Path (Join-Path $fakeLocalAppData "HallOfWisdom") "config-dir-override"
$workspaceRoot = Join-Path $tempRoot "workspace"
$dataDir = Join-Path $tempRoot "data"
$agentWorktreeRoot = Join-Path $tempRoot "agent-worktrees"
$comparisonRoot = Join-Path $tempRoot "comparisons"
New-Item -ItemType Directory -Path $fakeLocalAppData, $workspaceRoot, $comparisonRoot -Force | Out-Null

$corePort = 41310
$webPort = 41300

$originalLocalAppData = $env:LOCALAPPDATA
$originalHallConfigDir = $env:HALL_CONFIG_DIR
$launcherPid = $null
try {
    $env:LOCALAPPDATA = $fakeLocalAppData
    $env:HALL_CONFIG_DIR = $fakeHallConfigDir

    Write-Host "--- Step 1/5: install.ps1 -NonInteractive (real pnpm install/build, produces a real persisted config) ---"
    $installPs1 = Join-Path $RepoRoot "install.ps1"
    & pwsh -NoProfile -File $installPs1 `
        -WorkspaceRoot $workspaceRoot `
        -DataDir $dataDir `
        -AgentWorktreeRoot $agentWorktreeRoot `
        -ComparisonRoot $comparisonRoot `
        -NonInteractive
    if ($LASTEXITCODE -ne 0) {
        throw "install.ps1 -NonInteractive exited $LASTEXITCODE"
    }

    $configPath = Join-Path $fakeHallConfigDir "config.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "Expected config file was not written at '$configPath'."
    }
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.workspaceRoot -ne $workspaceRoot) {
        throw "Persisted workspaceRoot '$($config.workspaceRoot)' does not match the requested '$workspaceRoot'."
    }
    Write-Host "  [OK] install.ps1 produced a real persisted config at '$configPath'"

    # Pin non-default ports directly into the config install.ps1 just wrote
    # - proves start.ps1 genuinely reads THIS file's ports, not a built-in
    # default that would coincidentally match.
    $config | Add-Member -NotePropertyName hallCorePort -NotePropertyValue $corePort -Force
    $config | Add-Member -NotePropertyName hallWebPort -NotePropertyValue $webPort -Force
    # .NET's UTF8Encoding($false) writes no BOM - Set-Content -Encoding utf8
    # would (on Windows PowerShell 5.1; pwsh's does not), and hall-config's
    # JSON.parse rejects a leading BOM (see packages/hall-config/src/config-store.ts).
    # This script only ever runs under pwsh (see the header comment), so this
    # is defensive rather than load-bearing today.
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8NoBom)

    Write-Host "--- Step 2/5: start.ps1, consuming that exact config, in its own process group (for a later real Ctrl+Break) ---"
    $startPs1 = Join-Path $RepoRoot "start.ps1"
    $launcherPid = Start-HallTestProcessGroup -ExePath (Get-Command pwsh).Source -Arguments "-NoProfile -File `"$startPs1`"" -WorkingDirectory $RepoRoot

    Write-Host "--- Step 3/5: Hall Core + Hall Web + Providers page all become ready ---"
    Wait-HallReleaseVerificationReady -Url "http://127.0.0.1:$corePort/api/v1/health" -TimeoutSeconds 60
    Write-Host "  [OK] Hall Core is healthy on port $corePort (from the persisted config, zero CLI flags)"
    Wait-HallReleaseVerificationReady -Url "http://127.0.0.1:$webPort/" -TimeoutSeconds 90
    Write-Host "  [OK] Hall Web is ready on port $webPort"
    Wait-HallReleaseVerificationReady -Url "http://127.0.0.1:$webPort/providers" -TimeoutSeconds 30
    Write-Host "  [OK] the Providers page is reachable at http://127.0.0.1:$webPort/providers"

    Write-Host "--- Step 4/5: clean shutdown via a real Ctrl+Break ---"
    Send-HallTestCtrlBreak -ProcessGroupId $launcherPid
    $deadline = (Get-Date).AddSeconds(30)
    $childProcess = Get-Process -Id $launcherPid -ErrorAction SilentlyContinue
    while ($childProcess -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $childProcess = Get-Process -Id $launcherPid -ErrorAction SilentlyContinue
    }
    if ($childProcess) { throw "start.ps1 (PID $launcherPid) did not exit within 30s of receiving Ctrl+Break." }
    $launcherPid = $null

    Write-Host "--- Step 5/5: confirming no orphaned Hall Core/Hall Web process remains ---"
    Start-Sleep -Seconds 1
    foreach ($port in @($corePort, $webPort)) {
        $client = New-Object System.Net.Sockets.TcpClient
        $stillOpen = $false
        try {
            $connectTask = $client.ConnectAsync("127.0.0.1", $port)
            try { $connectTask.Wait(500) | Out-Null; $stillOpen = $client.Connected } catch { $stillOpen = $false }
        } finally { $client.Close() }
        if ($stillOpen) { throw "Port $port is still accepting connections after shutdown - an orphan process was left running." }
    }
    Write-Host "  [OK] no orphaned process remains on either port"

    Write-Host ""
    Write-Host "Phase 17 release verification PASSED: install -> persisted config -> launcher -> Core/Web ready -> Providers page -> clean shutdown." -ForegroundColor Green
} finally {
    if ($launcherPid) {
        $stray = Get-Process -Id $launcherPid -ErrorAction SilentlyContinue
        if ($stray) { & taskkill /PID $launcherPid /T /F 2>&1 | Out-Null }
    }
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:HALL_CONFIG_DIR = $originalHallConfigDir
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
