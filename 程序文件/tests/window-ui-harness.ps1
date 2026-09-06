param([string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot '..\reader-window.ps1') -ProjectRoot $ProjectRoot -NoShow

function Assert-Window([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}
function Wait-WindowOperation {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ($script:readerJob -and [DateTime]::UtcNow -lt $deadline) {
    # Exercise the actual timer event without opening an interactive window.
    [Windows.Forms.Timer].GetMethod('OnTick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($timer, @([EventArgs]::Empty)) | Out-Null
    Start-Sleep -Milliseconds 20
  }
  Assert-Window ($null -eq $script:readerJob) 'UI operation timed out'
}

try {
  Assert-Window ($PSVersionTable.PSVersion.Major -eq 5) 'Run using the launcher Windows PowerShell 5.1'
  Assert-Window ($form.Text -eq '公众号文章阅读器') 'Chinese title was decoded incorrectly'
  Assert-Window (-not $openArticleButton.Enabled) 'Open must be disabled for empty selection'
  $urlBox.Text = 'https://mp.weixin.qq.com/s/example?x=1&y=2'
  Read-ArticleLink
  Assert-Window (-not $readButton.Enabled -and $cancelButton.Enabled) 'Busy state did not update'
  Wait-WindowOperation
  Assert-Window ($status.Text -match 'PDF 未生成') 'Library refresh overwrote the partial PDF failure'
  Assert-Window ($list.Items.Count -eq 1 -and $list.SelectedIndex -eq 0) 'Saved article was not selected after refresh'
  Assert-Window ($readButton.Enabled -and -not $cancelButton.Enabled) 'Controls did not recover after completion'
  Assert-Window ($openArticleButton.Enabled -and $pdfButton.Enabled) 'Saved Markdown and PDF retry must remain available'
  Assert-Window ((Get-Content -LiteralPath (Join-Path $programRoot 'logs\reader.log') -Raw -Encoding UTF8) -match 'PDF 未生成') 'Partial failure was not logged'
  $searchBox.Text = '不存在'
  Refresh-Library
  Wait-WindowOperation
  Assert-Window ($list.Items.Count -eq 0 -and -not $openArticleButton.Enabled) 'No-result search kept a stale selection'
  Assert-Window ($status.Text -match '没有找到文章') 'No-result search needs an explicit empty message'
  $urlBox.Text = 'bad-url'
  Read-ArticleLink
  Wait-WindowOperation
  Assert-Window ($status.Text -match '链接格式无效') 'Failure message disappeared after refreshing history'
  $form.ClientSize = New-Object Drawing.Size(1100, 760)
  Assert-Window ($list.Width -gt 792 -and $list.Height -gt 218) 'Article list does not resize with window'
  # The process helper is covered separately; this checks the UI does not restart a cancelled search.
  function Stop-ReaderProcess($Job) { }
  $script:readerJob = [pscustomobject]@{ Fake=$true }
  $script:readerOperation = 'list'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($cancelButton, @([EventArgs]::Empty)) | Out-Null
  Assert-Window ($null -eq $script:readerJob -and $readButton.Enabled) 'Cancelling library search restarted it and prevented closing'
  function Stop-ReaderProcess($Job) { throw 'Access denied during cancellation' }
  $script:readerJob = [pscustomobject]@{ Started=[DateTime]::UtcNow.AddSeconds(-901); Completed=$false; StopRequested=$false }
  [Windows.Forms.Timer].GetMethod('OnTick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($timer, @([EventArgs]::Empty)) | Out-Null
  Assert-Window ($null -ne $script:readerJob -and -not $readButton.Enabled -and $cancelButton.Enabled) 'Failed termination lost the running process reference'
  $script:readerJob = $null
  [pscustomobject]@{ok=$true;version=$PSVersionTable.PSVersion.ToString();checks=10} | ConvertTo-Json -Compress
} finally {
  if ($script:readerJob) { Stop-ReaderProcess $script:readerJob }
  $timer.Dispose()
  $tooltip.Dispose()
  $form.Dispose()
}
