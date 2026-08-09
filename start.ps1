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
