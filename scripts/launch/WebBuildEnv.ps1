<#
Build-freshness for Hall Web's NEXT_PUBLIC_HALL_CORE_URL - see the design
doc, decision 2. NEXT_PUBLIC_HALL_CORE_URL is inlined into Hall Web's client
bundle at `next build` time; a stale bundle (built for a different
hallCorePort) would silently point the browser at the wrong Hall Core. The
marker file this module writes is the ONLY record of what URL a given
.next build was actually made with - .env.local is never read, written, or
trusted; NEXT_PUBLIC_HALL_CORE_URL is passed directly in the spawned build
(and, for consistency, the spawned `next start`) process's environment
instead.
#>

function Get-HallWebBuildMarkerPath {
    param([Parameter(Mandatory)][string]$RepoRoot)
    Join-Path $RepoRoot (Join-Path "apps" (Join-Path "web" (Join-Path ".next" "hall-launcher-build-marker.json")))
}

function Get-HallWebBuildMarker {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $markerPath = Get-HallWebBuildMarkerPath -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $markerPath)) { return $null }
    try {
        Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        # A corrupt/unreadable marker is treated exactly like a missing one
        # - rebuild rather than trust it.
        $null
    }
}

function Invoke-HallWebBuildIfStale {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$HallCoreUrl
    )
    $marker = Get-HallWebBuildMarker -RepoRoot $RepoRoot
    if ($marker -and $marker.hallCoreUrl -eq $HallCoreUrl) {
        return
    }

    Write-Host "Hall Web's build does not match the configured Hall Core URL ($HallCoreUrl) - rebuilding..."
    Push-Location $RepoRoot
    $previousHallCoreUrl = $env:NEXT_PUBLIC_HALL_CORE_URL
    try {
        $env:NEXT_PUBLIC_HALL_CORE_URL = $HallCoreUrl
        & pnpm --filter "@hall-of-wisdom/web" run build
        if ($LASTEXITCODE -ne 0) {
            throw "Building Hall Web failed (exit code $LASTEXITCODE)."
        }
    } finally {
        $env:NEXT_PUBLIC_HALL_CORE_URL = $previousHallCoreUrl
        Pop-Location
    }

    $markerPath = Get-HallWebBuildMarkerPath -RepoRoot $RepoRoot
    [PSCustomObject]@{ hallCoreUrl = $HallCoreUrl } | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding utf8
    Write-Host "  [OK] Hall Web rebuilt for $HallCoreUrl"
}
