param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$sourceRoot = Join-Path $ProjectRoot '程序文件'
$tempProject = Join-Path ([IO.Path]::GetTempPath()) ('link-window-harness-' + [guid]::NewGuid().ToString('N'))
$tempProgram = Join-Path $tempProject '程序文件'
[void][IO.Directory]::CreateDirectory((Join-Path $tempProgram 'dist'))
[void][IO.Directory]::CreateDirectory((Join-Path $tempProject '资料库\items\content-1'))
[void][IO.Directory]::CreateDirectory((Join-Path $tempProject '资料库\items\content-2'))
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-1\reading.html') -Value '<h1>测试资料</h1>' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-1\资料.pdf') -Value 'pdf' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-1\资料.mp4') -Value 'video' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-1\测试资料.md') -Value '# 测试资料：整篇正文，从开头到结尾。' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-1\图片识别稿.md') -Value '这只是图片上的几个字。' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-2\reading.html') -Value '<h1>微信资料</h1>' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-2\微信资料.md') -Value '# 没有图片识别稿的整篇文章。' -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $sourceRoot 'link-window.ps1') -Destination (Join-Path $tempProgram 'link-window.ps1')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'reader-process.ps1') -Destination (Join-Path $tempProgram 'reader-process.ps1')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'link-library-dialogs.ps1') -Destination (Join-Path $tempProgram 'link-library-dialogs.ps1')
$fakeCli = @'
const fs = require('fs');
const path = require('path');
const command = process.argv[2];
const statePath = path.join(process.cwd(), 'link-state.json');
const callsPath = path.join(process.cwd(), 'link-calls.jsonl');
const root = path.resolve(process.cwd(), '..', '资料库');
const now = () => new Date().toISOString();
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { job: null }; } };
const writeState = state => fs.writeFileSync(statePath, JSON.stringify(state));
const state = readState();
const args = process.argv.slice(3);
fs.appendFileSync(callsPath, JSON.stringify({ command, args }) + '\n');
const job = () => state.job;
const historicJob = { id: 'job-history', input: { url: 'https://example.com/history', platform: 'web' }, platform: 'web', title: '很长的历史资料标题，用来确认列表不会显示对象字面量', state: 'completed', stage: '处理结束', message: '资料已保存', createdAt: '2025-01-01T08:00:00.000Z', updatedAt: '2025-01-01T08:03:00.000Z', attempts: 1 };
const jobs = () => state.job ? [state.job, historicJob] : [historicJob];
const items = [
  { contentId: 'content-1', title: '测试资料', platform: 'web', kind: 'article', status: 'completed', directory: path.join(root, 'items', 'content-1'), readingPath: path.join(root, 'items', 'content-1', 'reading.html'), pdfPath: path.join(root, 'items', 'content-1', '资料.pdf'), textPath: path.join(root, 'items', 'content-1', '测试资料.md'), transcriptPath: path.join(root, 'items', 'content-1', '图片识别稿.md'), videoPath: path.join(root, 'items', 'content-1', '资料.mp4'), sourceUrl: 'https://example.com/a', capturedAt: now() },
  { contentId: 'content-2', title: '微信资料', platform: 'wechat', kind: 'article', status: 'partial', directory: path.join(root, 'items', 'content-2'), readingPath: path.join(root, 'items', 'content-2', 'reading.html'), textPath: path.join(root, 'items', 'content-2', '微信资料.md'), sourceUrl: 'https://mp.weixin.qq.com/s/a', capturedAt: now() }
];
if (command === 'enqueue') {
  state.job = { id: 'job-1', input: { url: args.join(' ') || 'https://example.com/a', platform: 'web', canonicalUrl: args.join(' ') || 'https://example.com/a' }, platform: 'web', title: '测试资料', state: 'queued', stage: '等待', message: '已加入队列', contentId: 'content-1', createdAt: now(), updatedAt: now(), attempts: 0 };
  writeState(state); process.stdout.write(JSON.stringify({ ok: true, message: '已加入队列', jobs: jobs() })); return;
}
if (command === 'cancel') {
  if (state.job) { state.job.state = 'cancelled'; state.job.stage = '已取消'; state.job.message = '已取消，已保存文件保留'; state.job.updatedAt = now(); state.job.cancelRequested = true; writeState(state); }
  process.stdout.write(JSON.stringify({ ok: true, message: '任务已取消', jobs: jobs() })); return;
}
if (command === 'retry') {
  if (state.job) { state.job.state = 'queued'; state.job.stage = '等待重试'; state.job.message = '将复用已保存文件并补充缺失项'; state.job.updatedAt = now(); state.job.cancelRequested = false; writeState(state); }
  process.stdout.write(JSON.stringify({ ok: true, message: '任务已重试', jobs: jobs() })); return;
}
if (command === 'work') {
  if (state.job) { state.job.state = 'running'; state.job.stage = '准备'; state.job.message = '正在处理'; state.job.updatedAt = now(); writeState(state); }
  setTimeout(() => { const latest = readState(); if (latest.job && latest.job.state !== 'cancelled') { latest.job.state = 'completed'; latest.job.stage = '处理结束'; latest.job.message = '资料已保存，可离线阅读'; latest.job.updatedAt = now(); } writeState(latest); process.stdout.write(JSON.stringify({ ok: true, message: '处理完成', jobs: latest.job ? [latest.job] : [] })); }, 260); return;
}
if (command === 'jobs') { process.stdout.write(JSON.stringify({ ok: true, message: '任务状态已读取', jobs: jobs() })); return; }
if (command === 'list') { process.stdout.write(JSON.stringify({ ok: true, message: '资料库已读取', items })); return; }
if (command === 'read') { process.stdout.write(JSON.stringify({ ok: true, message: '产物状态已读取', text: '# 测试资料', manifest: { assets: [{ role: 'reading', status: 'saved', label: '正文' }, { role: 'pdf', status: 'saved', label: 'PDF' }, { role: 'video', status: 'saved', label: '视频' }] } })); return; }
if (command === 'export') { process.stdout.write(JSON.stringify({ ok: true, message: '资料包已导出', directory: path.join(root, 'exports', 'content-1') })); return; }
if (command === 'export-zip') { process.stdout.write(JSON.stringify({ ok: true, message: 'ZIP 已导出', path: path.join(root, 'exports', args[0] + '.zip') })); return; }
if (command === 'doctor') { process.stdout.write(JSON.stringify({ ok: true, message: '依赖检查完成', tools: [{ id: 'node', name: 'Node.js', available: true }] })); return; }
if (command === 'login') { process.stdout.write(JSON.stringify({ ok: true, message: '已打开登录入口' })); return; }
process.stdout.write(JSON.stringify({ ok: false, message: '未知命令' }));
'@
[IO.File]::WriteAllText((Join-Path $tempProgram 'dist\link-cli.js'), $fakeCli, (New-Object Text.UTF8Encoding($false)))

$script:windowChecks = 0
function Assert-Window([bool]$Condition, [string]$Message) { $script:windowChecks++; if (-not $Condition) { throw $Message } }
function Assert-QueueControlsAccessible([string]$SizeName) {
  $form.PerformLayout()
  $queueGroup.PerformLayout()
  [Windows.Forms.Application]::DoEvents()
  $problems = New-Object 'System.Collections.Generic.List[string]'
  foreach ($control in @($cancelButton, $retryButton, $queueStatus)) {
    $label = [string]$control.Text
    if ($control.Parent -ne $queueGroup) { $problems.Add("$label 的 Parent 不是任务队列") }
    if (-not $queueGroup.ClientRectangle.Contains($control.Bounds)) { $problems.Add("$label 超出任务队列边界：$($control.Bounds)") }
    if (-not $control.Visible) { $problems.Add("$label 不可见") }
  }
  Assert-Window ($problems.Count -eq 0) ("任务队列控件在${SizeName}不可访问：" + ($problems -join '；'))
}
function Wait-WindowOperation {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (($script:linkJob -or $script:linkWorkJob -or $script:linkPollJob) -and [DateTime]::UtcNow -lt $deadline) {
    [Windows.Forms.Timer].GetMethod('OnTick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($linkTimer, @([EventArgs]::Empty)) | Out-Null
    Start-Sleep -Milliseconds 20
  }
  Assert-Window ($null -eq $script:linkJob -and $null -eq $script:linkWorkJob -and $null -eq $script:linkPollJob) '多平台资料库 UI 操作超时'
}

try {
  . (Join-Path $tempProgram 'link-window.ps1') -ProjectRoot $tempProject -NoShow
  $form.CreateControl()
  $form.PerformLayout()
  Assert-Window ($PSVersionTable.PSVersion.Major -eq 5) '必须使用 Windows PowerShell 5.1'
  Assert-Window ($form.Text -eq '多平台资料库') '窗口标题不正确'
  Assert-Window ($form.ClientSize.Width -ge 1100 -and $form.ClientSize.Height -ge 740) '默认窗口尺寸不足'
  # Real child handles and native hit tests are required: reflected OnClick succeeds even behind a GroupBox.
  $form.ShowInTaskbar = $false
  $form.StartPosition = 'Manual'
  $form.Location = New-Object Drawing.Point(-32000, -32000)
  $form.Show()
  Assert-Window ($mainTabs.SelectedTab -eq $libraryTab) '启动默认页应为资料库'
  Initialize-LinkWorkspace
  Wait-WindowOperation
  Assert-Window ($libraryList.Items.Count -eq 2) '启动未自动加载资料库，仍依赖手动搜索'
  $script:openedTargets = @()
  function Start-Process { param([string]$FilePath, $ArgumentList) $script:openedTargets += [pscustomobject]@{path=$FilePath;arguments=$ArgumentList} }
  Assert-Window $openTranscriptButton.Enabled '整篇文字稿未启用'
  $openTranscriptButton.PerformClick()
  Assert-Window ($script:openedTargets.Count -eq 1 -and $script:openedTargets[0].path -eq (Join-Path $tempProject '资料库\items\content-1\测试资料.md')) '打开文字稿仍指向单图识别稿，未打开整篇文章'
  Assert-Window ($form.Text -eq '测试资料 - 多平台资料库' -and $hint.Text.Contains((Join-Path $tempProject '资料库\items\content-1'))) '所选标题与目录未同步到窗口提示'
  Assert-Window ($libraryGroup.Text -match '2 条' -and $assetStatusLabel.Text -match '3 个资源') '资料条数与内部资源数没有明确区分'
  foreach ($spec in @(@($openReadingButton,'reading.html'), @($openPdfButton,'资料.pdf'), @($openVideoButton,'资料.mp4'))) {
    $spec[0].PerformClick()
    Assert-Window ($script:openedTargets[-1].path -eq (Join-Path (Join-Path $tempProject '资料库\items\content-1') $spec[1])) ('阅读按钮没有打开所选条目的当前文件：' + $spec[0].Text)
    Assert-Window ($tooltip.GetToolTip($spec[0]).Contains($script:openedTargets[-1].path)) ('阅读按钮提示未显示实际文件：' + $spec[0].Text)
  }
  $openFolderButton.PerformClick(); Assert-Window ($script:openedTargets[-1].path -eq 'explorer.exe' -and $script:openedTargets[-1].arguments.Contains('content-1')) '打开目录未使用当前资料目录'
  $openSourceButton.PerformClick(); Assert-Window ($script:openedTargets[-1].path -eq 'https://example.com/a') '打开来源未使用当前来源链接'
  $keyDown = [Windows.Forms.Control].GetMethod('OnKeyDown', [Reflection.BindingFlags]'NonPublic,Instance')
  $readingKey = New-Object Windows.Forms.KeyEventArgs([Windows.Forms.Keys]::Enter)
  [void]$keyDown.Invoke($libraryList, @($readingKey.PSObject.BaseObject))
  Assert-Window ($readingKey.SuppressKeyPress -and $script:openedTargets[-1].path.EndsWith('reading.html')) '列表 Enter 无法打开阅读页'
  $textKey = New-Object Windows.Forms.KeyEventArgs([Windows.Forms.Keys]([int][Windows.Forms.Keys]::Control -bor [int][Windows.Forms.Keys]::Enter))
  [void]$keyDown.Invoke($libraryList, @($textKey.PSObject.BaseObject))
  Assert-Window ($textKey.SuppressKeyPress -and $script:openedTargets[-1].path.EndsWith('测试资料.md')) '列表 Ctrl+Enter 无法打开整篇文字稿'
  $manageButton.PerformClick()
  Assert-Window ($manageMenu.Visible -and $manageMenu.Items.Contains($detailsButton) -and $manageMenu.Items.Contains($editTranscriptButton) -and $manageMenu.Items.Contains($resolveMissingButton) -and $manageMenu.Items.Contains($organizeButton)) '管理菜单遗漏现有操作或无法展开'
  Assert-Window ($editTranscriptButton.Enabled -and $editTranscriptButton.Text -match '识别稿 / 转写稿') '全文与识别稿校订仍混为同一入口'
  $manageMenu.Close()
  $exportMenuButton.PerformClick()
  Assert-Window ($exportMenu.Visible -and $exportMenu.Items.Contains($exportButton) -and $exportMenu.Items.Contains($zipButton)) '导出菜单遗漏资料包或 ZIP'
  $exportMenu.Close()
  $selectedManifest = $script:linkCurrentManifest
  $script:linkJob = [pscustomobject]@{fixture=$true}
  Set-LinkControls
  Assert-Window (-not $exportMenuButton.Enabled -and -not $exportButton.Enabled -and -not $zipButton.Enabled) '处理前台命令时，导出菜单与菜单项未同步禁用'
  Assert-Window (-not $detailsButton.Enabled -and -not $organizeButton.Enabled -and -not $editTranscriptButton.Enabled -and -not $resolveMissingButton.Enabled) '前台命令进行时，管理菜单项未禁用'
  Assert-Window ($openReadingButton.Enabled -and $openTranscriptButton.Enabled) '前台命令错误阻止打开已保存的阅读文件'
  $libraryList.SelectedIndex=-1
  Assert-Window (-not $manageButton.Enabled -and -not $exportMenuButton.Enabled -and -not $openReadingButton.Enabled -and -not $openTranscriptButton.Enabled) '未选中资料时仍可执行条目操作'
  Assert-Window ($form.Text -eq '多平台资料库' -and $hint.Text -eq ('资料库：'+$libraryRoot)) '取消选择后窗口仍提示旧条目的标题或目录'
  $libraryList.SelectedIndex=0
  $script:linkJob=$null
  Set-LinkControls
  Render-LinkManifest $selectedManifest
  Assert-Window ($manageButton.Enabled -and $exportMenuButton.Enabled -and $exportButton.Enabled -and $zipButton.Enabled) '前台命令结束后菜单未恢复'
  $script:linkWorkJob=[pscustomobject]@{fixture=$true}
  Set-LinkControls
  Assert-Window (-not $editTranscriptButton.Enabled -and -not $resolveMissingButton.Enabled) '采集任务进行时仍可重复处理或校订'
  $script:linkWorkJob=$null
  Set-LinkControls
  foreach ($testSize in @(@(1150,760), @(980,680))) {
    $form.ClientSize = New-Object Drawing.Size($testSize[0], $testSize[1])
    Set-LinkWorkspaceLayout
    Assert-Window ($libraryTab.ClientRectangle.Contains($libraryGroup.Bounds)) '资料区超出页面'
    foreach ($c in @($libraryList,$searchBox,$searchLabel,$platformLabel,$platformCombo,$searchButton,$allButton,$openReadingButton,$openPdfButton,$openTranscriptButton,$openVideoButton,$openFolderButton,$openSourceButton,$manageButton,$exportMenuButton,$importButton,$favoritesOnly)) {
      Assert-Window ($libraryGroup.ClientRectangle.Contains($c.Bounds)) ('资料控件越界：' + $c.Name + $c.Text)
    }
    Assert-Window ($libraryList.Height -ge 240) '资料列表高度不足'
    $readingControls = @($openReadingButton,$openPdfButton,$openTranscriptButton,$openVideoButton,$openFolderButton,$openSourceButton)
    for($i=0;$i -lt $readingControls.Count-1;$i++) { Assert-Window (-not $readingControls[$i].Bounds.IntersectsWith($readingControls[$i+1].Bounds)) '阅读按钮在窄窗口中重叠' }
  }
  $defaultFont = $form.Font
  $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 12.5)
  $mainTabs.Font = $form.Font
  $form.ClientSize = New-Object Drawing.Size(1225,850)
  Set-LinkWorkspaceLayout
  foreach ($c in @($openReadingButton,$openPdfButton,$openTranscriptButton,$openVideoButton,$openFolderButton,$openSourceButton,$manageButton,$exportMenuButton,$importButton,$favoritesOnly)) {
    Assert-Window ($libraryGroup.ClientRectangle.Contains($c.Bounds)) ('125% 字体与最小窗口控件越界：'+$c.Text)
    $needed = [Windows.Forms.TextRenderer]::MeasureText($c.Text,$c.Font)
    Assert-Window ($c.Width -ge $needed.Width -and $c.Height -ge $needed.Height) ('125% 字体下按钮文字被截断：'+$c.Text)
  }
  $form.Font=$defaultFont; $mainTabs.Font=$defaultFont
  $form.ClientSize = New-Object Drawing.Size(1150,760)
  $mainTabs.SelectedTab = $taskTab
  [Windows.Forms.Application]::DoEvents()
  $defaultSize = $form.Size
  Assert-QueueControlsAccessible '默认尺寸'
  $form.Size = $form.MinimumSize
  Assert-QueueControlsAccessible '最小尺寸'
  $form.Size = $defaultSize
  Assert-Window ($queueList.Items.Count -eq 0) '初始任务列表不为空'
  Assert-Window ($historyToggle.Text -match '历史') '任务区缺少历史切换入口'
  $inputBox.Text = '测试资料 https://example.com/a'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($enqueueButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($queueList.Items.Count -eq 1 -and $queueList.Items[0].Text -match '待处理') '加入队列没有显示待处理任务'
  Assert-Window ([string]$queueList.Items[0] -notmatch '@\{Text=') '任务列表将对象字面量显示给用户'
  Assert-Window ($status.Text -match '加入队列|队列') '加入队列状态未显示'
  $inputBox.Clear()
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($workButton, @([EventArgs]::Empty)) | Out-Null
  Start-Sleep -Milliseconds 60
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($cancelButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'cancel' }).Count -eq 1) '取消按钮没有调用 cancel <id>'
  Assert-Window ($queueList.Items.Count -eq 0) '已取消任务仍混在默认当前任务中'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($historyToggle, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($queueList.Items.Count -eq 2) '切换历史后没有显示完成任务'
  Assert-Window ($queueList.Items[0].Text -match '测试资料') '历史列表没有按新到旧显示当前任务'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($retryButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'retry' }).Count -eq 1) '重试按钮没有调用 retry <id>'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($historyToggle, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($queueList.Items.Count -eq 1 -and $queueList.Items[0].Text -match '待处理') '关闭历史后没有恢复当前重试任务'
  $searchBox.Text = '测试资料'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($searchButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  Assert-Window ($libraryList.Items.Count -eq 2) '资料库搜索没有显示资料'
  Assert-Window ($platformCombo.Items.Count -ge 5) '平台过滤选项不完整'
  Assert-Window ($openReadingButton.Enabled -and $exportButton.Enabled) '资料操作按钮未根据选择启用'
  Assert-Window ($assetStatusLabel.Text -match '3 个资源 · 已保存 3' -and $assetStatusLabel.Text -match '阅读页 1') ('选中资料没有读取简短资源状态：' + $assetStatusLabel.Text)
  $manyAssets = @(1..58 | ForEach-Object { [pscustomobject]@{role='image';status='saved';label=('图片 '+$_)} })
  Render-LinkManifest ([pscustomobject]@{assets=$manyAssets})
  Assert-Window ($assetStatusLabel.Text -match '58 个资源' -and $assetStatusLabel.Text -match '图片 58' -and $assetStatusLabel.Text.Length -lt 150) '58 个资源仍被逐项堆在底部或误标为资料条数'
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'read' }).Count -ge 1) '选择资料没有调用 read <contentId>'
  $platformCombo.SelectedIndex = 1
  [Windows.Forms.ComboBox].GetMethod('OnSelectedIndexChanged', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($platformCombo, @([EventArgs]::Empty)) | Out-Null
  Refresh-LinkLibrary
  Wait-WindowOperation
  Assert-Window ($libraryList.Items.Count -eq 1 -and $libraryList.Items[0].Text -match '微信公众号') ('平台筛选没有只保留微信公众号：选择=' + [string]$platformCombo.SelectedItem + '，数量=' + $libraryList.Items.Count + '，文本=' + (($libraryList.Items | ForEach-Object { $_.Text }) -join '|'))
  Assert-Window (-not $openPdfButton.Enabled -and -not $openVideoButton.Enabled) '不存在的PDF和视频操作未禁用'
  Assert-Window ($openTranscriptButton.Enabled -and -not $editTranscriptButton.Enabled) '没有识别稿的文章无法打开全文，或错误启用了校订'
  $withoutText = Get-LinkSelectedItem
  $savedTextPath = $withoutText.textPath
  $withoutText.textPath = ''
  Set-LinkControls
  Assert-Window (-not $openTranscriptButton.Enabled) '缺少全文的资料错误启用了文字入口'
  $withoutText.textPath = $savedTextPath
  Set-LinkControls
  Assert-Window ($form.Text -eq '微信资料 - 多平台资料库' -and $hint.Text.Contains('content-2')) '切换选中资料后仍显示上一个条目的标题或路径'
  $exportButton.PerformClick()
  Wait-WindowOperation
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'export' }).Count -eq 1) '导出按钮没有调用 export <id>'
  $zipButton.PerformClick()
  Wait-WindowOperation
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'export-zip' -and $_.args[0] -eq 'content-2' }).Count -eq 1) '导出 ZIP 菜单没有调用所选资料的 export-zip <id>'
  Assert-Window ($status.Text -match 'ZIP 已导出' -and $status.Text.Contains('content-2.zip')) 'ZIP 导出结果未显示实际文件位置'
  $form.ClientSize = New-Object Drawing.Size(1400, 900)
  Assert-Window ($libraryList.Width -gt 500 -and $libraryList.Height -gt 180) '资料列表没有随窗口拉伸'
  $inputBox.Text = 'https://example.com/one-click'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($workButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'work' }).Count -eq 2) '一键保存没有自动启动worker'
  Assert-Window ($inputBox.Text -eq '') '成功入队后输入未清空'
  Assert-Window ($queueList.Items.Count -eq 0) '完成任务未离开当前队列'
  $script:linkStartWorkerAfterEnqueue = $true
  Complete-LinkOperation ([pscustomobject]@{ok=$false;message='测试拒绝'}) 'enqueue'
  Assert-Window (-not $script:linkStartWorkerAfterEnqueue) '入队失败残留自动启动标记'
  $script:linkPendingRefresh = $false
  Complete-LinkWorker ([pscustomobject]@{ok=$false;message='测试后台失败'})
  Assert-Window $script:linkPendingRefresh '后台失败没有触发刷新'
  $script:linkPendingRefresh = $false
  $script:linkReadContentId = 'content-1'
  $script:linkSelectedContentId = 'content-2'
  Complete-LinkOperation ([pscustomobject]@{ok=$true;message='旧回调';manifest=[pscustomobject]@{assets=@([pscustomobject]@{label='过期资料';status='saved'})}}) 'read'
  Assert-Window ($assetStatusLabel.Text -notmatch '过期资料') '旧read结果覆盖了新选择'
  Wait-WindowOperation
  Assert-Window ($script:linkReadContentId -eq 'content-2') '未为最新选择补发read'
  $socialItems = @([pscustomobject]@{ platform = 'douyin'; contentId = 'douyin-only' }, [pscustomobject]@{ platform = 'weibo'; contentId = 'weibo-only' }, [pscustomobject]@{ platform = 'web'; contentId = 'other' })
  foreach ($socialPlatform in @([pscustomobject]@{ Text = '抖音'; Value = 'douyin' }, [pscustomobject]@{ Text = '微博'; Value = 'weibo' })) {
    $platformCombo.SelectedItem = $socialPlatform.Text
    Wait-WindowOperation
    $socialFiltered = @(Get-LinkFilteredItems $socialItems)
    Assert-Window ($socialFiltered.Count -eq 1 -and $socialFiltered[0].platform -eq $socialPlatform.Value) ('新平台筛选错误：' + $socialPlatform.Text)
    $loginOption = @($loginPlatformCombo.Items | Where-Object { $_.Value -eq $socialPlatform.Value })
    Assert-Window ($loginOption.Count -eq 1) ('新平台缺少专用登录选项：' + $socialPlatform.Text)
    $loginPlatformCombo.SelectedItem = $loginOption[0]
    [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($loginButton, @([EventArgs]::Empty)) | Out-Null
    Wait-WindowOperation
    $socialCalls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert-Window (@($socialCalls | Where-Object { $_.command -eq 'login' -and $_.args[0] -eq $socialPlatform.Value }).Count -eq 1) ('专用登录传入平台错误：' + $socialPlatform.Text)
  }
  [pscustomobject]@{ok=$true;version=$PSVersionTable.PSVersion.ToString();checks=$script:windowChecks} | ConvertTo-Json -Compress
} finally {
  if ($script:linkJob) { try { Stop-ReaderProcess $script:linkJob } catch {} }
  if ($linkTimer) { $linkTimer.Dispose() }
  if ($tooltip) { $tooltip.Dispose() }
  if ($form) { $form.Dispose() }
  if (Test-Path -LiteralPath $tempProject) {
    $resolvedTempProject = (Resolve-Path -LiteralPath $tempProject).ProviderPath
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedTempProject.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedTempProject) -notlike 'link-window-harness-*') { throw '拒绝清理测试临时目录以外的路径。' }
    Remove-Item -LiteralPath $resolvedTempProject -Recurse -Force
  }
}
