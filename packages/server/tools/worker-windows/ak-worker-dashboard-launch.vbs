' Launcher for the tray's "Open dashboard (live)" item.
'
' Starts ak-worker-dashboard.mjs and opens it in the default browser. Window mode
' 0 so the node invocation never flashes a console - the whole point of the tray
' is that the worker is invisible until it needs attention.
'
' Starting a second time is harmless: the server steps to the next free port and
' writes its real URL to dashboard.json, and --open aims the browser at whichever
' port it actually got.
Set shell = CreateObject("WScript.Shell")
scriptPath = Replace(WScript.ScriptFullName, WScript.ScriptName, "")   ' trailing backslash
shell.Run "cmd /c node """ & scriptPath & "ak-worker-dashboard.mjs"" --open", 0, False
