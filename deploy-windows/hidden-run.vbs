' Start the console service with NO visible window.
' Path is derived from this script's own location, so the folder can be moved/copied freely.
' Elevation is handled by the launcher (.cmd self-elevates via UAC); this child inherits it.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
runner = fso.BuildPath(root, "service-run.cmd")
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & runner & """", 0, False
