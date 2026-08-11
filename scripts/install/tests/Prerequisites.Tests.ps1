$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Prerequisites.ps1")

# Test-HallVersionInRange — narrow ">=A.B.C <D" clause parser with explicit disjunctions
Assert-True (Test-HallVersionInRange -VersionText "v22.13.0" -RangeText ">=22.13.0 <23 || >=24.11.0 <25") "22.13.0 is exactly the minimum, must be in range"
Assert-True (Test-HallVersionInRange -VersionText "v24.12.5" -RangeText ">=22.13.0 <23 || >=24.11.0 <25") "24.12.5 is above the second minimum, must be in range"
Assert-True (Test-HallVersionInRange -VersionText "10.0.0" -RangeText ">=10.0.0 <11") "pnpm 10.0.0 is exactly the minimum, must be in range"
Assert-False (Test-HallVersionInRange -VersionText "v22.12.9" -RangeText ">=22.13.0 <23 || >=24.11.0 <25") "22.12.9 is below the minimum, must NOT be in range"
Assert-False (Test-HallVersionInRange -VersionText "9.15.0" -RangeText ">=10.0.0 <11") "pnpm 9 is below range, must NOT be in range"
Assert-False (Test-HallVersionInRange -VersionText "v23.4.0" -RangeText ">=22.13.0 <23 || >=24.11.0 <25") "the unsupported Node 23 line must NOT be in range"
Assert-Throws { Test-HallVersionInRange -VersionText "v24.11.0" -RangeText "not a range" } "an unrecognized range format must throw, never silently pass"

# Get-HallRequiredVersions — reads engines/packageManager from a fixture package.json
$fixtureDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-prereq-test-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixtureDir -Force | Out-Null
try {
    $fixturePackageJson = @{
        engines = @{ node = ">=22.13.0 <23 || >=24.11.0 <25"; pnpm = ">=10.0.0 <11" }
        packageManager = "pnpm@10.33.0"
    } | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $fixtureDir "package.json") -Value $fixturePackageJson -Encoding utf8

    $versions = Get-HallRequiredVersions -RepoRoot $fixtureDir
    Assert-Equal ">=22.13.0 <23 || >=24.11.0 <25" $versions.NodeRange "NodeRange should come from package.json engines.node"
    Assert-Equal ">=10.0.0 <11" $versions.PnpmRange "PnpmRange should come from package.json engines.pnpm"
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

$nodeResult = Test-HallNodePrerequisite -RequiredRange ">=22.13.0 <23 || >=24.11.0 <25"
Assert-True $nodeResult.Ok "a supported Node.js version must be present in this environment"

$pnpmResult = Test-HallPnpmPrerequisite -RequiredRange ">=10.0.0 <11"
Assert-True $pnpmResult.Ok "a supported pnpm version must be present in this environment"

Write-Host "  (Prerequisites.Tests.ps1: all assertions passed)"
