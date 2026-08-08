<#
.SYNOPSIS
    End-to-end smoke test for install.ps1 -NonInteractive, run against
    fully disposable directories (including a fake LOCALAPPDATA, so the
    real user profile's Hall configuration is never touched).
.DESCRIPTION
    Run explicitly: pwsh -NoProfile -File scripts/install/tests/end-to-end-smoke-test.ps1

    Deliberately NOT named *.Tests.ps1 - run-tests.ps1 only picks up that
    pattern for its fast unit-test loop, and this script runs the real
    pnpm install/build/lint/test pipeline (genuinely slow). It is the
    concrete "manual installer verification" Phase 17.1's completion
    criteria requires, invoked explicitly.

    Isolation note: install.ps1's Get-HallInstallerConfigPath checks
    $env:HALL_CONFIG_DIR BEFORE %LOCALAPPDATA%. Overriding only
    LOCALAPPDATA would not be sufficient isolation if HALL_CONFIG_DIR
    happens to be set in the ambient environment - so this script also
    pins HALL_CONFIG_DIR to a disposable path alongside the fake
    LOCALAPPDATA, regardless of what the ambient environment has.
#>
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$installPs1 = Join-Path $repoRoot "install.ps1"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-e2e-smoke-$([guid]::NewGuid())"
$fakeLocalAppData = Join-Path $tempRoot "LocalAppData"
$fakeHallConfigDir = Join-Path (Join-Path $fakeLocalAppData "HallOfWisdom") "config-dir-override"
$workspaceRoot = Join-Path $tempRoot "workspace"
$dataDir = Join-Path $tempRoot "data"
$agentWorktreeRoot = Join-Path $tempRoot "agent-worktrees"
$comparisonRoot = Join-Path $tempRoot "comparisons"
# workspaceRoot and comparisonRoot both go through the server's
# validateWorkspace (apps/server/src/server.ts), which requires the
# directory to already exist - unlike dataDir and agentWorktreeRoot, which
# are auto-created via fs.mkdirSync(..., { recursive: true }) in
# persistence/database-config.ts and agent-worktrees/path-safety.ts
# respectively. Pre-create only the two that actually require it.
New-Item -ItemType Directory -Path $fakeLocalAppData, $workspaceRoot, $comparisonRoot -Force | Out-Null

$originalLocalAppData = $env:LOCALAPPDATA
$originalHallConfigDir = $env:HALL_CONFIG_DIR
try {
    $env:LOCALAPPDATA = $fakeLocalAppData
    # Pin HALL_CONFIG_DIR to a disposable path under the same fake temp
    # root, so isolation is genuinely complete even if HALL_CONFIG_DIR
    # happens to be set to something real in the ambient environment -
    # install.ps1's Get-HallInstallerConfigPath (and hall-config's
    # resolveHallConfigDir, which the running server also honors) check
    # HALL_CONFIG_DIR before LOCALAPPDATA.
    $env:HALL_CONFIG_DIR = $fakeHallConfigDir

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
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.workspaceRoot -ne $workspaceRoot) {
        throw "Persisted workspaceRoot '$($config.workspaceRoot)' does not match the requested '$workspaceRoot'."
    }
    if ($config.comparisonRoot -ne $comparisonRoot) {
        throw "Persisted comparisonRoot was not saved as the requested value (Correction 2)."
    }

    # The actual completion criterion: Hall Core now starts with ZERO
    # flags, reading everything from the just-saved persisted config.
    # Start-Process inherits the current process environment (including
    # the LOCALAPPDATA/HALL_CONFIG_DIR overrides set above), so the
    # spawned node process resolves the config through the same fake
    # location install.ps1 just wrote to.
    $serverDist = Join-Path $repoRoot "apps/server/dist/server.js"
    $proc = Start-Process -FilePath "node" -ArgumentList @($serverDist, "--verify-only") -NoNewWindow -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        throw "node dist/server.js --verify-only (zero flags) exited $($proc.ExitCode) - Hall Core did not start cleanly from persisted config alone."
    }

    # Re-running install.ps1 -NonInteractive against the SAME fake
    # LOCALAPPDATA/HALL_CONFIG_DIR must take the reconfigure path and
    # succeed idempotently - never destroy the SQLite database it just
    # verified above.
    & pwsh -NoProfile -File $installPs1 `
        -WorkspaceRoot $workspaceRoot `
        -DataDir $dataDir `
        -AgentWorktreeRoot $agentWorktreeRoot `
        -ComparisonRoot $comparisonRoot `
        -NonInteractive
    if ($LASTEXITCODE -ne 0) {
        throw "second install.ps1 -NonInteractive run (idempotent reconfigure) exited $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $dataDir "hall-core.db"))) {
        throw "SQLite database (hall-core.db, see apps/server/src/persistence/database.ts's DATABASE_FILE_NAME) appears to have been removed by a reconfigure run - this must never happen."
    }

    Write-Host "End-to-end install.ps1 smoke test PASSED." -ForegroundColor Green
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:HALL_CONFIG_DIR = $originalHallConfigDir
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
