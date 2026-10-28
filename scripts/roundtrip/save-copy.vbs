Option Explicit
' Usage: cscript //nologo save-copy.vbs <source.docx> <target.docx>
' Opens source read-only and saves a copy as target (Word re-save round).
' Never modifies source. ASCII-only comments: VBScript is parsed as ANSI.
Dim w, d, fso, src, dst, errNum, errDesc
src = WScript.Arguments(0)
dst = WScript.Arguments(1)
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(src) Then
  WScript.Echo "missing source: " & src
  WScript.Quit 2
End If
Set w = CreateObject("Word.Application")
w.Visible = False
w.DisplayAlerts = 0
w.Options.SaveNormalPrompt = False
On Error Resume Next
Set d = w.Documents.Open(src, False, True)
If Err.Number = 0 Then d.SaveAs2 dst, 16
errNum = Err.Number
errDesc = Err.Description
On Error GoTo 0
Cleanup
If errNum <> 0 Then
  WScript.Echo "resave error " & errNum & ": " & errDesc & " (" & dst & ")"
  WScript.Quit 3
End If
If fso.FileExists(dst) Then
  WScript.Echo "resaved: " & dst
  WScript.Quit 0
Else
  WScript.Echo "resave failed: " & dst
  WScript.Quit 1
End If

' Guaranteed cleanup: close doc and quit Word even after a failure,
' so an aborted SaveAs2 never orphans a hidden WINWORD process.
Sub Cleanup()
  On Error Resume Next
  If IsObject(d) Then d.Close False
  If IsObject(w) Then w.Quit
  On Error GoTo 0
End Sub
