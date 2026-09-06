# Windows PowerShell 5.1: execute Node out of process, poll only from the UI thread.
function ConvertTo-ReaderArgument([AllowEmptyString()][string]$Value) {
  # Windows CommandLineToArgvW quoting, including trailing backslashes.
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Protect-ReaderDiagnostic([string]$Text) {
  $clean = [regex]::Replace($Text, 'https?://[^\s<>"'']+', '[链接已省略]')
  $clean = [regex]::Replace($clean, '[\x00-\x08\x0B\x0C\x0E-\x1F]', '')
  if ($clean.Length -gt 4000) { return $clean.Substring(0, 4000) + '…' }
  return $clean.Trim()
}

function Start-ReaderProcess {
  param([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory,
    [hashtable]$Environment = @{})
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Executable
  $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-ReaderArgument $_ }) -join ' ')
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $psi.CreateNoWindow = $true
  foreach ($key in $Environment.Keys) { $psi.EnvironmentVariables[$key] = $Environment[$key] }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    [void]$process.Start()
    # Drain both pipes concurrently; script callbacks on worker threads lack a runspace.
    return [PSCustomObject]@{
      Process = $process
      Stdout = $process.StandardOutput.ReadToEndAsync()
      Stderr = $process.StandardError.ReadToEndAsync()
      Started = [DateTime]::UtcNow
      Completed = $false
      StopRequested = $false
    }
  } catch { $process.Dispose(); throw }
}

function Get-ReaderProcessResult($Job) {
  if (-not $Job.Process.HasExited -or -not $Job.Stdout.IsCompleted -or -not $Job.Stderr.IsCompleted) { return $null }
  try {
    $exitCode = $Job.Process.ExitCode
    $stdout = $Job.Stdout.GetAwaiter().GetResult()
    $stderr = Protect-ReaderDiagnostic ($Job.Stderr.GetAwaiter().GetResult())
    try {
      if ([string]::IsNullOrWhiteSpace($stdout)) { throw '没有输出' }
      $payload = $stdout | ConvertFrom-Json -ErrorAction Stop
      if ($null -eq $payload -or $payload -is [array] -or $payload.ok -isnot [bool] -or
        [string]::IsNullOrWhiteSpace([string]$payload.message)) { throw '结果格式不完整' }
    } catch {
      $detail = if ($stderr) { $stderr } else { '程序没有返回有效的读取结果。' }
      return [PSCustomObject]@{ ok = $false; status = 'failed'; message = "读取程序异常退出（退出码 $exitCode）：$detail"; diagnostic = $stderr }
    }
    if ($exitCode -ne 0 -and $payload.ok) {
      $payload.ok = $false
      $payload.status = 'failed'
      $payload.message = "读取程序异常退出（退出码 $exitCode），请检查文章库中的已保存文件。"
    }
    $payload | Add-Member -NotePropertyName diagnostic -NotePropertyValue $stderr -Force
    return $payload
  } finally { $Job.Completed = $true; $Job.Process.Dispose() }
}

function Stop-ReaderProcess($Job) {
  if ($null -eq $Job) { return }
  try {
    if (-not $Job.Process.HasExited) {
      # PID belongs to this live child; do not terminate unrelated Node/Edge instances.
      $stopInfo = New-Object System.Diagnostics.ProcessStartInfo
      $stopInfo.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
      $stopInfo.Arguments = '/PID ' + $Job.Process.Id + ' /T /F'
      $stopInfo.UseShellExecute = $false
      $stopInfo.CreateNoWindow = $true
      $stopInfo.RedirectStandardOutput = $true
      $stopInfo.RedirectStandardError = $true
      $nativeEncoding = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
      $stopInfo.StandardOutputEncoding = $nativeEncoding
      $stopInfo.StandardErrorEncoding = $nativeEncoding
      $stopProcess = [System.Diagnostics.Process]::Start($stopInfo)
      try {
        $stopOut = $stopProcess.StandardOutput.ReadToEndAsync()
        $stopErr = $stopProcess.StandardError.ReadToEndAsync()
        if (-not $stopProcess.WaitForExit(5000)) { throw '取消读取超时，请稍后重试。' }
        if ($stopProcess.ExitCode -ne 0 -and -not $Job.Process.HasExited) {
          $reason = Protect-ReaderDiagnostic ($stopErr.GetAwaiter().GetResult())
          throw ('无法取消读取（退出码 {0}）：{1}' -f $stopProcess.ExitCode, $reason)
        }
        if (-not $Job.Process.WaitForExit(2000)) { throw '读取进程尚未退出，请稍后重试。' }
      } finally { $stopProcess.Dispose() }
    }
  } finally { if ($Job.Process.HasExited) { $Job.Completed = $true; $Job.Process.Dispose() } }
}
