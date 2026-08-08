<#
.SYNOPSIS
    Hall of Wisdom interactive setup - installs dependencies, builds Hall,
    collects and persists configuration, and verifies the installation.
.DESCRIPTION
    See docs/architecture/0017-persistent-hall-configuration.md. Locates
    the repository via $PSScriptRoot, never the caller's working directory.
#>
[CmdletBinding()]
param(
    [string]$WorkspaceRoot,
    [string]$DataDir,
    [string]$AgentWorktreeRoot,
    [string]$ComparisonRoot,
    [switch]$EnableCodexTrustedLocal,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot

. (Join-Path $RepoRoot "scripts/install/Prerequisites.ps1")
. (Join-Path $RepoRoot "scripts/install/HallConfigDefaults.ps1")
. (Join-Path $RepoRoot "scripts/install/HallConfigCli.ps1")
. (Join-Path $RepoRoot "scripts/install/Verification.ps1")
. (Join-Path $RepoRoot "scripts/install/Reconfigure.ps1")

function Get-HallInstallerConfigPath {
    # Deliberately mirrors packages/hall-config/src/config-path.ts's
    # win32 branch exactly (%LOCALAPPDATA%\HallOfWisdom\config.json) - a
    # narrow, unavoidable duplication: existing-config detection must run
    # BEFORE the first build (so the reinstall/reconfigure prompt appears
    # before "Installing Hall..."), but the hall-config CLI only exists
    # after `pnpm --filter @hall-of-wisdom/hall-config run build`. If
    # config-path.ts's win32 logic ever changes, this literal must change
    # with it.
    param([string]$LocalAppData = $env:LOCALAPPDATA)
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
        throw "LOCALAPPDATA is not set; cannot locate the Hall configuration file."
    }
    Join-Path (Join-Path $LocalAppData "HallOfWisdom") "config.json"
}

function Write-HallBanner {
    Write-Host ""
    Write-Host "Hall of Wisdom Setup" -ForegroundColor Cyan
    Write-Host "----------------------------------------"
    Write-Host ""
}

function Test-HallPrerequisitesOrExit {
    param([Parameter(Mandatory)][string]$RepoRoot)
    Write-Host "Checking your system..."
    $versions = Get-HallRequiredVersions -RepoRoot $RepoRoot
    $checks = @(
        @{ Name = "Git"; Result = Test-HallGitPrerequisite }
        @{ Name = "Node.js"; Result = (Test-HallNodePrerequisite -RequiredRange $versions.NodeRange) }
        @{ Name = "pnpm"; Result = (Test-HallPnpmPrerequisite -RequiredVersion $versions.PnpmVersion) }
        @{ Name = "Hall repository"; Result = (Test-HallRepositoryIntegrity -RepoRoot $RepoRoot) }
    )
    $failed = $false
    foreach ($check in $checks) {
        if ($check.Result.Ok) {
            Write-Host "  [OK] $($check.Name) ($($check.Result.Message))" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] $($check.Name): $($check.Result.Message)" -ForegroundColor Red
            $failed = $true
        }
    }
    Write-Host ""
    if ($failed) {
        Write-Host "One or more prerequisites are missing. Install/upgrade the tools reported above, then run .\install.ps1 again." -ForegroundColor Red
        exit 1
    }
}

function Read-HallAnswer {
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$Default,
        [string]$BoundValue,
        [switch]$NonInteractive
    )
    if ($BoundValue) { return $BoundValue }
    if ($NonInteractive) { return $Default }
    $response = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($response)) { return $Default }
    return $response
}

function Get-HallAnswers {
    param(
        [string]$BoundWorkspaceRoot,
        [string]$BoundDataDir,
        [string]$BoundAgentWorktreeRoot,
        [string]$BoundComparisonRoot,
        [bool]$BoundEnableCodexTrustedLocal,
        [switch]$NonInteractive,
        [PSCustomObject]$ExistingConfig
    )
    $defaults = Get-HallDefaultPaths

    $defaultWorkspaceRoot = if ($ExistingConfig) { $ExistingConfig.workspaceRoot } else { (Get-Location).Path }
    $workspaceRoot = Read-HallAnswer -Prompt "Projects/workspace folder" -Default $defaultWorkspaceRoot -BoundValue $BoundWorkspaceRoot -NonInteractive:$NonInteractive

    $defaultDataDir = if ($ExistingConfig -and $ExistingConfig.dataDir) { $ExistingConfig.dataDir } else { $defaults.DataDir }
    $dataDir = Read-HallAnswer -Prompt "Hall data location" -Default $defaultDataDir -BoundValue $BoundDataDir -NonInteractive:$NonInteractive

    $defaultAgentWorktreeRoot = if ($ExistingConfig -and $ExistingConfig.agentWorktreeRoot) { $ExistingConfig.agentWorktreeRoot } else { $defaults.AgentWorktreeRoot }
    $agentWorktreeRoot = Read-HallAnswer -Prompt "Agent worktree location" -Default $defaultAgentWorktreeRoot -BoundValue $BoundAgentWorktreeRoot -NonInteractive:$NonInteractive

    $defaultComparisonRoot = if ($ExistingConfig -and $ExistingConfig.comparisonRoot) { $ExistingConfig.comparisonRoot } else { $defaults.ComparisonRoot }
    $comparisonRoot = if ($BoundComparisonRoot) { $BoundComparisonRoot } else { $defaultComparisonRoot }

    $enableCodexTrustedLocal = $BoundEnableCodexTrustedLocal
    if (-not $NonInteractive -and -not $BoundEnableCodexTrustedLocal) {
        $codexResponse = Read-Host "Enable Codex trusted-local execution? [No, recommended] (y/N)"
        $enableCodexTrustedLocal = ($codexResponse -match '^(y|yes)$')
    }

    [PSCustomObject]@{
        schemaVersion     = 1
        workspaceRoot     = $workspaceRoot
        dataDir           = $dataDir
        agentWorktreeRoot = $agentWorktreeRoot
        comparisonRoot    = $comparisonRoot
        hallCorePort      = 4310
        hallWebPort       = 3000
        codexTrustedLocal = [bool]$enableCodexTrustedLocal
    }
}

function Install-HallDependenciesAndConfig {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)]$Answers)
    Write-Host "Installing Hall..."
    Push-Location $RepoRoot
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit code $LASTEXITCODE)." }
        Write-Host "  [OK] Dependencies installed" -ForegroundColor Green

        & pnpm --filter "@hall-of-wisdom/hall-config" run build
        if ($LASTEXITCODE -ne 0) { throw "Building @hall-of-wisdom/hall-config failed (exit code $LASTEXITCODE)." }

        $saved = Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath $ConfigPath -Candidate $Answers
        if ($saved.ExitCode -ne 0) { throw "Saving Hall configuration failed: $($saved.Result.errors -join '; ')" }
        Write-Host "  [OK] Configuration saved ($ConfigPath)" -ForegroundColor Green

        & pnpm typecheck
        if ($LASTEXITCODE -ne 0) { throw "pnpm typecheck failed (exit code $LASTEXITCODE) - this is a blocking installation failure." }

        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit code $LASTEXITCODE) - this is a blocking installation failure." }
        Write-Host "  [OK] Hall Core built" -ForegroundColor Green
        Write-Host "  [OK] Hall Web built" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

function Invoke-HallInstallVerification {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)]$Answers)
    # -HallWebPort must be passed explicitly: Invoke-HallVerifyOnly isolates
    # the spawned process from the active persisted config (HALL_CONFIG_DIR
    # override), so any field not passed here - including hallWebPort - would
    # silently fall back to Hall Core's own built-in default instead of being
    # verified against the candidate's actual value.
    $verify = Invoke-HallVerifyOnly -RepoRoot $RepoRoot -WorkspaceRoot $Answers.workspaceRoot -DataDir $Answers.dataDir `
        -AgentWorktreeRoot $Answers.agentWorktreeRoot -ComparisonRoot $Answers.comparisonRoot -Port $Answers.hallCorePort `
        -HallWebPort $Answers.hallWebPort -EnableCodexTrustedLocal:([bool]$Answers.codexTrustedLocal)
    if (-not $verify.Success) {
        Write-Host "  [FAIL] Installation verification failed:" -ForegroundColor Red
        Write-Host $verify.Output -ForegroundColor Red
        exit 1
    }
    Write-Host "  [OK] Installation verified" -ForegroundColor Green
}

function Invoke-HallDiagnostics {
    param([Parameter(Mandatory)][string]$RepoRoot)
    Write-Host ""
    Write-Host "Running diagnostics (lint/test - not blocking)..."
    Push-Location $RepoRoot
    try {
        & pnpm lint
        if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] pnpm lint reported issues (non-blocking)." -ForegroundColor Yellow } else { Write-Host "  [OK] pnpm lint" -ForegroundColor Green }
        & pnpm test
        if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] pnpm test reported failures (non-blocking)." -ForegroundColor Yellow } else { Write-Host "  [OK] pnpm test" -ForegroundColor Green }
    } finally {
        Pop-Location
    }
}

function Invoke-HallInstaller {
    param([Parameter(Mandatory)][string]$RepoRoot)

    Write-HallBanner
    Test-HallPrerequisitesOrExit -RepoRoot $RepoRoot

    $configPath = Get-HallInstallerConfigPath
    $existing = $null
    if (Test-Path -LiteralPath $configPath) {
        try {
            $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        } catch {
            Write-Host "An existing Hall configuration was found at '$configPath' but could not be read: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Refusing to guess - fix or remove that file manually, then run .\install.ps1 again." -ForegroundColor Red
            exit 1
        }
    }

    $mode = "install"
    if ($existing -and -not $NonInteractive) {
        Write-Host "Existing Hall configuration found."
        Write-Host "  1. Keep current configuration and verify/repair installation"
        Write-Host "  2. Reconfigure Hall"
        Write-Host "  3. Cancel"
        $choice = Read-Host "Choose an option [1]"
        switch ($choice) {
            "2" { $mode = "reconfigure" }
            "3" { Write-Host "Cancelled."; exit 0 }
            default { $mode = "keep" }
        }
    } elseif ($existing -and $NonInteractive) {
        $mode = "reconfigure"
    }

    if ($mode -eq "keep") {
        Install-HallDependenciesAndConfig -RepoRoot $RepoRoot -ConfigPath $configPath -Answers $existing
        Invoke-HallInstallVerification -RepoRoot $RepoRoot -Answers $existing
        Invoke-HallDiagnostics -RepoRoot $RepoRoot
        Write-Host ""; Write-Host "Hall of Wisdom is ready." -ForegroundColor Cyan
        return
    }

    $answers = Get-HallAnswers -BoundWorkspaceRoot $WorkspaceRoot -BoundDataDir $DataDir -BoundAgentWorktreeRoot $AgentWorktreeRoot `
        -BoundComparisonRoot $ComparisonRoot -BoundEnableCodexTrustedLocal ([bool]$EnableCodexTrustedLocal) -NonInteractive:$NonInteractive -ExistingConfig $existing

    if ($mode -eq "reconfigure") {
        Push-Location $RepoRoot
        try {
            & pnpm install
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit code $LASTEXITCODE)." }
            & pnpm build
            if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit code $LASTEXITCODE) - cannot verify a reconfiguration candidate without a build." }
        } finally {
            Pop-Location
        }
        $result = Invoke-HallReconfigure -RepoRoot $RepoRoot -ConfigPath $configPath -Candidate $answers
        if (-not $result.Success) {
            Write-Host "Reconfiguration failed at stage '$($result.Stage)':" -ForegroundColor Red
            $result.Errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            Write-Host "The previous configuration at '$configPath' was left untouched." -ForegroundColor Yellow
            exit 1
        }
        Write-Host "  [OK] Configuration reconfigured and verified" -ForegroundColor Green
        Invoke-HallDiagnostics -RepoRoot $RepoRoot
        Write-Host ""; Write-Host "Hall of Wisdom is ready." -ForegroundColor Cyan
        return
    }

    Install-HallDependenciesAndConfig -RepoRoot $RepoRoot -ConfigPath $configPath -Answers $answers
    Invoke-HallInstallVerification -RepoRoot $RepoRoot -Answers $answers
    Invoke-HallDiagnostics -RepoRoot $RepoRoot
    Write-Host ""; Write-Host "Hall of Wisdom is ready." -ForegroundColor Cyan
}

# Guard so this file can be dot-sourced (for testing the pure helper
# functions above, or by run-tests.ps1's fixtures) without immediately
# running the full interactive installer.
if (-not $env:HALL_INSTALL_PS1_UNDER_TEST) {
    Invoke-HallInstaller -RepoRoot $RepoRoot
}
