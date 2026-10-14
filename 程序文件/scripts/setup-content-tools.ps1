param([switch]$PrepareModel)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tools = Join-Path $root 'tools'; $venv = Join-Path $root '.venv-content'; $versions = Join-Path $tools 'versions.json'
New-Item -ItemType Directory -Force -Path $tools, (Join-Path $tools 'models') | Out-Null
function Download-Verified([string]$Url, [string]$Path, [string]$ExpectedSha256) {
  Invoke-WebRequest -Uri $Url -OutFile $Path
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) { Remove-Item -LiteralPath $Path -Force; throw "SHA256 mismatch for $Url" }
  return $actual
}
$ytVersion = '2026.08.19'; $ytPath = Join-Path $tools 'yt-dlp.exe'; $ytSums = Join-Path $tools 'yt-dlp.SHA2-256SUMS'
# Keep the release-manifest value alongside the pinned version.  A verified local
# binary must not make the installer contact the network again.
$ytExpected = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a'
$ytActual = if (Test-Path -LiteralPath $ytPath) { (Get-FileHash -LiteralPath $ytPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { '' }
if ($ytActual -ne $ytExpected) {
  Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/download/$ytVersion/SHA2-256SUMS" -OutFile $ytSums
  $ytExpected = ((Select-String -LiteralPath $ytSums -Pattern 'yt-dlp\.exe$').Line.Split()[0]).ToLowerInvariant()
  Download-Verified "https://github.com/yt-dlp/yt-dlp/releases/download/$ytVersion/yt-dlp.exe" $ytPath $ytExpected | Out-Null
} else { Write-Host 'yt-dlp: reusing verified local binary' }
$ffmpegVersion = '9.0.1'; $ffmpegZip = Join-Path $tools 'ffmpeg-release-essentials.zip'; $ffmpegHash = 'fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9'; $ffmpegPath = Join-Path $tools 'ffmpeg.exe'
$ffmpegBinaryHashes = @{
  'ffmpeg.exe' = '72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3'
  'ffprobe.exe' = '19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f'
}
$ffmpegReady = $true
foreach ($name in $ffmpegBinaryHashes.Keys) {
  $target = Join-Path $tools $name
  if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or (Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ffmpegBinaryHashes[$name]) { $ffmpegReady = $false }
}
if ($ffmpegReady) { Write-Host 'FFmpeg/ffprobe: reusing verified local binaries; no archive download' }
else {
  if (-not (Test-Path -LiteralPath $ffmpegZip) -or (Get-FileHash -LiteralPath $ffmpegZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ffmpegHash) { Download-Verified 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip' $ffmpegZip $ffmpegHash | Out-Null }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ffmpegZip)
  try {
    foreach ($name in $ffmpegBinaryHashes.Keys) {
      $entry = $archive.GetEntry("ffmpeg-$ffmpegVersion-essentials_build/bin/$name")
      if (-not $entry) { throw "Verified FFmpeg archive did not contain $name" }
      $pending = [IO.Path]::GetFullPath((Join-Path $tools ($name + '.' + [Guid]::NewGuid().ToString('N') + '.pending')))
      if (-not $pending.StartsWith(([IO.Path]::GetFullPath($tools).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'FFmpeg temporary path escaped tools' }
      try {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $pending)
        if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ffmpegBinaryHashes[$name]) { throw "FFmpeg binary hash mismatch: $name" }
        Move-Item -LiteralPath $pending -Destination (Join-Path $tools $name) -Force
      } finally { if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force } }
    }
    $license = $archive.GetEntry("ffmpeg-$ffmpegVersion-essentials_build/LICENSE")
    if ($license) { [IO.Compression.ZipFileExtensions]::ExtractToFile($license, (Join-Path $tools 'FFmpeg-LICENSE.txt'), $true) }
  } finally { $archive.Dispose() }
  # Only the two required verified binaries are installed; no unpacked package tree.
  $resolvedArchive = [IO.Path]::GetFullPath($ffmpegZip)
  if ($resolvedArchive.StartsWith(([IO.Path]::GetFullPath($tools).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -and -not ((Get-Item -LiteralPath $resolvedArchive).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $resolvedArchive -Force }
}
if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) { & python -m venv $venv }
$python = Join-Path $venv 'Scripts\python.exe'; & $python -c "import faster_whisper" 2>$null
if ($LASTEXITCODE -ne 0) {
  & $python -m pip install --upgrade pip faster-whisper
  if ($LASTEXITCODE -ne 0) { throw 'faster-whisper installation failed' }
} else { Write-Host 'faster-whisper: reusing local environment' }
$modelPath = Join-Path $tools 'models\faster-whisper-tiny'
if ($PrepareModel -and -not (Test-Path -LiteralPath (Join-Path $modelPath 'model.bin'))) { & $python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-tiny', local_dir=r'$modelPath')"; if ($LASTEXITCODE -ne 0) { throw 'offline ASR model download failed' } } elseif ($PrepareModel) { Write-Host 'ASR model: reusing verified local model directory' }
$metadata = [ordered]@{ yt_dlp = @{ version = $ytVersion; sha256 = $ytExpected; path = 'yt-dlp.exe'; source = "https://github.com/yt-dlp/yt-dlp/releases/tag/$ytVersion" }; ffmpeg = @{ version = $ffmpegVersion; sha256 = $ffmpegBinaryHashes['ffmpeg.exe']; ffprobeSha256 = $ffmpegBinaryHashes['ffprobe.exe']; archiveSha256 = $ffmpegHash; path = 'ffmpeg.exe'; source = 'https://ffmpeg.org/download.html (Windows build link: GyanD/codexffmpeg)' }; asr = @{ python = '.venv-content/Scripts/python.exe'; package = 'faster-whisper'; model = $(if (Test-Path -LiteralPath (Join-Path $modelPath 'model.bin')) { 'models/faster-whisper-tiny' } else { $null }); modelSource = 'https://huggingface.co/Systran/faster-whisper-tiny' } }
$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $versions -Encoding UTF8
& $ytPath --version; & $ffmpegPath -version | Select-Object -First 1; & (Join-Path $tools 'ffprobe.exe') -version | Select-Object -First 1; & $python (Join-Path $root 'scripts\transcribe-content.py') --probe; & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\ocr-content.ps1') -Probe
if (-not $PrepareModel -and -not (Test-Path -LiteralPath (Join-Path $modelPath 'model.bin'))) { Write-Host 'Tools are installed. Run with -PrepareModel to download the tiny offline ASR model (about 75 MB) into tools/models.' }
