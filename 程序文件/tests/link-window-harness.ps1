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
Set-Content -LiteralPath (Join-Path $tempProject '资料库\items\content-2\reading.html') -Value '<h1>微信资料</h1>' -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $sourceRoot 'link-window.ps1') -Destination (Join-Path $tempProgram 'link-window.ps1')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'reader-process.ps1') -Destination (Join-Path $tempProgram 'reader-process.ps1')
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
  { contentId: 'content-1', title: '测试资料', platform: 'web', kind: 'article', status: 'completed', directory: path.join(root, 'items', 'content-1'), readingPath: path.join(root, 'items', 'content-1', 'reading.html'), pdfPath: path.join(root, 'items', 'content-1', '资料.pdf'), videoPath: path.join(root, 'items', 'content-1', '资料.mp4'), sourceUrl: 'https://example.com/a', capturedAt: now() },
  { contentId: 'content-2', title: '微信资料', platform: 'wechat', kind: 'article', status: 'partial', directory: path.join(root, 'items', 'content-2'), readingPath: path.join(root, 'items', 'content-2', 'reading.html'), sourceUrl: 'https://mp.weixin.qq.com/s/a', capturedAt: now() }
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
if (command === 'doctor') { process.stdout.write(JSON.stringify({ ok: true, message: '依赖检查完成', tools: [{ id: 'node', name: 'Node.js', available: true }] })); return; }
if (command === 'login') { process.stdout.write(JSON.stringify({ ok: true, message: '已打开登录入口' })); return; }
process.stdout.write(JSON.stringify({ ok: false, message: '未知命令' }));
'@
[IO.File]::WriteAllText((Join-Path $tempProgram 'dist\link-cli.js'), $fakeCli, (New-Object Text.UTF8Encoding($false)))

function Assert-Window([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
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
  foreach ($testSize in @(@(1150,760), @(980,680))) {
    $form.ClientSize = New-Object Drawing.Size($testSize[0], $testSize[1])
    Set-LinkWorkspaceLayout
    Assert-Window ($libraryTab.ClientRectangle.Contains($libraryGroup.Bounds)) '资料区超出页面'
    foreach ($c in @($libraryList,$searchBox,$allButton,$openReadingButton,$exportButton)) {
      Assert-Window ($libraryGroup.ClientRectangle.Contains($c.Bounds)) ('资料控件越界：' + $c.Name + $c.Text)
    }
    Assert-Window ($libraryList.Height -ge 240) '资料列表高度不足'
  }
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
  Assert-Window ($assetStatusLabel.Text -match '正文：已保存') ('选中资料没有读取 manifest 产物状态：' + $assetStatusLabel.Text)
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'read' }).Count -ge 1) '选择资料没有调用 read <contentId>'
  $platformCombo.SelectedIndex = 1
  [Windows.Forms.ComboBox].GetMethod('OnSelectedIndexChanged', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($platformCombo, @([EventArgs]::Empty)) | Out-Null
  Refresh-LinkLibrary
  Wait-WindowOperation
  Assert-Window ($libraryList.Items.Count -eq 1 -and $libraryList.Items[0].Text -match '微信公众号') ('平台筛选没有只保留微信公众号：选择=' + [string]$platformCombo.SelectedItem + '，数量=' + $libraryList.Items.Count + '，文本=' + (($libraryList.Items | ForEach-Object { $_.Text }) -join '|'))
  Assert-Window (-not $openPdfButton.Enabled -and -not $openVideoButton.Enabled) '不存在的PDF和视频操作未禁用'
  [Windows.Forms.Button].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic,Instance').Invoke($exportButton, @([EventArgs]::Empty)) | Out-Null
  Wait-WindowOperation
  $calls = @(Get-Content -LiteralPath (Join-Path $tempProgram 'link-calls.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Window (@($calls | Where-Object { $_.command -eq 'export' }).Count -eq 1) '导出按钮没有调用 export <id>'
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
  [pscustomobject]@{ok=$true;version=$PSVersionTable.PSVersion.ToString();checks=32} | ConvertTo-Json -Compress
} finally {
  if ($script:linkJob) { try { Stop-ReaderProcess $script:linkJob } catch {} }
  if ($linkTimer) { $linkTimer.Dispose() }
  if ($tooltip) { $tooltip.Dispose() }
  if ($form) { $form.Dispose() }
  if (Test-Path -LiteralPath $tempProject) { Remove-Item -LiteralPath $tempProject -Recurse -Force }
}
