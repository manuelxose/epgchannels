# Identify (and optionally stop) the process that serves the vertical API.
param(
  [int]$Port = 4010,
  [int]$ApiPort = 4020,
  [switch]$Stop
)

$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
$servers = @($processes | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dist[\\/]server[\\/]main\.js' })
if ($servers.Count -eq 0) {
  Write-Output "no backend process found"
} else {
  foreach ($server in $servers) {
    Write-Output ("backend pid={0} cmd={1}" -f $server.ProcessId, $server.CommandLine)
    if ($Stop) {
      Stop-Process -Id $server.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Output ("stopped {0}" -f $server.ProcessId)
    }
  }
}

foreach ($target in @($Port, $ApiPort)) {
  try {
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/v1/health" -f $target) -UseBasicParsing -TimeoutSec 3
    $body = $response.Content | ConvertFrom-Json
    Write-Output ("port {0} answers: status={1} uptime={2}s" -f $target, $body.status, $body.uptimeSeconds)
  } catch {
    Write-Output ("port {0} does not answer" -f $target)
  }
}
