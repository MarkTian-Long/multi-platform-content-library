param([string]$ProjectRoot,[string]$ContentRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$env:CONTENT_LIBRARY_ROOT=$ContentRoot
$env:WECHAT_ARTICLE_LIBRARY_ROOT=Join-Path $ContentRoot 'legacy-empty'
[void][IO.Directory]::CreateDirectory($env:WECHAT_ARTICLE_LIBRARY_ROOT)
. (Join-Path $ProjectRoot '程序文件\link-window.ps1') -ProjectRoot $ProjectRoot -NoShow
$script:youtubeChecks=0
function Assert-Youtube([bool]$Value,[string]$Message){$script:youtubeChecks++;if(-not $Value){throw $Message}}
try {
  Assert-Youtube (@($loginPlatformCombo.Items | Where-Object {$_.Value -eq 'youtube'}).Count -eq 1) 'YouTube专用登录选择缺失'
  Assert-Youtube ($youtubeNetworkButton.Parent -eq $toolGroup) '网络设置按钮不在登录与依赖页面'
  Assert-Youtube (-not $youtubeNetworkButton.Bounds.IntersectsWith($parserToggleButton.Bounds)) '网络与视频号设置按钮重叠'
  $dialog = Show-LinkYoutubeNetworkDialog ([pscustomobject]@{mode='auto'})
  $mode = $dialog.Controls.Find('YoutubeNetworkMode',$true)[0]
  $address = $dialog.Controls.Find('YoutubeProxyAddress',$true)[0]
  $save = $dialog.Controls.Find('SaveYoutubeNetwork',$true)[0]
  $message = $dialog.Controls.Find('YoutubeNetworkValidation',$true)[0]
  $dialog.Show()
  Assert-Youtube (-not $address.Enabled) '自动模式不应要求填写代理'
  $mode.SelectedIndex=2
  Assert-Youtube ($address.Enabled) '代理模式没有启用输入框'
  $dialog.Size=$dialog.MinimumSize
  Assert-Youtube (@($dialog.Controls | Where-Object {$_.Right -gt $dialog.ClientSize.Width -or $_.Bottom -gt $dialog.ClientSize.Height}).Count -eq 0) '最小窗口下控件越界'
  $address.Text='http://user:password@localhost:7897'
  $save.PerformClick()
  Assert-Youtube ($null -eq $dialog.Tag -and $message.Text.Length -gt 0) '非法代理不能关闭并提交'
  $address.Text='http://127.0.0.1:7897'
  $save.PerformClick()
  Assert-Youtube ($dialog.Tag.Mode -eq 'proxy' -and $dialog.Tag.ProxyUrl -eq 'http://127.0.0.1:7897') ('保存选择未保留：'+($dialog.Tag | ConvertTo-Json -Compress))
  $dialog.Dispose()
  $script:youtubeStarted=New-Object 'Collections.Generic.List[string]'
  function Start-LinkCli([string[]]$Arguments) {$script:youtubeStarted.Add(($Arguments -join ' ')); return [pscustomobject]@{fixture=$true}}
  $waiting=[pscustomobject]@{id='youtube-wait';platform='youtube';state='waiting';stage='YouTube限流冷却';message='已有资料保留';title='429 fixture';input=[pscustomobject]@{url='https://www.youtube.com/watch?v=jNQXAC9IVRw';processing='original'};createdAt=[DateTime]::UtcNow.ToString('o');updatedAt=[DateTime]::UtcNow.ToString('o');attempts=1;cancelRequested=$false;retry=[pscustomobject]@{kind='youtube_rate_limit';notBefore=[DateTime]::UtcNow.AddMinutes(5).ToString('o');attempts=1;automatic=$true}}
  Render-LinkJobs @($waiting)
  Assert-Youtube ($queueList.Items.Count -eq 1 -and $linkTimer.Enabled) '重开窗口未装载等待任务并保持定时器'
  Assert-Youtube ((Convert-LinkState 'waiting') -eq '限流冷却' -and $queueStatus.Text.Contains('恢复时间')) '没有显示冷却与恢复时间'
  Assert-Youtube (-not (Test-LinkRetryDue)) '冷却未到期就允许恢复'
  Invoke-LinkRetryScheduler
  Assert-Youtube ($script:youtubeStarted.Count -eq 1 -and $script:youtubeStarted[0] -eq 'jobs') '到期判断前没有先刷新持久队列'
  $script:linkPollJob=$null
  Complete-LinkPoll ([pscustomobject]@{ok=$true;jobs=@($waiting)})
  Assert-Youtube ($script:youtubeStarted.Count -eq 1) '未到期启动了worker'
  $waiting.retry.notBefore=[DateTime]::UtcNow.AddSeconds(-1).ToString('o')
  Render-LinkJobs @($waiting)
  Invoke-LinkRetryScheduler ([DateTime]::UtcNow.AddSeconds(6))
  $script:linkPollJob=$null
  # A newly observed cancellation must defeat an older due display.
  $cancelled=$waiting.PSObject.Copy();$cancelled.cancelRequested=$true;$cancelled.state='cancelled'
  Complete-LinkPoll ([pscustomobject]@{ok=$true;jobs=@($cancelled)})
  Assert-Youtube (@($script:youtubeStarted | Where-Object {$_ -like 'work*'}).Count -eq 0) '刷新后取消仍启动了worker'
  Render-LinkJobs @($waiting)
  Invoke-LinkRetryScheduler ([DateTime]::UtcNow.AddSeconds(12))
  $script:linkPollJob=$null
  Complete-LinkPoll ([pscustomobject]@{ok=$true;jobs=@($waiting)})
  Complete-LinkPoll ([pscustomobject]@{ok=$true;jobs=@($waiting)})
  Assert-Youtube (@($script:youtubeStarted | Where-Object {$_ -eq 'work --scheduled'}).Count -eq 1) '到期未单次启动限定恢复worker'
  $script:linkWorkJob=$null;$script:linkWorkRunning=$false
  $queued=$waiting.PSObject.Copy();$queued.state='queued';$queued.retry=$null
  Render-LinkJobs @($queued)
  $startedBefore=$script:youtubeStarted.Count
  Invoke-LinkRetryScheduler ([DateTime]::UtcNow.AddSeconds(20))
  Assert-Youtube ($script:youtubeStarted.Count -eq $startedBefore) '自动恢复误启动了仅入队的普通任务'
  [pscustomobject]@{ok=$true;checks=$script:youtubeChecks} | ConvertTo-Json -Compress
} finally {
  if($dialog){$dialog.Dispose()}
  if($linkTimer){$linkTimer.Stop();$linkTimer.Dispose()}
  if($tooltip){$tooltip.Dispose()}
  if($form){$form.Dispose()}
}
