# Re-exports scripts/install/tests/TestHelpers.ps1's Assert-* functions so
# every scripts/launch/tests/*.Tests.ps1 file can dot-source this ONE file
# instead of reaching across into scripts/install/tests/ with a relative
# path of its own.
. (Join-Path (Join-Path (Join-Path $PSScriptRoot "..") "..") (Join-Path "install" (Join-Path "tests" "TestHelpers.ps1")))
