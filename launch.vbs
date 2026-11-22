' Proxy Lab launcher: starts the local node server (hidden) then opens an app window.
' Written by DSH. ASCII only on purpose - VBScript files are best kept ANSI-safe.

Option Explicit

Dim fso, sh, base, nodeExe, edge, url, tries

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
url = "http://127.0.0.1:8787"

Function Alive()
  Dim h
  Alive = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.XMLHTTP.6.0")
  h.Open "GET", url & "/api/ping", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then Alive = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

If Not Alive() Then
  If Not fso.FileExists(nodeExe) Then
    MsgBox "Node.js not found at " & nodeExe, 16, "Proxy Lab"
    WScript.Quit 1
  End If
  sh.Run """" & nodeExe & """ """ & base & "\server.mjs""", 0, False
End If

tries = 0
Do While Not Alive() And tries < 80
  WScript.Sleep 250
  tries = tries + 1
Loop

If Not Alive() Then
  MsgBox "Server did not start. Run server.mjs manually to see the error.", 16, "Proxy Lab"
  WScript.Quit 1
End If

edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edge) Then edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"

If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=" & url & " --window-size=1220,940", 1, False
Else
  sh.Run url, 1, False
End If

WScript.Quit 0
