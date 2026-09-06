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
  [Windows.Forms.Application]::DoEvents()
  $form.Refresh()
  $bitmap = New-Object Drawing.Bitmap($Width, $Height)
  try {
    $form.DrawToBitmap($bitmap, (New-Object Drawing.Rectangle(0, 0, $Width, $Height)))
    $bitmap.Save((Join-Path $outputRoot $Name), [Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
}

try {
  Save-LinkWindowShot 'link-window-1150x760.png' 1150 760
  Save-LinkWindowShot 'link-window-980x680.png' 980 680
  [pscustomobject]@{ ok = $true; files = @('link-window-1150x760.png', 'link-window-980x680.png') } | ConvertTo-Json -Compress
} finally {
  if ($linkTimer) { $linkTimer.Dispose() }
  if ($tooltip) { $tooltip.Dispose() }
  if ($form) { $form.Dispose() }
}
