param([string]$Directory = ".superpowers/previews/word-structures")

# Word COM 实开核对：对每个夹具与引擎导出各做一次 Word 实开核对（只读、不修复），再对导出另存一份回存件。
# 注意：manifest.json 为 UTF-8（无 BOM，Node 写出），所有 Get-Content/Set-Content 显式指定 -Encoding UTF8；
# 报告以 UTF-8（无 BOM）写出以保证 Node JSON.parse 可直接读取。本脚本以 UTF-8 BOM 保存，供 PS 5.1 正确解析中文常量。
# 另存轮经 save-copy.vbs（cscript）完成：本机 PowerShell 5.1 对 Word SaveAs2/SaveCopyAs 的 COM 调用会挂起
# （VBScript 同一调用正常，判定为 PowerShell IDispatch 封送问题），故只读核对留在 PowerShell、另存走 VBScript。
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Word COM 按自身进程工作目录解析相对路径（常为 C:\Windows\system32），必须先转为绝对路径。
$Directory = (Resolve-Path -LiteralPath $Directory).Path
$saveHelper = Join-Path $PSScriptRoot "save-copy.vbs"

Get-ChildItem -Path $Directory -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

$manifest = Get-Content (Join-Path $Directory "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json

$word = $null
$wordVersion = ""
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.Options.SaveNormalPrompt = $false
  $wordVersion = [string]$word.Version   # Quit() 之前取版本，避免 COM 释放顺序问题
} catch {
  Write-Output "Word COM 启动失败:$($_.Exception.Message)"
  exit 1
}

function Test-Expect($path, $expect) {
  $doc = $word.Documents.Open($path, $false, $true)  # ReadOnly
  try {
    $body = [string]$doc.Content.Text
    $headers = @()
    foreach ($section in $doc.Sections) {
      foreach ($hf in $section.Headers) { if ($hf.Exists) { $headers += $hf.Range.Text } }
      foreach ($hf in $section.Footers) { if ($hf.Exists) { $headers += $hf.Range.Text } }
    }
    $failures = @()
    foreach ($phrase in $expect.bodyContains) { if (-not $body.Contains($phrase)) { $failures += "正文缺少:$phrase" } }
    foreach ($phrase in $expect.headerContains) { if (-not (($headers -join "").Contains($phrase))) { $failures += "页眉页脚缺少:$phrase" } }
    if ($null -ne $expect.revisions -and $doc.Revisions.Count -ne $expect.revisions) { $failures += "修订数:$($doc.Revisions.Count)!=$($expect.revisions)" }
    if ($null -ne $expect.inlineShapesMin -and $doc.InlineShapes.Count -lt $expect.inlineShapesMin) { $failures += "行内图不足:$($doc.InlineShapes.Count)<$($expect.inlineShapesMin)" }
    if ($null -ne $expect.shapesMin -and $doc.Shapes.Count -lt $expect.shapesMin) { $failures += "浮动图/图形不足:$($doc.Shapes.Count)<$($expect.shapesMin)" }
    if ($null -ne $expect.fieldsMin -and $doc.Fields.Count -lt $expect.fieldsMin) { $failures += "域不足:$($doc.Fields.Count)<$($expect.fieldsMin)" }
    if ($null -ne $expect.tables -and $doc.Tables.Count -ne $expect.tables) { $failures += "表格数:$($doc.Tables.Count)!=$($expect.tables)" }
    if ($null -ne $expect.footnotesMin -and $doc.Footnotes.Count -lt $expect.footnotesMin) { $failures += "脚注不足:$($doc.Footnotes.Count)<$($expect.footnotesMin)" }
    return $failures
  } finally { $doc.Close($false) }
}

$results = @()
try {
  foreach ($item in $manifest) {
    $original = Join-Path $Directory $item.file
    $exported = Join-Path $Directory "engine/$($item.id).export.docx"
    $resaved = Join-Path $Directory "engine/$($item.id).word-resaved.docx"
    $entry = [ordered]@{ id = $item.id; original = @(); exported = @(); resaved = $false }
    try {
      $entry.original = @(Test-Expect $original $item.expect)
    } catch {
      $entry.original = @("Word 打开失败:$($_.Exception.Message)")
    }
    if (Test-Path $exported) {
      try {
        $entry.exported = @(Test-Expect $exported $item.expect)
      } catch {
        $entry.exported = @("Word 打开失败:$($_.Exception.Message)")
      }
      # 另存轮：cscript + save-copy.vbs（只读打开导出件并另存副本，不回写导出件）
      $saveOutput = & cscript //nologo $saveHelper $exported $resaved 2>&1
      if ($LASTEXITCODE -eq 0 -and (Test-Path $resaved)) {
        $entry.resaved = $true
      } else {
        $entry.exported += @("Word 另存失败:$($saveOutput -join ' ')")
      }
    } else {
      $entry.exported = @("缺少导出文件")
    }
    $results += [pscustomobject]$entry
    $status = if ($entry.original.Count -or $entry.exported.Count -or -not $entry.resaved) { "FAIL" } else { "OK" }
    Write-Output "$($item.id): $status 原样=$($entry.original.Count)项失败 导出=$($entry.exported.Count)项失败 另存=$($entry.resaved)"
    foreach ($detail in ($entry.original + $entry.exported)) { Write-Output "  - $detail" }
  }
} finally {
  $word.Quit()
}

# Set-Content -Encoding UTF8 在 PS 5.1 会带 BOM，改用 UTF8Encoding($false) 写无 BOM UTF-8，保证 Node JSON.parse 可读。
$report = [ordered]@{ wordVersion = $wordVersion; generatedAt = (Get-Date).ToString("o"); results = $results }
$json = $report | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $Directory "word-report.json"), $json, (New-Object System.Text.UTF8Encoding($false)))

$failed = @($results | Where-Object { $_.original.Count -or $_.exported.Count -or -not $_.resaved })
if ($failed.Count) {
  Write-Output "Word 核对失败 $($failed.Count) 项（Word $wordVersion，报告 word-report.json）"
  exit 1
}
Write-Output "Word 核对全部通过（$($results.Count) 项，Word $wordVersion）"
exit 0
