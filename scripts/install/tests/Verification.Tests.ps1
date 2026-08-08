$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Verification.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-verify-test-$([guid]::NewGuid())"
$serverDistDir = Join-Path $fixtureRoot "apps/server/dist"
New-Item -ItemType Directory -Path $serverDistDir -Force | Out-Null

# Mirrors run-verify-only.ts's observable contract just enough to test
# this wrapper: exit 0 unless --workspace-root contains the literal
# substring "trigger-verify-failure".
$fakeServer = @'
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--workspace-root");
const workspaceRoot = rootIndex === -1 ? "" : args[rootIndex + 1];
if (workspaceRoot.includes("trigger-verify-failure")) {
  console.error("simulated verify-only failure");
  process.exit(2);
}
console.log("OK: installation verified.");
process.exit(0);
'@
Set-Content -LiteralPath (Join-Path $serverDistDir "server.js") -Value $fakeServer -Encoding utf8

try {
    $distPath = Get-HallServerDistPath -RepoRoot $fixtureRoot
    Assert-Equal (Join-Path $serverDistDir "server.js") $distPath "Get-HallServerDistPath should resolve to apps/server/dist/server.js"

    $ok = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\HallOfWisdom"
    Assert-Equal 0 $ok.ExitCode "a normal workspace root should verify successfully"
    Assert-True $ok.Success "Success should be true on exit code 0"

    $bad = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\trigger-verify-failure"
    Assert-Equal 2 $bad.ExitCode "a workspace root that triggers the fake failure should propagate exit code 2"
    Assert-False $bad.Success "Success should be false on a non-zero exit code"

    Assert-Throws { Get-HallServerDistPath -RepoRoot "C:\definitely-does-not-exist-hall-test" } "a missing server.js must throw a clear 'run pnpm build first' error"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (Verification.Tests.ps1: all assertions passed)"
