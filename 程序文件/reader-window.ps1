param([Parameter(Mandatory = $true)][string]$ProjectRoot)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$libraryRoot = Join-Path $ProjectRoot "文章库"

$form = New-Object System.Windows.Forms.Form
$form.Text = "公众号文章阅读器"
$form.Size = New-Object System.Drawing.Size(690, 520)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)

function Invoke-ReaderCli([string[]]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node.exe"
  $quoted = $Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
  $programRoot = Join-Path $ProjectRoot "程序文件"
  $psi.Arguments = ('"{0}" {1}' -f (Join-Path $programRoot "dist\cli.js"), ($quoted -join ' '))
  $psi.WorkingDirectory = $programRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $psi.CreateNoWindow = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $process.WaitForExit()
  return $stdout | ConvertFrom-Json
}

$label = New-Object System.Windows.Forms.Label
$label.Text = "粘贴微信公众号文章链接"
$label.Location = New-Object System.Drawing.Point(24, 18)
$label.AutoSize = $true
$form.Controls.Add($label)
$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Location = New-Object System.Drawing.Point(24, 44)
$urlBox.Size = New-Object System.Drawing.Size(630, 30)
$form.Controls.Add($urlBox)
$readButton = New-Object System.Windows.Forms.Button
$readButton.Text = "读取并生成 MD 和 PDF"
$readButton.Location = New-Object System.Drawing.Point(24, 86)
$readButton.Size = New-Object System.Drawing.Size(150, 36)
$form.Controls.Add($readButton)

$searchBox = New-Object System.Windows.Forms.TextBox
$searchBox.Location = New-Object System.Drawing.Point(24, 145)
$searchBox.Size = New-Object System.Drawing.Size(480, 30)
$searchBox.PlaceholderText = "搜索已保存文章"
$form.Controls.Add($searchBox)
$searchButton = New-Object System.Windows.Forms.Button
$searchButton.Text = "搜索"
$searchButton.Location = New-Object System.Drawing.Point(518, 142)
$searchButton.Size = New-Object System.Drawing.Size(70, 34)
$form.Controls.Add($searchButton)

$list = New-Object System.Windows.Forms.ListBox
$list.Location = New-Object System.Drawing.Point(24, 190)
$list.Size = New-Object System.Drawing.Size(630, 180)
$list.DisplayMember = "Text"
$form.Controls.Add($list)

$openArticleButton = New-Object System.Windows.Forms.Button
$openArticleButton.Text = "打开文章"
$openArticleButton.Location = New-Object System.Drawing.Point(24, 385)
$openArticleButton.Size = New-Object System.Drawing.Size(110, 36)
$openArticleButton.Enabled = $false
$form.Controls.Add($openArticleButton)
$openFolderButton = New-Object System.Windows.Forms.Button
$openFolderButton.Text = "打开文章库"
$openFolderButton.Location = New-Object System.Drawing.Point(148, 385)
$openFolderButton.Size = New-Object System.Drawing.Size(120, 36)
$form.Controls.Add($openFolderButton)
$status = New-Object System.Windows.Forms.Label
$status.Text = "就绪：粘贴链接读取，或在下方搜索历史文章。"
$status.Location = New-Object System.Drawing.Point(24, 438)
$status.Size = New-Object System.Drawing.Size(630, 40)
$form.Controls.Add($status)

function Refresh-Library {
  try {
    $payload = Invoke-ReaderCli @("list", $searchBox.Text.Trim())
    $list.Items.Clear()
    foreach ($article in @($payload.articles)) {
      [void]$list.Items.Add([PSCustomObject]@{ Text = "[$($article.extractedAt.Substring(0,10))] $($article.title)"; ArticleId = $article.articleId })
    }
    $status.Text = "已显示 $($list.Items.Count) 篇文章。"
  } catch { $status.Text = "文章库暂时无法读取。" }
}

$worker = New-Object System.ComponentModel.BackgroundWorker
$worker.add_DoWork({ param($sender, $eventArgs); $eventArgs.Result = Invoke-ReaderCli @("capture", [string]$eventArgs.Argument) })
$worker.add_RunWorkerCompleted({ param($sender, $eventArgs); $readButton.Enabled = $true; if ($eventArgs.Error) { $status.Text = "读取失败：程序发生错误。"; return }; $payload = $eventArgs.Result; if ($payload.ok) { $status.Text = "读取完成：$($payload.title)；本地图片 $($payload.imageSummary.saved)/$($payload.imageSummary.total)，PDF 已自动生成。"; Refresh-Library } else { $status.Text = "读取失败：$($payload.message)" } })
$readButton.add_Click({ $url = $urlBox.Text.Trim(); if (-not $url) { $status.Text = "请先粘贴公众号文章链接。"; return }; if ($worker.IsBusy) { return }; $status.Text = "正在读取文章并生成 PDF，请稍候…"; $readButton.Enabled = $false; $worker.RunWorkerAsync($url) })
$searchButton.add_Click({ Refresh-Library })
$searchBox.add_KeyDown({ if ($_.KeyCode -eq [Windows.Forms.Keys]::Enter) { Refresh-Library } })
$list.add_SelectedIndexChanged({ $openArticleButton.Enabled = $null -ne $list.SelectedItem })
$openArticleButton.add_Click({ if ($list.SelectedItem) { $article = $list.SelectedItem; $directory = Join-Path $libraryRoot ((Get-ChildItem $libraryRoot -Directory | Where-Object { (Get-Content -Raw (Join-Path $_.FullName "manifest.json") | ConvertFrom-Json).articleId -eq $article.ArticleId }).Name); $markdown = Get-ChildItem -LiteralPath $directory -Filter '*.md' -File | Select-Object -First 1; if ($markdown) { Start-Process $markdown.FullName } } })
$openFolderButton.add_Click({ if (Test-Path $libraryRoot) { Start-Process explorer.exe -ArgumentList ('"{0}"' -f $libraryRoot) } else { $status.Text = "文章库将在首次成功读取后创建。" } })

Refresh-Library
[void]$form.ShowDialog()
