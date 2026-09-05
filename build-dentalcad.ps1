# DentalCAD build script - v3
# Reads original DentalCAD.html from the zip extract,
# extracts CSS/HTML body/JS modules into dentalcad-web/ source files,
# then assembles the final self-contained DentalCAD.html.
#
# Requirements:
#  - Read files with [System.IO.File]::ReadAllText using UTF8
#  - Build output with StringBuilder
#  - Write output with WriteAllText using UTF8 without BOM

$ErrorActionPreference = 'Stop'
$baseDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$origFile  = Join-Path $baseDir 'DentalCAD.html'
$srcDir    = "$baseDir\dentalcad-web"
$outFile   = "$baseDir\DentalCAD.html"

Write-Host "=== DentalCAD Build Script v3 ===" -ForegroundColor Cyan

# ─────────────────────────────────────────────────────────────
# PHASE 1: Read the original file
# ─────────────────────────────────────────────────────────────
Write-Host "`n[1] Reading original DentalCAD.html from zip extract..." -ForegroundColor Yellow
$src = [System.IO.File]::ReadAllText($origFile, [System.Text.Encoding]::UTF8)
# Normalize line endings to LF only for reliable processing
$src = $src.Replace("`r`n", "`n").Replace("`r", "`n")
Write-Host "    Size: $($src.Length) chars"

# Create directory structure
New-Item -ItemType Directory -Force -Path "$srcDir\css" | Out-Null
New-Item -ItemType Directory -Force -Path "$srcDir\js"  | Out-Null
Write-Host "    Created source directories"

# ─────────────────────────────────────────────────────────────
# PHASE 2: Extract CSS
# ─────────────────────────────────────────────────────────────
Write-Host "`n[2] Preserving modular CSS source..." -ForegroundColor Yellow
if (-not (Test-Path "$srcDir\css\style.css")) { throw "Missing modular style.css" }
$cssText = [System.IO.File]::ReadAllText("$srcDir\css\style.css", [System.Text.Encoding]::UTF8)
Write-Host "    Using style.css  ($($cssText.Length) chars)"

# ─────────────────────────────────────────────────────────────
# PHASE 3: Extract HTML body
# ─────────────────────────────────────────────────────────────
Write-Host "`n[3] Extracting HTML body..." -ForegroundColor Yellow
# Find <body> tag (works for minified and pretty-printed HTML)
$bodyStart = $src.IndexOf('<body')
if ($bodyStart -lt 0) { throw "Cannot find <body> tag" }
$bodyTagEnd = $src.IndexOf('>', $bodyStart)
if ($bodyTagEnd -lt 0) { throw "Cannot close <body> tag" }
$bodyContentStart = $bodyTagEnd + 1

# Find the scripts section start (the cdnjs three.js script tag)
$scriptsMarker = '<script src="https://cdnjs'
$scriptsPos = $src.IndexOf($scriptsMarker, $bodyContentStart)
if ($scriptsPos -lt 0) { throw "Cannot find cdnjs scripts marker" }

# Also look for <!-- Scripts comment before the script tag (various formats)
$commentPos = -1
# Search backwards from scriptsPos for any HTML comment mentioning Scripts
$searchFrom = $bodyContentStart
for ($ci = $scriptsPos - 1; $ci -gt $bodyContentStart; $ci--) {
    if ($src[$ci] -eq '<' -and $ci + 4 -lt $src.Length -and $src.Substring($ci, 4) -eq '<!--') {
        $cmtEnd = $src.IndexOf('-->', $ci)
        if ($cmtEnd -gt 0 -and $cmtEnd -lt $scriptsPos) {
            $cmtText = $src.Substring($ci, $cmtEnd - $ci + 3)
            if ($cmtText -like '*Scripts*' -or $cmtText -like '*scripts*') {
                $commentPos = $ci
                break
            }
        }
    }
}

$bodyEndPos = if ($commentPos -gt $bodyContentStart) { $commentPos } else { $scriptsPos }

# Trim trailing whitespace/newlines from body content
$htmlBody = $src.Substring($bodyContentStart, $bodyEndPos - $bodyContentStart).TrimEnd()
Write-Host "    HTML body extracted  ($($htmlBody.Length) chars)"

# ─────────────────────────────────────────────────────────────
# PHASE 4: Extract JS modules
# ─────────────────────────────────────────────────────────────
Write-Host "`n[4] Extracting JS modules..." -ForegroundColor Yellow

# Find the inline <script> block (after the cdnjs script tag)
$inlineScriptOpen = '<script>'
$inlineStart = $src.IndexOf($inlineScriptOpen, $scriptsPos)
if ($inlineStart -lt 0) { throw "Cannot find inline <script> block" }
$jsBlockStart = $inlineStart + $inlineScriptOpen.Length

$inlineScriptClose = '</script>'
$jsBlockEnd = $src.IndexOf($inlineScriptClose, $jsBlockStart)
if ($jsBlockEnd -lt 0) { throw "Cannot find </script> close" }

$jsBlock = $src.Substring($jsBlockStart, $jsBlockEnd - $jsBlockStart)
Write-Host "    JS block: $($jsBlock.Length) chars"

# Define module extraction boundaries
# The original file uses:
#   First module (stl-parser): starts directly at block start with // ═══... header
#   Subsequent modules:        // === module.js ===
#
# Strategy: find each module's start/end using known boundaries

# Module boundaries in the original (using markers that exist):
# stl-parser: from start of jsBlock to before "// === project-io.js ==="
# project-io: from "// === project-io.js ===" to "// === undo-redo.js ==="
# etc.

$modMarkers = @(
    [PSCustomObject]@{ name='stl-parser';   start='/* === stl-parser === */'; end='/* === project-io === */' }
    [PSCustomObject]@{ name='project-io';   start='/* === project-io === */'; end='/* === undo-redo === */' }
    [PSCustomObject]@{ name='undo-redo';    start='/* === undo-redo === */'; end='/* === logger === */' }
    [PSCustomObject]@{ name='logger';       start='/* === logger === */'; end='/* === analysis === */' }
    [PSCustomObject]@{ name='analysis';     start='/* === analysis === */'; end='/* === manufacturing === */' }
    [PSCustomObject]@{ name='manufacturing';start='/* === manufacturing === */'; end='/* === tools === */' }
    [PSCustomObject]@{ name='tools';        start='/* === tools === */'; end='/* === viewport === */' }
    [PSCustomObject]@{ name='viewport';     start='/* === viewport === */'; end='/* === dental-chart === */' }
    [PSCustomObject]@{ name='dental-chart'; start='/* === dental-chart === */'; end='/* === wizard === */' }
    [PSCustomObject]@{ name='wizard';       start='/* === wizard === */'; end='/* === app === */' }
    [PSCustomObject]@{ name='app';          start='/* === app === */'; end='' }
)

Write-Host "    Modular source extraction skipped; source files are authoritative." -ForegroundColor DarkGray

# ─────────────────────────────────────────────────────────────
# PHASE 5: Build index.html source file
# ─────────────────────────────────────────────────────────────
Write-Host "`n[5] Preserving modular index.html source..." -ForegroundColor Yellow
if (-not (Test-Path "$srcDir\index.html")) { throw "Missing modular index.html" }

# ─────────────────────────────────────────────────────────────
# PHASE 6: Re-read source files and assemble the combined HTML
# ─────────────────────────────────────────────────────────────
Write-Host "`n[6] Re-reading source files and assembling DentalCAD.html..." -ForegroundColor Yellow

$cssContent      = [System.IO.File]::ReadAllText("$srcDir\css\style.css",        [System.Text.Encoding]::UTF8)
$stlParserJs     = [System.IO.File]::ReadAllText("$srcDir\js\stl-parser.js",     [System.Text.Encoding]::UTF8)
$projectIoJs     = [System.IO.File]::ReadAllText("$srcDir\js\project-io.js",     [System.Text.Encoding]::UTF8)
$undoRedoJs      = [System.IO.File]::ReadAllText("$srcDir\js\undo-redo.js",      [System.Text.Encoding]::UTF8)
$loggerJs        = [System.IO.File]::ReadAllText("$srcDir\js\logger.js",         [System.Text.Encoding]::UTF8)
$analysisJs      = [System.IO.File]::ReadAllText("$srcDir\js\analysis.js",       [System.Text.Encoding]::UTF8)
$manufacturingJs = [System.IO.File]::ReadAllText("$srcDir\js\manufacturing.js",  [System.Text.Encoding]::UTF8)
$toolsJs         = [System.IO.File]::ReadAllText("$srcDir\js\tools.js",          [System.Text.Encoding]::UTF8)
$viewportJs      = [System.IO.File]::ReadAllText("$srcDir\js\viewport.js",       [System.Text.Encoding]::UTF8)
$dentalChartJs   = [System.IO.File]::ReadAllText("$srcDir\js\dental-chart.js",   [System.Text.Encoding]::UTF8)
$wizardJs        = [System.IO.File]::ReadAllText("$srcDir\js\wizard.js",         [System.Text.Encoding]::UTF8)
$appJs           = [System.IO.File]::ReadAllText("$srcDir\js\app.js",            [System.Text.Encoding]::UTF8)

# Extract body from index.html
$idxText     = [System.IO.File]::ReadAllText("$srcDir\index.html", [System.Text.Encoding]::UTF8)
$idxText     = $idxText.Replace("`r`n", "`n").Replace("`r", "`n")
$bodyOpenIdx = "<body>`n"
$bodyPosIdx  = $idxText.IndexOf($bodyOpenIdx)
if ($bodyPosIdx -lt 0) { throw "No <body> in index.html" }
$bodyStartIdx = $bodyPosIdx + $bodyOpenIdx.Length

# Find the Scripts comment or cdnjs script
$scriptsCmtIdx = -1
$cdnjsIdx = $idxText.IndexOf("<script src=""https://cdnjs", $bodyStartIdx)
# Search for any comment mentioning Scripts
for ($ci = $cdnjsIdx - 1; $ci -gt $bodyStartIdx; $ci--) {
    if ($idxText[$ci] -eq '<' -and $ci + 4 -lt $idxText.Length -and $idxText.Substring($ci, 4) -eq '<!--') {
        $cmtEnd = $idxText.IndexOf('-->', $ci)
        if ($cmtEnd -gt 0 -and $cmtEnd -lt $cdnjsIdx) {
            $cmtText = $idxText.Substring($ci, $cmtEnd - $ci + 3)
            if ($cmtText -like '*Scripts*' -or $cmtText -like '*scripts*') {
                $scriptsCmtIdx = $ci
                break
            }
        }
    }
}
$bodyEndIdx = if ($scriptsCmtIdx -gt 0) { $scriptsCmtIdx } elseif ($cdnjsIdx -gt 0) { $cdnjsIdx } else { throw "Cannot find script section in index.html" }

$htmlBodyFinal = $idxText.Substring($bodyStartIdx, $bodyEndIdx - $bodyStartIdx).TrimEnd()

# Build the combined file using StringBuilder
$sb = [System.Text.StringBuilder]::new(700000)
[void]$sb.AppendLine('<!DOCTYPE html>')
[void]$sb.AppendLine('<html lang="en">')
[void]$sb.AppendLine('<head>')
[void]$sb.AppendLine('<meta charset="UTF-8"/>')
[void]$sb.AppendLine('<meta name="viewport" content="width=device-width,initial-scale=1.0"/>')
[void]$sb.AppendLine('<title>DentalCAD ' + [char]0x2014 + ' Dental Design System</title>')
[void]$sb.AppendLine('<style>')
[void]$sb.AppendLine($cssContent)
[void]$sb.AppendLine('</style>')
[void]$sb.AppendLine('</head>')
[void]$sb.AppendLine('<body>')
[void]$sb.AppendLine($htmlBodyFinal)
[void]$sb.AppendLine('<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>')
[void]$sb.AppendLine('<script>')
[void]$sb.AppendLine('// === stl-parser.js ===')
[void]$sb.AppendLine($stlParserJs)
[void]$sb.AppendLine('// === project-io.js ===')
[void]$sb.AppendLine($projectIoJs)
[void]$sb.AppendLine('// === undo-redo.js ===')
[void]$sb.AppendLine($undoRedoJs)
[void]$sb.AppendLine('// === logger.js ===')
[void]$sb.AppendLine($loggerJs)
[void]$sb.AppendLine('// === analysis.js ===')
[void]$sb.AppendLine($analysisJs)
[void]$sb.AppendLine('// === manufacturing.js ===')
[void]$sb.AppendLine($manufacturingJs)
[void]$sb.AppendLine('// === tools.js ===')
[void]$sb.AppendLine($toolsJs)
[void]$sb.AppendLine('// === viewport.js ===')
[void]$sb.AppendLine($viewportJs)
[void]$sb.AppendLine('// === dental-chart.js ===')
[void]$sb.AppendLine($dentalChartJs)
[void]$sb.AppendLine('// === wizard.js ===')
[void]$sb.AppendLine($wizardJs)
[void]$sb.AppendLine('// === app.js ===')
[void]$sb.AppendLine($appJs)
[void]$sb.AppendLine('</script>')
[void]$sb.AppendLine('</body>')
[void]$sb.Append('</html>')

$finalContent = $sb.ToString()

# Write without BOM
[System.IO.File]::WriteAllText($outFile, $finalContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "    Wrote: $outFile"

# ─────────────────────────────────────────────────────────────
# PHASE 7: Verification
# ─────────────────────────────────────────────────────────────
Write-Host "`n[7] Verifying output..." -ForegroundColor Yellow

$bytes    = [System.IO.File]::ReadAllBytes($outFile)
$firstByte = $bytes[0]
$verify   = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)

if ($firstByte -eq 60) {
    Write-Host "    PASS: First byte = 60 ('<', no BOM)" -ForegroundColor Green
} else {
    Write-Warning "FAIL: First byte = $firstByte (expected 60)"
}

$checks = [ordered]@{
    'const STLParser'      = $verify.Contains('const STLParser')
    'const Wizard'         = $verify.Contains('const Wizard')
    'const Viewport'       = $verify.Contains('const Viewport')
    'DOMContentLoaded'     = $verify.Contains('DOMContentLoaded')
    'id="viewport-canvas"' = $verify.Contains('id="viewport-canvas"')
}

foreach ($k in $checks.Keys) {
    if ($checks[$k]) { Write-Host "    PASS: contains '$k'" -ForegroundColor Green }
    else             { Write-Warning "FAIL: does NOT contain '$k'" }
}

$sizeKB = [math]::Round($bytes.Length / 1024, 1)
Write-Host "`n    File size: $sizeKB KB" -ForegroundColor Cyan
Write-Host "`n=== Build complete! ===" -ForegroundColor Cyan
