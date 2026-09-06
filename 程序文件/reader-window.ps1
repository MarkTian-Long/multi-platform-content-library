param([Parameter(Mandatory = $true)][string]$ProjectRoot, [switch]$NoShow)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'reader-process.ps1')

$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$programRoot = Join-Path $ProjectRoot '程序文件'
$libraryRoot = Join-Path $ProjectRoot '文章库'
$script:readerJob = $null
$script:readerOperation = ''
$script:afterRefreshMessage = ''
$script:afterRefreshId = ''
$script:operationMessage = ''

$form = New-Object Windows.Forms.Form
$form.Text = '公众号文章阅读器'
$form.ClientSize = New-Object Drawing.Size(840, 600)
$form.MinimumSize = New-Object Drawing.Size(856, 639)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$form.BackColor = [Drawing.ColorTranslator]::FromHtml('#F4F6F8')
$form.ForeColor = [Drawing.ColorTranslator]::FromHtml('#223044')
$form.AutoScaleMode = 'Dpi'
$form.AutoScaleDimensions = New-Object Drawing.SizeF(96, 96)

function Add-ReaderLabel([string]$Text, [int]$X, [int]$Y) {
  $control = New-Object Windows.Forms.Label
  $control.Text = $Text
  $control.Location = New-Object Drawing.Point($X, $Y)
  $control.AutoSize = $true
  $form.Controls.Add($control)
  return $control
}
function Add-ReaderButton([string]$Text, [int]$X, [int]$Y, [int]$Width) {
  $control = New-Object Windows.Forms.Button
  $control.Text = $Text
  $control.Location = New-Object Drawing.Point($X, $Y)
  $control.Size = New-Object Drawing.Size($Width, 36)
  $control.FlatStyle = 'Flat'
  $control.FlatAppearance.BorderColor = [Drawing.ColorTranslator]::FromHtml('#CED6E0')
  $control.BackColor = [Drawing.Color]::White
  $control.Cursor = [Windows.Forms.Cursors]::Hand
  $form.Controls.Add($control)
  return $control
}

$label = Add-ReaderLabel '粘贴微信公众号文章链接' 24 20
$urlBox = New-Object Windows.Forms.TextBox
$urlBox.Location = New-Object Drawing.Point(24, 49)
$urlBox.Size = New-Object Drawing.Size(792, 30)
$urlBox.Anchor = 'Top, Left, Right'
$form.Controls.Add($urlBox)
$readButton = Add-ReaderButton '读取并生成 MD 和 PDF' 24 94 230
$readButton.BackColor = [Drawing.ColorTranslator]::FromHtml('#246B58')
$readButton.ForeColor = [Drawing.Color]::White
$readButton.FlatAppearance.BorderSize = 0
$cancelButton = Add-ReaderButton '取消读取' 266 94 110
$cancelButton.Enabled = $false
$hint = Add-ReaderLabel '保存正文、图片与可下载的视频；PDF 中的视频以说明和链接保留。' 24 140
$hint.ForeColor = [Drawing.Color]::DimGray

$searchLabel = Add-ReaderLabel '搜索已保存文章（标题或链接）' 24 182
$searchBox = New-Object Windows.Forms.TextBox
$searchBox.Location = New-Object Drawing.Point(24, 211)
$searchBox.Size = New-Object Drawing.Size(590, 30)
$searchBox.Anchor = 'Top, Left, Right'
$form.Controls.Add($searchBox)
$searchButton = Add-ReaderButton '搜索' 628 207 90
$searchButton.Anchor = 'Top, Right'
$allButton = Add-ReaderButton '全部' 728 207 88
$allButton.Anchor = 'Top, Right'

$list = New-Object Windows.Forms.ListBox
$list.Location = New-Object Drawing.Point(24, 256)
$list.Size = New-Object Drawing.Size(792, 218)
$list.Anchor = 'Top, Bottom, Left, Right'
$list.IntegralHeight = $false
$list.HorizontalScrollbar = $true
$list.DisplayMember = 'Text'
$list.BorderStyle = 'FixedSingle'
$form.Controls.Add($list)

$openArticleButton = Add-ReaderButton '打开 Markdown' 24 488 120
$openPdfButton = Add-ReaderButton '打开 PDF' 156 488 100
$pdfButton = Add-ReaderButton '重新生成 PDF' 268 488 132
$articleFolderButton = Add-ReaderButton '打开本篇文件夹' 412 488 144
$openFolderButton = Add-ReaderButton '文章库' 568 488 116
$logButton = Add-ReaderButton '错误日志' 696 488 120
foreach ($button in @($openArticleButton, $openPdfButton, $pdfButton, $articleFolderButton, $openFolderButton, $logButton)) { $button.Anchor = 'Bottom, Left' }
$status = New-Object Windows.Forms.Label
$status.Text = '就绪：粘贴链接读取，或在下方搜索历史文章。'
$status.Location = New-Object Drawing.Point(24, 540)
$status.Size = New-Object Drawing.Size(792, 48)
$status.Anchor = 'Bottom, Left, Right'
$form.Controls.Add($status)
$tooltip = New-Object Windows.Forms.ToolTip
$tooltip.SetToolTip($hint, '视频最多 20 段，每段 100 MB，总计 500 MB。超限或下载失败时保留原文入口。')

function Set-ReaderStatus([string]$Message) {
  $status.Text = $Message
  $tooltip.SetToolTip($status, $Message)
}
function Write-ReaderError([string]$Message) {
  try {
    $logRoot = Join-Path $programRoot 'logs'
    [void][IO.Directory]::CreateDirectory($logRoot)
    $logPath = Join-Path $logRoot 'reader.log'
    # Keep two bounded files; never record the pasted URL or article contents.
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
      [IO.File]::Copy($logPath, (Join-Path $logRoot 'reader.previous.log'), $true)
      [IO.File]::WriteAllText($logPath, '', (New-Object Text.UTF8Encoding($true)))
    }
    $line = '[{0}] {1}{2}' -f [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'), (Protect-ReaderDiagnostic $Message), [Environment]::NewLine
    [IO.File]::AppendAllText($logPath, $line, (New-Object Text.UTF8Encoding($true)))
  } catch { # An unavailable log must not hide the operation's actual result.
  }
}
function Set-ReaderControls {
  $busy = $null -ne $script:readerJob
  $readButton.Enabled = -not $busy
  $searchButton.Enabled = -not $busy
  $allButton.Enabled = -not $busy
  $cancelButton.Enabled = $busy
  $selected = $null -ne $list.SelectedItem
  $openArticleButton.Enabled = $selected
  $openPdfButton.Enabled = $selected
  $articleFolderButton.Enabled = $selected
  $pdfButton.Enabled = $selected -and -not $busy
}
function Start-ReaderOperation([string[]]$Arguments, [string]$Message) {
  if ($null -ne $script:readerJob) { return }
  try {
    $cli = Join-Path $programRoot 'dist\cli.js'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw '缺少程序文件 dist\cli.js，请重新构建程序。' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $script:readerJob = Start-ReaderProcess -Executable $node -Arguments (@($cli) + $Arguments) -WorkingDirectory $programRoot -Environment @{
      WECHAT_ARTICLE_READER_ROOT = $programRoot
      WECHAT_ARTICLE_LIBRARY_ROOT = $libraryRoot
    }
    $script:readerOperation = $Arguments[0]
    $script:operationMessage = $Message
    Set-ReaderStatus $Message
    Set-ReaderControls
    $timer.Start()
  } catch {
    $script:readerJob = $null
    $message = '无法启动读取程序：' + $_.Exception.Message
    Set-ReaderStatus $message
    Write-ReaderError $message
    Set-ReaderControls
  }
}
function Refresh-Library([string]$KeepMessage = '', [string]$SelectId = '') {
  if ($null -ne $script:readerJob) { return }
  $script:afterRefreshMessage = $KeepMessage
  $script:afterRefreshId = $SelectId
  Start-ReaderOperation @('list', $searchBox.Text.Trim()) '正在读取文章库…'
}
function Complete-ReaderOperation($Payload, [string]$Operation) {
  if ($Operation -eq 'list') {
    if (-not $Payload.ok) {
      $message = '文章库读取失败：' + $Payload.message
      if ($script:afterRefreshMessage) { $message = $script:afterRefreshMessage + '；' + $message }
      Set-ReaderStatus $message
      Write-ReaderError $message
      return
    }
    $selectedId = $script:afterRefreshId
    if (-not $selectedId -and $list.SelectedItem) { $selectedId = $list.SelectedItem.ArticleId }
    $list.BeginUpdate()
    try {
      $list.Items.Clear()
      foreach ($article in @($Payload.articles)) {
        if (-not $article.articleId) { continue }
        $date = [string]$article.extractedAt
        if ($date.Length -ge 10) { $date = $date.Substring(0, 10) }
        $pdfText = if ($article.pdf.status -eq 'saved') { 'PDF 已保存' } else { 'PDF 待生成' }
        $videoText = ''
        $videos = @($article.videos | Where-Object { $null -ne $_ })
        if ($videos.Count -gt 0) {
          $savedVideos = @($videos | Where-Object { $_.status -eq 'saved' }).Count
          $videoText = "  ·  视频 $savedVideos/$($videos.Count)"
        }
        $item = [PSCustomObject]@{ Text = "[$date] $($article.title)  ·  $pdfText$videoText"; ArticleId = $article.articleId; Article = $article }
        $index = $list.Items.Add($item)
        if ($item.ArticleId -eq $selectedId) { $list.SelectedIndex = $index }
      }
      if ($list.SelectedIndex -lt 0 -and $list.Items.Count -gt 0) { $list.SelectedIndex = 0 }
    } finally { $list.EndUpdate() }
    if ($script:afterRefreshMessage) { Set-ReaderStatus $script:afterRefreshMessage }
    elseif ($list.Items.Count -eq 0) { Set-ReaderStatus '没有找到文章。可清空搜索条件，或粘贴链接读取新文章。' }
    else { Set-ReaderStatus "已显示 $($list.Items.Count) 篇文章；双击条目可打开 PDF。" }
    $script:afterRefreshMessage = ''
    Set-ReaderControls
    return
  }
  $message = [string]$Payload.message
  if (-not $Payload.ok) { $message = '操作失败：' + $message }
  Set-ReaderStatus $message
  if (-not $Payload.ok -or $Payload.status -eq 'partial' -or $Payload.diagnostic) {
    Write-ReaderError ($message + [Environment]::NewLine + $Payload.diagnostic)
  }
  # Refresh metadata after any operation: a failure/cancellation may leave valid MD.
  if ($Payload.ok -and $Operation -eq 'capture') { $searchBox.Clear() }
  Refresh-Library $message ([string]$Payload.articleId)
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
  if ($null -eq $script:readerJob) { $timer.Stop(); return }
  try {
    $elapsed = [int]([DateTime]::UtcNow - $script:readerJob.Started).TotalSeconds
    if ($elapsed -gt 900 -and -not $script:readerJob.StopRequested) {
      $script:readerJob.StopRequested = $true
      Stop-ReaderProcess $script:readerJob
      $script:readerJob = $null
      throw '操作超过 15 分钟，已停止本次任务。已保存的文件仍保留在文章库。'
    }
    $payload = Get-ReaderProcessResult $script:readerJob
    if ($null -eq $payload) { Set-ReaderStatus "$($script:operationMessage)（已等待 $elapsed 秒）"; return }
    $operation = $script:readerOperation
    $script:readerJob = $null
    $timer.Stop()
    Set-ReaderControls
    Complete-ReaderOperation $payload $operation
  } catch {
    $timer.Stop()
    $message = '操作失败：' + $_.Exception.Message
    if ($script:readerJob -and -not $script:readerJob.Completed -and -not $script:readerJob.StopRequested) {
      $script:readerJob.StopRequested = $true
      try { Stop-ReaderProcess $script:readerJob } catch { $message += '；' + $_.Exception.Message }
    }
    if ($script:readerJob -and -not $script:readerJob.Completed) {
      $script:operationMessage = $message + '；任务仍在运行，可重试取消或等待完成。'
      $message = $script:operationMessage
      $timer.Start()
    } else { $script:readerJob = $null }
    Set-ReaderStatus $message
    Write-ReaderError $message
    Set-ReaderControls
  }
})

function Read-ArticleLink {
  $url = $urlBox.Text.Trim()
  if (-not $url) { Set-ReaderStatus '请先粘贴公众号文章链接。'; return }
  Start-ReaderOperation @('capture', $url) '正在读取文章并生成 PDF，请稍候…'
}
function Open-SelectedArticle([string]$Extension) {
  if (-not $list.SelectedItem) { return }
  try {
    $article = $list.SelectedItem.Article
    if (-not $article.directory) { throw '文章记录缺少目录，请点击“全部”刷新文章库。' }
    $directory = [IO.Path]::GetFullPath($article.directory)
    $rootPrefix = [IO.Path]::GetFullPath($libraryRoot).TrimEnd('\') + '\'
    if (-not $directory.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '文章目录不在当前文章库内。' }
    if ($Extension -eq 'folder') {
      if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw '文章目录已被移动或删除。' }
      Start-Process explorer.exe -ArgumentList (ConvertTo-ReaderArgument $directory)
      return
    }
    $fileName = if ($Extension -eq 'pdf') { [string]$article.pdf.path } else { [string]$article.markdownFile }
    if ($Extension -eq 'md' -and -not $fileName) { $fileName = 'article.md' }
    if (-not $fileName -or [IO.Path]::GetFileName($fileName) -ne $fileName -or [IO.Path]::GetExtension($fileName) -ne ".$Extension") {
      throw ('没有可打开的 {0} 文件；PDF 可通过“重新生成 PDF”补齐。' -f $Extension)
    }
    $file = Join-Path $directory $fileName
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw '文章文件已被移动或删除，请检查文章库。' }
    Start-Process -FilePath $file -ErrorAction Stop
  } catch { Set-ReaderStatus ('无法打开文章：' + $_.Exception.Message) }
}
$readButton.add_Click({ Read-ArticleLink })
$urlBox.add_KeyDown({ if ($_.KeyCode -eq [Windows.Forms.Keys]::Enter) { $_.SuppressKeyPress = $true; Read-ArticleLink } })
$searchButton.add_Click({ Refresh-Library })
$allButton.add_Click({ $searchBox.Clear(); Refresh-Library })
$searchBox.add_KeyDown({ if ($_.KeyCode -eq [Windows.Forms.Keys]::Enter) { $_.SuppressKeyPress = $true; Refresh-Library } })
$cancelButton.add_Click({
  try {
    if ($script:readerJob) {
      $timer.Stop()
      $cancelledOperation = $script:readerOperation
      Stop-ReaderProcess $script:readerJob
      $script:readerJob = $null
      Set-ReaderControls
      if ($cancelledOperation -eq 'list') { Set-ReaderStatus '文章库搜索已取消。' }
      else { Refresh-Library '操作已取消；已保存的文件仍保留在文章库。' }
    }
  } catch { Set-ReaderStatus $_.Exception.Message; Write-ReaderError $_.Exception.Message; $timer.Start() }
})
$list.add_SelectedIndexChanged({ Set-ReaderControls })
$list.add_DoubleClick({ Open-SelectedArticle 'pdf' })
$openArticleButton.add_Click({ Open-SelectedArticle 'md' })
$openPdfButton.add_Click({ Open-SelectedArticle 'pdf' })
$articleFolderButton.add_Click({ Open-SelectedArticle 'folder' })
$pdfButton.add_Click({ if ($list.SelectedItem) { Start-ReaderOperation @('regenerate-pdf', $list.SelectedItem.ArticleId) '正在重新生成 PDF…' } })
$openFolderButton.add_Click({
  if (Test-Path -LiteralPath $libraryRoot) { Start-Process explorer.exe -ArgumentList (ConvertTo-ReaderArgument $libraryRoot) }
  else { Set-ReaderStatus '文章库将在首次成功读取后创建。' }
})
$logButton.add_Click({
  $logPath = Join-Path $programRoot 'logs\reader.log'
  if (Test-Path -LiteralPath $logPath) { Start-Process notepad.exe -ArgumentList (ConvertTo-ReaderArgument $logPath) }
  else { Set-ReaderStatus '暂无错误日志。读取失败时会自动记录错误原因。' }
})
$form.add_FormClosing({
  if ($script:readerJob) { $_.Cancel = $true; Set-ReaderStatus '任务仍在运行；可等待完成，或先点击“取消读取”再关闭窗口。' }
})
$form.add_FormClosed({ $timer.Dispose(); $tooltip.Dispose() })
Set-ReaderControls
if (-not $NoShow) {
  $form.add_Shown({ Refresh-Library })
  [void]$form.ShowDialog()
  $form.Dispose()
}
