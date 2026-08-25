Option Explicit

Dim shell, fileSystem, scriptsDirectory, projectRoot, syncScript, powerShellExe, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptsDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fileSystem.GetParentFolderName(scriptsDirectory)
syncScript = fileSystem.BuildPath(scriptsDirectory, "Sync-JianDaoYun.ps1")
powerShellExe = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")

shell.CurrentDirectory = projectRoot
command = """" & powerShellExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & syncScript & """"
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode
