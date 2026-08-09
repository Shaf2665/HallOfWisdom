$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "PortCheck.ps1")

try {
    # An ephemeral free port: bind nothing, ask the OS for a port, then
    # immediately release it - there's a small theoretical race (another
    # process could grab it between release and the assertion below), but
    # this is the standard, accepted way to get a "probably free" port
    # number without hardcoding one that might collide with a real service
    # already running on the test machine.
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $freePort = $probe.LocalEndpoint.Port
    $probe.Stop()

    Test-HallPortFree -Port $freePort -ServiceName "Test Service"
    Write-Host "  (free port correctly reported as free)" -ForegroundColor DarkGray

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $occupiedPort = $listener.LocalEndpoint.Port
    try {
        Assert-Throws { Test-HallPortFree -Port $occupiedPort -ServiceName "Test Service" } "an occupied port must throw a clear error"
        try {
            Test-HallPortFree -Port $occupiedPort -ServiceName "Test Service"
        } catch {
            Assert-True ($_.Exception.Message -like "*$occupiedPort*") "the error message should name the occupied port"
            Assert-True ($_.Exception.Message -like "*Test Service*") "the error message should name which service needs the port"
        }
    } finally {
        $listener.Stop()
    }
} finally {
}

Write-Host "  (PortCheck.Tests.ps1: all assertions passed)"
