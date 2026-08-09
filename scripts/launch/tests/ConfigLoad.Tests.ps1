$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "..") (Join-Path "install" "HallConfigCli.ps1"))
. (Join-Path (Join-Path $PSScriptRoot "..") "ConfigLoad.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-configload-test-$([guid]::NewGuid())"
$cliDir = Join-Path $fixtureRoot "packages/hall-config/dist"
New-Item -ItemType Directory -Path $cliDir -Force | Out-Null

$fakeCli = @'
const mode = process.env.HALL_TEST_CONFIG_MODE || "valid";
if (mode === "missing") {
  console.log(JSON.stringify({ exists: false, path: "C:\\fake\\config.json", config: null, error: null }));
} else if (mode === "invalid") {
  console.log(JSON.stringify({ exists: true, path: "C:\\fake\\config.json", config: null, error: "schema validation failed" }));
} else {
  console.log(JSON.stringify({ exists: true, path: "C:\\fake\\config.json", config: { schemaVersion: 1, workspaceRoot: "D:\\HallOfWisdom", comparisonRoot: null, hallCorePort: 4310, hallWebPort: 3000, codexTrustedLocal: false }, error: null }));
}
process.exit(0);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

$previousMode = $env:HALL_TEST_CONFIG_MODE
try {
    $env:HALL_TEST_CONFIG_MODE = "missing"
    $missingError = $null
    try { Get-HallLauncherConfig -RepoRoot $fixtureRoot | Out-Null } catch { $missingError = $_ }
    Assert-True ($null -ne $missingError) "a missing config must throw"
    Assert-True ($missingError.Exception.Message -like "*install.ps1*") "a missing-config error must point the user at install.ps1"

    $env:HALL_TEST_CONFIG_MODE = "invalid"
    $invalidError = $null
    try { Get-HallLauncherConfig -RepoRoot $fixtureRoot | Out-Null } catch { $invalidError = $_ }
    Assert-True ($null -ne $invalidError) "an invalid config must throw"
    Assert-True ($invalidError.Exception.Message -like "*schema validation failed*") "an invalid-config error must include the underlying reason"

    $env:HALL_TEST_CONFIG_MODE = "valid"
    $config = Get-HallLauncherConfig -RepoRoot $fixtureRoot
    Assert-Equal 4310 $config.hallCorePort "a valid config's hallCorePort should round-trip"
    Assert-Equal 3000 $config.hallWebPort "a valid config's hallWebPort should round-trip"
} finally {
    $env:HALL_TEST_CONFIG_MODE = $previousMode
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (ConfigLoad.Tests.ps1: all assertions passed)"
