param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$outputRoot = Join-Path $ProjectRoot '程序文件\logs\link-window-acceptance'
[void][IO.Directory]::CreateDirectory($outputRoot)
. (Join-Path $ProjectRoot '程序文件\link-window.ps1') -ProjectRoot $ProjectRoot -NoShow
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(-2000, -2000)
$form.Show()

function Save-LinkWindowShot([string]$Name, [int]$Width, [int]$Height) {
  $form.ClientSize = New-Object Drawing.Size($Width, $Height)
  $form.CreateControl()
  $form.PerformLayout()
  Set-LinkLibraryLayout
  Set-LinkQueueLayout
  [Windows.Forms.Application]::DoEvents()
  $form.Refresh()
  $bitmap = New-Object Drawing.Bitmap($form.Width, $form.Height)
  try {
    $form.DrawToBitmap($bitmap, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $bitmap.Save((Join-Path $outputRoot $Name), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
}

try {
  # Keep the deterministic visual fixture local; do not start a real CLI read while rendering screenshots.
  $script:linkJob = [pscustomobject]@{ Fixture = $true }
  Render-LinkJobs @(
    [pscustomobject]@{ id = 'shot-running'; title = '正在采集的长标题：多平台资料内容与媒体附件'; state = 'running'; stage = '正在保存视频'; message = '正在下载媒体，窗口仍可浏览资料库'; createdAt = '2026-09-19T08:12:00.000Z'; updatedAt = '2026-09-19T08:14:00.000Z'; input = [pscustomobject]@{ url = 'https://example.com/running' } },
    [pscustomobject]@{ id = 'shot-queued'; title = '等待中的资料'; state = 'queued'; stage = '等待'; message = '已加入队列'; createdAt = '2026-09-19T08:13:00.000Z'; updatedAt = '2026-09-19T08:13:00.000Z'; input = [pscustomobject]@{ url = 'https://example.com/queued' } }
  )
  Render-LinkLibrary @(
    [pscustomobject]@{ contentId = 'shot-content'; title = '资料库示例：离线阅读与素材状态'; platform = 'wechat'; kind = 'article'; status = 'partial'; capturedAt = '2026-09-19T00:00:00.000Z'; directory = 'items\\shot-content' }
  )
  $assetStatusLabel.Text = '产物状态：正文=已保存；PDF=已保存；视频=处理中；字幕=缺失'
  Save-LinkWindowShot 'link-window-1150x760.png' 1150 760
  Save-LinkWindowShot 'link-window-980x680.png' 980 680
  $mainTabs.SelectedTab = $taskTab
  Save-LinkWindowShot 'link-tasks-980x680.png' 980 680
  $mainTabs.SelectedTab = $toolsTab
  Save-LinkWindowShot 'link-tools-980x680.png' 980 680
  $script:linkJob = $null
  [pscustomobject]@{ ok = $true; files = @('link-window-1150x760.png', 'link-window-980x680.png', 'link-tasks-980x680.png', 'link-tools-980x680.png') } | ConvertTo-Json -Compress
} finally {
  if ($linkTimer) { $linkTimer.Dispose() }
  if ($tooltip) { $tooltip.Dispose() }
  if ($form) { $form.Dispose() }
}
