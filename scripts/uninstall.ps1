# Removes automatic collection and the desktop shortcut, and stops the
# background archive viewer (and any running collection) started from this folder,
# so the folder is no longer locked and can be deleted or moved.
# The archive itself (archiveDir in config.json) is NOT deleted.

$root = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

Unregister-ScheduledTask -TaskName $cfg.taskName -Confirm:$false -ErrorAction SilentlyContinue
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($cfg.shortcutName + '.lnk')
if (Test-Path $lnk) { Remove-Item $lnk -Confirm:$false }

# Stop node processes running this folder's server.mjs / collect.mjs.
$srcDir = (Join-Path $root 'src').ToLower()
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($srcDir) }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
}
if ($procs) { Write-Host "Stopped $(@($procs).Count) running background process(es)." }

Write-Host "Removed scheduled task and shortcut. Archive kept at: $($cfg.archiveDir)"
