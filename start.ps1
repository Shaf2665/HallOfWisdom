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

    # Remote access via Cloudflare Tunnel (see docs/remote-access.md) is
    # opt-in: unset (the default), both env vars are blank and every line
    # below behaves exactly as it did before - loopback URL, zero Hall Core
    # CLI flags. NEXT_PUBLIC_HALL_CORE_URL reuses the exact env var name
    # Hall Web's build already reads (see WebBuildEnv.ps1); HALL_WEB_ORIGIN
    # is the public Hall Web origin Hall Core should additionally trust for
    # CORS/WebSocket-origin checks (see server-cli-args.ts's --web-origin).
    $hallCoreUrl = if ([string]::IsNullOrWhiteSpace($env:NEXT_PUBLIC_HALL_CORE_URL)) {
        "http://127.0.0.1:$($config.hallCorePort)"
    } else {
        $env:NEXT_PUBLIC_HALL_CORE_URL
    }
    $remoteWebOrigin = $env:HALL_WEB_ORIGIN
    Invoke-HallWebBuildIfStale -RepoRoot $RepoRoot -HallCoreUrl $hallCoreUrl

    # From here on, at least one child process may be running - every exit
    # path (a genuine startup failure, Start-Process/Ctrl+C-registration
    # failing, a normal Ctrl+C, or a child dying on its own) must go
    # through the single `finally` below so an owned process is never left
    # running unattended. $coreProcess/$webProcess start $null so the
    # cleanup can tell "never started" apart from "started, needs
    # stopping" for whichever child never got created before a failure.
    $coreProcess = $null
    $webProcess = $null
    $failedService = $null
    $ctrlCHandlerRegistered = $false
    try {
        Write-Host "Starting Hall Core on port $($config.hallCorePort)..."
        $coreProcess = Start-HallCoreProcess -RepoRoot $RepoRoot -WebOrigin $remoteWebOrigin
        Wait-HallCoreHealthy -Port $config.hallCorePort -Process $coreProcess
        Write-Host "  [OK] Hall Core is ready"

        Write-Host "Starting Hall Web on port $($config.hallWebPort)..."
        $webProcess = Start-HallWebProcess -RepoRoot $RepoRoot -Port $config.hallWebPort -HallCoreUrl $hallCoreUrl
        Wait-HallWebReady -Port $config.hallWebPort -Process $webProcess
        Write-Host "  [OK] Hall Web is ready"

        # Once HALL_WEB_ORIGIN is set, Hall Core's CORS/WebSocket-origin
        # allowlist only trusts that origin (see docs/remote-access.md,
        # "Running local and remote at the same time") - the loopback URL
        # would load but fail to sign in, reproducing issue #22. Announce
        # and open the origin that will actually work.
        $webUrl = if ([string]::IsNullOrWhiteSpace($remoteWebOrigin)) {
            "http://127.0.0.1:$($config.hallWebPort)"
        } else {
            $remoteWebOrigin
        }
        Write-Host ""
        Write-Host "Hall of Wisdom is running at $webUrl" -ForegroundColor Cyan
        Write-Host "Press Ctrl+C to stop." -ForegroundColor Cyan
        Start-Process $webUrl

        Register-HallLauncherCtrlCHandler
        $ctrlCHandlerRegistered = $true
        try {
            while (-not (Test-HallLauncherShutdownRequested)) {
                if ($coreProcess.HasExited) { $failedService = "Hall Core"; break }
                if ($webProcess.HasExited) { $failedService = "Hall Web"; break }
                Start-Sleep -Milliseconds 250
            }
        } finally {
            Unregister-HallLauncherCtrlCHandler
            $ctrlCHandlerRegistered = $false
        }
    } finally {
        # Guards a throw between Register-HallLauncherCtrlCHandler and the
        # inner try above (there is none today, but this stays correct if
        # that ever changes) - the inner finally already unregisters on
        # every other path.
        if ($ctrlCHandlerRegistered) { Unregister-HallLauncherCtrlCHandler }

        Write-Host ""
        if ($failedService) {
            Write-Host "$failedService exited unexpectedly - shutting down." -ForegroundColor Red
        } else {
            Write-Host "Shutting down..." -ForegroundColor Cyan
        }
        # Each stop is its own try/catch so a failure stopping one service
        # (e.g. Stop-HallLauncherProcess's new "still alive after forced
        # termination" check) never prevents the attempt on the other.
        $stopErrors = @()
        if ($webProcess) {
            try { Stop-HallLauncherProcess -Process $webProcess -ServiceName "Hall Web" } catch { $stopErrors += $_.Exception.Message }
        }
        if ($coreProcess) {
            try { Stop-HallLauncherProcess -Process $coreProcess -ServiceName "Hall Core" } catch { $stopErrors += $_.Exception.Message }
        }
        if ($stopErrors.Count -gt 0) {
            throw ($stopErrors -join "; ")
        }
        Write-Host "Hall of Wisdom stopped." -ForegroundColor Cyan
    }

    if ($failedService) { exit 1 }
}

# Guard so this file can be dot-sourced (for a testable subset, or by a
# smoke-test harness) without immediately launching real processes -
# mirrors install.ps1's HALL_INSTALL_PS1_UNDER_TEST guard exactly.
if (-not $env:HALL_START_PS1_UNDER_TEST) {
    Invoke-HallLauncher -RepoRoot $RepoRoot
}
