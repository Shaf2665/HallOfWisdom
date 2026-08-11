function Get-HallRequiredVersions {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $packageJsonPath = Join-Path $RepoRoot "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "package.json not found at '$packageJsonPath'."
    }
    $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
    [PSCustomObject]@{
        NodeRange = $packageJson.engines.node
        PnpmRange = $packageJson.engines.pnpm
    }
}

# Narrow parser for THIS repo's engines range shape: one or more
# ">=A.B.C <D" clauses joined by " || ". This is not a general semver-range
# parser; it throws on anything else rather than guessing.
function Test-HallVersionInRange {
    param(
        [Parameter(Mandatory)][string]$VersionText,
        [Parameter(Mandatory)][string]$RangeText
    )
    $cleanVersion = $VersionText.TrimStart('v')
    if ($cleanVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        return $false
    }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]

    $clauses = $RangeText -split '\s+\|\|\s+'
    $matched = $false
    foreach ($clause in $clauses) {
        if ($clause -notmatch '^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)$') {
            throw "Unsupported engines range format: '$RangeText'."
        }
        $minMajor = [int]$Matches[1]; $minMinor = [int]$Matches[2]; $minPatch = [int]$Matches[3]
        $maxMajorExclusive = [int]$Matches[4]
        $aboveMinimum = $major -gt $minMajor -or
            ($major -eq $minMajor -and $minor -gt $minMinor) -or
            ($major -eq $minMajor -and $minor -eq $minMinor -and $patch -ge $minPatch)
        if ($aboveMinimum -and $major -lt $maxMajorExclusive) { $matched = $true }
    }
    return $matched
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
    if (-not (Test-HallVersionInRange -VersionText $version -RangeText $RequiredRange)) {
        return [PSCustomObject]@{ Ok = $false; Message = "Node.js $version was found, but Hall requires $RequiredRange." }
    }
    return [PSCustomObject]@{ Ok = $true; Message = $version.Trim() }
}

function Test-HallPnpmPrerequisite {
    param([Parameter(Mandatory)][string]$RequiredRange)
    try {
        $version = ((pnpm --version) 2>$null).Trim()
        if (-not $version) { return [PSCustomObject]@{ Ok = $false; Message = "pnpm was not found on PATH." } }
    } catch {
        return [PSCustomObject]@{ Ok = $false; Message = "pnpm was not found on PATH." }
    }
    if (-not (Test-HallVersionInRange -VersionText $version -RangeText $RequiredRange)) {
        return [PSCustomObject]@{ Ok = $false; Message = "pnpm $version was found, but Hall requires $RequiredRange." }
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
