function Get-HallServerDistPath {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $distPath = Join-Path $RepoRoot "apps/server/dist/server.js"
    if (-not (Test-Path -LiteralPath $distPath)) {
        throw "Hall Core build not found at '$distPath' - run 'pnpm --filter @hall-of-wisdom/hall-core run build' first."
    }
    return $distPath
}

# Wraps `node dist/server.js --verify-only ...` — see
# apps/server/src/verify-only/run-verify-only.ts and
# docs/architecture/0017-persistent-hall-configuration.md for exactly what
# this preflight does and, just as importantly, does not do (never
# runRestartRecovery, never app.listen(), never fences a live instance).
# Every argument is passed as an array element, never a concatenated
# shell string.
function Invoke-HallVerifyOnly {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$WorkspaceRoot,
        [string]$DataDir,
        [string]$AgentWorktreeRoot,
        [string]$ComparisonRoot,
        [int]$Port = 4310,
        [int]$HallWebPort,
        [switch]$EnableCodexTrustedLocal
    )
    $distPath = Get-HallServerDistPath -RepoRoot $RepoRoot
    $arguments = @($distPath, "--workspace-root", $WorkspaceRoot, "--port", $Port, "--verify-only")
    if ($DataDir) { $arguments += @("--data-dir", $DataDir) }
    if ($AgentWorktreeRoot) { $arguments += @("--agent-worktree-root", $AgentWorktreeRoot) }
    if ($ComparisonRoot) { $arguments += @("--comparison-root", $ComparisonRoot) }
    if ($EnableCodexTrustedLocal) { $arguments += "--enable-codex-trusted-local" }
    # Deriving the origin the same way apps/server/src/config/resolve-server-config.ts
    # does (http://127.0.0.1:<hallWebPort>) so a candidate's hallWebPort is actually
    # verified (parseWebOrigin validates it) instead of silently falling back to
    # whatever the active config's hallWebPort happens to be.
    if ($HallWebPort) { $arguments += @("--web-origin", "http://127.0.0.1:$HallWebPort") }

    # Isolate this spawned process from the machine's real, still-active
    # %LOCALAPPDATA%\HallOfWisdom\config.json. apps/server/src/server.ts
    # unconditionally calls tryLoadConfig() with no argument, which (per
    # packages/hall-config/src/config-path.ts) reads that active persisted
    # config for ANY field this function did not pass above as an explicit
    # CLI flag. Without this isolation, a reconfiguration candidate that
    # clears comparisonRoot (or codexTrustedLocal, or hallWebPort) would
    # silently verify against the STALE active value for that field instead
    # of the candidate's actual intent, since reconfiguration hasn't
    # promoted the candidate yet. Point HALL_CONFIG_DIR (the override
    # HALL_CONFIG_DIR_ENV_OVERRIDE names, from @hall-of-wisdom/hall-config)
    # at a freshly created, guaranteed-empty temp directory unique to this
    # call so every unset field falls back only to Hall Core's own built-in
    # defaults, never to the active config. A fixed/reused path would let
    # concurrent or successive calls race or leak state into each other, so
    # a new GUID-suffixed directory is created every call.
    $isolatedConfigDir = Join-Path ([System.IO.Path]::GetTempPath()) "hall-verify-only-isolated-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path $isolatedConfigDir -Force | Out-Null
    $previousHallConfigDir = $env:HALL_CONFIG_DIR
    $env:HALL_CONFIG_DIR = $isolatedConfigDir

    # Windows PowerShell 5.1 converts merged stderr text (2>&1) from a
    # native command into a terminating NativeCommandError whenever
    # $ErrorActionPreference is "Stop" (pwsh 7 does not do this - it
    # captures stderr as plain strings). Scope ErrorActionPreference to
    # "Continue" for just this call so a non-zero exit with stderr output
    # is captured and returned, not thrown, on both hosts.
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & node @arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        # Assigning $null to an env: drive item removes it entirely, which
        # is what we want when HALL_CONFIG_DIR was not set before this call.
        $env:HALL_CONFIG_DIR = $previousHallConfigDir
        Remove-Item -LiteralPath $isolatedConfigDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    [PSCustomObject]@{
        ExitCode = $exitCode
        Success  = ($exitCode -eq 0)
        Output   = ($output -join [Environment]::NewLine)
    }
}
