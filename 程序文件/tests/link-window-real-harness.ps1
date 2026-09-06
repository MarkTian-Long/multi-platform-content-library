param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$programRoot = Join-Path $ProjectRoot '程序文件'
$acceptanceRoot = Join-Path $programRoot 'logs\link-window-acceptance'
$runRoot = Join-Path $acceptanceRoot ('real-' + [guid]::NewGuid().ToString('N'))
$contentRoot = Join-Path $runRoot '资料库'
$legacyRoot = Join-Path $runRoot 'legacy-empty'
[void][IO.Directory]::CreateDirectory($contentRoot)
[void][IO.Directory]::CreateDirectory($legacyRoot)

function Write-Utf8Json([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
}
function New-FixtureContent([string]$Id, [string]$Platform, [string]$Title, [string]$SourceUrl, [string]$ImageName) {
  $directory = Join-Path $contentRoot ('items\' + $Id)
  [void][IO.Directory]::CreateDirectory($directory)
  [IO.File]::WriteAllText((Join-Path $directory 'content.md'), "# $Title`n`n离线测试资料。", (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $directory 'reading.html'), "<!doctype html><html><body><h1>$Title</h1></body></html>", (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $directory $ImageName), 'fixture-image', (New-Object Text.UTF8Encoding($false)))
  $manifest = [ordered]@{
    platform = $Platform; nativeId = $Id; sourceUrl = $SourceUrl; canonicalUrl = $SourceUrl; title = $Title
    capturedAt = '2026-09-06T12:00:00.000Z'; kind = 'article'; markdown = '# ' + $Title
    assets = @([ordered]@{ id = 'image-1'; role = 'image'; status = 'saved'; path = $ImageName; label = '封面' })
    warnings = @(); coverage = @{}; schemaVersion = 1; contentId = $Id; status = 'completed'; aliases = @($SourceUrl)
    updatedAt = '2026-09-06T12:00:00.000Z'; contentHash = 'fixture'; markdownFile = 'content.md'; bodyFile = 'content.md'; readingFile = 'reading.html'
  }
  Write-Utf8Json (Join-Path $directory 'content.json') $manifest
}

New-FixtureContent ('aaaaaaaaaaaaaaaaaaaaaaaa') 'web' '真实后端网页资料' 'https://example.com/fixture' 'fixture.txt'
New-FixtureContent ('bbbbbbbbbbbbbbbbbbbbbbbb') 'wechat' '真实后端微信资料' 'https://mp.weixin.qq.com/s/fixture' 'fixture.txt'

$oldContentRoot = $env:CONTENT_LIBRARY_ROOT
$oldLegacyRoot = $env:WECHAT_ARTICLE_LIBRARY_ROOT
$env:CONTENT_LIBRARY_ROOT = $contentRoot
$env:WECHAT_ARTICLE_LIBRARY_ROOT = $legacyRoot

function Assert-Window([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Wait-WindowOperation([int]$Seconds = 50) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while (($script:linkJob -or $script:linkWorkJob -or $script:linkPollJob) -and [DateTime]::UtcNow -lt $deadline) {
    [Windows.Forms.Timer].GetMethod('OnTick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($linkTimer, @([EventArgs]::Empty)) | Out-Null
    Start-Sleep -Milliseconds 35
  }
  Assert-Window ($null -eq $script:linkJob -and $null -eq $script:linkWorkJob -and $null -eq $script:linkPollJob) '真实后端窗口操作超时'
}

try {
  . (Join-Path $programRoot 'link-window.ps1') -ProjectRoot $ProjectRoot -NoShow
  $form.CreateControl()
  $form.PerformLayout()
  Assert-Window ($libraryRoot -eq $contentRoot) '窗口没有使用临时 CONTENT_LIBRARY_ROOT'
  Assert-Window ($form.ClientSize.Width -eq 1150 -and $form.ClientSize.Height -eq 760) '默认布局尺寸不正确'

  $inputBox.Text = 'Example 资料 https://example.com/'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($enqueueButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($queueList.Items.Count -eq 1) '真实 link-cli 没有入队'

  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($cancelButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($queueList.Items[0].Text -match 'cancelled|已取消') '真实 cancel 没有更新任务'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($retryButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($queueList.Items[0].Text -match 'queued|等待') '真实 retry 没有恢复任务'

  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($workButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  $workState = [string]$queueList.Items[0].Job.state
  $workMessage = [string]$queueList.Items[0].Job.message
  $networkLimited = $workState -eq 'failed' -and $workMessage -match '网络|连接|超时|fetch|ENOTFOUND|Edge|来源|访问'

  Refresh-LinkJobs
  Wait-WindowOperation
  Refresh-LinkLibrary
  Wait-WindowOperation
  Assert-Window ($libraryList.Items.Count -ge 2) '真实 list 没有读取临时资料库'
  $fixtureIndex = -1
  for ($index = 0; $index -lt $libraryList.Items.Count; $index++) { if ($libraryList.Items[$index].ContentId -eq 'aaaaaaaaaaaaaaaaaaaaaaaa') { $fixtureIndex = $index; break } }
  Assert-Window ($fixtureIndex -ge 0) '真实 list 没有返回可选测试资料'
  $libraryList.SelectedIndex = $fixtureIndex
  [Windows.Forms.ListBox].GetMethod('OnSelectedIndexChanged', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($libraryList, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($assetStatusLabel.Text -match '封面=saved') ('选中资料没有通过真实 read 显示素材状态：' + $assetStatusLabel.Text + '；状态=' + $status.Text)
  $platformCombo.SelectedIndex = 1
  Refresh-LinkLibrary
  Wait-WindowOperation
  Assert-Window ($libraryList.Items.Count -eq 1 -and $libraryList.Items[0].Text -match '微信公众号') '真实平台筛选失败'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($exportButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($status.Text -match '导出|资料包') '真实 export 没有返回结果'

  [pscustomobject]@{
    ok = $true; version = $PSVersionTable.PSVersion.ToString(); workState = $workState; workMessage = $workMessage
    networkLimited = $networkLimited; contentRoot = $contentRoot; checks = 10
  } | ConvertTo-Json -Compress
} finally {
  if ($script:linkJob) { try { Stop-ReaderProcess $script:linkJob } catch {} }
  if ($script:linkPollJob) { try { Stop-ReaderProcess $script:linkPollJob } catch {} }
  if ($script:linkWorkJob) { try { Stop-ReaderProcess $script:linkWorkJob } catch {} }
  if ($linkTimer) { $linkTimer.Dispose() }
  if ($tooltip) { $tooltip.Dispose() }
  if ($form) { $form.Dispose() }
  if ($oldContentRoot) { $env:CONTENT_LIBRARY_ROOT = $oldContentRoot } else { Remove-Item Env:CONTENT_LIBRARY_ROOT -ErrorAction SilentlyContinue }
  if ($oldLegacyRoot) { $env:WECHAT_ARTICLE_LIBRARY_ROOT = $oldLegacyRoot } else { Remove-Item Env:WECHAT_ARTICLE_LIBRARY_ROOT -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $runRoot) { Remove-Item -LiteralPath $runRoot -Recurse -Force }
}
