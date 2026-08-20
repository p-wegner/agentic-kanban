' Launcher for the kanban-worker systray icon (path-portable: resolves its own folder).
'
' Window mode 0 (hidden), like fleet-tray-launch.vbs: this process lives behind a
' tray icon for the whole session, so a console window would be permanent clutter.
' The tray script guards itself with a named mutex, so launching twice is harmless.
Set shell = CreateObject("WScript.Shell")
scriptPath = Replace(WScript.ScriptFullName, WScript.ScriptName, "")   ' trailing backslash
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & "ak-worker-tray.ps1""", 0, False
