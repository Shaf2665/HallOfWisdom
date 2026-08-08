# Derives Hall's default machine-local paths, sibling to
# packages/hall-config's own config-file location logic
# (%LOCALAPPDATA%\HallOfWisdom on Windows) — see
# docs/architecture/0017-persistent-hall-configuration.md. comparisonRoot
# gets a real default here (Correction 2: comparisons are a normal
# setting, not dev-only) rather than being silently left disabled.
function Get-HallDefaultPaths {
    param([string]$LocalAppData = $env:LOCALAPPDATA)
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
        throw "LOCALAPPDATA is not set; cannot derive default Hall paths. Pass -LocalAppData explicitly."
    }
    $base = Join-Path $LocalAppData "HallOfWisdom"
    [PSCustomObject]@{
        DataDir           = Join-Path $base "data"
        AgentWorktreeRoot = Join-Path $base "agent-worktrees"
        ComparisonRoot    = Join-Path $base "comparisons"
    }
}
