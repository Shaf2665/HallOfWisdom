<#
.SYNOPSIS
    Crosses the REAL PowerShell -> Node stdin JSON boundary, under every
    PowerShell host installed on this machine.
.DESCRIPTION
    HallConfigCli.Tests.ps1 and Reconfigure.Tests.ps1 both pipe into a fake
    dist/cli.js that never calls JSON.parse on stdin (it only does a
    substring check), and run-cli.test.ts feeds the real parser from Node,
    never from a PowerShell pipe. That combination let two encoding bugs
    through three task-level reviews:

      * Windows PowerShell 5.1 under chcp 65001 (Windows 11's "Use Unicode
        UTF-8 for worldwide language support") prepends a UTF-8 BOM to
        piped stdin; JSON.parse rejects the leading U+FEFF outright.
      * Windows PowerShell 5.1 defaults $OutputEncoding to ASCIIEncoding,
        turning every non-ASCII character into "?" - silently, since "?"
        still passes hall-config's path pre-checks and is then persisted
        into a path where it is a reserved character.

    So this file uses the real packages/hall-config/dist/cli.js and asserts
    an exact round-trip of a non-ASCII path, in BOTH directions (what the
    CLI echoes back on stdout, and what it wrote to disk), under BOTH pwsh
    and powershell.exe, with and without a BOM-emitting $OutputEncoding.
#>
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$realCli = Join-Path $repoRoot "packages/hall-config/dist/cli.js"
if (-not (Test-Path -LiteralPath $realCli)) {
    Write-Host "  (HallConfigStdinEncoding.Tests.ps1: SKIPPED - '$realCli' is not built."
    Write-Host "   Run 'pnpm --filter @hall-of-wisdom/hall-config run build' to enable this test.)" -ForegroundColor Yellow
    return
}

# The worker runs in a child process so it can be launched under a host
# other than the one running this file. It asserts by throwing and reports
# via its exit code. Kept free of non-ASCII source characters - the
# non-ASCII test data is built from a code point at runtime, so this file's
# own on-disk encoding can never be what makes the test pass or fail.
$worker = @'
param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Mode)
$ErrorActionPreference = "Stop"
$tmp = $null
try {
    . (Join-Path $RepoRoot "scripts/install/HallConfigCli.ps1")

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "hall-stdin-enc-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null

    if ($Mode -eq "wrapper-non-ascii") {
        # "M<u+00FC>ller" - a realistic non-ASCII Windows user name, the
        # shape that reaches a real %LOCALAPPDATA%-derived default path.
        # Used for BOTH the config path (exercising the stdout decode) and
        # the workspace root (exercising the stdin encode).
        $nonAsciiDir = Join-Path $tmp ("M" + [char]0xFC + "ller")
        $configPath = Join-Path $nonAsciiDir "config.json"
        $workspaceRoot = Join-Path $nonAsciiDir "workspace"

        $candidate = [PSCustomObject]@{
            schemaVersion     = 1
            workspaceRoot     = $workspaceRoot
            dataDir           = (Join-Path $nonAsciiDir "data")
            agentWorktreeRoot = (Join-Path $nonAsciiDir "worktrees")
            comparisonRoot    = $null
            hallCorePort      = 4310
            hallWebPort       = 3000
            codexTrustedLocal = $false
        }

        $result = Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath $configPath -Candidate $candidate
        if ($result.ExitCode -ne 0) {
            throw "save exited $($result.ExitCode): $($result.Result.errors -join '; ')"
        }
        # Read direction: the CLI echoes the (non-ASCII) config path back
        # in its JSON result, which Invoke-HallConfigCli decodes using
        # [Console]::OutputEncoding before ConvertFrom-Json.
        if ($result.Result.path -ne $configPath) {
            throw "stdout round-trip corrupted: CLI echoed '$($result.Result.path)', expected '$configPath'"
        }
        # Write direction: what actually landed on disk after travelling
        # through $OutputEncoding into node's stdin.
        $saved = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved.workspaceRoot -ne $workspaceRoot) {
            throw "stdin round-trip corrupted: sent '$workspaceRoot', persisted '$($saved.workspaceRoot)'"
        }

        # `status` takes the OTHER branch of Invoke-HallConfigCli - no
        # stdin pipe, so it depends on [Console]::OutputEncoding alone.
        # install.ps1's "keep current configuration" path feeds exactly
        # this object to Invoke-HallInstallVerification, so a broken read
        # direction here would verify a mojibake workspace root.
        $status = Invoke-HallConfigStatus -RepoRoot $RepoRoot -ConfigPath $configPath
        if (-not $status.config) {
            throw "status reported no config for the file just saved: $($status.error)"
        }
        if ($status.config.workspaceRoot -ne $workspaceRoot) {
            throw "status stdout corrupted: reported '$($status.config.workspaceRoot)', expected '$workspaceRoot'"
        }
        exit 0
    }

    if ($Mode -eq "raw-bom") {
        # Invoke-HallConfigCli deliberately pins $OutputEncoding to a
        # NO-BOM UTF-8 encoding, which means the wrapper can no longer
        # produce a BOM at all - so a BOM regression in dist/cli.js is
        # unreachable through it. This mode therefore pipes straight into
        # `node dist/cli.js`, with a BOM-emitting $OutputEncoding, which is
        # exactly what Windows PowerShell 5.1 does under chcp 65001
        # (Windows 11's "Use Unicode UTF-8 for worldwide language
        # support"). It is the second, independent line of defence: the
        # CLI must tolerate a BOM from ANY caller, not only this wrapper.
        # ASCII-only paths here, so this stays a test about the BOM and
        # not about console decoding.
        $configPath = Join-Path $tmp "config.json"
        $candidate = [PSCustomObject]@{
            schemaVersion     = 1
            workspaceRoot     = (Join-Path $tmp "workspace")
            dataDir           = (Join-Path $tmp "data")
            agentWorktreeRoot = (Join-Path $tmp "worktrees")
            comparisonRoot    = $null
            hallCorePort      = 4310
            hallWebPort       = 3000
            codexTrustedLocal = $false
        }
        $cliPath = Get-HallConfigCliPath -RepoRoot $RepoRoot
        $previousOutputEncoding = $global:OutputEncoding
        try {
            # [System.Text.Encoding]::UTF8 has the BOM preamble enabled.
            $global:OutputEncoding = [System.Text.Encoding]::UTF8
            $json = $candidate | ConvertTo-Json -Depth 10
            $stdout = $json | & node @($cliPath, "save", "--path", $configPath)
            $exitCode = $LASTEXITCODE
        } finally {
            $global:OutputEncoding = $previousOutputEncoding
        }
        if ($exitCode -ne 0) {
            throw "a BOM-prefixed stdin payload must still be parsed (exit $exitCode): $stdout"
        }
        if (-not (Test-Path -LiteralPath $configPath)) {
            throw "the CLI reported success but wrote no config at '$configPath'"
        }
        exit 0
    }

    throw "unknown mode '$Mode'"
} catch {
    Write-Host "WORKER FAILED: $($_.Exception.Message)"
    exit 1
} finally {
    if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
'@

$workerRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-stdin-enc-worker-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $workerRoot -Force | Out-Null
$workerPath = Join-Path $workerRoot "stdin-encoding-worker.ps1"
# -Encoding ascii deliberately: Windows PowerShell 5.1's `-Encoding utf8`
# writes a BOM, and a test about BOM handling should not depend on one.
Set-Content -LiteralPath $workerPath -Value $worker -Encoding ascii

try {
    # The outer @(...) is required: on Windows PowerShell 5.1 a
    # single-match Where-Object returns a bare scalar with no .Count, so
    # the assertion below would fail on a machine with only one host
    # installed - a false pass waiting to happen in the very test written
    # to prevent false passes.
    $hosts = @(@("pwsh", "powershell") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue })
    Assert-True ($hosts.Count -gt 0) "at least one PowerShell host (pwsh or powershell) must be available"
    if ($hosts.Count -lt 2) {
        Write-Host "  (only these hosts are installed: $($hosts -join ', ') - cross-host coverage is partial)" -ForegroundColor Yellow
    }

    foreach ($hostExe in $hosts) {
        & $hostExe -NoProfile -File $workerPath -RepoRoot $repoRoot -Mode "wrapper-non-ascii"
        Assert-Equal 0 $LASTEXITCODE "a non-ASCII path must survive the PowerShell -> node stdin pipe (and node's stdout back) intact under host '$hostExe'"

        & $hostExe -NoProfile -File $workerPath -RepoRoot $repoRoot -Mode "raw-bom"
        Assert-Equal 0 $LASTEXITCODE "dist/cli.js must parse BOM-prefixed stdin (chcp 65001 behaviour) under host '$hostExe'"
    }
} finally {
    Remove-Item -LiteralPath $workerRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "  (HallConfigStdinEncoding.Tests.ps1: all assertions passed)"
