param([Parameter(Mandatory=$true)][string]$ProjectRoot,[Parameter(Mandatory=$true)][string]$ContentRoot,[Parameter(Mandatory=$true)][string]$ContentId)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$env:CONTENT_LIBRARY_ROOT=$ContentRoot
$env:WECHAT_ARTICLE_LIBRARY_ROOT=Join-Path $ContentRoot 'legacy-empty'
[void][IO.Directory]::CreateDirectory($env:WECHAT_ARTICLE_LIBRARY_ROOT)
. (Join-Path $ProjectRoot '程序文件\link-window.ps1') -ProjectRoot $ProjectRoot -NoShow
$script:dialogMode=''
$script:dialogChecked=$false
$script:dialogError=$null
$script:upgradeChecks=0
$modalTimer=New-Object Windows.Forms.Timer
$modalTimer.Interval=60
function Assert-Upgrade([bool]$Condition,[string]$Message){$script:upgradeChecks++;if(-not $Condition){throw $Message}}
function Find-UpgradeControl($Control,[string]$Name){
  if($Control.Name -eq $Name){return $Control}
  foreach($child in $Control.Controls){$found=Find-UpgradeControl $child $Name;if($found){return $found}}
  return $null
}
$modalTimer.add_Tick({
  foreach($dialog in @([Windows.Forms.Application]::OpenForms)){
    if($dialog -eq $form -or -not $dialog.Visible){continue}
    try{
      if($script:dialogMode -eq 'details' -and $dialog.Text -like '处理结果*'){
        $box=@($dialog.Controls | Where-Object {$_ -is [Windows.Forms.TextBox]})[0]
        Assert-Upgrade ($box.Text -match '文字稿' -and $box.Text -match '本次未请求') '结果详情未显示文字稿和未请求的历史缺项'
        $script:dialogChecked=$true;$dialog.DialogResult='Cancel';$dialog.Close()
      }elseif($script:dialogMode -eq 'edit' -and $dialog.Text -like '校订识别稿 / 转写稿*'){
        $editor=Find-UpgradeControl $dialog 'TranscriptEditor'
        $from=Find-UpgradeControl $dialog 'ReplacementFrom';$to=Find-UpgradeControl $dialog 'ReplacementTo'
        $from.Text='萨斯';$to.Text='SaaS'
        @($dialog.Controls|Where-Object {$_.Text -eq '替换预览'})[0].PerformClick()
        Assert-Upgrade ($editor.Text -match 'SaaS' -and $editor.Text -notmatch '萨斯') '术语替换预览未更新校订稿'
        $script:dialogChecked=$true
        @($dialog.Controls|Where-Object {$_.Text -eq '保存校订稿'})[0].PerformClick()
      }elseif($script:dialogMode -eq 'tags' -and $dialog.Text -eq '资料标签与收藏'){
        @($dialog.Controls|Where-Object {$_ -is [Windows.Forms.TextBox]})[0].Text="项目测试`r`n术语校订"
        @($dialog.Controls|Where-Object {$_ -is [Windows.Forms.CheckBox]})[0].Checked=$true
        $script:dialogChecked=$true
        @($dialog.Controls|Where-Object {$_.Text -eq '保存'})[0].PerformClick()
      }elseif($script:dialogMode -eq 'history' -and $dialog.Text -like '已归档任务*'){
        $list=@($dialog.Controls|Where-Object {$_ -is [Windows.Forms.ListBox]})[0]
        Assert-Upgrade ($list.Items.Count -eq 1) '历史对话框未显示已归档任务'
        $list.SelectedIndex=0;$script:dialogChecked=$true
        @($dialog.Controls|Where-Object {$_.Text -eq '恢复选中任务'})[0].PerformClick()
      }
    }catch{$script:dialogError=$_.Exception.Message;$dialog.DialogResult='Cancel';$dialog.Close()}
  }
})
function Wait-Upgrade{
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while($script:linkJob -or $script:linkPollJob){
    [Windows.Forms.Application]::DoEvents()
    if([DateTime]::UtcNow -gt $deadline){throw '窗口升级操作超时'}
    Start-Sleep -Milliseconds 25
  }
  if($script:dialogError){throw $script:dialogError}
}
function Click-Upgrade($Button){$Button.PerformClick();Wait-Upgrade}
function Modal-Upgrade([string]$Mode,$Button){$script:dialogMode=$Mode;$script:dialogChecked=$false;$modalTimer.Start();try{Click-Upgrade $Button;Assert-Upgrade $script:dialogChecked ('未进入预期对话框：'+$Mode)}finally{$modalTimer.Stop()}}
try{
  $form.ShowInTaskbar=$false;$form.StartPosition='Manual';$form.Location=New-Object Drawing.Point(-32000,-32000);$form.Show();$form.CreateControl();Initialize-LinkWorkspace;Wait-Upgrade
  Assert-Upgrade ($libraryList.SelectedItem.ContentId -eq $ContentId) '没有选中隔离测试资料'
  Assert-Upgrade $openTranscriptButton.Enabled '打开文字稿按钮未就绪'
  foreach($size in @(@(1150,760),@(980,680))){
    $form.ClientSize=New-Object Drawing.Size($size[0],$size[1]);Set-LinkWorkspaceLayout
    [Windows.Forms.Application]::DoEvents();Set-LinkLibraryLayout
    foreach($control in @($openTranscriptButton,$manageButton,$exportMenuButton,$importButton,$favoritesOnly)){Assert-Upgrade ($libraryGroup.ClientRectangle.Contains($control.Bounds)) ('资料操作控件越界：'+$control.Text+' '+$control.Bounds+' parent='+$libraryGroup.ClientRectangle)}
    foreach($entry in @($editTranscriptButton,$detailsButton,$resolveMissingButton,$organizeButton)){Assert-Upgrade ($manageMenu.Items.Contains($entry)) ('管理菜单遗漏操作：'+$entry.Text)}
    Assert-Upgrade ($exportMenu.Items.Contains($zipButton)) '导出菜单遗漏 ZIP'
  }
  $mainTabs.SelectedTab=$toolsTab;[Windows.Forms.Application]::DoEvents();Assert-Upgrade (-not $assetStatusLabel.Visible) '工具页残留资料产物横幅'
  $mainTabs.SelectedTab=$libraryTab
  Modal-Upgrade 'details' $detailsButton
  Modal-Upgrade 'edit' $editTranscriptButton
  Assert-Upgrade (@($script:linkCurrentManifest.assets|Where-Object {$_.provenance -eq 'user_edited'}).Count -eq 1) ('校订保存失败：'+$status.Text)
  Modal-Upgrade 'tags' $organizeButton
  Assert-Upgrade ([bool]$libraryList.SelectedItem.Item.favorite) '收藏更新未回读'
  Assert-Upgrade (@($libraryList.SelectedItem.Item.tags) -contains '术语校订') '标签更新未回读'
  $searchBox.Text='术语校订';Refresh-LinkLibrary;Wait-Upgrade;Assert-Upgrade ($libraryList.Items.Count -eq 1) '新增标签不可搜索'
  Click-Upgrade $zipButton
  Assert-Upgrade ($status.Text -match 'ZIP 已导出') ('ZIP导出失败：'+$status.Text)
  $mainTabs.SelectedTab=$taskTab
  $processingCombo.SelectedIndex=0;$inputBox.Text='https://example.com/no-network-work';Click-Upgrade $enqueueButton
  Assert-Upgrade ($queueList.SelectedItem.Job.input.processing -eq 'original') '入队未保存处理选项'
  Click-Upgrade $cancelButton;Click-Upgrade $historyToggle
  Assert-Upgrade $archiveJobButton.Enabled '已取消任务不可归档'
  Click-Upgrade $archiveJobButton;Assert-Upgrade ($queueList.Items.Count -eq 0) '归档后任务未移出队列'
  Modal-Upgrade 'history' $archivedJobsButton
  Assert-Upgrade ($queueList.Items.Count -eq 1) '恢复历史后未回到任务列表'
  $fakeRunning=[pscustomobject]@{state='running';title='OCR阶段';stage='图片文字识别';message='处理图片';input=[pscustomobject]@{processing='full'};progress=[pscustomobject]@{phase='图片文字识别';completed=2;total=4;unit='张图片'}}
  Set-LinkQueueDetail $fakeRunning;Assert-Upgrade ($queueProgress.Value -eq 50 -and $queueStatus.Text -match '2 / 4') '有分母的阶段进度未显示'
  $fakeRunning.progress=[pscustomobject]@{phase='ASR'};Set-LinkQueueDetail $fakeRunning;Assert-Upgrade ($queueProgress.Style -eq 'Marquee') '未知进度被虚构为百分比'
  [pscustomobject]@{ok=$true;checks=$script:upgradeChecks;newFlows='details,edit,terms,tags,favorites,zip,processing,archive,restore,phase-progress'}|ConvertTo-Json -Compress
}finally{
  $modalTimer.Stop();$modalTimer.Dispose()
  if($linkTimer){$linkTimer.Stop();$linkTimer.Dispose()}
  if($script:linkJob){Stop-ReaderProcess $script:linkJob}
  if($script:linkPollJob){Stop-ReaderProcess $script:linkPollJob}
  if($tooltip){$tooltip.Dispose()};$form.Dispose()
}
