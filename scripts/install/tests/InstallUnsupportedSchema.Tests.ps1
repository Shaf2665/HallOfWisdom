<#
.SYNOPSIS
    A persisted config the authoritative schema rejects (e.g. a NEWER,
    unsupported schemaVersion) must never be silently overwritten by a
    reconfigure - interactively or unattended.
.DESCRIPTION
    install.ps1 detects an existing config with a raw, UNVALIDATED
    ConvertFrom-Json (Get-HallPersistedConfig), deliberately before any
    build exists, so the keep/reconfigure menu can appear first. Feeding
    that raw object to Get-HallAnswers is what made this dangerous:
    Get-HallAnswers harvests whatever v1-shaped fields happen to be present
    and emits a structurally valid schemaVersion:1 candidate, which then
    passes validation and DOWNGRADES the newer file on save.
    `install.ps1 -NonInteractive` auto-routes any existing config to
    reconfigure, so that corruption could happen with no prompt at all.

    This exercises the REAL Invoke-HallInstaller (not a reimplementation of
    its check) in a child process, because the fail-closed path calls
    `exit 1`, which would otherwise kill the test host. Only the expensive,
    irrelevant steps are shadowed (prerequisites, pnpm install/build,
    diagnostics); mode selection, the authoritative check, Get-HallAnswers
    and the save path are all the real thing, driven through a fake
    dist/cli.js modelled on packages/hall-config/src/run-cli.ts's exact
    JSON contract - the same build-free fixture style
    Reconfigure.Tests.ps1 uses.
#>
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-install-schema-test-$([guid]::NewGuid())"
$fixtureRepo = Join-Path $fixtureRoot "repo"
$cliDir = Join-Path $fixtureRepo "packages/hall-config/dist"
$configDir = Join-Path $fixtureRoot "hall-config"
New-Item -ItemType Directory -Path $cliDir, $configDir -Force | Out-Null

# Mirrors packages/hall-config/src/run-cli.ts's JSON contract exactly:
#   status  -> {exists,path,config,error}, always exit 0; config is null and
#              error is set when the authoritative parse rejects the file.
#   validate-> {valid,errors}
#   save    -> {saved,path}, plus a sentinel marker so a test can assert
#              save was never CALLED, not merely that it looked like a
#              no-op (the pattern Reconfigure.Tests.ps1 established).
# The rejection rule is the real one from schema.ts's hasNewerSchemaVersion:
# a schemaVersion above the highest supported (1) is refused outright.
$fakeCli = @'
const fs = require("fs");
const nodePath = require("path");
const command = process.argv[2];
const pathIndex = process.argv.indexOf("--path");
const configPath = pathIndex === -1 ? undefined : process.argv[pathIndex + 1];

if (command === "status") {
  if (!fs.existsSync(configPath)) {
    console.log(JSON.stringify({ exists: false, path: configPath, config: null, error: null }));
    process.exit(0);
  }
  let raw = fs.readFileSync(configPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) { raw = raw.slice(1); }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.log(JSON.stringify({ exists: true, path: configPath, config: null, error: String(error && error.message) }));
    process.exit(0);
  }
  if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > 1) {
    console.log(JSON.stringify({
      exists: true,
      path: configPath,
      config: null,
      error: "Hall configuration schema version " + parsed.schemaVersion + " is newer than the highest version this build supports (1). Refusing to load it.",
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({ exists: true, path: configPath, config: parsed, error: null }));
  process.exit(0);
}

let stdin = "";
try { stdin = require("fs").readFileSync(0, "utf8"); } catch {}
if (command === "validate") {
  console.log(JSON.stringify({ valid: true, errors: [] }));
  process.exit(0);
}
if (command === "save") {
  fs.writeFileSync(configPath, stdin);
  fs.writeFileSync(nodePath.join(nodePath.dirname(configPath), "save-was-called.marker"), "called");
  console.log(JSON.stringify({ saved: true, path: configPath }));
  process.exit(0);
}
process.exit(1);
'@
Set-Content -LiteralPath (Join-Path $cliDir "cli.js") -Value $fakeCli -Encoding utf8

# Runs in a child process: the code under test calls `exit 1` on the
# fail-closed path, which would terminate the test host otherwise. Kept
# free of non-ASCII characters.
$worker = @'
param(
    [Parameter(Mandatory)][string]$InstallPs1,
    [Parameter(Mandatory)][string]$FixtureRepo,
    [Parameter(Mandatory)][string]$Mode
)
$ErrorActionPreference = "Stop"
$env:HALL_INSTALL_PS1_UNDER_TEST = "1"
. $InstallPs1
Remove-Item Env:\HALL_INSTALL_PS1_UNDER_TEST

# Shadow only the expensive, irrelevant steps. Mode selection, the
# authoritative existing-config check, Get-HallAnswers and the save path
# stay real.
function Test-HallPrerequisitesOrExit { param([string]$RepoRoot) }
function Install-HallDependencies { param([string]$RepoRoot) }
function Invoke-HallBuild { param([string]$RepoRoot) }
function Invoke-HallDiagnostics { param([string]$RepoRoot) }

# Proves the guard is placed BEFORE any candidate is built: if
# Get-HallAnswers is ever reached, exit with a distinctive code instead of
# continuing. The supported-v1 control mode below asserts on exactly that
# code, so "the guard rejects everything" cannot masquerade as a pass.
function Get-HallAnswers {
    param([Parameter(ValueFromRemainingArguments)]$Rest)
    Write-Host "WORKER: Get-HallAnswers was reached"
    exit 7
}

if ($Mode -eq "noninteractive") {
    # install.ps1's Invoke-HallInstaller reads $NonInteractive from the
    # script scope this dot-source created, which is the same routing an
    # unattended `.\install.ps1 -NonInteractive` takes.
    $NonInteractive = $true
} elseif ($Mode -eq "menu") {
    # Interactive: choose "2. Reconfigure Hall" at the menu.
    function Read-Host { param([Parameter(Position = 0)][string]$Prompt) return "2" }
} else {
    throw "unknown mode '$Mode'"
}

Invoke-HallInstaller -RepoRoot $FixtureRepo
# Reaching here means the installer completed without exiting.
exit 0
'@

$workerPath = Join-Path $fixtureRoot "install-schema-worker.ps1"
# -Encoding ascii deliberately: the worker is pure ASCII and Windows
# PowerShell 5.1's -Encoding utf8 would prepend a BOM.
Set-Content -LiteralPath $workerPath -Value $worker -Encoding ascii

$installPs1 = Join-Path $repoRoot "install.ps1"
$configPath = Join-Path $configDir "config.json"
$saveMarkerPath = Join-Path $configDir "save-was-called.marker"

$previousHallConfigDir = $env:HALL_CONFIG_DIR
try {
    # Get-HallInstallerConfigPath checks HALL_CONFIG_DIR before
    # LOCALAPPDATA, so this fully isolates the test from the real machine
    # configuration regardless of the ambient environment.
    $env:HALL_CONFIG_DIR = $configDir

    $hostExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

    foreach ($mode in @("noninteractive", "menu")) {
        # A NEWER, unsupported schema version that is nevertheless perfectly
        # well-formed JSON containing every v1-shaped field - exactly the
        # shape the raw ConvertFrom-Json read cannot distinguish from a
        # supported config, and from which Get-HallAnswers would happily
        # build a schemaVersion:1 candidate.
        $unsupported = '{"schemaVersion":2,"workspaceRoot":"C:/Existing/Workspace","dataDir":"C:/Existing/Data","agentWorktreeRoot":"C:/Existing/Worktrees","comparisonRoot":null,"hallCorePort":4310,"hallWebPort":3000,"codexTrustedLocal":false,"somethingOnlyV2Understands":"must survive"}'
        Set-Content -LiteralPath $configPath -Value $unsupported -Encoding ascii
        $originalContent = Get-Content -LiteralPath $configPath -Raw
        if (Test-Path -LiteralPath $saveMarkerPath) { Remove-Item -LiteralPath $saveMarkerPath -Force }

        # Windows PowerShell 5.1 turns merged stderr (2>&1) from a native
        # command into a terminating NativeCommandError while
        # $ErrorActionPreference is "Stop", so scope it narrowly and
        # restore in `finally`, matching Invoke-HallVerifyOnly's pattern.
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $workerOutput = & $hostExe -NoProfile -File $workerPath -InstallPs1 $installPs1 -FixtureRepo $fixtureRepo -Mode $mode 2>&1
            $workerExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        $workerText = (@($workerOutput) -join " ")

        Assert-True ($workerExit -ne 0) "install.ps1 ($mode reconfigure) must fail closed on an unsupported persisted schema version, not proceed (worker exited $workerExit)"
        Assert-True ($workerExit -ne 7) "install.ps1 ($mode reconfigure) must reject the unsupported config BEFORE Get-HallAnswers ever builds a candidate from it"
        # Without this, the "menu" case passes vacuously: if the Read-Host
        # shadow ever stopped taking effect, a blank choice selects "keep",
        # whose own Invoke-HallConfigStatus check also exits 1 with no save
        # - satisfying every other assertion here while proving nothing
        # about the reconfigure route. The two branches print different
        # text, so match on the reconfigure guard's wording specifically.
        Assert-True ($workerText -like "*Refusing to reconfigure automatically*") "install.ps1 ($mode) must fail closed in the RECONFIGURE guard, not fall through to the keep branch's own check (got: '$workerText')"
        Assert-False (Test-Path -LiteralPath $saveMarkerPath) "save must never be called for a config the authoritative schema rejects ($mode)"
        Assert-Equal $originalContent (Get-Content -LiteralPath $configPath -Raw) "the unsupported config file must be byte-for-byte unchanged ($mode) - never silently downgraded to schemaVersion 1"
    }

    # Control: a SUPPORTED schemaVersion 1 file must sail past the same
    # guard and reach Get-HallAnswers (sentinel exit 7). Without this, a
    # guard that rejected every existing config would pass the assertions
    # above while breaking every real reconfigure.
    $supported = '{"schemaVersion":1,"workspaceRoot":"C:/Existing/Workspace","dataDir":"C:/Existing/Data","agentWorktreeRoot":"C:/Existing/Worktrees","comparisonRoot":null,"hallCorePort":4310,"hallWebPort":3000,"codexTrustedLocal":false}'
    Set-Content -LiteralPath $configPath -Value $supported -Encoding ascii
    if (Test-Path -LiteralPath $saveMarkerPath) { Remove-Item -LiteralPath $saveMarkerPath -Force }
    & $hostExe -NoProfile -File $workerPath -InstallPs1 $installPs1 -FixtureRepo $fixtureRepo -Mode "noninteractive" | Out-Null
    Assert-Equal 7 $LASTEXITCODE "a supported schemaVersion 1 config must pass the authoritative check and reach Get-HallAnswers normally"
} finally {
    $env:HALL_CONFIG_DIR = $previousHallConfigDir
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "  (InstallUnsupportedSchema.Tests.ps1: all assertions passed)"
