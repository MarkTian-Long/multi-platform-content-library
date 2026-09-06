param(
  [switch]$Probe,
  [string]$InputPath,
  [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
  if ($Probe) { Write-Output 'Windows.Media.Ocr available'; exit 0 }
  if (-not $InputPath -or -not $OutputPath) { throw 'InputPath and OutputPath are required' }
  if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) { throw 'Input image is missing' }
  function Await-WinRt($Operation, [Type]$ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait(); return $task.Result
  }
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($InputPath)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'Windows OCR language data is unavailable' }
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $payload = @{ status = $(if ([string]::IsNullOrWhiteSpace($result.Text)) { 'blank' } else { 'saved' }); text = $result.Text; lines = @($result.Lines | ForEach-Object { $_.Text }) } | ConvertTo-Json -Compress
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
  [IO.File]::WriteAllText($OutputPath, $payload, [Text.UTF8Encoding]::new($false))
  Write-Output $payload
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
