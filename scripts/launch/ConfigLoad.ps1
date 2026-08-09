<#
Thin wrapper around scripts/install/HallConfigCli.ps1's Invoke-HallConfigStatus,
translating its three possible outcomes into either a normalized config
object or a clear, actionable thrown error. Deliberately calls
Invoke-HallConfigStatus with NO -ConfigPath, so the underlying hall-config
CLI resolves its own canonical path via resolveHallConfigFilePath() - the
exact same function apps/server/src/server.ts's tryLoadConfig() uses -
instead of this script recomputing it (design doc decision 3).
#>

function Get-HallLauncherConfig {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $status = Invoke-HallConfigStatus -RepoRoot $RepoRoot
    if (-not $status.exists) {
        throw "No persisted Hall configuration found at '$($status.path)'. Run .\install.ps1 first."
    }
    if (-not $status.config) {
        throw "The persisted Hall configuration at '$($status.path)' is invalid: $($status.error). Run .\install.ps1 and choose 'Reconfigure Hall', or fix that file manually."
    }
    $status.config
}
