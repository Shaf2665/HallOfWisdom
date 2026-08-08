$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$env:HALL_INSTALL_PS1_UNDER_TEST = "1"
. (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "..") "..") "install.ps1")
Remove-Item Env:\HALL_INSTALL_PS1_UNDER_TEST

Assert-Throws { Get-HallInstallerConfigPath -LocalAppData "" } "an empty LOCALAPPDATA must throw, never silently resolve a relative config path"
$resolved = Get-HallInstallerConfigPath -LocalAppData "C:\Users\Test\AppData\Local"
Assert-Equal (Join-Path (Join-Path "C:\Users\Test\AppData\Local" "HallOfWisdom") "config.json") $resolved "Get-HallInstallerConfigPath must mirror packages/hall-config's win32 config-path convention exactly"

Assert-Equal "bound-value" (Read-HallAnswer -Prompt "x" -Default "default-value" -BoundValue "bound-value") "a bound (parameter) value must win over any prompt"
Assert-Equal "default-value" (Read-HallAnswer -Prompt "x" -Default "default-value" -NonInteractive) "-NonInteractive with no bound value must fall back to the default, never prompt"

Write-Host "  (InstallHelpers.Tests.ps1: all assertions passed)"
