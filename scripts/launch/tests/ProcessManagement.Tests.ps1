$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "ProcessManagement.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-processmgmt-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

function New-HallTestPort {
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = $probe.LocalEndpoint.Port
    $probe.Stop()
    $port
}

# A minimal HTTP server: opens $port, returns 200 for any GET, honors a
# "SHUTDOWN\n" line on stdin by exiting 0. Written with Node's bare `http`
# module (no dependency install needed in this fixture context).
$fakeCoreScript = @'
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
$fakeCorePath = Join-Path $fixtureRoot "fake-core.js"
Set-Content -LiteralPath $fakeCorePath -Value $fakeCoreScript -Encoding utf8

# Same shape but NEVER reacts to stdin - proves Stop-HallLauncherProcess's
# forced taskkill fallback is what actually stops a process like this
# (Hall Web has no stdin-shutdown protocol at all).
$fakeWebScript = @'
const http = require("http");
const port = Number(process.argv[2]);
const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
server.listen(port, "127.0.0.1");
process.stdin.resume();
'@
$fakeWebPath = Join-Path $fixtureRoot "fake-web.js"
Set-Content -LiteralPath $fakeWebPath -Value $fakeWebScript -Encoding utf8

function Start-HallTestFixture {
    param([Parameter(Mandatory)][string]$ScriptPath, [Parameter(Mandatory)][int]$Port)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command node).Source
    $psi.Arguments = ConvertTo-HallProcessArgumentString -ArgumentList @($ScriptPath, [string]$Port)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $process.Start() | Out-Null
    $process
}

try {
    # --- Wait-HallServiceReady: succeeds once listening ---
    $corePort = New-HallTestPort
    $coreFixture = Start-HallTestFixture -ScriptPath $fakeCorePath -Port $corePort
    try {
        Wait-HallServiceReady -Url "http://127.0.0.1:$corePort/api/v1/health" -ServiceName "Fake Core" -Process $coreFixture -TimeoutSeconds 10
        Write-Host "  (fixture became ready within timeout)" -ForegroundColor DarkGray

        # --- Stop-HallLauncherProcess: graceful stdin path ---
        Stop-HallLauncherProcess -Process $coreFixture -ServiceName "Fake Core"
        Assert-True $coreFixture.HasExited "the Core-shaped fixture must exit after receiving the stdin SHUTDOWN command"
        $stillRunning = Get-Process -Id $coreFixture.Id -ErrorAction SilentlyContinue
        Assert-True ($null -eq $stillRunning) "no process with the fixture's PID should remain after a graceful stop"
    } finally {
        if (-not $coreFixture.HasExited) { $coreFixture.Kill() }
    }

    # --- Wait-HallServiceReady: fails fast when the process exits before opening its port ---
    $neverStartsScript = @'
process.exit(1);
'@
    $neverStartsPath = Join-Path $fixtureRoot "never-starts.js"
    Set-Content -LiteralPath $neverStartsPath -Value $neverStartsScript -Encoding utf8
    $deadPort = New-HallTestPort
    $deadFixture = Start-HallTestFixture -ScriptPath $neverStartsPath -Port $deadPort
    Start-Sleep -Milliseconds 500
    $waitError = $null
    try {
        Wait-HallServiceReady -Url "http://127.0.0.1:$deadPort/" -ServiceName "Dead Fixture" -Process $deadFixture -TimeoutSeconds 5
    } catch {
        $waitError = $_
    }
    Assert-True ($null -ne $waitError) "waiting on a process that already exited must fail, not hang for the full timeout"
    Assert-True ($waitError.Exception.Message -like "*Dead Fixture*") "the failure message should name the service"

    # --- Stop-HallLauncherProcess: forced taskkill fallback for a fixture that ignores stdin ---
    $webPort = New-HallTestPort
    $webFixture = Start-HallTestFixture -ScriptPath $fakeWebPath -Port $webPort
    try {
        Wait-HallServiceReady -Url "http://127.0.0.1:$webPort/" -ServiceName "Fake Web" -Process $webFixture -TimeoutSeconds 10
        Stop-HallLauncherProcess -Process $webFixture -ServiceName "Fake Web" -GracefulTimeoutSeconds 2
        Assert-True $webFixture.HasExited "the Web-shaped fixture (which ignores stdin) must still be reaped by the forced fallback"
        $stillRunningWeb = Get-Process -Id $webFixture.Id -ErrorAction SilentlyContinue
        Assert-True ($null -eq $stillRunningWeb) "no process with the fixture's PID should remain after the forced fallback"
    } finally {
        if (-not $webFixture.HasExited) { $webFixture.Kill() }
    }

    # --- Stop-HallLauncherProcess: idempotent on an already-exited process ---
    Stop-HallLauncherProcess -Process $webFixture -ServiceName "Fake Web"
    Write-Host "  (calling Stop-HallLauncherProcess twice on an exited process did not throw)" -ForegroundColor DarkGray

    # --- Ctrl+C flag plumbing (function-level, not a real console signal - see the dual-host smoke test for that) ---
    Register-HallLauncherCtrlCHandler
    try {
        Assert-False (Test-HallLauncherShutdownRequested) "the shutdown flag must start false"
        [Console]::CancelKeyPress # touch the event to confirm the type resolves under both hosts (no-op statement)
    } finally {
        Unregister-HallLauncherCtrlCHandler
    }
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (ProcessManagement.Tests.ps1: all assertions passed)"
