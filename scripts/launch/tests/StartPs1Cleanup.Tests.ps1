$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$env:HALL_START_PS1_UNDER_TEST = "1"
. (Join-Path $RepoRoot "start.ps1")

<#
Regression coverage for the post-start failure cleanup gap: once a child
process is running, EVERY subsequent failure inside Invoke-HallLauncher
(not just a child failing its own readiness check) must stop both Hall
Core and Hall Web before the failure propagates. Exercised here by
shadowing the specific step that fails (Start-Process for the browser, or
Register-HallLauncherCtrlCHandler) with a same-named function that throws
- everything else Invoke-HallLauncher calls runs for real, against real
fixture-spawned Node processes standing in for Hall Core/Hall Web, so the
cleanup path genuinely has real processes to reap rather than mocks.
#>

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-startcleanup-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

function New-HallTestPort {
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = $probe.LocalEndpoint.Port
    $probe.Stop()
    $port
}

# Both fixtures serve 200 on any GET (satisfying Wait-HallCoreHealthy /
# Wait-HallWebReady for real) and honor the stdin SHUTDOWN command
# (satisfying Stop-HallLauncherProcess's graceful path for real).
$fakeServiceScript = @'
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
$fakeServicePath = Join-Path $fixtureRoot "fake-service.js"
Set-Content -LiteralPath $fakeServicePath -Value $fakeServiceScript -Encoding utf8

function Start-HallTestFixtureProcess {
    param([Parameter(Mandatory)][int]$Port)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command node).Source
    $psi.Arguments = ConvertTo-HallProcessArgumentString -ArgumentList @($fakeServicePath, [string]$Port)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $process.Start() | Out-Null
    $process
}

function Test-HallCleanupScenario {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$FailingStepOverride)

    $corePort = New-HallTestPort
    $webPort = New-HallTestPort
    $script:hallTestCoreProcess = $null
    $script:hallTestWebProcess = $null

    # Shadow every step up to and including the one under test with a
    # same-named function in this script's own scope - Invoke-HallLauncher,
    # dot-sourced into this same scope above, resolves these ahead of the
    # real cmdlets/functions of the same name.
    function Get-HallLauncherConfig {
        param($RepoRoot)
        [PSCustomObject]@{ hallCorePort = $corePort; hallWebPort = $webPort }
    }
    function Test-HallPortFree { param($Port, $ServiceName) }
    function Invoke-HallWebBuildIfStale { param($RepoRoot, $HallCoreUrl) }
    function Start-HallCoreProcess {
        param($RepoRoot)
        $script:hallTestCoreProcess = Start-HallTestFixtureProcess -Port $corePort
        $script:hallTestCoreProcess
    }
    function Start-HallWebProcess {
        param($RepoRoot, $Port, $HallCoreUrl)
        $script:hallTestWebProcess = Start-HallTestFixtureProcess -Port $webPort
        $script:hallTestWebProcess
    }
    # Real Wait-HallCoreHealthy/Wait-HallWebReady/Stop-HallLauncherProcess
    # run unmodified (already dot-sourced from ProcessManagement.ps1 by
    # start.ps1 itself) - real polling against real fixture ports, real
    # cleanup at the end.
    . $FailingStepOverride

    $launcherError = $null
    try {
        Invoke-HallLauncher -RepoRoot $RepoRoot
    } catch {
        $launcherError = $_
    }

    Assert-True ($null -ne $launcherError) "$Name`: Invoke-HallLauncher must propagate the failure, not swallow it"

    $deadline = (Get-Date).AddSeconds(10)
    while (((-not $script:hallTestCoreProcess.HasExited) -or (-not $script:hallTestWebProcess.HasExited)) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    Assert-True $script:hallTestCoreProcess.HasExited "$Name`: Hall Core's fixture process must be stopped, not left orphaned"
    Assert-True $script:hallTestWebProcess.HasExited "$Name`: Hall Web's fixture process must be stopped, not left orphaned"

    Remove-Item -LiteralPath function:Get-HallLauncherConfig -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath function:Test-HallPortFree -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath function:Invoke-HallWebBuildIfStale -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath function:Start-HallCoreProcess -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath function:Start-HallWebProcess -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath function:Start-Process -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath function:Register-HallLauncherCtrlCHandler -ErrorAction SilentlyContinue
}

try {
    Test-HallCleanupScenario -Name "browser-open failure" -FailingStepOverride {
        function Start-Process { param($FilePath) throw "simulated browser-open failure" }
    }

    Test-HallCleanupScenario -Name "Ctrl+C-handler registration failure" -FailingStepOverride {
        # A real Start-Process would pop open a real browser during this
        # test run - stub it to a harmless no-op for this scenario, since
        # the failure under test is the NEXT step, not this one.
        function Start-Process { param($FilePath) }
        function Register-HallLauncherCtrlCHandler { throw "simulated Ctrl+C handler registration failure" }
    }

    # --- Remote-access env vars (see docs/remote-access.md) are actually read by Invoke-HallLauncher itself, not just accepted as parameters further down the call chain ---
    $corePort = New-HallTestPort
    $webPort = New-HallTestPort
    $script:hallTestCoreProcess = $null
    $script:hallTestWebProcess = $null
    $script:capturedWebOrigin = "(not called)"
    $script:capturedHallCoreUrl = "(not called)"
    $script:capturedOpenedUrl = "(not called)"

    function Get-HallLauncherConfig {
        param($RepoRoot)
        [PSCustomObject]@{ hallCorePort = $corePort; hallWebPort = $webPort }
    }
    function Test-HallPortFree { param($Port, $ServiceName) }
    function Invoke-HallWebBuildIfStale {
        param($RepoRoot, $HallCoreUrl)
        $script:capturedHallCoreUrl = $HallCoreUrl
    }
    function Start-HallCoreProcess {
        param($RepoRoot, $WebOrigin)
        $script:capturedWebOrigin = $WebOrigin
        $script:hallTestCoreProcess = Start-HallTestFixtureProcess -Port $corePort
        $script:hallTestCoreProcess
    }
    function Start-HallWebProcess {
        param($RepoRoot, $Port, $HallCoreUrl)
        $script:hallTestWebProcess = Start-HallTestFixtureProcess -Port $webPort
        $script:hallTestWebProcess
    }
    # Fails fast right after the value Invoke-HallLauncher announces/opens
    # is captured, reusing the same "throw to unwind, then assert cleanup"
    # idiom Test-HallCleanupScenario uses above - this also doubles as
    # regression coverage for the announced/opened URL being the remote
    # origin, not the now-CORS-rejected loopback one, once HALL_WEB_ORIGIN
    # is set (see docs/remote-access.md, "Running local and remote at the
    # same time").
    function Start-Process {
        param($FilePath)
        $script:capturedOpenedUrl = $FilePath
        throw "simulated browser-open failure"
    }

    $env:NEXT_PUBLIC_HALL_CORE_URL = "https://core.hall.example.com"
    $env:HALL_WEB_ORIGIN = "https://hall.example.com"
    try {
        try { Invoke-HallLauncher -RepoRoot $RepoRoot } catch { }

        Assert-Equal "https://hall.example.com" $script:capturedWebOrigin `
            "HALL_WEB_ORIGIN must be read by Invoke-HallLauncher and passed to Start-HallCoreProcess as -WebOrigin"
        Assert-Equal "https://core.hall.example.com" $script:capturedHallCoreUrl `
            "NEXT_PUBLIC_HALL_CORE_URL must be read by Invoke-HallLauncher, overriding the loopback Hall Core URL"
        Assert-Equal "https://hall.example.com" $script:capturedOpenedUrl `
            "once HALL_WEB_ORIGIN is set, the announced/opened URL must be the remote origin, not the loopback one CORS would now reject"

        $deadline = (Get-Date).AddSeconds(10)
        while (((-not $script:hallTestCoreProcess.HasExited) -or (-not $script:hallTestWebProcess.HasExited)) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 200
        }
        Assert-True $script:hallTestCoreProcess.HasExited "remote-access env var test: Hall Core's fixture process must be stopped, not left orphaned"
        Assert-True $script:hallTestWebProcess.HasExited "remote-access env var test: Hall Web's fixture process must be stopped, not left orphaned"
    } finally {
        Remove-Item -LiteralPath env:NEXT_PUBLIC_HALL_CORE_URL -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath env:HALL_WEB_ORIGIN -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath function:Get-HallLauncherConfig -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath function:Test-HallPortFree -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath function:Invoke-HallWebBuildIfStale -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath function:Start-HallCoreProcess -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath function:Start-HallWebProcess -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath function:Start-Process -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath env:HALL_START_PS1_UNDER_TEST -ErrorAction SilentlyContinue
}

Write-Host "  (StartPs1Cleanup.Tests.ps1: all assertions passed)"
