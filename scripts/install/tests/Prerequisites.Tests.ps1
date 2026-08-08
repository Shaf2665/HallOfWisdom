$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Prerequisites.ps1")

# Test-HallNodeVersionInRange — narrow ">=A.B.C <D" range parser
Assert-True (Test-HallNodeVersionInRange -VersionText "v24.11.0" -RangeText ">=24.11.0 <25") "24.11.0 is exactly the minimum, must be in range"
Assert-True (Test-HallNodeVersionInRange -VersionText "v24.12.5" -RangeText ">=24.11.0 <25") "24.12.5 is above the minimum, must be in range"
Assert-True (Test-HallNodeVersionInRange -VersionText "v24.99.99" -RangeText ">=24.11.0 <25") "24.99.99 is still major 24, must be in range"
Assert-False (Test-HallNodeVersionInRange -VersionText "v24.10.9" -RangeText ">=24.11.0 <25") "24.10.9 is below the minor minimum, must NOT be in range"
Assert-False (Test-HallNodeVersionInRange -VersionText "v23.0.0" -RangeText ">=24.11.0 <25") "major 23 is below range, must NOT be in range"
Assert-False (Test-HallNodeVersionInRange -VersionText "v25.0.0" -RangeText ">=24.11.0 <25") "major 25 is excluded by the upper bound, must NOT be in range"
Assert-Throws { Test-HallNodeVersionInRange -VersionText "v24.11.0" -RangeText "not a range" } "an unrecognized range format must throw, never silently pass"

# Get-HallRequiredVersions — reads engines/packageManager from a fixture package.json
$fixtureDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-prereq-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixtureDir -Force | Out-Null
try {
    $fixturePackageJson = @{
        engines = @{ node = ">=24.11.0 <25" }
        packageManager = "pnpm@10.33.0"
    } | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $fixtureDir "package.json") -Value $fixturePackageJson -Encoding utf8

    $versions = Get-HallRequiredVersions -RepoRoot $fixtureDir
    Assert-Equal ">=24.11.0 <25" $versions.NodeRange "NodeRange should come from package.json engines.node"
    Assert-Equal "10.33.0" $versions.PnpmVersion "PnpmVersion should be parsed out of the packageManager field"
} finally {
    Remove-Item -LiteralPath $fixtureDir -Recurse -Force
}

Assert-Throws { Get-HallRequiredVersions -RepoRoot "C:\definitely-does-not-exist-hall-test" } "missing package.json must throw"

# Test-HallRepositoryIntegrity — a fixture missing required paths must fail
$emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-empty-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
try {
    $result = Test-HallRepositoryIntegrity -RepoRoot $emptyDir
    Assert-False $result.Ok "an empty directory must fail repository-integrity check"
} finally {
    Remove-Item -LiteralPath $emptyDir -Recurse -Force
}

# Test-HallGitPrerequisite / Test-HallNodePrerequisite / Test-HallPnpmPrerequisite —
# smoke-tested against whatever this test-runner's own environment actually has,
# since the plan's own Global Constraints already require Git/Node/pnpm present.
$gitResult = Test-HallGitPrerequisite
Assert-True $gitResult.Ok "Git must be present in the environment running this test suite"

$nodeResult = Test-HallNodePrerequisite -RequiredRange ">=24.11.0 <25"
Assert-True $nodeResult.Ok "the pinned Node.js version must be present in this environment"

$pnpmResult = Test-HallPnpmPrerequisite -RequiredVersion "10.33.0"
Assert-True $pnpmResult.Ok "the pinned pnpm version must be present in this environment"

Write-Host "  (Prerequisites.Tests.ps1: all assertions passed)"
