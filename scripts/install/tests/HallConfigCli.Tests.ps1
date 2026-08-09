$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "HallConfigCli.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-cli-test-$([guid]::NewGuid())"
$cliDir = Join-Path $fixtureRoot "packages/hall-config/dist"
New-Item -ItemType Directory -Path $cliDir -Force | Out-Null

# A fake CLI mirroring the real dist/cli.js JSON contract from
# packages/hall-config's run-cli.ts, so this file tests only the
# PowerShell wrapper's argument-passing / JSON round-trip, not
# hall-config's own business logic (already covered by run-cli.test.ts).
$fakeCli = @'
const path = process.argv[3] === "--path" ? process.argv[4] : undefined;
const command = process.argv[2];
if (command === "status") {
  console.log(JSON.stringify({ exists: false, path, config: null, error: null }));
  process.exit(0);
}
let stdin = "";
try { stdin = require("fs").readFileSync(0, "utf8"); } catch {}
const failing = stdin.includes("invalid-marker");
if (command === "validate") {
  console.log(JSON.stringify(failing ? { valid: false, errors: ["fake error"] } : { valid: true, errors: [] }));
  process.exit(failing ? 1 : 0);
}
if (command === "save") {
  console.log(JSON.stringify(failing ? { saved: false, errors: ["fake error"] } : { saved: true, path }));
  process.exit(failing ? 1 : 0);
}
process.exit(1);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

try {
    $configPath = Join-Path $fixtureRoot "config.json"

    $cliPath = Get-HallConfigCliPath -RepoRoot $fixtureRoot
    Assert-Equal (Join-Path $cliDir "cli.js") $cliPath "Get-HallConfigCliPath should resolve to packages/hall-config/dist/cli.js"

    $status = Invoke-HallConfigStatus -RepoRoot $fixtureRoot -ConfigPath $configPath
    Assert-Equal $false $status.exists "fake CLI status should report exists:false"
    Assert-Equal $configPath $status.path "status should echo back the --path argument exactly"

    $statusNoPath = Invoke-HallConfigStatus -RepoRoot $fixtureRoot
    Assert-True ($null -eq $statusNoPath.path) "status without -ConfigPath must omit --path, letting the CLI resolve its own canonical path (the fake CLI echoes back `$null when --path is absent)"

    $validCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\HallOfWisdom" }
    $validateResult = Invoke-HallConfigValidate -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $validCandidate
    Assert-Equal 0 $validateResult.ExitCode "a valid candidate should exit 0"
    Assert-Equal $true $validateResult.Result.valid "a valid candidate should report valid:true"

    $invalidCandidate = @{ schemaVersion = 1; workspaceRoot = "invalid-marker" }
    $invalidResult = Invoke-HallConfigValidate -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $invalidCandidate
    Assert-Equal 1 $invalidResult.ExitCode "an invalid candidate should exit 1"
    Assert-Equal $false $invalidResult.Result.valid "an invalid candidate should report valid:false"

    $saveResult = Invoke-HallConfigSave -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $validCandidate
    Assert-Equal 0 $saveResult.ExitCode "saving a valid candidate should exit 0"
    Assert-Equal $true $saveResult.Result.saved "saving a valid candidate should report saved:true"

    Assert-Throws { Get-HallConfigCliPath -RepoRoot "C:\definitely-does-not-exist-hall-test" } "a missing dist/cli.js must throw a clear 'run pnpm build first' error"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (HallConfigCli.Tests.ps1: all assertions passed)"
