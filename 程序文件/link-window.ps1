param([Parameter(Mandatory = $true)][string]$ProjectRoot, [switch]$NoShow)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'reader-process.ps1')

$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$programRoot = Join-Path $ProjectRoot '程序文件'
$configuredContentRoot = [string]$env:CONTENT_LIBRARY_ROOT
$libraryRoot = if ($configuredContentRoot -and [IO.Path]::IsPathRooted($configuredContentRoot)) { [IO.Path]::GetFullPath($configuredContentRoot) } else { Join-Path $ProjectRoot '资料库' }
$script:linkJob = $null
$script:linkWorkJob = $null
$script:linkPollJob = $null
$script:linkInstallJob = $null
$script:linkOperation = ''
$script:linkWorkRunning = $false
$script:linkLastPoll = [DateTime]::MinValue
$script:linkPendingRefresh = $false
$script:linkSelectedJobId = ''
$script:linkSelectedContentId = ''

$form = New-Object Windows.Forms.Form
$form.Text = '链接资料库'
$form.ClientSize = New-Object Drawing.Size(1150, 760)
$form.MinimumSize = New-Object Drawing.Size(980, 680)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)
$form.BackColor = [Drawing.ColorTranslator]::FromHtml('#F4F6F8')
$form.ForeColor = [Drawing.ColorTranslator]::FromHtml('#223044')
$form.AutoScaleMode = 'Dpi'
$form.AutoScaleDimensions = New-Object Drawing.Size(96, 96)

function Add-LinkLabel([string]$Text, [int]$X, [int]$Y, [int]$Width = 0, [int]$Height = 0) {
  $control = New-Object Windows.Forms.Label
  $control.Text = $Text
  $control.Location = New-Object Drawing.Point($X, $Y)
  if ($Width -gt 0 -or $Height -gt 0) {
    if ($Width -le 0) { $Width = 180 }
    if ($Height -le 0) { $Height = 24 }
    $control.Size = New-Object Drawing.Size($Width, $Height)
  } else { $control.AutoSize = $true }
  $form.Controls.Add($control)
  return $control
}
function Add-LinkButton([string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height = 32) {
  $control = New-Object Windows.Forms.Button
  $control.Text = $Text
  $control.Location = New-Object Drawing.Point($X, $Y)
  $control.Size = New-Object Drawing.Size($Width, $Height)
  $control.FlatStyle = 'Flat'
  $control.FlatAppearance.BorderColor = [Drawing.ColorTranslator]::FromHtml('#CED6E0')
  $control.BackColor = [Drawing.Color]::White
  $control.Cursor = [Windows.Forms.Cursors]::Hand
  $form.Controls.Add($control)
  return $control
}
function New-LinkTextBox([int]$X, [int]$Y, [int]$Width, [int]$Height, [bool]$Multiline = $false) {
  $control = New-Object Windows.Forms.TextBox
  $control.Location = New-Object Drawing.Point($X, $Y)
  $control.Size = New-Object Drawing.Size($Width, $Height)
  $control.Multiline = $Multiline
  $control.ScrollBars = if ($Multiline) { 'Vertical' } else { 'None' }
  $control.AcceptsReturn = $Multiline
  $control.BorderStyle = 'FixedSingle'
  $form.Controls.Add($control)
  return $control
}

$title = Add-LinkLabel '链接资料库' 22 16 300 30
$title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 14, [Drawing.FontStyle]::Bold)
$hint = Add-LinkLabel '支持多行粘贴；点击后加入队列，任务和资料状态会显示在下方。' 24 48 1060 24
$hint.ForeColor = [Drawing.Color]::DimGray

$inputBox = New-LinkTextBox 24 78 840 78  $true
$inputBox.Anchor = 'Top, Left, Right'
$enqueueButton = Add-LinkButton '加入队列' 880 78 112
$enqueueButton.Anchor = 'Top, Right'
$workButton = Add-LinkButton '开始保存' 1000 78 112
$workButton.Anchor = 'Top, Right'
$inputHint = Add-LinkLabel '支持微信、小红书、B 站和普通网页。' 24 160 840 22
$inputHint.ForeColor = [Drawing.Color]::DimGray

$queueGroup = New-Object Windows.Forms.GroupBox
$queueGroup.Text = '任务队列'
$queueGroup.Location = New-Object Drawing.Point(24, 194)
$queueGroup.Size = New-Object Drawing.Size(1088, 184)
$queueGroup.Anchor = 'Top, Left, Right'
$form.Controls.Add($queueGroup)
$queueList = New-Object Windows.Forms.ListBox
$queueList.Location = New-Object Drawing.Point(12, 28)
$queueList.Size = New-Object Drawing.Size(860, 140)
$queueList.Anchor = 'Top, Bottom, Left, Right'
$queueList.IntegralHeight = $false
$queueList.HorizontalScrollbar = $true
$queueGroup.Controls.Add($queueList)
$cancelButton = Add-LinkButton '取消任务' 900 226 96
$cancelButton.Anchor = 'Top, Right'
$cancelButton.Enabled = $false
$retryButton = Add-LinkButton '重试任务' 1000 226 96
$retryButton.Anchor = 'Top, Right'
$retryButton.Enabled = $false
$queueStatus = Add-LinkLabel '阶段 / 耗时会显示在任务列表中。' 900 270 190 68
$queueStatus.Anchor = 'Top, Right'
$queueStatus.ForeColor = [Drawing.Color]::DimGray

$libraryGroup = New-Object Windows.Forms.GroupBox
$libraryGroup.Text = '资料库'
$libraryGroup.Location = New-Object Drawing.Point(24, 394)
$libraryGroup.Size = New-Object Drawing.Size(1088, 252)
$libraryGroup.Anchor = 'Top, Bottom, Left, Right'
$form.Controls.Add($libraryGroup)
$searchBox = New-LinkTextBox 12 28 470 30 $false
$searchBox.Parent = $libraryGroup
$searchBox.Anchor = 'Top, Left, Right'
$searchLabel = Add-LinkLabel '全文搜索' 494 34 65 22
$searchLabel.Parent = $libraryGroup
$platformLabel = Add-LinkLabel '平台' 568 34 42 22
$platformLabel.Parent = $libraryGroup
$platformCombo = New-Object Windows.Forms.ComboBox
$platformCombo.Location = New-Object Drawing.Point(610, 29)
$platformCombo.Size = New-Object Drawing.Size(128, 28)
$platformCombo.DropDownStyle = 'DropDownList'
[void]$platformCombo.Items.Add('全部平台')
[void]$platformCombo.Items.Add('微信公众号')
[void]$platformCombo.Items.Add('小红书')
[void]$platformCombo.Items.Add('B 站')
[void]$platformCombo.Items.Add('普通网页')
$platformCombo.SelectedIndex = 0
$platformCombo.Anchor = 'Top, Left'
$libraryGroup.Controls.Add($platformCombo)
$searchButton = Add-LinkButton '搜索' 750 27 76 32
$searchButton.Parent = $libraryGroup
$searchButton.Anchor = 'Top, Left'
$allButton = Add-LinkButton '全部' 832 27 76 32
$allButton.Parent = $libraryGroup
$allButton.Anchor = 'Top, Left'
$libraryList = New-Object Windows.Forms.ListBox
$libraryList.Location = New-Object Drawing.Point(12, 68)
$libraryList.Size = New-Object Drawing.Size(896, 116)
$libraryList.Anchor = 'Top, Bottom, Left, Right'
$libraryList.IntegralHeight = $false
$libraryList.HorizontalScrollbar = $true
$libraryGroup.Controls.Add($libraryList)
$openReadingButton = Add-LinkButton '打开阅读页' 12 194 100 32
$openReadingButton.Parent = $libraryGroup
$openReadingButton.Enabled = $false
$openPdfButton = Add-LinkButton '打开 PDF' 120 194 88 32
$openPdfButton.Parent = $libraryGroup
$openPdfButton.Enabled = $false
$openVideoButton = Add-LinkButton '打开视频' 216 194 88 32
$openVideoButton.Parent = $libraryGroup
$openVideoButton.Enabled = $false
$openFolderButton = Add-LinkButton '打开目录' 312 194 88 32
$openFolderButton.Parent = $libraryGroup
$openFolderButton.Enabled = $false
$openSourceButton = Add-LinkButton '打开来源' 408 194 88 32
$openSourceButton.Parent = $libraryGroup
$openSourceButton.Enabled = $false
$exportButton = Add-LinkButton '导出资料包' 504 194 100 32
$exportButton.Parent = $libraryGroup
$exportButton.Enabled = $false

$doctorButton = Add-LinkButton '依赖检查' 620 194 88 32
$doctorButton.Parent = $libraryGroup
$installButton = Add-LinkButton '安装到应用目录' 716 194 120 32
$installButton.Parent = $libraryGroup
$loginPlatformCombo = New-Object Windows.Forms.ComboBox
$loginPlatformCombo.Location = New-Object Drawing.Point(844, 195)
$loginPlatformCombo.Size = New-Object Drawing.Size(92, 28)
$loginPlatformCombo.DropDownStyle = 'DropDownList'
$loginPlatformCombo.DisplayMember = 'Text'
foreach ($platform in @(
  [PSCustomObject]@{ Text = '小红书'; Value = 'xiaohongshu' },
  [PSCustomObject]@{ Text = 'B 站'; Value = 'bilibili' }
)) { [void]$loginPlatformCombo.Items.Add($platform) }
$loginPlatformCombo.SelectedIndex = 0
$loginPlatformCombo.Parent = $libraryGroup
$loginButton = Add-LinkButton '专用浏览器登录' 916 194 128 32
$loginButton.Parent = $libraryGroup

function Set-LinkLibraryLayout {
  $innerWidth = [Math]::Max(400, $libraryGroup.ClientSize.Width - 24)
  $searchWidth = [Math]::Max(180, $innerWidth - 435)
  $searchBox.Location = New-Object Drawing.Point -ArgumentList @([int]12, [int]28)
  $searchBox.Size = New-Object Drawing.Size -ArgumentList @([int]$searchWidth, [int]30)
  $searchLabel.Location = New-Object Drawing.Point -ArgumentList @([int](20 + $searchWidth), [int]34)
  $platformLabel.Location = New-Object Drawing.Point -ArgumentList @([int](93 + $searchWidth), [int]34)
  $platformCombo.Location = New-Object Drawing.Point -ArgumentList @([int](135 + $searchWidth), [int]29)
  $searchButton.Location = New-Object Drawing.Point -ArgumentList @([int](271 + $searchWidth), [int]27)
  $allButton.Location = New-Object Drawing.Point -ArgumentList @([int](351 + $searchWidth), [int]27)
  $actionY = [Math]::Max(108, $libraryGroup.ClientSize.Height - 58)
  $libraryList.Location = New-Object Drawing.Point -ArgumentList @([int]12, [int]68)
  $libraryList.Size = New-Object Drawing.Size -ArgumentList @([int]$innerWidth, [int]([Math]::Max(36, $actionY - 78)))
  $actionX = 12
  foreach ($spec in @(
    @($openReadingButton, 88), @($openPdfButton, 66), @($openVideoButton, 66),
    @($openFolderButton, 66), @($openSourceButton, 66), @($exportButton, 82)
  )) {
    $spec[0].Location = New-Object Drawing.Point -ArgumentList @([int]$actionX, [int]$actionY)
    $spec[0].Size = New-Object Drawing.Size -ArgumentList @([int]$spec[1], [int]32)
    $actionX += $spec[1] + 4
  }
  $actionX += 4
  foreach ($spec in @(
    @($doctorButton, 70), @($installButton, 102)
  )) {
    $spec[0].Location = New-Object Drawing.Point -ArgumentList @([int]$actionX, [int]$actionY)
    $spec[0].Size = New-Object Drawing.Size -ArgumentList @([int]$spec[1], [int]32)
    $actionX += $spec[1] + 4
  }
  $loginPlatformCombo.Location = New-Object Drawing.Point -ArgumentList @([int]$actionX, [int]($actionY + 2))
  $loginPlatformCombo.Size = New-Object Drawing.Size -ArgumentList @([int]78, [int]28)
  $loginPlatformCombo.DropDownWidth = 130
  $actionX += 82
  $loginButton.Location = New-Object Drawing.Point -ArgumentList @([int]$actionX, [int]$actionY)
  $loginButton.Size = New-Object Drawing.Size -ArgumentList @([int]112, [int]32)
}
$libraryGroup.add_Resize({ Set-LinkLibraryLayout })
Set-LinkLibraryLayout

$assetStatusLabel = Add-LinkLabel '产物状态：选择资料后显示正文、图片、视频、字幕、转写、OCR 等逐项结果。' 24 662 1088 24
$assetStatusLabel.Anchor = 'Bottom, Left, Right'
$assetStatusLabel.ForeColor = [Drawing.Color]::DimGray
$status = Add-LinkLabel '就绪：粘贴链接后加入队列。' 24 690 1088 42
$status.Anchor = 'Bottom, Left, Right'
$status.AutoEllipsis = $true
$tooltip = New-Object Windows.Forms.ToolTip
$tooltip.SetToolTip($inputBox, '支持多行粘贴；点击“加入队列”后才会提交给本地 CLI。')

function Set-LinkStatus([string]$Message) {
  $status.Text = $Message
  $tooltip.SetToolTip($status, $Message)
}
function Set-LinkQueueStatus([string]$Message) { $queueStatus.Text = $Message }
function Write-LinkError([string]$Message) {
  try {
    $logRoot = Join-Path $programRoot 'logs'
    [void][IO.Directory]::CreateDirectory($logRoot)
    $logPath = Join-Path $logRoot 'link-window.log'
    $line = '[{0}] {1}{2}' -f [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'), (Protect-ReaderDiagnostic $Message), [Environment]::NewLine
    [IO.File]::AppendAllText($logPath, $line, (New-Object Text.UTF8Encoding($true)))
  } catch {}
}
function Set-LinkControls {
  $busy = ($null -ne $script:linkJob) -or ($null -ne $script:linkPollJob) -or ($null -ne $script:linkInstallJob)
  $workerBusy = $null -ne $script:linkWorkJob
  $enqueueButton.Enabled = -not $busy
  $workButton.Enabled = -not $busy -and -not $workerBusy
  $cancelButton.Enabled = $busy -or $workerBusy
  $retryButton.Enabled = $null -ne $queueList.SelectedItem -and -not $busy
  $selected = $null -ne $libraryList.SelectedItem
  $openReadingButton.Enabled = $selected
  $openPdfButton.Enabled = $selected
  $openVideoButton.Enabled = $selected
  $openFolderButton.Enabled = $selected
  $openSourceButton.Enabled = $selected
  $exportButton.Enabled = $selected -and -not $busy
  $loginButton.Enabled = -not $busy -and -not $workerBusy
  $installButton.Enabled = -not $busy -and -not $workerBusy
}
function Get-LinkCliPath { return (Join-Path $programRoot 'dist\link-cli.js') }
function Start-LinkCli([string[]]$Arguments) {
  $cli = Get-LinkCliPath
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw '缺少程序文件 dist\link-cli.js，请先运行构建。' }
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $environment = @{
    WECHAT_ARTICLE_READER_ROOT = $programRoot
    CONTENT_LIBRARY_ROOT = $libraryRoot
  }
  if ($env:WECHAT_ARTICLE_LIBRARY_ROOT) { $environment.WECHAT_ARTICLE_LIBRARY_ROOT = $env:WECHAT_ARTICLE_LIBRARY_ROOT }
  return Start-ReaderProcess -Executable $nodeCommand.Source -Arguments (@($cli) + $Arguments) -WorkingDirectory $programRoot -Environment $environment
}
function Start-LinkOperation([string[]]$Arguments, [string]$Message) {
  $operation = [string]$Arguments[0]
  if ($operation -eq 'login' -and $null -ne $script:linkWorkJob) {
    Set-LinkStatus '保存任务正在运行；请等待完成或先取消保存任务，再打开登录入口。'
    return
  }
  if ($null -ne $script:linkJob -and $operation -ne 'cancel') { return }
  try {
    $script:linkJob = Start-LinkCli $Arguments
    $script:linkOperation = $Arguments[0]
    Set-LinkStatus $Message
    Set-LinkControls
    $linkTimer.Start()
  } catch {
    $script:linkJob = $null
    $message = '无法启动链接资料库程序：' + $_.Exception.Message
    Set-LinkStatus $message
    Write-LinkError $message
    Set-LinkControls
  }
}
function Start-LinkWorker {
  if ($null -ne $script:linkWorkJob -or $null -ne $script:linkJob) { return }
  try {
    $script:linkWorkJob = Start-LinkCli @('work')
    $script:linkWorkRunning = $true
    Set-LinkStatus '正在后台保存队列任务；窗口仍可搜索资料库。'
    Set-LinkControls
    $linkTimer.Start()
  } catch {
    $script:linkWorkJob = $null
    $script:linkWorkRunning = $false
    $message = '无法启动保存任务：' + $_.Exception.Message
    Set-LinkStatus $message
    Write-LinkError $message
    Set-LinkControls
  }
}
function Start-LinkInstaller {
  if ($null -ne $script:linkInstallJob -or $null -ne $script:linkWorkJob -or $null -ne $script:linkJob) { return }
  try {
    $installer = Join-Path $programRoot 'scripts\setup-content-tools.ps1'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw '当前版本没有应用目录安装器。' }
    $logRoot = Join-Path $programRoot 'logs'
    [void][IO.Directory]::CreateDirectory($logRoot)
    $stamp = [guid]::NewGuid().ToString('N')
    $outPath = Join-Path $logRoot ("content-tools-install-$stamp.out.log")
    $errPath = Join-Path $logRoot ("content-tools-install-$stamp.err.log")
    $installerArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (ConvertTo-ReaderArgument $installer) + ' -PrepareModel'
    $process = Start-Process powershell.exe -WindowStyle Hidden -PassThru -RedirectStandardOutput $outPath -RedirectStandardError $errPath -WorkingDirectory $programRoot -ArgumentList $installerArguments
    $script:linkInstallJob = [PSCustomObject]@{ Process = $process; OutPath = $outPath; ErrPath = $errPath; Started = [DateTime]::UtcNow }
    Set-LinkStatus '正在安装本地依赖和离线 ASR 模型；完成后会自动刷新检查结果。'
    Set-LinkControls
    $linkTimer.Start()
  } catch {
    $message = '无法启动依赖安装：' + $_.Exception.Message
    Set-LinkStatus $message
    Write-LinkError $message
    Set-LinkControls
  }
}
function Complete-LinkInstaller {
  $job = $script:linkInstallJob
  if ($null -eq $job) { return }
  try {
    $exitCode = $job.Process.ExitCode
    $stdout = if (Test-Path -LiteralPath $job.OutPath) { Get-Content -LiteralPath $job.OutPath -Raw -Encoding UTF8 } else { '' }
    $stderr = if (Test-Path -LiteralPath $job.ErrPath) { Get-Content -LiteralPath $job.ErrPath -Raw -Encoding UTF8 } else { '' }
    $detail = Protect-ReaderDiagnostic (($stderr.Trim() + ' ' + $stdout.Trim()).Trim())
    if ($exitCode -eq 0) {
      Set-LinkStatus '依赖安装完成，正在刷新检查结果…'
      if ($detail) { Write-LinkError ('依赖安装输出：' + $detail) }
      $script:linkInstallJob = $null
      $job.Process.Dispose()
      Set-LinkControls
      Start-LinkOperation @('doctor') '正在刷新依赖检查…'
    } else {
      $script:linkInstallJob = $null
      $job.Process.Dispose()
      $message = if ($detail) { '依赖安装失败：' + $detail } else { "依赖安装失败（退出码 $exitCode）。" }
      Set-LinkStatus $message
      Write-LinkError $message
      Set-LinkControls
    }
  } catch {
    $script:linkInstallJob = $null
    Set-LinkStatus ('依赖安装结果读取失败：' + $_.Exception.Message)
    Write-LinkError $_.Exception.Message
    Set-LinkControls
  }
}
function Start-LinkPoll {
  if (-not $script:linkWorkRunning -or $null -ne $script:linkPollJob -or $null -ne $script:linkJob) { return }
  try {
    $script:linkPollJob = Start-LinkCli @('jobs')
    $script:linkLastPoll = [DateTime]::UtcNow
  } catch { Write-LinkError ('任务状态查询失败：' + $_.Exception.Message) }
}
function Convert-LinkPlatform([string]$Platform) {
  switch ($Platform) {
    'wechat' { return '微信公众号' }
    'xiaohongshu' { return '小红书' }
    'bilibili' { return 'B 站' }
    default { return '普通网页' }
  }
}
function Format-LinkJob($Job) {
  if ($null -eq $Job) { return $null }
  $updated = [string]$Job.updatedAt
  if ($updated.Length -ge 19) { $updated = $updated.Substring(0, 19).Replace('T', ' ') }
  $title = if ($Job.title) { [string]$Job.title } else { [string]$Job.input.url }
  $elapsed = ''
  try {
    $startAt = [DateTime]::Parse([string]$Job.createdAt).ToUniversalTime()
    $endAt = if ($Job.state -eq 'running') { [DateTime]::UtcNow } else { [DateTime]::Parse([string]$Job.updatedAt).ToUniversalTime() }
    $elapsed = "耗时 {0}s" -f [Math]::Max(0, [int]($endAt - $startAt).TotalSeconds)
  } catch { $elapsed = '耗时未知' }
  return [PSCustomObject]@{ Text = "[$($Job.state)] $title  ·  $($Job.stage)  ·  $elapsed  ·  $updated  ·  $($Job.message)"; JobId = [string]$Job.id; Job = $Job }
}
function Render-LinkJobs($Jobs) {
  $keep = $script:linkSelectedJobId
  $queueList.BeginUpdate()
  try {
    $queueList.Items.Clear()
    foreach ($job in @($Jobs)) {
      $item = Format-LinkJob $job
      if ($null -eq $item) { continue }
      $index = $queueList.Items.Add($item)
      if ($item.JobId -eq $keep) { $queueList.SelectedIndex = $index }
    }
    if ($queueList.SelectedIndex -lt 0 -and $queueList.Items.Count -gt 0) { $queueList.SelectedIndex = 0 }
  } finally { $queueList.EndUpdate() }
  if ($queueList.SelectedItem) { $script:linkSelectedJobId = $queueList.SelectedItem.JobId }
  Set-LinkQueueStatus ("任务 $($queueList.Items.Count) 项；状态会自动刷新。")
  Set-LinkControls
}
function Render-LinkAssets($Item) {
  if ($null -eq $Item) { $assetStatusLabel.Text = '产物状态：选择资料后显示逐项结果。'; return }
  $parts = @()
  foreach ($property in @('kind', 'status', 'readingPath', 'pdfPath', 'videoPath')) {
    if ($Item.PSObject.Properties.Name -contains $property -and $Item.$property) { $parts += "$property=$($Item.$property)" }
  }
  $assetStatusLabel.Text = '产物状态：' + ($parts -join '；')
}
function Render-LinkManifest($Manifest) {
  if ($null -eq $Manifest) { return }
  $assets = @($Manifest.assets)
  if ($assets.Count -eq 0) { return }
  $parts = @($assets | ForEach-Object {
    $label = if ($_.label) { [string]$_.label } else { [string]$_.role }
    "$label=$($_.status)"
  })
  $assetStatusLabel.Text = '产物状态：' + ($parts -join '；')
}
function Get-LinkFilteredItems($Items) {
  $platform = [string]$platformCombo.SelectedItem
  if ($platform -eq '全部平台' -or [string]::IsNullOrWhiteSpace($platform)) { return @($Items) }
  $wanted = switch ($platform) { '微信公众号' { 'wechat' } '小红书' { 'xiaohongshu' } 'B 站' { 'bilibili' } default { 'web' } }
  return @($Items | Where-Object { [string]$_.platform -eq $wanted })
}
function Render-LinkLibrary($Items) {
  $filtered = Get-LinkFilteredItems $Items
  $keep = $script:linkSelectedContentId
  $libraryList.BeginUpdate()
  try {
    $libraryList.Items.Clear()
    foreach ($item in @($filtered)) {
      $date = [string]$item.capturedAt
      if ($date.Length -ge 10) { $date = $date.Substring(0, 10) }
      $text = "[$date] $($item.title)  ·  $(Convert-LinkPlatform $item.platform)  ·  $($item.kind)  ·  $($item.status)"
      $view = [PSCustomObject]@{ Text = $text; ContentId = [string]$item.contentId; Item = $item }
      $index = $libraryList.Items.Add($view)
      if ($view.ContentId -eq $keep) { $libraryList.SelectedIndex = $index }
    }
    if ($libraryList.SelectedIndex -lt 0 -and $libraryList.Items.Count -gt 0) { $libraryList.SelectedIndex = 0 }
  } finally { $libraryList.EndUpdate() }
  if ($libraryList.SelectedItem) {
    $script:linkSelectedContentId = $libraryList.SelectedItem.ContentId
    Render-LinkAssets $libraryList.SelectedItem.Item
    if ($null -eq $script:linkJob -and $null -eq $script:linkPollJob) {
      Start-LinkOperation @('read', $script:linkSelectedContentId) '正在读取产物状态…'
    }
  } else { Render-LinkAssets $null }
  if ($libraryList.Items.Count -eq 0) { Set-LinkStatus '没有找到资料；可清空搜索条件或先加入新任务。' }
  else { Set-LinkStatus "已显示 $($libraryList.Items.Count) 项资料。" }
  Set-LinkControls
}
function Refresh-LinkJobs {
  if ($null -eq $script:linkJob -and $null -eq $script:linkWorkJob) { Start-LinkOperation @('jobs') '正在读取任务状态…' }
}
function Refresh-LinkLibrary {
  if ($null -eq $script:linkJob -and $null -eq $script:linkPollJob) {
    Start-LinkOperation @('list', $searchBox.Text.Trim()) '正在读取资料库…'
  }
}
function Complete-LinkOperation($Payload, [string]$Operation) {
  if ($null -eq $Payload) { return }
  if ($Operation -eq 'list') {
    if ($Payload.ok) { Render-LinkLibrary $Payload.items }
    else { Set-LinkStatus ('资料库读取失败：' + $Payload.message); Write-LinkError $Payload.message }
    return
  }
  if ($Operation -eq 'jobs') {
    if ($Payload.ok) { Render-LinkJobs $Payload.jobs }
    else { Set-LinkStatus ('任务状态读取失败：' + $Payload.message); Write-LinkError $Payload.message }
    return
  }
  if ($Operation -eq 'doctor') {
    if ($Payload.ok) {
      $missing = @($Payload.tools | Where-Object { -not $_.available })
      if ($missing.Count -eq 0) { Set-LinkStatus '依赖检查完成：当前工具均可用。' }
      else { Set-LinkStatus ('依赖缺失：' + (($missing | ForEach-Object { $_.name }) -join '、') + '。可点击“安装到应用目录”。') }
    } else { Set-LinkStatus ('依赖检查失败：' + $Payload.message) }
    return
  }
  if ($Operation -eq 'enqueue' -or $Operation -eq 'cancel' -or $Operation -eq 'retry') {
    if ($Payload.ok) {
      Render-LinkJobs $Payload.jobs
      Set-LinkStatus ([string]$Payload.message)
    } else { Set-LinkStatus ('任务操作失败：' + $Payload.message); Write-LinkError $Payload.message }
    return
  }
  if ($Operation -eq 'read') {
    if ($Payload.ok) { Render-LinkManifest $Payload.manifest; Set-LinkStatus ([string]$Payload.message) }
    else { Set-LinkStatus ('产物状态读取失败：' + $Payload.message); Write-LinkError $Payload.message }
    return
  }
  if ($Operation -eq 'export' -or $Operation -eq 'login') {
    if ($Payload.ok) { Set-LinkStatus ([string]$Payload.message) }
    else { Set-LinkStatus ('操作失败：' + $Payload.message); Write-LinkError $Payload.message }
    return
  }
  if (-not $Payload.ok) { Set-LinkStatus ('保存失败：' + $Payload.message); Write-LinkError $Payload.message }
  else { Set-LinkStatus ([string]$Payload.message); Refresh-LinkJobs; Refresh-LinkLibrary }
}
function Complete-LinkWorker($Payload) {
  $script:linkWorkRunning = $false
  if ($Payload -and $Payload.ok) { Set-LinkStatus ([string]$Payload.message); $script:linkPendingRefresh = $true }
  elseif ($Payload) { Set-LinkStatus ('后台保存失败：' + $Payload.message); Write-LinkError $Payload.message }
  else { Set-LinkStatus '后台保存程序没有返回有效结果。'; Write-LinkError '后台保存程序没有返回有效结果。' }
  Set-LinkControls
}
function Complete-LinkPoll($Payload) {
  if ($Payload -and $Payload.ok) { Render-LinkJobs $Payload.jobs }
}

$linkTimer = New-Object Windows.Forms.Timer
$linkTimer.Interval = 180
$linkTimer.add_Tick({
  try {
    if ($script:linkJob) {
      $payload = Get-ReaderProcessResult $script:linkJob
      if ($null -ne $payload) {
        $operation = $script:linkOperation
        $script:linkJob = $null
        Complete-LinkOperation $payload $operation
        Set-LinkControls
      }
    }
    if ($script:linkPollJob) {
      $payload = Get-ReaderProcessResult $script:linkPollJob
      if ($null -ne $payload) { $script:linkPollJob = $null; Complete-LinkPoll $payload; Set-LinkControls }
    }
    if ($script:linkWorkJob) {
      $payload = Get-ReaderProcessResult $script:linkWorkJob
      if ($null -ne $payload) { $script:linkWorkJob = $null; Complete-LinkWorker $payload }
    }
    if ($script:linkInstallJob -and $script:linkInstallJob.Process.HasExited) { Complete-LinkInstaller }
    if ($script:linkWorkRunning -and ([DateTime]::UtcNow - $script:linkLastPoll).TotalMilliseconds -ge 700) { Start-LinkPoll }
    if ($script:linkPendingRefresh -and $null -eq $script:linkJob -and $null -eq $script:linkPollJob -and -not $script:linkWorkRunning) {
      $script:linkPendingRefresh = $false
      Refresh-LinkJobs
      if ($null -eq $script:linkJob) { Refresh-LinkLibrary }
    }
    if ($null -eq $script:linkJob -and $null -eq $script:linkWorkJob -and $null -eq $script:linkPollJob -and $null -eq $script:linkInstallJob) { $linkTimer.Stop() }
  } catch {
    Set-LinkStatus ('窗口刷新失败：' + $_.Exception.Message)
    Write-LinkError $_.Exception.Message
  }
})

function Get-LinkSelectedJob { if ($queueList.SelectedItem) { return $queueList.SelectedItem.Job }; return $null }
function Get-LinkSelectedItem { if ($libraryList.SelectedItem) { return $libraryList.SelectedItem.Item }; return $null }
function Invoke-LinkOpen([string]$Kind) {
  $item = Get-LinkSelectedItem
  if ($null -eq $item) { return }
  try {
    $directoryInput = [string]$item.directory
    $directory = if ([IO.Path]::IsPathRooted($directoryInput)) { [IO.Path]::GetFullPath($directoryInput) } else { [IO.Path]::GetFullPath((Join-Path $libraryRoot $directoryInput)) }
    $rootPrefix = [IO.Path]::GetFullPath($libraryRoot).TrimEnd('\') + '\'
    if (-not $directory.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '资料目录不在当前资料库内。' }
    if ($Kind -eq 'folder') { Start-Process explorer.exe -ArgumentList (ConvertTo-ReaderArgument $directory); return }
    if ($Kind -eq 'source') { Start-Process ([string]$item.sourceUrl); return }
    $relative = switch ($Kind) { 'reading' { [string]$item.readingPath } 'pdf' { [string]$item.pdfPath } default { [string]$item.videoPath } }
    if ([string]::IsNullOrWhiteSpace($relative)) { throw '该资料没有对应产物，可能尚未生成或不可用。' }
    $candidate = if ([IO.Path]::IsPathRooted($relative)) { [IO.Path]::GetFullPath($relative) } else { [IO.Path]::GetFullPath((Join-Path $directory $relative)) }
    if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and -not $candidate.StartsWith($directory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '产物路径不在资料目录内。' }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw '对应产物文件不存在。' }
    Start-Process -FilePath $candidate
  } catch { Set-LinkStatus ('无法打开资料：' + $_.Exception.Message); Write-LinkError $_.Exception.Message }
}

$enqueueButton.add_Click({
  if ([string]::IsNullOrWhiteSpace($inputBox.Text)) { Set-LinkStatus '请先粘贴链接或完整分享文案。'; return }
  Start-LinkOperation @('enqueue', $inputBox.Text) '正在加入持久队列…'
})
$workButton.add_Click({ Start-LinkWorker })
$cancelButton.add_Click({
  try {
    if ($script:linkOperation -eq 'login' -and $script:linkJob) {
      Stop-ReaderProcess $script:linkJob
      $script:linkJob = $null
      Set-LinkStatus '登录入口已关闭。'
      Set-LinkControls
      return
    }
    if ($script:linkInstallJob) {
      Stop-Process -Id $script:linkInstallJob.Process.Id -Force -ErrorAction SilentlyContinue
      $script:linkInstallJob = $null
      Set-LinkStatus '依赖安装已取消。'
      Set-LinkControls
      return
    }
    $selectedJob = Get-LinkSelectedJob
    if ($selectedJob -and $script:linkWorkJob) {
      Start-LinkOperation @('cancel', $selectedJob.id) '正在提交取消任务请求…'
      return
    }
    if ($script:linkJob) {
      Stop-ReaderProcess $script:linkJob
      $script:linkJob = $null
      Set-LinkStatus '当前窗口操作已取消。'
      Set-LinkControls
      return
    }
    if ($selectedJob) { Start-LinkOperation @('cancel', $selectedJob.id) '正在提交取消任务请求…'; return }
    if ($script:linkWorkJob) {
      Stop-ReaderProcess $script:linkWorkJob
      $script:linkWorkJob = $null
      $script:linkWorkRunning = $false
      Set-LinkStatus '保存任务已停止；已经保存的资料不会被删除。'
      Set-LinkControls
    }
  } catch { Set-LinkStatus ('取消失败：' + $_.Exception.Message); Write-LinkError $_.Exception.Message }
})
$retryButton.add_Click({ $job = Get-LinkSelectedJob; if ($job) { Start-LinkOperation @('retry', $job.id) '正在重试任务…' } })
$searchButton.add_Click({ Refresh-LinkLibrary })
$allButton.add_Click({ $searchBox.Clear(); $platformCombo.SelectedIndex = 0; Refresh-LinkLibrary })
$searchBox.add_KeyDown({ if ($_.KeyCode -eq [Windows.Forms.Keys]::Enter) { $_.SuppressKeyPress = $true; Refresh-LinkLibrary } })
$platformCombo.add_SelectedIndexChanged({ if ($form.IsHandleCreated) { Refresh-LinkLibrary } })
$queueList.add_SelectedIndexChanged({ if ($queueList.SelectedItem) { $script:linkSelectedJobId = $queueList.SelectedItem.JobId }; Set-LinkControls })
$libraryList.add_SelectedIndexChanged({
  if ($libraryList.SelectedItem) {
    $script:linkSelectedContentId = $libraryList.SelectedItem.ContentId
    Render-LinkAssets $libraryList.SelectedItem.Item
    if ($null -eq $script:linkJob -and $null -eq $script:linkPollJob) {
      Start-LinkOperation @('read', $script:linkSelectedContentId) '正在读取产物状态…'
    }
  }
  Set-LinkControls
})
$libraryList.add_DoubleClick({ Invoke-LinkOpen 'reading' })
$openReadingButton.add_Click({ Invoke-LinkOpen 'reading' })
$openPdfButton.add_Click({ Invoke-LinkOpen 'pdf' })
$openVideoButton.add_Click({ Invoke-LinkOpen 'video' })
$openFolderButton.add_Click({ Invoke-LinkOpen 'folder' })
$openSourceButton.add_Click({ Invoke-LinkOpen 'source' })
$exportButton.add_Click({ $item = Get-LinkSelectedItem; if ($item) { Start-LinkOperation @('export', [string]$item.contentId) '正在导出资料包…' } })
$doctorButton.add_Click({ Start-LinkOperation @('doctor') '正在检查本地依赖…' })
$installButton.add_Click({ Start-LinkInstaller })
$loginButton.add_Click({ Start-LinkOperation @('login', [string]$loginPlatformCombo.SelectedItem.Value) '正在打开专用浏览器登录入口…' })
$form.add_FormClosing({
  try {
    if ($script:linkJob) { Stop-ReaderProcess $script:linkJob; $script:linkJob = $null }
    if ($script:linkPollJob) { Stop-ReaderProcess $script:linkPollJob; $script:linkPollJob = $null }
    if ($script:linkWorkJob) { Stop-ReaderProcess $script:linkWorkJob; $script:linkWorkJob = $null }
    if ($script:linkInstallJob) { Stop-Process -Id $script:linkInstallJob.Process.Id -Force -ErrorAction SilentlyContinue; $script:linkInstallJob = $null }
  } catch {}
})
$form.add_FormClosed({ $linkTimer.Stop(); $linkTimer.Dispose(); $tooltip.Dispose() })

Set-LinkControls
if (-not $NoShow) {
  $form.add_Shown({ Refresh-LinkJobs; Refresh-LinkLibrary })
  [void]$form.ShowDialog()
  $form.Dispose()
}
