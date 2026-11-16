' Starts the archive viewer in the background (if not running) and opens it in the browser.
' Port must match "port" in config.json.
Const PORT = 8765
url = "http://127.0.0.1:" & PORT & "/"

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

Function IsUp()
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", url & "api/auth-state", False
  http.send
  IsUp = (Err.Number = 0 And http.status = 200)
  On Error GoTo 0
End Function

If Not IsUp() Then
  node = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
  If Not fso.FileExists(node) Then node = "node"
  sh.Run """" & node & """ --no-warnings """ & root & "\src\server.mjs""", 0, False
  ' The first launch builds the archive, which can take a little while.
  For i = 1 To 60
    WScript.Sleep 500
    If IsUp() Then Exit For
  Next
End If

sh.Run url
