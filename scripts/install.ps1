# Sets up the message archive for the current Windows user:
#   1) creates the archive folder   2) registers automatic collection (at logon + daily)
#   3) creates a desktop shortcut   4) runs the first collection
# No administrator rights are needed. Run again at any time to repair the setup.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

# --- Node.js check
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
$ver = [version]((& $node --version).TrimStart('v'))
if ($ver -lt [version]'22.13.0') { throw "Node.js 22.13 or newer is required (found $ver)." }
Write-Host "Node.js $ver : $node"

# --- archive folder
New-Item -ItemType Directory -Force -Path $cfg.archiveDir | Out-Null
Write-Host "Archive folder: $($cfg.archiveDir)"

# --- scheduled task (current user only)
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" `
  -Argument ('"{0}"' -f (Join-Path $root 'scripts\collect-hidden.vbs')) -WorkingDirectory $root
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$atLogon.Delay = 'PT2M'
$daily = New-ScheduledTaskTrigger -Daily -At $cfg.dailyCollectTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $cfg.taskName -Action $action -Trigger @($atLogon, $daily) `
  -Settings $settings -Principal $principal -Force `
  -Description 'Gen Messenger message archive: copies new messages into the local archive.' | Out-Null
Write-Host "Scheduled task registered: $($cfg.taskName) (at logon + daily $($cfg.dailyCollectTime))"

# --- desktop shortcut
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop ($cfg.shortcutName + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$lnk.Arguments = '"{0}"' -f (Join-Path $root 'scripts\open-archive.vbs')
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$env:SystemRoot\System32\imageres.dll,15"
$lnk.Description = 'Gen Messenger message archive'
$lnk.Save()
Write-Host "Desktop shortcut: $lnkPath"

# --- first collection
Write-Host 'Running first collection...'
& $node --no-warnings (Join-Path $root 'src\collect.mjs')
if ($LASTEXITCODE -ne 0) { throw 'First collection failed. See the logs folder in the archive.' }
Write-Host 'Done.'
