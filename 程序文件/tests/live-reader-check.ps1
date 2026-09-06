param([Parameter(Mandatory=$true)][string]$ProjectRoot, [Parameter(Mandatory=$true)][string]$ArticleUrl)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot '..\reader-window.ps1') -ProjectRoot $ProjectRoot -NoShow
try {
  $urlBox.Text = $ArticleUrl
  Read-ArticleLink
  $lastReport = [DateTime]::UtcNow
  while ($script:readerJob) {
    [Windows.Forms.Timer].GetMethod('OnTick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($timer, @([EventArgs]::Empty)) | Out-Null
    if (([DateTime]::UtcNow - $lastReport).TotalSeconds -ge 20) {
      [Console]::Error.WriteLine($status.Text)
      $lastReport = [DateTime]::UtcNow
    }
    Start-Sleep -Milliseconds 100
  }
  $article = @($list.Items | ForEach-Object { $_.Article } | Where-Object { $_.sourceUrl -eq $ArticleUrl }) | Select-Object -First 1
  [pscustomobject]@{statusText=$status.Text; article=$article; powershell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Depth 8
  if (-not $article -or $status.Text -match '^操作失败|^无法启动') { exit 1 }
} finally {
  if ($script:readerJob) { Stop-ReaderProcess $script:readerJob }
  $timer.Dispose(); $tooltip.Dispose(); $form.Dispose()
}
