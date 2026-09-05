param(
  [switch]$SkipHttp,
  [string]$BaseUrl = 'http://127.0.0.1:8765'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build-dentalcad.ps1
  node .\audit\test.cjs
  git diff --check
  if (-not $SkipHttp) {
    powershell -NoProfile -ExecutionPolicy Bypass -File .\audit\http-smoke.ps1 -BaseUrl $BaseUrl
  }
  Write-Output 'ALL ACCEPTANCE GATES PASSED'
} finally {
  Pop-Location
}
