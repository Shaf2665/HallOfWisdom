# Verify-before-promote reconfiguration (Correction 4 — never
# write-active-then-rollback). The active config file at $ConfigPath is
# read exactly nowhere in this function's write path until the very last
# step, and only once every earlier stage has succeeded.
function Invoke-HallReconfigure {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)]$Candidate
    )
    $structural = Invoke-HallConfigValidate -RepoRoot $RepoRoot -ConfigPath $ConfigPath -Candidate $Candidate
    if ($structural.ExitCode -ne 0) {
        return [PSCustomObject]@{ Success = $false; Stage = "structural-validation"; Errors = $structural.Result.errors }
    }

    $verify = Invoke-HallVerifyOnly `
        -RepoRoot $RepoRoot `
        -WorkspaceRoot $Candidate.workspaceRoot `
        -DataDir $Candidate.dataDir `
        -AgentWorktreeRoot $Candidate.agentWorktreeRoot `
        -ComparisonRoot $Candidate.comparisonRoot `
        -Port $Candidate.hallCorePort `
        -HallWebPort $Candidate.hallWebPort `
        -EnableCodexTrustedLocal:([bool]$Candidate.codexTrustedLocal)

    if (-not $verify.Success) {
        return [PSCustomObject]@{ Success = $false; Stage = "verify-only"; Errors = @($verify.Output) }
    }

    $saved = Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath $ConfigPath -Candidate $Candidate
    if ($saved.ExitCode -ne 0) {
        return [PSCustomObject]@{ Success = $false; Stage = "save"; Errors = $saved.Result.errors }
    }

    [PSCustomObject]@{ Success = $true; Stage = "complete"; Errors = @() }
}
