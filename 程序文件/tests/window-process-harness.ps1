param(
  [ValidateSet('unicode', 'stderr', 'invalid', 'exit-code', 'arguments', 'mock-list', 'cancel')]
  [string]$Scenario,
  [string]$NodeExecutable = 'node.exe'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot '..\reader-process.ps1')

function Assert-ReaderProcess([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-TestNode([string]$Source, [string[]]$ExtraArguments = @()) {
  $job = Start-ReaderProcess -Executable $NodeExecutable -Arguments (@('-e', $Source, '--') + $ExtraArguments) -WorkingDirectory $PSScriptRoot
  $completed = $false
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
      $payload = Get-ReaderProcessResult -Job $job
      if ($null -ne $payload) { $completed = $true; return $payload }
      Start-Sleep -Milliseconds 20
    }
    throw 'Reader process did not finish within ten seconds'
  } finally {
    if (-not $completed) { Stop-ReaderProcess -Job $job }
  }
}

Assert-ReaderProcess ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1) 'Use the launcher Windows PowerShell 5.1 runtime'

switch ($Scenario) {
  'unicode' {
    $job = Start-ReaderProcess -Executable $NodeExecutable -Arguments @('-e', 'setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,status:"complete",message:"中文文章读取完成",title:"引号与汉字：阅读器"})),150)') -WorkingDirectory $PSScriptRoot
    $completed = $false
    try {
      Assert-ReaderProcess ($null -eq (Get-ReaderProcessResult -Job $job)) 'Running jobs must return null without waiting'
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
      do {
        Start-Sleep -Milliseconds 20
        $payload = Get-ReaderProcessResult -Job $job
      } while ($null -eq $payload -and [DateTime]::UtcNow -lt $deadline)
      Assert-ReaderProcess ($null -ne $payload) 'Unicode task timed out'
      $completed = $true
      Assert-ReaderProcess ($payload.ok -and $payload.message -ceq '中文文章读取完成' -and $payload.title -ceq '引号与汉字：阅读器') 'UTF-8 JSON was corrupted'
    } finally { if (-not $completed) { Stop-ReaderProcess -Job $job } }
  }
  'stderr' {
    $payload = Invoke-TestNode 'process.stderr.write("x".repeat(256*1024),()=>process.stdout.write(JSON.stringify({ok:true,status:"complete",message:"large stderr completed"})))'
    Assert-ReaderProcess ($payload.ok -and $payload.message -eq 'large stderr completed') 'Large stderr prevented a successful result'
    Assert-ReaderProcess ($payload.diagnostic.Length -gt 0 -and $payload.diagnostic.Length -lt 5000) 'Diagnostic output must be available and bounded'
  }
  'invalid' {
    foreach ($source in @(
      'process.stderr.write("node diagnostic failure");process.exitCode=7',
      'process.stdout.write("not JSON");process.stderr.write("node diagnostic failure");process.exitCode=7',
      'process.stdout.write(JSON.stringify({ok:"true",message:"wrong type"}));process.stderr.write("node diagnostic failure");process.exitCode=7',
      'process.stdout.write("[]");process.stderr.write("node diagnostic failure");process.exitCode=7'
    )) {
      $payload = Invoke-TestNode $source
      Assert-ReaderProcess (-not $payload.ok -and $payload.status -eq 'failed') 'Invalid process output must be reported as failed'
      Assert-ReaderProcess ($payload.message -match '7' -and $payload.message -match 'node diagnostic failure') 'Failure must include the exit code and stderr detail'
    }
    $payload = Invoke-TestNode 'process.stderr.write("failed https://mp.weixin.qq.com/s/private?token=secret");process.exitCode=3'
    Assert-ReaderProcess ($payload.message -notmatch 'token=secret|https://' -and $payload.diagnostic -notmatch 'token=secret|https://') 'Diagnostic must not disclose the article URL'
  }
  'exit-code' {
    $payload = Invoke-TestNode 'process.stdout.write(JSON.stringify({ok:true,status:"complete",message:"apparently complete"}));process.exitCode=9'
    Assert-ReaderProcess (-not $payload.ok -and $payload.status -eq 'failed' -and $payload.message -match '9') 'Nonzero exit must override an apparent success'
  }
  'arguments' {
    $expected = @('quote"inside', 'C:\spaces name\', 'before\\\"after', '', '中文 与 空格', "line`nsecond", 'https://mp.weixin.qq.com/s/article?x=1&y=two#part', '--looks-like-option')
    $payload = Invoke-TestNode 'process.stdout.write(JSON.stringify({ok:true,status:"complete",message:"arguments echoed",arguments:process.argv.slice(1)}))' $expected
    Assert-ReaderProcess ($payload.ok -and $payload.arguments.Count -eq $expected.Count) 'Argument count changed'
    for ($index = 0; $index -lt $expected.Count; $index++) {
      Assert-ReaderProcess ($payload.arguments[$index] -ceq $expected[$index]) "Argument $index was not preserved"
    }
  }
  'mock-list' {
    $payload = Invoke-TestNode 'process.stdout.write(JSON.stringify({ok:true,status:"complete",message:"文章库已读取",articles:process.argv[1]==="list"?[{articleId:"fixture",title:process.argv[2]}]:[]}))' @('list', '中文检索 & 空格')
    Assert-ReaderProcess ($payload.ok -and $payload.articles.Count -eq 1 -and $payload.articles[0].title -ceq '中文检索 & 空格') 'List-style payload or keyword was corrupted'
  }
  'cancel' {
    $sentinel = Start-ReaderProcess -Executable $NodeExecutable -Arguments @('-e', 'setTimeout(()=>{},20000)') -WorkingDirectory $PSScriptRoot
    $job = $null
    try {
      $job = Start-ReaderProcess -Executable $NodeExecutable -Arguments @('-e', 'setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,status:"complete",message:"late result"})),20000)') -WorkingDirectory $PSScriptRoot
      $cancelledProcessId = $job.Process.Id
      Assert-ReaderProcess ($null -eq (Get-ReaderProcessResult -Job $job)) 'Delayed task was expected to remain pending'
      Stop-ReaderProcess -Job $job
      $job = $null
      Assert-ReaderProcess ($null -eq (Get-Process -Id $cancelledProcessId -ErrorAction SilentlyContinue)) 'Cancelled task is still running'
      Assert-ReaderProcess (-not $sentinel.Process.HasExited) 'Cancellation terminated an unrelated task'
    } finally {
      if ($null -ne $job) { Stop-ReaderProcess -Job $job }
      Stop-ReaderProcess -Job $sentinel
    }
  }
}
[pscustomobject]@{ ok = $true; scenario = $Scenario; version = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress
