param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
[IO.Directory]::CreateDirectory((Join-Path $Directory 'assets')) | Out-Null
$bitmap = [Drawing.Bitmap]::new(900, 240)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([Drawing.Color]::White)
$font = [Drawing.Font]::new('Microsoft YaHei', 42, [Drawing.FontStyle]::Regular)
$knownText = [string]::Concat([char]0x4E2D, [char]0x6587, ' OCR ', [char]0x9A8C, [char]0x8BC1)
$graphics.DrawString($knownText, $font, [Drawing.Brushes]::Black, 30, 80)
$graphics.Dispose(); $font.Dispose(); $bitmap.Save((Join-Path $Directory 'assets\known-text.png'), [Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose()
Add-Type -AssemblyName System.Speech
$wave = Join-Path $Directory 'assets\known-voice.wav'
$phrase = 'And so my fellow Americans'
try {
  $speech = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  $voice = @($speech.GetInstalledVoices()) | Select-Object -First 1
  if ($null -eq $voice) { throw 'No installed Windows speech voice' }
  $speech.SetOutputToWaveFile($wave); $speech.Speak($phrase); $speech.Dispose()
} catch {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\tools\validation\jfk.wav') -Destination $wave -Force
}
[IO.File]::WriteAllText((Join-Path $Directory 'assets\known-voice.txt'), $phrase, [Text.UTF8Encoding]::new($false))
& (Join-Path $PSScriptRoot '..\tools\ffmpeg.exe') -nostdin -f lavfi -i 'color=c=blue:s=640x360:d=3' -i $wave -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac (Join-Path $Directory 'assets\sample.mp4')
if ($LASTEXITCODE -ne 0) { throw 'sample video generation failed' }
