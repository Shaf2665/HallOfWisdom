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

    # Windows PowerShell 5.1 defaults $OutputEncoding to ASCIIEncoding, so
    # every non-ASCII character in piped stdin (e.g. a Windows user name
    # like "M<u+00FC>ller" inside a %LOCALAPPDATA%-derived default path)
    # silently becomes "?" before `node` ever sees it - and "?" is a
    # reserved character in Windows paths, so a corrupted path would be
    # accepted and persisted with no error at all.
    # [Console]::OutputEncoding is the mirror-image half: it decodes what
    # `node` writes back on stdout, which this function immediately parses
    # as JSON (the CLI echoes the config path back in its result).
    # Scoped narrowly around the native call and restored in `finally`,
    # matching the $ErrorActionPreference pattern in Invoke-HallVerifyOnly
    # (scripts/install/Verification.ps1). A no-BOM UTF8Encoding is used
    # deliberately: [System.Text.Encoding]::UTF8 emits a BOM preamble,
    # which is exactly the leading U+FEFF that dist/cli.js has to strip.
    # $global: is load-bearing, not stylistic: PowerShell resolves
    # $OutputEncoding for a native command's stdin from the GLOBAL scope, so
    # a plain function-local assignment here is silently ignored (verified
    # on 5.1 - a local assignment still produced "M?ller"). The global is
    # always restored in the `finally` below.
    $previousOutputEncoding = $global:OutputEncoding
    $previousConsoleOutputEncoding = [Console]::OutputEncoding
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    try {
        $global:OutputEncoding = $utf8NoBom
        [Console]::OutputEncoding = $utf8NoBom
        if ($CandidateJson) {
            $stdout = $CandidateJson | & node @arguments
        } else {
            $stdout = & node @arguments
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $global:OutputEncoding = $previousOutputEncoding
        [Console]::OutputEncoding = $previousConsoleOutputEncoding
    }

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
