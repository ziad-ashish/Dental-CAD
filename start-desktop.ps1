$ErrorActionPreference = 'Stop'
$desktopRoot = Join-Path $PSScriptRoot 'desktop'
if (-not (Test-Path (Join-Path $desktopRoot 'node_modules'))) {
  throw 'Desktop dependencies are missing. Run: cd desktop; npm install'
}
Push-Location $desktopRoot
try { npm start } finally { Pop-Location }
