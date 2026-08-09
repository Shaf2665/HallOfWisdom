$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
. (Join-Path (Join-Path $PSScriptRoot "..") "WebBuildEnv.ps1")

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "hall-launch-webbuild-test-$([guid]::NewGuid())"
$webNextDir = Join-Path $fixtureRoot "apps/web/.next"
New-Item -ItemType Directory -Path $webNextDir -Force | Out-Null

# A fake pnpm that only understands "--filter @hall-of-wisdom/web run build":
# records whether NEXT_PUBLIC_HALL_CORE_URL was present in ITS OWN process
# environment (never a file - design doc decision 2/3) and whether a
# .env.local was ever created, then exits 0, or exits 1 if the marker
# fixture directory below signals it should fail.
$fakePnpmDir = Join-Path $fixtureRoot "fake-bin"
New-Item -ItemType Directory -Path $fakePnpmDir -Force | Out-Null
$callLogPath = Join-Path $fixtureRoot "pnpm-calls.log"
$fakePnpmScript = @'
@echo off
echo CALLED>>"%HALL_TEST_CALL_LOG%"
echo NEXT_PUBLIC_HALL_CORE_URL=%NEXT_PUBLIC_HALL_CORE_URL%>>"%HALL_TEST_CALL_LOG%"
if exist "%HALL_TEST_ENV_LOCAL_CHECK%" (
  echo ENV_LOCAL_EXISTS>>"%HALL_TEST_CALL_LOG%"
)
if "%HALL_TEST_FORCE_BUILD_FAILURE%"=="1" exit /b 1
exit /b 0
'@
Set-Content -LiteralPath (Join-Path $fakePnpmDir "pnpm.cmd") -Value $fakePnpmScript -Encoding ascii

$previousPath = $env:PATH
$previousCallLog = $env:HALL_TEST_CALL_LOG
$previousEnvLocalCheck = $env:HALL_TEST_ENV_LOCAL_CHECK
$previousForceFailure = $env:HALL_TEST_FORCE_BUILD_FAILURE
try {
    $env:PATH = "$fakePnpmDir;$previousPath"
    $env:HALL_TEST_CALL_LOG = $callLogPath
    $env:HALL_TEST_ENV_LOCAL_CHECK = Join-Path $fixtureRoot "apps/web/.env.local"
    $env:HALL_TEST_FORCE_BUILD_FAILURE = "0"

    # --- marker absent: rebuild triggered ---
    Remove-Item -LiteralPath $callLogPath -ErrorAction SilentlyContinue
    Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:4310"
    $callLog = Get-Content -LiteralPath $callLogPath -Raw
    Assert-True ($callLog -like "*CALLED*") "a missing marker must trigger a rebuild"
    Assert-True ($callLog -like "*NEXT_PUBLIC_HALL_CORE_URL=http://127.0.0.1:4310*") "the build must receive NEXT_PUBLIC_HALL_CORE_URL in its own process environment"
    Assert-False ($callLog -like "*ENV_LOCAL_EXISTS*") "no .env.local must ever be written"
    $marker = Get-HallWebBuildMarker -RepoRoot $fixtureRoot
    Assert-Equal "http://127.0.0.1:4310" $marker.hallCoreUrl "a successful build must write the marker with the built URL"

    # --- marker present, matching: no rebuild ---
    Remove-Item -LiteralPath $callLogPath -ErrorAction SilentlyContinue
    Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:4310"
    Assert-False (Test-Path -LiteralPath $callLogPath) "a matching marker must skip the rebuild entirely"

    # --- marker present, different URL (hallCorePort changed): rebuild triggered ---
    Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:5000"
    $callLog2 = Get-Content -LiteralPath $callLogPath -Raw
    Assert-True ($callLog2 -like "*NEXT_PUBLIC_HALL_CORE_URL=http://127.0.0.1:5000*") "a changed hallCorePort must trigger a rebuild with the new URL"
    $marker2 = Get-HallWebBuildMarker -RepoRoot $fixtureRoot
    Assert-Equal "http://127.0.0.1:5000" $marker2.hallCoreUrl "the marker must be rewritten to the new URL"

    # --- failing build: clear error, marker untouched ---
    $env:HALL_TEST_FORCE_BUILD_FAILURE = "1"
    Assert-Throws { Invoke-HallWebBuildIfStale -RepoRoot $fixtureRoot -HallCoreUrl "http://127.0.0.1:6000" } "a failing build must throw"
    $markerAfterFailure = Get-HallWebBuildMarker -RepoRoot $fixtureRoot
    Assert-Equal "http://127.0.0.1:5000" $markerAfterFailure.hallCoreUrl "a failed build must not rewrite the marker to the URL that failed to build"
} finally {
    $env:PATH = $previousPath
    $env:HALL_TEST_CALL_LOG = $previousCallLog
    $env:HALL_TEST_ENV_LOCAL_CHECK = $previousEnvLocalCheck
    $env:HALL_TEST_FORCE_BUILD_FAILURE = $previousForceFailure
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Host "  (WebBuildEnv.Tests.ps1: all assertions passed)"
