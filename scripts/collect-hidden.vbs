' Runs the collector without showing a console window (used by Task Scheduler).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(node) Then node = "node"
sh.Run """" & node & """ --no-warnings """ & root & "\src\collect.mjs""", 0, True
