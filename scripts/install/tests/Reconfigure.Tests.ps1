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
  // Deliberately no self-guard on structurallyInvalid here: this command
  // must ALWAYS write when invoked, so the test can tell "Invoke-HallReconfigure
  // correctly never called save" apart from "it incorrectly called save,
  // but this fake happened to no-op anyway". A sentinel marker file is
  // written alongside the config path so a test can assert save was never
  // CALLED, not just that its effects looked absent.
  const fs = require("fs");
  const nodePath = require("path");
  fs.writeFileSync(path, stdin);
  fs.writeFileSync(nodePath.join(nodePath.dirname(path), "save-was-called.marker"), "called");
  console.log(JSON.stringify({ saved: true, path }));
  process.exit(0);
}
process.exit(1);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

$fakeServer = @'
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--workspace-root");
const workspaceRoot = rootIndex === -1 ? "" : args[rootIndex + 1];
if (workspaceRoot.includes("trigger-verify-failure")) { console.error("simulated verify-only failure"); process.exit(2); }
const webOriginIndex = args.indexOf("--web-origin");
const webOrigin = webOriginIndex === -1 ? "" : args[webOriginIndex + 1];
// Proves Invoke-HallReconfigure actually passes the candidate's hallWebPort
// through to Invoke-HallVerifyOnly (as --web-origin), not just workspaceRoot.
if (webOrigin.includes("64999")) { console.error("simulated verify-only failure (web-origin port marker)"); process.exit(5); }
console.log("OK: installation verified.");
process.exit(0);
'@
Set-Content -LiteralPath (Join-Path $serverDistDir "server.js") -Value $fakeServer -Encoding utf8

try {
    $configPath = Join-Path $fixtureRoot "config.json"
    # Written alongside $configPath by the fake CLI's "save" command only
    # when save is actually invoked (see the fixture above) - this is the
    # side effect Case 2 asserts on, since the fake "save" command no
    # longer self-guards on the structural-failure marker.
    $saveMarkerPath = Join-Path $fixtureRoot "save-was-called.marker"
    Set-Content -LiteralPath $configPath -Value '{"schemaVersion":1,"workspaceRoot":"D:\\OriginalActive","comparisonRoot":null,"hallCorePort":4310,"hallWebPort":3000,"codexTrustedLocal":false}' -Encoding utf8
    $originalContent = Get-Content -LiteralPath $configPath -Raw

    # Case 1: verify-only fails -> active config must be untouched, Stage reported precisely.
    $failingCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\trigger-verify-failure"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $failResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $failingCandidate
    Assert-False $failResult.Success "a candidate that fails --verify-only must not be promoted"
    Assert-Equal "verify-only" $failResult.Stage "the failure stage must be reported as verify-only, not save"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config file must be byte-for-byte untouched after a failed verify-only"
    Assert-False (Test-Path -LiteralPath $saveMarkerPath) "save must never be called when verify-only fails"

    # Case 2: structural validation fails -> verify-only (and save) must never even run. The
    # fake CLI's "save" command always writes $configPath AND $saveMarkerPath when invoked
    # (no self-guard on the structural-failure marker), so this genuinely proves
    # Invoke-HallReconfigure never called Invoke-HallConfigSave here - not merely that the
    # fake happened to no-op.
    $structurallyBadCandidate = @{ schemaVersion = 1; workspaceRoot = "trigger-structural-failure"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $structResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $structurallyBadCandidate
    Assert-False $structResult.Success "a structurally invalid candidate must not be promoted"
    Assert-Equal "structural-validation" $structResult.Stage "the failure stage must be reported as structural-validation"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config file must be untouched after a structural-validation failure"
    Assert-False (Test-Path -LiteralPath $saveMarkerPath) "save must never be called when structural validation fails, even though the fake CLI's save command no longer self-guards"

    # Case 3: a candidate's hallWebPort must actually reach --verify-only (not be silently
    # dropped/ignored) - Invoke-HallReconfigure must pass it through to Invoke-HallVerifyOnly.
    $badWebPortCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\NewActiveWorkspace"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 64999; codexTrustedLocal = $false }
    $webPortResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $badWebPortCandidate
    Assert-False $webPortResult.Success "a candidate whose hallWebPort fails --verify-only must not be promoted"
    Assert-Equal "verify-only" $webPortResult.Stage "the failure stage must be reported as verify-only when hallWebPort fails verification"
    Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the active config file must be untouched after a hallWebPort verify-only failure"
    Assert-False (Test-Path -LiteralPath $saveMarkerPath) "save must never be called when hallWebPort fails verify-only"

    # Case 4: everything passes -> active config is promoted (overwritten) exactly once, atomically.
    $goodCandidate = @{ schemaVersion = 1; workspaceRoot = "D:\NewActiveWorkspace"; comparisonRoot = $null; hallCorePort = 4310; hallWebPort = 3000; codexTrustedLocal = $false }
    $successResult = Invoke-HallReconfigure -RepoRoot $fixtureRoot -ConfigPath $configPath -Candidate $goodCandidate
    Assert-True $successResult.Success "a fully valid candidate must be promoted"
    Assert-Equal "complete" $successResult.Stage "a successful reconfigure must report stage complete"
    $promotedContent = Get-Content -LiteralPath $configPath -Raw
    Assert-True ($promotedContent -like "*NewActiveWorkspace*") "the active config file must now contain the promoted candidate's workspaceRoot"
    Assert-True (Test-Path -LiteralPath $saveMarkerPath) "save must actually be called on a successful reconfigure - confirms the marker fixture itself is not a permanent no-op"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (Reconfigure.Tests.ps1: all assertions passed)"
