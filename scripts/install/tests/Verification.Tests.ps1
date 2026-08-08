$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "Verification.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-verify-test-$([guid]::NewGuid())"
$serverDistDir = Join-Path $fixtureRoot "apps/server/dist"
New-Item -ItemType Directory -Path $serverDistDir -Force | Out-Null

# Mirrors run-verify-only.ts's observable contract just enough to test this
# wrapper: exit 0 unless --workspace-root contains the literal substring
# "trigger-verify-failure". It also mirrors apps/server/src/server.ts's
# tryLoadConfig() fallback (packages/hall-config/src/config-path.ts): when
# --comparison-root is NOT passed explicitly, it falls back to reading
# comparisonRoot from <HALL_CONFIG_DIR>/config.json, exactly like the real
# binary falls back to the machine's active persisted config. This lets the
# tests below prove that Invoke-HallVerifyOnly's HALL_CONFIG_DIR isolation
# actually works, instead of merely asserting exit codes that would pass
# even if the isolation code were deleted. It also fails when --web-origin
# contains the literal substring "64999", proving hallWebPort is actually
# passed through and verified rather than silently inherited/ignored.
$fakeServer = @'
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
const workspaceRoot = argValue("--workspace-root") || "";
if (workspaceRoot.includes("trigger-verify-failure")) {
  console.error("simulated verify-only failure");
  process.exit(2);
}
// 5 = EXIT_VERIFICATION_INCOMPLETE (apps/server/src/config/server-config.ts):
// a live Hall Core instance holds the data dir, so the durable checks were
// skipped. Neither success nor failure.
if (workspaceRoot.includes("trigger-verify-incomplete")) {
  console.log("Hall Core is currently running against this data directory");
  process.exit(5);
}
let effectiveComparisonRoot = argValue("--comparison-root");
if (effectiveComparisonRoot === undefined) {
  const configDir = process.env.HALL_CONFIG_DIR;
  if (configDir) {
    const configPath = path.join(configDir, "config.json");
    if (fs.existsSync(configPath)) {
      try {
        // Strip a possible leading UTF-8 BOM: Windows PowerShell 5.1's
        // Set-Content -Encoding utf8 always writes one (pwsh 7's does not),
        // and an unstripped BOM makes JSON.parse throw.
        let raw = fs.readFileSync(configPath, "utf8");
        if (raw.charCodeAt(0) === 0xfeff) { raw = raw.slice(1); }
        const persisted = JSON.parse(raw);
        if (persisted && typeof persisted.comparisonRoot === "string") {
          effectiveComparisonRoot = persisted.comparisonRoot;
        }
      } catch {}
    }
  }
}
if (effectiveComparisonRoot && effectiveComparisonRoot.includes("trigger-verify-failure")) {
  console.error("simulated verify-only failure (inherited comparisonRoot from active config)");
  process.exit(3);
}
const webOrigin = argValue("--web-origin");
if (webOrigin && webOrigin.includes("64999")) {
  console.error("simulated verify-only failure (web-origin port marker)");
  process.exit(4);
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
    Assert-False $ok.Incomplete "a fully successful verification must never be reported as Incomplete"

    $bad = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\trigger-verify-failure"
    Assert-Equal 2 $bad.ExitCode "a workspace root that triggers the fake failure should propagate exit code 2"
    Assert-False $bad.Success "Success should be false on a non-zero exit code"
    Assert-False $bad.Incomplete "a genuine verification failure must not be reported as Incomplete"

    # Exit 5 (EXIT_VERIFICATION_INCOMPLETE) is the third outcome: a live
    # Hall Core instance holds the data directory, so the durable
    # storage/fingerprint checks never ran. It must be reported as neither
    # success nor an ordinary failure, or a caller cannot tell "skipped,
    # expected" apart from "fully verified".
    $incomplete = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\trigger-verify-incomplete"
    Assert-Equal 5 $incomplete.ExitCode "exit code 5 must be propagated verbatim"
    Assert-False $incomplete.Success "an incomplete verification must never be reported as success"
    Assert-True $incomplete.Incomplete "exit code 5 must be surfaced as Incomplete (keep in sync with EXIT_VERIFICATION_INCOMPLETE)"

    Assert-Throws { Get-HallServerDistPath -RepoRoot "C:\definitely-does-not-exist-hall-test" } "a missing server.js must throw a clear 'run pnpm build first' error"

    # --- HALL_CONFIG_DIR isolation (Finding 1) ---
    $activeConfigDir = Join-Path $fixtureRoot "active-config"
    New-Item -ItemType Directory -Path $activeConfigDir -Force | Out-Null
    # -Encoding ascii (not utf8): the content is plain ASCII, and Windows
    # PowerShell 5.1's Set-Content -Encoding utf8 always writes a UTF-8 BOM
    # (pwsh 7's does not), which would otherwise break the fake server's
    # JSON.parse of this file.
    Set-Content -LiteralPath (Join-Path $activeConfigDir "config.json") -Value '{"comparisonRoot":"D:\\trigger-verify-failure"}' -Encoding ascii

    $previousHallConfigDirForTest = $env:HALL_CONFIG_DIR
    $env:HALL_CONFIG_DIR = $activeConfigDir
    try {
        # Control: calling the fake server directly (bypassing the wrapper)
        # with HALL_CONFIG_DIR already pointed at the active config proves
        # the fixture's fallback logic is real - it must fail here, or the
        # isolation assertion below would be meaningless. Scoped
        # ErrorActionPreference to "Continue" for this raw native-command
        # call for the same reason Invoke-HallVerifyOnly itself does: on
        # Windows PowerShell 5.1, merged stderr (2>&1) from a native command
        # becomes a terminating NativeCommandError when ErrorActionPreference
        # is "Stop" (this file's top-level setting), which would abort
        # before $LASTEXITCODE could be read.
        $previousControlErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & node (Join-Path $serverDistDir "server.js") --workspace-root "D:\SomeWorkspace" --port 4310 --verify-only 2>&1 | Out-Null
            $controlExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousControlErrorActionPreference
        }
        Assert-Equal 3 $controlExitCode "control: without isolation the fake server must inherit the active config's comparisonRoot and fail"

        # Invoke-HallVerifyOnly must isolate this call from that same
        # active config - even though $env:HALL_CONFIG_DIR is already set
        # to it by this test - by pointing the spawned process at a fresh,
        # empty directory instead. No -ComparisonRoot is passed, so the
        # only way this can succeed is if the active config's comparisonRoot
        # (which would fail verification) was never read.
        $isolated = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\SomeWorkspace"
        Assert-Equal 0 $isolated.ExitCode "Invoke-HallVerifyOnly must isolate the spawned process from the active config instead of inheriting its comparisonRoot"
        Assert-True $isolated.Success "isolation should make an otherwise-failing candidate verify successfully"

        Assert-Equal $activeConfigDir $env:HALL_CONFIG_DIR "Invoke-HallVerifyOnly must restore the caller's original HALL_CONFIG_DIR value afterward"
    } finally {
        $env:HALL_CONFIG_DIR = $previousHallConfigDirForTest
    }

    # A candidate that explicitly clears comparisonRoot (by simply not
    # passing -ComparisonRoot, same as above) must not be rejected due to a
    # stale active comparisonRoot - already covered by $isolated above.
    # Confirm restoration also holds when no HALL_CONFIG_DIR was set at all
    # beforehand (the common case on a fresh shell).
    $previousHallConfigDirForTest2 = $env:HALL_CONFIG_DIR
    if (Test-Path -LiteralPath env:HALL_CONFIG_DIR) { Remove-Item -LiteralPath env:HALL_CONFIG_DIR }
    try {
        Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\HallOfWisdom" | Out-Null
        Assert-False (Test-Path -LiteralPath env:HALL_CONFIG_DIR) "Invoke-HallVerifyOnly must leave HALL_CONFIG_DIR unset if it was unset beforehand"
    } finally {
        if ($null -ne $previousHallConfigDirForTest2) { $env:HALL_CONFIG_DIR = $previousHallConfigDirForTest2 }
    }

    # --- -HallWebPort / --web-origin passthrough (Finding 1) ---
    $webOriginOk = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\HallOfWisdom" -HallWebPort 3000
    Assert-Equal 0 $webOriginOk.ExitCode "a normal hallWebPort should verify successfully"

    $webOriginBad = Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\HallOfWisdom" -HallWebPort 64999
    Assert-Equal 4 $webOriginBad.ExitCode "-HallWebPort must be passed through as --web-origin so it is actually verified"
    Assert-False $webOriginBad.Success "Success should be false when the derived --web-origin triggers the fake failure"

    # --- isolated temp directory cleanup (Finding 1) ---
    # Invoke-HallVerifyOnly creates a fresh, uniquely-named temp directory
    # for HALL_CONFIG_DIR isolation on every call and must remove it again
    # afterward - otherwise many reconfigure attempts over a machine's
    # lifetime would leak directories under %TEMP% indefinitely. Count
    # matching directories before and after a call instead of trying to
    # predict the GUID.
    $isolatedDirFilter = "hall-verify-only-isolated-*"
    $tempPathForCleanupCheck = [System.IO.Path]::GetTempPath()
    $beforeCount = @(Get-ChildItem -Path $tempPathForCleanupCheck -Filter $isolatedDirFilter -Directory -ErrorAction SilentlyContinue).Count
    Invoke-HallVerifyOnly -RepoRoot $fixtureRoot -WorkspaceRoot "D:\HallOfWisdom" | Out-Null
    $afterCount = @(Get-ChildItem -Path $tempPathForCleanupCheck -Filter $isolatedDirFilter -Directory -ErrorAction SilentlyContinue).Count
    Assert-Equal $beforeCount $afterCount "Invoke-HallVerifyOnly must remove its isolated HALL_CONFIG_DIR temp directory after each call, not leak it"
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (Verification.Tests.ps1: all assertions passed)"
