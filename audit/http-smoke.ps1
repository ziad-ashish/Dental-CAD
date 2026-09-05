param([string]$BaseUrl = 'http://127.0.0.1:8765')
$paths = @('/dentalcad-web/index.html', '/DentalCAD.html', '/dentalcad-web/js/manufacturing.js')
$failed = 0
foreach ($path in $paths) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($BaseUrl.TrimEnd('/') + $path)
    if ($response.StatusCode -ne 200 -or $response.RawContentLength -le 0) { throw "unexpected response" }
    Write-Output "PASS $path $($response.StatusCode) bytes=$($response.RawContentLength)"
  } catch {
    $failed++
    Write-Output "FAIL $path $($_.Exception.Message)"
  }
}
if ($failed -gt 0) { exit 1 }
