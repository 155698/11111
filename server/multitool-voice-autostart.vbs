' Start MultiVoice web server hidden at Windows logon
Set shell = CreateObject("WScript.Shell")
AppDir = "C:\Users\dimas\OneDrive\Документы\MultiTool\HomeChats\Chat-18\multitool-voice\server"
shell.CurrentDirectory = AppDir
shell.Run """C:\Program Files\nodejs\node.exe"" dist/index.cjs", 0, False