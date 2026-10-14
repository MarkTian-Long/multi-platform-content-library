param([string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference = 'Stop'
$backupProject = [IO.Path]::GetFullPath($ProjectRoot)
$backupDirectory = Join-Path $backupProject '版本备份'
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$backupName = '源码-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'
$backupPath = Join-Path $backupDirectory $backupName
$backupFiles = @(& git -C $backupProject -c core.quotepath=false ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw '无法读取源码文件列表' }
$backupManifest = @()
$backupStream = [IO.File]::Open($backupPath, [IO.FileMode]::CreateNew)
$backupZip = [IO.Compression.ZipArchive]::new($backupStream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($backupRelative in $backupFiles) {
    if ($backupRelative -match '(^|/)(\.git|node_modules|dist|logs|tools|版本备份|资料库|文章库|\.content-profile|\.venv-content|\.organization|\.log-archives|\.content-browser|\.login|\.wechat-reader-profile)(/|$)' -or $backupRelative -match '(^|/)(\.env[^/]*|\.content-settings\.json|\.content-parser-auth\.json|cookies\.txt)$') { continue }
    $backupFull = [IO.Path]::GetFullPath((Join-Path $backupProject $backupRelative))
    if (-not $backupFull.StartsWith($backupProject.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '源码路径越界' }
    if (-not [IO.File]::Exists($backupFull)) { continue }
    $backupInfo = Get-Item -LiteralPath $backupFull
    if (($backupInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '备份不接受目录链接或符号链接' }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($backupZip, $backupFull, $backupRelative.Replace('\','/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $backupManifest += [pscustomobject]@{ path = $backupRelative; bytes = $backupInfo.Length; sha256 = (Get-FileHash -LiteralPath $backupFull -Algorithm SHA256).Hash.ToLowerInvariant() }
  }
  $backupEntry = $backupZip.CreateEntry('SOURCE-BACKUP.json')
  $backupWriter = [IO.StreamWriter]::new($backupEntry.Open(), [Text.UTF8Encoding]::new($false))
  try { $backupWriter.Write((@{createdAt=(Get-Date).ToUniversalTime().ToString('o'); files=$backupManifest; scope='源码、测试、文档和入口；不含用户资料、凭证、依赖及日志'} | ConvertTo-Json -Depth 5)) } finally { $backupWriter.Dispose() }
} finally { $backupZip.Dispose(); $backupStream.Dispose() }
$backupRead = [IO.Compression.ZipFile]::OpenRead($backupPath)
try {
  foreach ($backupFile in $backupManifest) {
    $backupEntry = $backupRead.GetEntry($backupFile.path.Replace('\','/'))
    if (-not $backupEntry -or $backupEntry.Length -ne $backupFile.bytes) { throw '源码备份校验失败' }
    $backupHash = [Security.Cryptography.SHA256]::Create()
    $backupEntryStream = $backupEntry.Open()
    try { $backupActual = ([BitConverter]::ToString($backupHash.ComputeHash($backupEntryStream))).Replace('-','').ToLowerInvariant() } finally { $backupEntryStream.Dispose(); $backupHash.Dispose() }
    if ($backupActual -ne $backupFile.sha256) { throw '源码备份哈希校验失败' }
  }
} finally { $backupRead.Dispose() }
[pscustomobject]@{path=$backupPath; files=$backupManifest.Count; verified=$true} | ConvertTo-Json -Compress
