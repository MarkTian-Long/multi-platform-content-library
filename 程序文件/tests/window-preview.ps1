param([string]$ProjectRoot, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\reader-window.ps1') -ProjectRoot $ProjectRoot -NoShow
try {
  # Render the real controls offscreen. This is a layout preview, not desktop automation.
  $urlBox.Text = 'https://mp.weixin.qq.com/s/QYn2OeBXhsO2O7XLwE0lfA'
  $preview = [PSCustomObject]@{ ok=$true; articles=@(
    [PSCustomObject]@{articleId='preview';title='GPT-6最佳拍档＝字节Seedance';extractedAt='2026-09-06';pdf=@{status='saved'}}
    [PSCustomObject]@{articleId='history';title='对话兰小欢：置身 AI 事内，不要拿旧理论硬套新现实｜AI透镜研究系列';extractedAt='2026-09-03';pdf=@{status='saved'}}
  ) }
  Complete-ReaderOperation $preview 'list'
  Set-ReaderStatus '布局预览：正文、图片、视频和 PDF 的实际保存结果将在这里显示。'
  $bitmap = New-Object Drawing.Bitmap($form.Width, $form.Height)
  $form.DrawToBitmap($bitmap, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
  $inset = [int](($form.Width - $form.ClientSize.Width) / 2)
  $topInset = $form.Height - $form.ClientSize.Height - $inset
  foreach ($control in $form.Controls) {
    $control.DrawToBitmap($bitmap, (New-Object Drawing.Rectangle(($inset + $control.Left), ($topInset + $control.Top), $control.Width, $control.Height)))
  }
  $bitmap.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
} finally { $timer.Dispose(); $tooltip.Dispose(); $form.Dispose() }
