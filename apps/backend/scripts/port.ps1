# Find (and optionally stop) the process listening on a TCP port.
param(
  [int]$Port = 4010,
  [switch]$Stop
)

$connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
$listeners = @($connections | Where-Object { $_.State -eq 'Listen' })
if ($listeners.Count -eq 0) {
  Write-Output "no LISTENING owner on port $Port"
  exit 0
}
foreach ($listener in $listeners) {
  $ownerPid = $listener.OwningProcess
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  Write-Output ("listening pid={0} name={1} started={2}" -f $ownerPid, $proc.ProcessName, $proc.StartTime)
  if ($Stop) {
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Write-Output ("stopped {0}" -f $ownerPid)
  }
}
