param([Parameter(Mandatory = $true)][string]$ProjectRoot)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$libraryRoot = Join-Path $ProjectRoot "文章库"

$form = New-Object System.Windows.Forms.Form
$form.Text = "公众号文章阅读器"
$form.Size = New-Object System.Drawing.Size(640, 245)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)

$label = New-Object System.Windows.Forms.Label
$label.Text = "粘贴微信公众号文章链接"
$label.Location = New-Object System.Drawing.Point(24, 24)
$label.AutoSize = $true
$form.Controls.Add($label)

$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Location = New-Object System.Drawing.Point(24, 52)
$urlBox.Size = New-Object System.Drawing.Size(575, 30)
$urlBox.Anchor = "Top, Left, Right"
$form.Controls.Add($urlBox)

$readButton = New-Object System.Windows.Forms.Button
$readButton.Text = "读取文章"
$readButton.Location = New-Object System.Drawing.Point(24, 98)
$readButton.Size = New-Object System.Drawing.Size(120, 36)
$form.Controls.Add($readButton)

$openArticleButton = New-Object System.Windows.Forms.Button
$openArticleButton.Text = "打开文章"
$openArticleButton.Location = New-Object System.Drawing.Point(158, 98)
$openArticleButton.Size = New-Object System.Drawing.Size(120, 36)
$openArticleButton.Enabled = $false
$form.Controls.Add($openArticleButton)

$openFolderButton = New-Object System.Windows.Forms.Button
$openFolderButton.Text = "打开文章库"
$openFolderButton.Location = New-Object System.Drawing.Point(292, 98)
$openFolderButton.Size = New-Object System.Drawing.Size(130, 36)
$form.Controls.Add($openFolderButton)

$status = New-Object System.Windows.Forms.Label
$status.Text = "就绪：粘贴链接后点击读取文章。读取时 Edge 可能会短暂打开。"
$status.Location = New-Object System.Drawing.Point(24, 158)
$status.Size = New-Object System.Drawing.Size(575, 44)
$form.Controls.Add($status)

$worker = New-Object System.ComponentModel.BackgroundWorker
$worker.add_DoWork({
  param($sender, $eventArgs)
  $url = [string]$eventArgs.Argument
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node.exe"
  $escapedRoot = (Join-Path $ProjectRoot "dist\cli.js").Replace('"', '\"')
  $escapedUrl = $url.Replace('"', '\"')
  $psi.Arguments = ('"{0}" capture "{1}"' -f $escapedRoot, $escapedUrl)
  $psi.WorkingDirectory = $ProjectRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $eventArgs.Result = @{ ExitCode = $process.ExitCode; Output = $stdout; Error = $stderr }
})
$worker.add_RunWorkerCompleted({
  param($sender, $eventArgs)
  $readButton.Enabled = $true
  if ($eventArgs.Error) { $status.Text = "读取失败：程序发生错误。"; return }
  try {
    $payload = $eventArgs.Result.Output | ConvertFrom-Json
    if ($payload.ok) {
      $status.Text = "读取完成：$($payload.title)（本地图片 $($payload.imageSummary.saved)/$($payload.imageSummary.total)）"
      $form.Tag = $payload.directory
      $openArticleButton.Enabled = [bool]$payload.directory
    } else { $status.Text = "读取失败：$($payload.message)" }
  } catch { $status.Text = "读取失败：未能解析程序结果。" }
})

$readButton.add_Click({
  $url = $urlBox.Text.Trim()
  if (-not $url) { $status.Text = "请先粘贴公众号文章链接。"; return }
  if ($worker.IsBusy) { return }
  $openArticleButton.Enabled = $false
  $status.Text = "正在读取文章，请稍候…"
  $readButton.Enabled = $false
  $worker.RunWorkerAsync($url)
})
$openArticleButton.add_Click({ if ($form.Tag) { Start-Process (Join-Path $form.Tag "article.md") } })
$openFolderButton.add_Click({ if (Test-Path $libraryRoot) { Start-Process explorer.exe -ArgumentList ('"{0}"' -f $libraryRoot) } else { $status.Text = "文章库将在首次成功读取后创建。" } })

[void]$form.ShowDialog()