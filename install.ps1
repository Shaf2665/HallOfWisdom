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

# Captured immediately after the param block, at script scope, so
# Get-HallAnswers can later tell "-EnableCodexTrustedLocal was explicitly
# passed on the command line" apart from "the switch's own default value
# happens to be $false" - the switch value alone cannot distinguish those
# two cases (see Get-HallAnswers's codexTrustedLocal handling below).
$HallEnableCodexTrustedLocalWasBound = $PSBoundParameters.ContainsKey('EnableCodexTrustedLocal')

. (Join-Path $RepoRoot "scripts/install/Prerequisites.ps1")
. (Join-Path $RepoRoot "scripts/install/HallConfigDefaults.ps1")
. (Join-Path $RepoRoot "scripts/install/HallConfigCli.ps1")
. (Join-Path $RepoRoot "scripts/install/Verification.ps1")
. (Join-Path $RepoRoot "scripts/install/Reconfigure.ps1")

function Get-HallInstallerConfigPath {
    # Mirrors packages/hall-config/src/config-path.ts's resolveHallConfigDir
    # for win32: the HALL_CONFIG_DIR override is checked FIRST (same
    # blank/whitespace handling as the TypeScript version - a blank value is
    # ignored, not treated as set), falling back to
    # %LOCALAPPDATA%\HallOfWisdom\config.json when it is unset/blank. One
    # deliberate divergence: if LOCALAPPDATA itself is also blank,
    # config-path.ts falls back further to
    # path.join(os.homedir(), "AppData", "Local"); this installer instead
    # throws, since silently guessing a homedir-derived path for an
    # installer writing a new config is worse than failing loudly. This is
    # a narrow, unavoidable duplication rather than a direct call into
    # config-path.ts: existing-config detection must run BEFORE the first
    # build (so the reinstall/reconfigure prompt appears before "Installing
    # Hall..."), but the hall-config CLI only exists after
    # `pnpm --filter @hall-of-wisdom/hall-config run build`. If
    # config-path.ts's logic ever changes, this must change with it.
    param(
        [string]$LocalAppData = $env:LOCALAPPDATA,
        [string]$ConfigDirOverride = $env:HALL_CONFIG_DIR
    )
    if (-not [string]::IsNullOrWhiteSpace($ConfigDirOverride)) {
        return Join-Path $ConfigDirOverride "config.json"
    }
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
        throw "LOCALAPPDATA is not set; cannot locate the Hall configuration file."
    }
    Join-Path (Join-Path $LocalAppData "HallOfWisdom") "config.json"
}

# Reads and parses the persisted config file at $ConfigPath. Used both for
# the just-saved candidate re-read (see the "keep" branch of
# Invoke-HallInstaller, Finding 1) and, when convenient, for the initial
# existing-config detection.
function Get-HallPersistedConfig {
    param([Parameter(Mandatory)][string]$ConfigPath)
    Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
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
        [switch]$EnableCodexTrustedLocalExplicitlyBound,
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

    # comparisonRoot's schema allows an explicit $null (comparisons
    # disabled) as a real, intentional value distinct from "not present in
    # the config at all". ConvertFrom-Json surfaces that distinction as a
    # present property with a $null value vs. no property at all, so use
    # PSObject.Properties.Match rather than a truthy check here - a truthy
    # check cannot tell "explicitly disabled" apart from "absent" and would
    # silently re-enable comparisons with the derived default.
    $existingHasComparisonRoot = $ExistingConfig -and ($ExistingConfig.PSObject.Properties.Match('comparisonRoot').Count -gt 0)
    $defaultComparisonRoot = if ($existingHasComparisonRoot) { $ExistingConfig.comparisonRoot } else { $defaults.ComparisonRoot }
    $comparisonRoot = if ($BoundComparisonRoot) { $BoundComparisonRoot } else { $defaultComparisonRoot }

    # hallCorePort/hallWebPort are zod .default(...)-backed, so a
    # schema-valid on-disk config can legitimately omit them. Inherit the
    # existing value when present so a reconfigure never silently resets a
    # previously chosen port back to the built-in default.
    $hallCorePort = if ($ExistingConfig -and $ExistingConfig.hallCorePort) { $ExistingConfig.hallCorePort } else { 4310 }
    $hallWebPort = if ($ExistingConfig -and $ExistingConfig.hallWebPort) { $ExistingConfig.hallWebPort } else { 3000 }

    # codexTrustedLocal is zod .default(...)-backed too, so a schema-valid
    # on-disk config can legitimately omit it. Compute the inherited
    # default once, used both to pre-fill the interactive prompt (matching
    # the plan's "reconfigure ... pre-filled with current values as
    # defaults" intent) and as the -NonInteractive fallback.
    $existingHasCodexTrustedLocal = $ExistingConfig -and ($ExistingConfig.PSObject.Properties.Match('codexTrustedLocal').Count -gt 0)
    $defaultCodexTrustedLocal = if ($existingHasCodexTrustedLocal) { [bool]$ExistingConfig.codexTrustedLocal } else { $false }

    if ($EnableCodexTrustedLocalExplicitlyBound) {
        # An explicit -EnableCodexTrustedLocal on the command line always
        # wins, interactive or not.
        $enableCodexTrustedLocal = $BoundEnableCodexTrustedLocal
    } elseif (-not $NonInteractive) {
        $promptSuffix = if ($defaultCodexTrustedLocal) { "[Yes] (Y/n)" } else { "[No, recommended] (y/N)" }
        $codexResponse = Read-Host "Enable Codex trusted-local execution? $promptSuffix"
        if ([string]::IsNullOrWhiteSpace($codexResponse)) {
            $enableCodexTrustedLocal = $defaultCodexTrustedLocal
        } else {
            $enableCodexTrustedLocal = ($codexResponse -match '^(y|yes)$')
        }
    } else {
        # -NonInteractive with no explicit override: inherit the existing
        # config's value rather than silently downgrading a previously
        # enabled setting back to $false.
        $enableCodexTrustedLocal = $defaultCodexTrustedLocal
    }

    [PSCustomObject]@{
        schemaVersion     = 1
        workspaceRoot     = $workspaceRoot
        dataDir           = $dataDir
        agentWorktreeRoot = $agentWorktreeRoot
        comparisonRoot    = $comparisonRoot
        hallCorePort      = [int]$hallCorePort
        hallWebPort       = [int]$hallWebPort
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
            $existing = Get-HallPersistedConfig -ConfigPath $configPath
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
        # Only "" (blank, meaning the default) or "1" mean keep; anything
        # else unrecognized must re-prompt rather than silently falling
        # through to a mode that runs the full install/build/save/verify
        # pipeline.
        $mode = $null
        while (-not $mode) {
            # Cast to [string] before the switch: PowerShell's switch
            # statement treats a raw $null as an empty collection and runs
            # NO clause at all - not even default - which would leave
            # $mode permanently $null and spin this loop forever if
            # Read-Host ever returns $null (e.g. redirected/closed stdin).
            # [string]$null is "", which the "" case below already handles.
            $choice = [string](Read-Host "Choose an option [1]")
            switch ($choice) {
                "" { $mode = "keep" }
                "1" { $mode = "keep" }
                "2" { $mode = "reconfigure" }
                "3" { Write-Host "Cancelled."; exit 0 }
                default { Write-Host "Unrecognized option. Please enter 1, 2, or 3." -ForegroundColor Yellow }
            }
        }
    } elseif ($existing -and $NonInteractive) {
        $mode = "reconfigure"
    }

    if ($mode -eq "keep") {
        Install-HallDependenciesAndConfig -RepoRoot $RepoRoot -ConfigPath $configPath -Answers $existing
        # Install-HallDependenciesAndConfig just ran Invoke-HallConfigSave,
        # which re-validates $existing through the real zod schema and
        # normalizes every default-backed field the on-disk file may have
        # omitted (hallCorePort, hallWebPort, codexTrustedLocal). Re-read
        # the just-saved file rather than reusing the possibly-incomplete
        # $existing object, so verification runs against a complete
        # candidate instead of silently binding missing fields to 0/false.
        $verifiedCandidate = Get-HallPersistedConfig -ConfigPath $configPath
        Invoke-HallInstallVerification -RepoRoot $RepoRoot -Answers $verifiedCandidate
        Invoke-HallDiagnostics -RepoRoot $RepoRoot
        Write-Host ""; Write-Host "Hall of Wisdom is ready." -ForegroundColor Cyan
        return
    }

    $answers = Get-HallAnswers -BoundWorkspaceRoot $WorkspaceRoot -BoundDataDir $DataDir -BoundAgentWorktreeRoot $AgentWorktreeRoot `
        -BoundComparisonRoot $ComparisonRoot -BoundEnableCodexTrustedLocal ([bool]$EnableCodexTrustedLocal) `
        -EnableCodexTrustedLocalExplicitlyBound:$HallEnableCodexTrustedLocalWasBound `
        -NonInteractive:$NonInteractive -ExistingConfig $existing

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
