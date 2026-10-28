Option Explicit
' Usage: cscript //nologo save-copy.vbs <source.docx> <target.docx>
' Opens source read-only and saves a copy as target (Word re-save round).
' Never modifies source. ASCII-only comments: VBScript is parsed as ANSI.
Dim w, d, fso, src, dst
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
Set d = w.Documents.Open(src, False, True)
d.SaveAs2 dst, 16
d.Close False
w.Quit
If fso.FileExists(dst) Then
  WScript.Echo "resaved: " & dst
  WScript.Quit 0
Else
  WScript.Echo "resave failed: " & dst
  WScript.Quit 1
End If
