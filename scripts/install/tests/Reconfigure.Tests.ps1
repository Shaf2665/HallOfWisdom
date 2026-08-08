$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "HallConfigCli.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Verification.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Reconfigure.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-reconfigure-test-$([guid]::NewGuid())"
$cliDir = Join-Path $fixtureRoot "packages/hall-config/dist"
$serverDistDir = Join-Path $fixtureRoot "apps/server/dist"
New-Item -ItemType Directory -Path $cliDir -Force | Out-Null
New-Item -ItemType Directory -Path $serverDistDir -Force | Out-Null

$fakeCli = @'
const path = process.argv[3] === "--path" ? process.argv[4] : undefined;
const command = process.argv[2];
if (command === "status") { console.log(JSON.stringify({ exists: false, path, config: null, error: null })); process.exit(0); }
let stdin = "";
try { stdin = require("fs").readFileSync(0, "utf8"); } catch {}
const structurallyInvalid = stdin.includes("trigger-structural-failure");
if (command === "validate") {
  console.log(JSON.stringify(structurallyInvalid ? { valid: false, errors: ["fake structural error"] } : { valid: true, errors: [] }));
  process.exit(structurallyInvalid ? 1 : 0);
}
if (command === "save") {
  const fs = require("fs");
  if (!structurallyInvalid) { fs.writeFileSync(path, stdin); }
  console.log(JSON.stringify(structurallyInvalid ? { saved: false, errors: ["fake structural error"] } : { saved: true, path }));
  process.exit(structurallyInvalid ? 1 : 0);
}
process.exit(1);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

$fakeServer = @'
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--workspace-root");
const workspaceRoot = rootIndex === -1 ? "" : args[rootIndex + 1];
if (workspaceRoot.includes("trigger-verify-failure")) { console.error("simulated verify-only failure"); process.exit(2); }
console.log("OK: installation verified.");
process.exit(0);
'@
Set-Content -LiteralPath (Join-Path $serverDistDir "server.js") -Value $fakeServer -Encoding utf8

try {
    $configPath = Join-Path $fixtureRoot "config.json"
    Set-Content -LiteralPath $configPath -Value '{"schemaVersion":1,"workspaceRoot":"D:\\OriginalActive","comparisonRoot":null,"hallCorePort":4310,"hallWebPort":3000,"codexTrustedLocal":false}' -Encoding utf8
    $originalContent = Get-Content -LiteralPath $configPath -Raw

    # Case 1: verify-only fails -> active config must be untouched, Stage reported precisely.
    $failingCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\trigger-verify-failure"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $failResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $failingCandidate
    Assert-False $failResult.Success "a candidate that fails --verify-only must not be promoted"
    Assert-Equal "verify-only" $failResult.Stage "the failure stage must be reported as verify-only, not save"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config file must be byte-for-byte untouched after a failed verify-only"

    # Case 2: structural validation fails -> verify-only (and save) must never even run.
    $structurallyBadCandidate = @{ schemaVersion = 1; workspaceRoot = "trigger-structural-failure"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $structResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $structurallyBadCandidate
    Assert-False $structResult.Success "a structurally invalid candidate must not be promoted"
    Assert-Equal "structural-validation" $structResult.Stage "the failure stage must be reported as structural-validation"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config file must be untouched after a structural-validation failure"

    # Case 3: everything passes -> active config is promoted (overwritten) exactly once, atomically.
    $goodCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\NewActiveWorkspace"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $successResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $goodCandidate
    Assert-True $successResult.Success "a fully valid candidate must be promoted"
    Assert-Equal "complete" $successResult.Stage "a successful reconfigure must report stage complete"
    $promotedContent = Get-Content -LiteralPath $configPath -Raw
    Assert-True ($promotedContent -like "*NewActiveWorkspace*") "the active config file must now contain the promoted candidate's workspaceRoot"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (Reconfigure.Tests.ps1: all assertions passed)"
