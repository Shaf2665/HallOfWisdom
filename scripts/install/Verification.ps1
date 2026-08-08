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
        [switch]$EnableCodexTrustedLocal
    )
    $distPath = Get-HallServerDistPath -RepoRoot $RepoRoot
    $arguments = @($distPath, "--workspace-root", $WorkspaceRoot, "--port", $Port, "--verify-only")
    if ($DataDir) { $arguments += @("--data-dir", $DataDir) }
    if ($AgentWorktreeRoot) { $arguments += @("--agent-worktree-root", $AgentWorktreeRoot) }
    if ($ComparisonRoot) { $arguments += @("--comparison-root", $ComparisonRoot) }
    if ($EnableCodexTrustedLocal) { $arguments += "--enable-codex-trusted-local" }

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
    }
    [PSCustomObject]@{
        ExitCode = $exitCode
        Success  = ($exitCode -eq 0)
        Output   = ($output -join [Environment]::NewLine)
    }
}
