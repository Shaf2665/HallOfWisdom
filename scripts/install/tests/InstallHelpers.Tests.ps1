$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$env:HALL_INSTALL_PS1_UNDER_TEST = "1"
. (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "..") "..") "install.ps1")
Remove-Item Env:\HALL_INSTALL_PS1_UNDER_TEST

# -ConfigDirOverride is passed explicitly (rather than relying on the
# ambient $env:HALL_CONFIG_DIR default) throughout this block so these
# assertions are deterministic regardless of what happens to be set in the
# host running the test suite.
Assert-Throws { Get-HallInstallerConfigPath -LocalAppData "" -ConfigDirOverride "" } "an empty LOCALAPPDATA and no HALL_CONFIG_DIR override must throw, never silently resolve a relative config path"
$resolved = Get-HallInstallerConfigPath -LocalAppData "C:\Users\Test\AppData\Local" -ConfigDirOverride ""
Assert-Equal (Join-Path (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom") "config.json") $resolved "Get-HallInstallerConfigPath must mirror packages/hall-config's win32 config-path convention exactly"

# Finding 4: HALL_CONFIG_DIR must be checked first, mirroring
# resolveHallConfigDir in packages/hall-config/src/config-path.ts exactly.
$overridden = Get-HallInstallerConfigPath -LocalAppData "C:\Users\Test\AppData\Local" -ConfigDirOverride "C:\Custom\HallConfigDir"
Assert-Equal (Join-Path "C:\Custom\HallConfigDir" "config.json") $overridden "a set HALL_CONFIG_DIR override must win over LOCALAPPDATA"
$blankOverride = Get-HallInstallerConfigPath -LocalAppData "C:\Users\Test\AppData\Local" -ConfigDirOverride "   "
Assert-Equal (Join-Path (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom") "config.json") $blankOverride "a blank/whitespace-only HALL_CONFIG_DIR must be ignored, not treated as set (matches config-path.ts's .trim().length > 0 check)"

Assert-Equal "bound-value" (Read-HallAnswer -Prompt "x" -Default "default-value" -BoundValue "bound-value") "a bound (parameter) value must win over any prompt"
Assert-Equal "default-value" (Read-HallAnswer -Prompt "x" -Default "default-value" -NonInteractive) "-NonInteractive with no bound value must fall back to the default, never prompt"

# Finding 5: Get-HallAnswers coverage.

# (a0) -NonInteractive with neither an existing config nor an explicit
# workspace root must FAIL, never silently fall back to the caller's
# current directory: an unattended run launched from the wrong folder (the
# Hall repo itself, say) would otherwise persist that as the workspace.
# Every other field has a genuinely well-defined %LOCALAPPDATA%-derived
# default; workspaceRoot is the one that does not.
Assert-Throws { Get-HallAnswers -NonInteractive } "-NonInteractive with no existing config and no -BoundWorkspaceRoot must throw, never guess the workspace root from the current directory"
Assert-Throws { Get-HallAnswers -NonInteractive -BoundDataDir "C:\Some\Data" } "supplying other fields does not excuse a missing workspace root under -NonInteractive"

# (a) -NonInteractive with no -ExistingConfig: a fresh install must return
# all 8 fields populated with sensible defaults, never blank/null/zero.
$freshAnswers = Get-HallAnswers -NonInteractive -BoundWorkspaceRoot "C:\Fresh\Workspace"
Assert-Equal 1 $freshAnswers.schemaVersion "a fresh Get-HallAnswers result must have schemaVersion 1"
Assert-Equal "C:\Fresh\Workspace" $freshAnswers.workspaceRoot "a fresh Get-HallAnswers result must use the supplied workspaceRoot verbatim"
Assert-True ([bool]$freshAnswers.dataDir) "a fresh Get-HallAnswers result must populate dataDir with the derived default"
Assert-True ([bool]$freshAnswers.agentWorktreeRoot) "a fresh Get-HallAnswers result must populate agentWorktreeRoot with the derived default"
Assert-True ([bool]$freshAnswers.comparisonRoot) "a fresh Get-HallAnswers result with no existing config must populate comparisonRoot with the derived default, not leave it null"
Assert-Equal 4310 $freshAnswers.hallCorePort "a fresh Get-HallAnswers result must default hallCorePort to 4310"
Assert-Equal 3000 $freshAnswers.hallWebPort "a fresh Get-HallAnswers result must default hallWebPort to 3000"
Assert-Equal $false $freshAnswers.codexTrustedLocal "a fresh Get-HallAnswers result must default codexTrustedLocal to false"

# (b) -NonInteractive -ExistingConfig with a full set of fields, no bound
# overrides: the EXISTING config's values must win for hallCorePort,
# hallWebPort, codexTrustedLocal, and comparisonRoot - not the hardcoded
# defaults (the bug in Finding 3: an unattended `.\install.ps1
# -NonInteractive` on a machine with an existing config must never silently
# reset these to defaults).
$existingFull = [PSCustomObject]@{
    schemaVersion     = 1
    workspaceRoot     = "C:\Existing\Workspace"
    dataDir           = "C:\Existing\Data"
    agentWorktreeRoot = "C:\Existing\Worktrees"
    comparisonRoot    = "C:\Existing\Comparisons"
    hallCorePort      = 5555
    hallWebPort       = 6666
    codexTrustedLocal = $true
}
$inherited = Get-HallAnswers -NonInteractive -ExistingConfig $existingFull
Assert-Equal "C:\Existing\Workspace" $inherited.workspaceRoot "reconfigure defaults must inherit workspaceRoot from the existing config"
Assert-Equal "C:\Existing\Comparisons" $inherited.comparisonRoot "reconfigure defaults must inherit comparisonRoot from the existing config, not the derived default"
Assert-Equal 5555 $inherited.hallCorePort "reconfigure defaults must inherit hallCorePort from the existing config, not hardcode 4310"
Assert-Equal 6666 $inherited.hallWebPort "reconfigure defaults must inherit hallWebPort from the existing config, not hardcode 3000"
Assert-Equal $true $inherited.codexTrustedLocal "a NonInteractive reconfigure with no explicit -EnableCodexTrustedLocal must inherit codexTrustedLocal from the existing config, not hardcode false"

# (c) -NonInteractive -ExistingConfig with comparisonRoot explicitly $null:
# that must be preserved as $null (comparisons explicitly disabled), not
# silently replaced by the derived default.
$existingDisabledComparisons = [PSCustomObject]@{
    schemaVersion     = 1
    workspaceRoot     = "C:\Existing\Workspace"
    dataDir           = "C:\Existing\Data"
    agentWorktreeRoot = "C:\Existing\Worktrees"
    comparisonRoot    = $null
    hallCorePort      = 4310
    hallWebPort       = 3000
    codexTrustedLocal = $false
}
$disabledResult = Get-HallAnswers -NonInteractive -ExistingConfig $existingDisabledComparisons
Assert-True ($null -eq $disabledResult.comparisonRoot) "an existing config with comparisonRoot explicitly null must stay null (disabled), never be replaced by the derived default"

# (d) explicit -Bound* parameters still win over both the existing config
# and the defaults.
# existingFull.codexTrustedLocal is $true; the bound override below is
# deliberately the opposite ($false) so this assertion actually proves the
# explicit bind wins rather than passing by coincidence.
$boundOverrides = Get-HallAnswers -NonInteractive -ExistingConfig $existingFull `
    -BoundWorkspaceRoot "C:\Bound\Workspace" -BoundDataDir "C:\Bound\Data" -BoundAgentWorktreeRoot "C:\Bound\Worktrees" `
    -BoundComparisonRoot "C:\Bound\Comparisons" -BoundEnableCodexTrustedLocal $false -EnableCodexTrustedLocalExplicitlyBound
Assert-Equal "C:\Bound\Workspace" $boundOverrides.workspaceRoot "an explicit -BoundWorkspaceRoot must win over the existing config's workspaceRoot"
Assert-Equal "C:\Bound\Data" $boundOverrides.dataDir "an explicit -BoundDataDir must win over the existing config's dataDir"
Assert-Equal "C:\Bound\Worktrees" $boundOverrides.agentWorktreeRoot "an explicit -BoundAgentWorktreeRoot must win over the existing config's agentWorktreeRoot"
Assert-Equal "C:\Bound\Comparisons" $boundOverrides.comparisonRoot "an explicit -BoundComparisonRoot must win over the existing config's comparisonRoot"
Assert-Equal $false $boundOverrides.codexTrustedLocal "an explicit -BoundEnableCodexTrustedLocal:`$false (with -EnableCodexTrustedLocalExplicitlyBound) must win over the existing config's codexTrustedLocal of `$true"

# (e) an existing config that omits hallCorePort, hallWebPort,
# codexTrustedLocal, and comparisonRoot entirely (a schema-valid on-disk
# file that never had these default-backed fields written) must fall back
# to the DERIVED defaults - never silently bind to 0/0/$null, which is
# exactly the failure Finding 1's re-read-after-save fix exists to avoid.
# Built via ConvertFrom-Json (not a hand-built PSCustomObject) so the
# absent-property shape matches what Get-HallPersistedConfig actually
# produces from a real file on disk.
$existingSparse = '{"schemaVersion":1,"workspaceRoot":"C:/Existing/Workspace","dataDir":"C:/Existing/Data","agentWorktreeRoot":"C:/Existing/Worktrees"}' | ConvertFrom-Json
$sparseResult = Get-HallAnswers -NonInteractive -ExistingConfig $existingSparse
Assert-Equal 4310 $sparseResult.hallCorePort "an existing config omitting hallCorePort entirely must fall back to 4310, never 0"
Assert-Equal 3000 $sparseResult.hallWebPort "an existing config omitting hallWebPort entirely must fall back to 3000, never 0"
Assert-Equal $false $sparseResult.codexTrustedLocal "an existing config omitting codexTrustedLocal entirely must fall back to false"
Assert-True ([bool]$sparseResult.comparisonRoot) "an existing config omitting comparisonRoot entirely (property absent, not explicit null) must fall back to the derived default"

Write-Host "  (InstallHelpers.Tests.ps1: all assertions passed)"
