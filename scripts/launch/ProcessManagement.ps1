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
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        # Optional public browser origin (e.g. a second Cloudflare Tunnel
        # hostname mapped to 127.0.0.1:4310) to add to Hall Core's CORS/
        # WebSocket-origin allowlist - see docs/remote-access.md. Blank
        # (the default) preserves the zero-CLI-flags behavior below exactly:
        # apps/server/src/server.ts's tryLoadConfig() already auto-loads the
        # persisted Hall configuration - see design doc §2.
        [string]$WebOrigin
    )
    $distPath = Join-Path $RepoRoot (Join-Path "apps" (Join-Path "server" (Join-Path "dist" "server.js")))
    if (-not (Test-Path -LiteralPath $distPath)) {
        throw "Hall Core build not found at '$distPath' - run .\install.ps1 first."
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw "'node' was not found on PATH." }

    $argumentList = @($distPath)
    if (-not [string]::IsNullOrWhiteSpace($WebOrigin)) {
        $argumentList += @("--web-origin", $WebOrigin)
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeCommand.Source
    $psi.Arguments = ConvertTo-HallProcessArgumentString -ArgumentList $argumentList
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
        [int]$GracefulTimeoutSeconds = 5,
        [int]$ForcedWaitMilliseconds = 5000
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
        $Process.WaitForExit($ForcedWaitMilliseconds) | Out-Null
    }

    if (-not $Process.HasExited) {
        throw "$ServiceName (PID $($Process.Id)) could not be stopped even after forced termination."
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
