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
    param([Parameter(Mandatory)][string]$HostName)

    Write-Host "--- Lifecycle smoke test under host: $HostName ---"

    $corePort = New-HallTestPort
    $webPort = New-HallTestPort
    $fakeConfigDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-e2e-$HostName-$([guid]::NewGuid())"
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

        $hostCommand = Get-Command $HostName -ErrorAction SilentlyContinue
        if (-not $hostCommand) { throw "Host '$HostName' was not found on PATH - skipping this host's coverage is not acceptable; install it or run on a machine that has it." }

        $startPs1 = Join-Path $RepoRoot "start.ps1"
        $arguments = "-NoProfile -File `"$startPs1`""
        $processId = Start-HallTestProcessGroup -ExePath $hostCommand.Source -Arguments $arguments -WorkingDirectory $RepoRoot

        try {
            Wait-HallTestReady -Url "http://127.0.0.1:$corePort/api/v1/health" -TimeoutSeconds 60
            Wait-HallTestReady -Url "http://127.0.0.1:$webPort/" -TimeoutSeconds 180
            Write-Host "  [OK] both services became ready"

            Send-HallTestCtrlBreak -ProcessGroupId $processId
            $deadline = (Get-Date).AddSeconds(30)
            $childProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
            while ($childProcess -and (Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 250
                $childProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
            }
            if ($childProcess) { throw "start.ps1 (PID $processId) did not exit within 30s of receiving Ctrl+Break." }

            Test-HallTestNoOrphanProcesses -CorePort $corePort -WebPort $webPort
            Write-Host "  [OK] clean shutdown, no orphaned Hall Core/Hall Web process (host: $HostName)" -ForegroundColor Green
        } finally {
            $stray = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($stray) { & taskkill /PID $processId /T /F 2>&1 | Out-Null }
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
            Invoke-HallLauncherLifecycleSmokeTest -HostName $hostName
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
