function Get-HallConfigCliPath {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $cliPath = Join-Path $RepoRoot "packages/hall-config/dist/cli.js"
    if (-not (Test-Path -LiteralPath $cliPath)) {
        throw "hall-config CLI not found at '$cliPath' - run 'pnpm --filter @hall-of-wisdom/hall-config run build' first."
    }
    return $cliPath
}

# Every argument to `node` is passed as an array element — never
# string-concatenated — so a path containing spaces or special characters
# is handled correctly and no `Invoke-Expression`/shell-string
# construction is ever used.
function Invoke-HallConfigCli {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][ValidateSet("status", "validate", "save")][string]$Command,
        [Parameter(Mandatory)][string]$ConfigPath,
        [string]$CandidateJson
    )
    $cliPath = Get-HallConfigCliPath -RepoRoot $RepoRoot
    $arguments = @($cliPath, $Command, "--path", $ConfigPath)

    if ($CandidateJson) {
        $stdout = $CandidateJson | & node @arguments
    } else {
        $stdout = & node @arguments
    }
    $exitCode = $LASTEXITCODE

    if (-not $stdout) {
        throw "hall-config CLI '$Command' produced no output (exit code $exitCode)."
    }
    $lastLine = @($stdout) | Select-Object -Last 1
    [PSCustomObject]@{
        ExitCode = $exitCode
        Result   = $lastLine | ConvertFrom-Json
    }
}

function Invoke-HallConfigStatus {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath)
    (Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "status" -ConfigPath $ConfigPath).Result
}

function Invoke-HallConfigValidate {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)]$Candidate)
    Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "validate" -ConfigPath $ConfigPath -CandidateJson ($Candidate | ConvertTo-Json -Depth 10)
}

function Invoke-HallConfigSave {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)]$Candidate)
    Invoke-HallConfigCli -RepoRoot $RepoRoot -Command "save" -ConfigPath $ConfigPath -CandidateJson ($Candidate | ConvertTo-Json -Depth 10)
}
