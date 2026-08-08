function Get-HallRequiredVersions {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $packageJsonPath = Join-Path $RepoRoot "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "package.json not found at '$packageJsonPath'."
    }
    $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    [PSCustomObject]@{
        NodeRange   = $packageJson.engines.node
        PnpmVersion = ($packageJson.packageManager -replace '^pnpm@', '')
    }
}

# Narrow parser for THIS repo's exact node engines range shape
# (">=A.B.C <D" — minimum inclusive, major-exclusive upper bound). Not a
# general semver-range parser; throws on anything else rather than
# guessing.
function Test-HallNodeVersionInRange {
    param(
        [Parameter(Mandatory)][string]$VersionText,
        [Parameter(Mandatory)][string]$RangeText
    )
    if ($RangeText -notmatch '^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)$') {
        throw "Unsupported node engines range format: '$RangeText'."
    }
    $minMajor = [int]$Matches[1]; $minMinor = [int]$Matches[2]; $minPatch = [int]$Matches[3]
    $maxMajorExclusive = [int]$Matches[4]

    $cleanVersion = $VersionText.TrimStart('v')
    if ($cleanVersion -notmatch '^(\d+)\.(\d+)\.(\d+)') {
        return $false
    }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]

    if ($major -ge $maxMajorExclusive) { return $false }
    if ($major -lt $minMajor) { return $false }
    if ($major -eq $minMajor) {
        if ($minor -lt $minMinor) { return $false }
        if ($minor -eq $minMinor -and $patch -lt $minPatch) { return $false }
    }
    return $true
}

function Test-HallGitPrerequisite {
    try {
        $version = (git --version) 2>$null
        if (-not $version) { return [PSCustomObject]@{ Ok = $false; Message = "Git was not found on PATH." } }
        return [PSCustomObject]@{ Ok = $true; Message = $version.Trim() }
    } catch {
        return [PSCustomObject]@{ Ok = $false; Message = "Git was not found on PATH." }
    }
}

function Test-HallNodePrerequisite {
    param([Parameter(Mandatory)][string]$RequiredRange)
    try {
        $version = (node --version) 2>$null
        if (-not $version) { return [PSCustomObject]@{ Ok = $false; Message = "Node.js was not found on PATH." } }
    } catch {
        return [PSCustomObject]@{ Ok = $false; Message = "Node.js was not found on PATH." }
    }
    if (-not (Test-HallNodeVersionInRange -VersionText $version -RangeText $RequiredRange)) {
        return [PSCustomObject]@{ Ok = $false; Message = "Node.js $version was found, but Hall requires $RequiredRange." }
    }
    return [PSCustomObject]@{ Ok = $true; Message = $version.Trim() }
}

function Test-HallPnpmPrerequisite {
    param([Parameter(Mandatory)][string]$RequiredVersion)
    try {
        $version = ((pnpm --version) 2>$null).Trim()
        if (-not $version) { return [PSCustomObject]@{ Ok = $false; Message = "pnpm was not found on PATH." } }
    } catch {
        return [PSCustomObject]@{ Ok = $false; Message = "pnpm was not found on PATH." }
    }
    if ($version -ne $RequiredVersion) {
        return [PSCustomObject]@{ Ok = $false; Message = "pnpm $version was found, but Hall is pinned to pnpm $RequiredVersion." }
    }
    return [PSCustomObject]@{ Ok = $true; Message = $version }
}

function Test-HallRepositoryIntegrity {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $requiredRelativePaths = @("package.json", "pnpm-workspace.yaml", "AGENTS.md", "apps/server", "packages/hall-config")
    $missing = @()
    foreach ($relativePath in $requiredRelativePaths) {
        $fullPath = Join-Path $RepoRoot $relativePath
        if (-not (Test-Path -LiteralPath $fullPath)) { $missing += $relativePath }
    }
    if ($missing.Count -gt 0) {
        return [PSCustomObject]@{ Ok = $false; Message = "Missing expected repository paths: $($missing -join ', ')" }
    }
    return [PSCustomObject]@{ Ok = $true; Message = "Repository structure looks intact." }
}
