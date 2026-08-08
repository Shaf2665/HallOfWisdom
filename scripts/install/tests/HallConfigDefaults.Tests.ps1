$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "HallConfigDefaults.ps1")

$defaults = Get-HallDefaultPaths -LocalAppData "C:\Users\Test\AppData\Local"
Assert-Equal (Join-Path (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom") "data") $defaults.DataDir "DataDir should be a sibling under HallOfWisdom"
Assert-Equal (Join-Path (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom") "agent-worktrees") $defaults.AgentWorktreeRoot "AgentWorktreeRoot should be a sibling under HallOfWisdom"
Assert-Equal (Join-Path (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom") "comparisons") $defaults.ComparisonRoot "ComparisonRoot should default to a sibling under HallOfWisdom (Correction 2)"

Assert-Throws { Get-HallDefaultPaths -LocalAppData "" } "an empty LocalAppData must throw, never silently default to a relative path"

Write-Host "  (HallConfigDefaults.Tests.ps1: all assertions passed)"
