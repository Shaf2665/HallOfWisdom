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
        # An "incomplete" verification (a live Hall Core instance holds the
        # data directory, so the durable fingerprint compatibility check
        # never ran) is not a verification FAILURE - but it is emphatically
        # not grounds to promote either: the candidate's compatibility with
        # the already-recorded fingerprint is simply unknown. It stays
        # Success = $false; only the reported message differs, because the
        # raw preflight output reads like success and would mislead.
        $verifyErrors = if ($verify.Incomplete) {
            @(
                "Hall Core is currently running against this data directory, so its durable configuration compatibility could not be verified.",
                "Stop Hall Core, then reconfigure again."
            )
        } else {
            @($verify.Output)
        }
        return [PSCustomObject]@{ Success = $false; Stage = "verify-only"; Errors = $verifyErrors }
    }

    $saved = Invoke-HallConfigSave -RepoRoot $RepoRoot -ConfigPath $ConfigPath -Candidate $Candidate
    if ($saved.ExitCode -ne 0) {
        return [PSCustomObject]@{ Success = $false; Stage = "save"; Errors = $saved.Result.errors }
    }

    [PSCustomObject]@{ Success = $true; Stage = "complete"; Errors = @() }
}
