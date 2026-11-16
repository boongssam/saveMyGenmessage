# Removes automatic collection and the desktop shortcut.
# The archive itself (archiveDir in config.json) is NOT deleted.

$root = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

Unregister-ScheduledTask -TaskName $cfg.taskName -Confirm:$false -ErrorAction SilentlyContinue
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($cfg.shortcutName + '.lnk')
if (Test-Path $lnk) { Remove-Item $lnk -Confirm:$false }
Write-Host "Removed scheduled task and shortcut. Archive kept at: $($cfg.archiveDir)"
