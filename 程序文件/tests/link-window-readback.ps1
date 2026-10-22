param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [string]$ContentPrefix = '',
  [int]$ExpectedCount = 0,
  [string]$ExpectedClosingText = '',
  [string]$ExpectedTailText = ''
)

$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$contentRoot=Join-Path $ProjectRoot '资料库'
$outputRoot=Join-Path $ProjectRoot '程序文件\logs\single-library'
[void][IO.Directory]::CreateDirectory($outputRoot)
$env:CONTENT_LIBRARY_ROOT=$contentRoot
Remove-Item Env:WECHAT_ARTICLE_LIBRARY_ROOT -ErrorAction SilentlyContinue
$script:readbackChecks=0
$script:readbackCliCalls=@()
$script:readbackOpenTargets=@()
$script:readbackDetails=$null

function Assert-Readback([bool]$Condition,[string]$Message){$script:readbackChecks++;if(-not $Condition){throw $Message}}
function Get-ReadbackSnapshot {
  $entries=@(Get-ChildItem -LiteralPath $contentRoot -File -Force -Recurse | Sort-Object FullName)
  $metadata=@($entries | ForEach-Object {$_.FullName+'|'+$_.Length+'|'+$_.LastWriteTimeUtc.Ticks}) -join "`n"
  $jsonHashes=@($entries | Where-Object {$_.Extension -eq '.json'} | ForEach-Object {$_.FullName+'|'+(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}) -join "`n"
  return [pscustomobject]@{count=$entries.Count;metadata=$metadata;jsonHashes=$jsonHashes}
}
$before=Get-ReadbackSnapshot

. (Join-Path $ProjectRoot '程序文件\link-window.ps1') -ProjectRoot $ProjectRoot -NoShow
$script:readbackOriginalCli=(Get-Item Function:Start-LinkCli).ScriptBlock
function Start-LinkCli([string[]]$Arguments){
  if($Arguments[0] -notin @('list','read','details')){throw ('只读窗口验收拒绝执行：'+$Arguments[0])}
  $script:readbackCliCalls+=,[string[]]$Arguments
  return & $script:readbackOriginalCli -Arguments $Arguments
}
function Start-LinkWorker {throw '只读窗口验收禁止处理队列。'}
function Invoke-LinkRetryScheduler {}
function Start-Process {param([string]$FilePath,$ArgumentList) $script:readbackOpenTargets += [pscustomobject]@{path=$FilePath;arguments=$ArgumentList}}
function Show-LinkResultDialog($Payload){$script:readbackDetails=$Payload}
function Wait-Readback {
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while($script:linkJob){
    $linkTimer.Stop()
    $payload=Get-ReaderProcessResult $script:linkJob
    if($null -ne $payload){
      $operation=$script:linkOperation
      $script:linkJob=$null
      Complete-LinkOperation $payload $operation
      Set-LinkControls
    }
    [Windows.Forms.Application]::DoEvents()
    $linkTimer.Stop()
    if([DateTime]::UtcNow -gt $deadline){throw '只读窗口验收等待超时。'}
    Start-Sleep -Milliseconds 20
  }
}

try {
  $linkTimer.Stop()
  $form.ShowInTaskbar=$false
  $form.StartPosition='Manual'
  $form.Location=New-Object Drawing.Point(-32000,-32000)
  $form.Show()
  $form.CreateControl()
  Refresh-LinkLibrary
  Wait-Readback
  $actualCount=$libraryList.Items.Count
  Assert-Readback ($actualCount -gt 0 -and ($ExpectedCount -eq 0 -or $actualCount -eq $ExpectedCount)) ('正式库条数不符：'+$actualCount)
  $targetIndex=-1
  for($index=0;$index -lt $actualCount;$index++){
    $candidate=$libraryList.Items[$index]
    $candidateItem=$candidate.Item
    if($candidate.ContentId.StartsWith($ContentPrefix) -and $candidateItem.platform -eq 'wechat' -and $candidateItem.textPath -and $candidateItem.readingPath -and $candidateItem.pdfPath -and $candidateItem.transcriptPath){$targetIndex=$index;break}
  }
  Assert-Readback ($targetIndex -ge 0) '找不到包含阅读页、PDF、全文及识别稿的公众号条目；可用ContentPrefix指定样本。'
  $libraryList.SelectedIndex=$targetIndex
  Wait-Readback
  $item=Get-LinkSelectedItem
  Assert-Readback ($item.contentId.StartsWith($ContentPrefix)) '窗口未选中指定正式条目。'
  Assert-Readback ($libraryGroup.Text -match ($actualCount.ToString()+' 条')) '窗口没有显示正确资料条数。'
  Assert-Readback ($form.Text.Contains($item.title) -and $hint.Text.Contains($item.directory)) '所选资料的标题或目录提示不匹配。'

  $detailsButton.PerformClick()
  Wait-Readback
  Assert-Readback ([bool]$script:readbackDetails.ok -and $script:readbackDetails.manifest.contentId -eq $item.contentId) '详情菜单未读取当前正式条目。'
  Assert-Readback (@($script:readbackDetails.assets).Count -gt 0) '正式条目详情没有资源记录。'

  foreach($spec in @(@($openReadingButton,[string]$item.readingPath),@($openPdfButton,[string]$item.pdfPath),@($openTranscriptButton,[string]$item.textPath))){
    Assert-Readback $spec[0].Enabled ('正式阅读入口不可用：'+$spec[0].Text)
    $spec[0].PerformClick()
    Assert-Readback ($script:readbackOpenTargets[-1].path -eq $spec[1]) ('按钮没有精确打开当前正式文件：'+$spec[0].Text)
    Assert-Readback ($tooltip.GetToolTip($spec[0]).Contains($spec[1])) ('按钮提示与实际文件不一致：'+$spec[0].Text)
    Assert-Readback (Test-Path -LiteralPath $spec[1] -PathType Leaf) ('正式文件缺失：'+$spec[1])
  }
  $openFolderButton.PerformClick()
  Assert-Readback ($script:readbackOpenTargets[-1].path -eq 'explorer.exe' -and $script:readbackOpenTargets[-1].arguments -eq (ConvertTo-ReaderArgument ([string]$item.directory))) '打开目录按钮未指向当前正式目录。'
  $fullText=[IO.File]::ReadAllText($item.textPath,[Text.Encoding]::UTF8)
  $ocrText=[IO.File]::ReadAllText($item.transcriptPath,[Text.Encoding]::UTF8)
  Assert-Readback ($item.textPath -ne $item.transcriptPath -and $fullText -ne $ocrText -and $fullText.Trim().Length -gt 0) '全文入口仍与单图识别稿混淆。'
  if($ExpectedClosingText){Assert-Readback ($fullText.Contains($ExpectedClosingText)) '全文缺少指定文章结尾段。'}
  if($ExpectedTailText){Assert-Readback ($fullText.Contains($ExpectedTailText)) '全文缺少指定文章尾部内容。'}

  $form.Size=$form.MinimumSize
  Set-LinkWorkspaceLayout
  [Windows.Forms.Application]::DoEvents()
  $linkTimer.Stop()
  foreach($control in @($searchBox,$searchButton,$allButton,$openReadingButton,$openPdfButton,$openTranscriptButton,$openVideoButton,$openFolderButton,$openSourceButton,$manageButton,$exportMenuButton,$importButton,$favoritesOnly)){
    Assert-Readback ($libraryGroup.ClientRectangle.Contains($control.Bounds)) ('真实最小窗口操作被裁切：'+$control.Text)
  }
  Set-LinkStatus '阅读页、PDF、文字稿均对应当前资料；文字稿包含整篇正文。'
  $form.Refresh()
  $screenshot=Join-Path $outputRoot 'actual-library-window.png'
  $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
  try{$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save($screenshot,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
  $after=Get-ReadbackSnapshot
  Assert-Readback ($before.count -eq $after.count -and $before.metadata -eq $after.metadata -and $before.jsonHashes -eq $after.jsonHashes) '正式库在只读窗口验收前后发生变化。'
  Assert-Readback (@($script:readbackCliCalls | Where-Object {$_[0] -notin @('list','read','details')}).Count -eq 0) '验收出现非读取命令。'
  [pscustomobject]@{
    ok=$true;checks=$script:readbackChecks;libraryCount=$libraryList.Items.Count;contentId=$item.contentId
    resourceCount=@($script:readbackDetails.assets).Count;directory=$item.directory;readingPath=$item.readingPath;pdfPath=$item.pdfPath;textPath=$item.textPath
    textCharacters=$fullText.Length;ocrCharacters=$ocrText.Length
    closingTextChecked=[bool]$ExpectedClosingText;tailTextChecked=[bool]$ExpectedTailText
    minimumWindow=($form.Width.ToString()+'x'+$form.Height);formalFilesUnchanged=$true;commands=$script:readbackCliCalls;screenshot=$screenshot
  }|ConvertTo-Json -Depth 6 -Compress
} finally {
  $linkTimer.Stop()
  if($script:linkJob){Stop-ReaderProcess $script:linkJob}
  $linkTimer.Dispose();$tooltip.Dispose();$manageMenu.Dispose();$exportMenu.Dispose();$form.Dispose()
}
