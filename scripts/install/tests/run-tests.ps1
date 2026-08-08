param()
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$testFiles = Get-ChildItem -Path $here -Filter "*.Tests.ps1" | Sort-Object Name
$failed = @()

foreach ($file in $testFiles) {
    Write-Host "Running $($file.Name)..." -NoNewline
    try {
        & $file.FullName
        Write-Host " PASS" -ForegroundColor Green
    } catch {
        Write-Host " FAIL" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        $failed += $file.Name
    }
}

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "$($failed.Count) test file(s) failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "All $($testFiles.Count) test file(s) passed." -ForegroundColor Green
exit 0
