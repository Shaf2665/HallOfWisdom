<#
Checks whether a TCP port is already bound before the launcher spawns
anything that would try to bind it - failing here with a clear, specific
message beats a cryptic EADDRINUSE surfacing from deep inside Fastify or
Next.js several seconds later.
#>

function Test-HallPortFree {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$ServiceName
    )
    $client = New-Object System.Net.Sockets.TcpClient
    $isOpen = $false
    try {
        $connectTask = $client.ConnectAsync("127.0.0.1", $Port)
        try {
            $connectTask.Wait(500) | Out-Null
            $isOpen = $client.Connected
        } catch {
            # ConnectAsync's task faults (e.g. connection refused) when
            # nothing is listening on the port - that outcome IS "the port
            # is free," not an error to propagate.
            $isOpen = $false
        }
    } finally {
        $client.Close()
    }
    if ($isOpen) {
        throw "Port $Port is already in use (needed for $ServiceName). Stop whatever is using it, or reconfigure $ServiceName's port via .\install.ps1, then try again."
    }
}
