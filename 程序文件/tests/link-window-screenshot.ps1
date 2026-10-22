param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$outputRoot = Join-Path $ProjectRoot '程序文件\logs\link-window-acceptance'
[void][IO.Directory]::CreateDirectory($outputRoot)
. (Join-Path $ProjectRoot '程序文件\link-window.ps1') -ProjectRoot $ProjectRoot -NoShow
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(-32000, -32000)
$form.Show()

function Save-LinkWindowShot([string]$Name, [int]$Width, [int]$Height, [single]$FontPoints = 10) {
  $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', $FontPoints)
  $mainTabs.Font = $form.Font
  $title.Font = New-Object Drawing.Font('Microsoft YaHei UI', (18 * $FontPoints / 10), [Drawing.FontStyle]::Bold)
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
    [pscustomobject]@{ contentId = 'shot-content'; title = '资料库示例：离线阅读与文件入口'; platform = 'wechat'; kind = 'article'; status = 'completed'; capturedAt = '2026-10-20T00:00:00.000Z'; directory = 'items\2026-10-20_微信_资料库示例'; readingPath = '资料库示例.html'; pdfPath = '资料库示例.pdf'; textPath = '资料库示例.md'; transcriptPath = '处理结果\图片识别稿.md'; sourceUrl = 'https://example.com/article' },
    [pscustomobject]@{ contentId = 'shot-gallery'; title = '收藏的图片资料与手写笔记'; favorite = $true; tags = @('研究'); platform = 'local'; kind = 'gallery'; status = 'completed'; capturedAt = '2026-10-19T00:00:00.000Z'; directory = 'items\2026-10-19_本地文件_手写笔记'; readingPath = '手写笔记.html'; textPath = '手写笔记.md' },
    [pscustomobject]@{ contentId = 'shot-video'; title = '一段视频：原件已保存，转写等待处理'; platform = 'bilibili'; kind = 'video'; status = 'partial'; capturedAt = '2026-10-18T00:00:00.000Z'; directory = 'items\2026-10-18_B站_一段视频'; videoPath = '视频\001.mp4' }
  )
  Render-LinkManifest ([pscustomobject]@{assets=@([pscustomobject]@{role='reading';status='saved'},[pscustomobject]@{role='pdf';status='saved'}) + @(1..18 | ForEach-Object {[pscustomobject]@{role='image';status='saved'}})})
  Set-LinkControls
  Set-LinkStatus '选择阅读页保留原文排版；文字稿打开整篇正文。其他操作在“管理资料”和“导出”中。'
  Save-LinkWindowShot 'link-window-1150x760.png' 1150 760
  Save-LinkWindowShot 'link-window-980x680.png' 980 680
  Save-LinkWindowShot 'link-window-125percent.png' 1225 850 12.5
  $mainTabs.SelectedTab = $taskTab
  Save-LinkWindowShot 'link-tasks-980x680.png' 980 680
  $mainTabs.SelectedTab = $toolsTab
  Save-LinkWindowShot 'link-tools-980x680.png' 980 680
  $script:linkJob = $null
  [pscustomobject]@{ ok = $true; files = @('link-window-1150x760.png', 'link-window-980x680.png', 'link-window-125percent.png', 'link-tasks-980x680.png', 'link-tools-980x680.png') } | ConvertTo-Json -Compress
} finally {
  if ($linkTimer) { $linkTimer.Dispose() }
  if ($tooltip) { $tooltip.Dispose() }
  if ($form) { $form.Dispose() }
}
