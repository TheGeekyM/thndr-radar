' Starts Thndr Radar without a console window: the bundled node runs the server and opens the app window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\node.exe"" """ & dir & "\app.mjs"" --open", 0, False
