function New-LinkDialog([string]$Caption, [int]$Width = 840, [int]$Height = 600) {
  $dialog = New-Object Windows.Forms.Form
  $dialog.Text = $Caption
  $dialog.ClientSize = New-Object Drawing.Size($Width, $Height)
  $dialog.MinimumSize = New-Object Drawing.Size(680, 480)
  $dialog.StartPosition = 'CenterParent'
  $dialog.Font = $form.Font
  $dialog.BackColor = [Drawing.Color]::White
  if($NoShow) {$dialog.ShowInTaskbar=$false;$dialog.StartPosition='Manual';$dialog.Location=New-Object Drawing.Point(-32000,-32000)}
  return $dialog
}
function Show-LinkYoutubeNetworkDialog($Settings) {
  $dialog = New-LinkDialog 'YouTube 网络设置' 720 480
  $dialog.Tag = $null
  $hint = New-Object Windows.Forms.Label
  $hint.Text = '此选择同时用于 YouTube 提取、下载与专用登录。代理模式请填写正在运行的本机 HTTP 代理。'
  $hint.SetBounds(22, 24, 672, 44)
  $hint.Anchor = 'Top, Left, Right'
  $hint.Parent = $dialog
  $mode = New-Object Windows.Forms.ComboBox
  $mode.Name = 'YoutubeNetworkMode'
  $mode.DisplayMember = 'Text'
  $mode.DropDownStyle = 'DropDownList'
  $mode.SetBounds(22, 84, 672, 32)
  $mode.Anchor = 'Top, Left, Right'
  foreach($option in @([pscustomobject]@{Text='自动（沿用启动环境）';Value='auto'},[pscustomobject]@{Text='直接连接';Value='direct'},[pscustomobject]@{Text='使用本机代理';Value='proxy'})) {[void]$mode.Items.Add($option)}
  $mode.Parent = $dialog
  $label = New-Object Windows.Forms.Label
  $label.Text = '本机 HTTP 代理地址，例如 http://127.0.0.1:7897'
  $label.SetBounds(22, 140, 672, 26)
  $label.Anchor = 'Top, Left, Right'
  $label.Parent = $dialog
  $address = New-Object Windows.Forms.TextBox
  $address.Name = 'YoutubeProxyAddress'
  $address.MaxLength = 256
  $address.SetBounds(22, 172, 672, 32)
  $address.Anchor = 'Top, Left, Right'
  $address.Text = [string]$Settings.proxyUrl
  $address.Parent = $dialog
  $message = New-Object Windows.Forms.Label
  $message.Name = 'YoutubeNetworkValidation'
  $message.ForeColor = [Drawing.Color]::DarkRed
  $message.SetBounds(22, 226, 672, 62)
  $message.Anchor = 'Top, Left, Right'
  $message.Parent = $dialog
  $mode.add_SelectedIndexChanged({$address.Enabled = $mode.SelectedItem.Value -eq 'proxy'}.GetNewClosure())
  $mode.SelectedIndex = 0
  foreach($entry in $mode.Items) {if($entry.Value -eq [string]$Settings.mode) {$mode.SelectedItem = $entry}}
  $save = New-Object Windows.Forms.Button
  $save.Name = 'SaveYoutubeNetwork'
  $save.Text = '保存设置'
  $save.SetBounds(474, 394, 104, 38)
  $save.Anchor = 'Bottom, Right'
  $save.Parent = $dialog
  $cancel = New-Object Windows.Forms.Button
  $cancel.Text = '取消'
  $cancel.SetBounds(590, 394, 104, 38)
  $cancel.Anchor = 'Bottom, Right'
  $cancel.DialogResult = 'Cancel'
  $cancel.Parent = $dialog
  $dialog.CancelButton = $cancel
  $save.add_Click({
    $selection = [string]$mode.SelectedItem.Value
    $proxy = $address.Text.Trim()
    if($selection -eq 'proxy') {
      $uri = $null
      if(-not [Uri]::TryCreate($proxy,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.Host -notin @('127.0.0.1','localhost','[::1]','::1') -or $uri.IsDefaultPort -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        $message.Text = '请填写本机已有的 HTTP(S) 代理地址及端口，地址不包含账号、密码或路径。'
        return
      }
    }
    $dialog.Tag = [pscustomobject]@{Mode=$selection;ProxyUrl=$proxy}
    $dialog.DialogResult = 'OK'
    $dialog.Close()
  }.GetNewClosure())
  if($NoShow) {return $dialog}
  try {if($dialog.ShowDialog($form) -eq 'OK') {return $dialog.Tag}} finally {$dialog.Dispose()}
  return $null
}
function Show-LinkResultDialog($Payload) {
  $dialog = New-LinkDialog ('处理结果 · ' + [string]$Payload.manifest.title)
  $box = New-Object Windows.Forms.TextBox
  $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'
  $box.Location = New-Object Drawing.Point(20, 20); $box.Size = New-Object Drawing.Size(800, 516)
  $box.Anchor = 'Top, Bottom, Left, Right'; $box.BorderStyle = 'None'
  $roleNames = @{reading='阅读页';pdf='PDF';video='视频';image='图片';audio='音频';subtitle='字幕';transcript='文字稿';ocr='图片文字';source='来源资料';frame='关键帧';cover='封面';comments='评论';danmaku='弹幕'}
  $lines = New-Object Collections.Generic.List[string]
  $modeName = switch ([string]$Payload.manifest.processingMode) { 'original' {'原件'} 'transcribe' {'原件 + 文字稿'} default {'完整处理'} }
  $lines.Add("本次选择：$modeName。缺项不会覆盖已保存的原件。")
  foreach ($asset in @($Payload.assets | Sort-Object @{Expression={ if ($_.status -eq 'saved') {1} else {0} }}, role)) {
    $name = if ($roleNames.ContainsKey([string]$asset.role)) {$roleNames[[string]$asset.role]} else {[string]$asset.role}
    $state = if ($asset.requested -eq $false) {'本次未请求，保留历史结果'} else {Convert-LinkState ([string]$asset.status)}
    $lines.Add("`r`n$name · $state")
    if ($asset.provenance -eq 'user_edited') {$lines.Add('用户校订；机器原稿保留')}
    if ($asset.reason) {$lines.Add('原因：' + [string]$asset.reason)}
    if ($asset.path) {$lines.Add('文件：' + [string]$asset.path)}
    if ($asset.status -ne 'saved' -and $asset.requested -ne $false) {$lines.Add('操作：' + [string]$asset.action)}
  }
  foreach ($warning in @($Payload.manifest.warnings)) {$lines.Add("`r`n采集说明：$warning")}
  $box.Text = $lines -join "`r`n"; $dialog.Controls.Add($box)
  $close = New-Object Windows.Forms.Button; $close.Text = '关闭'; $close.SetBounds(712,550,108,34); $close.Anchor='Bottom, Right'; $close.DialogResult='Cancel'
  $dialog.Controls.Add($close); $dialog.CancelButton=$close
  try {[void]$dialog.ShowDialog($form)} finally {$dialog.Dispose()}
}
function Show-LinkTagEditor($Item) {
  $dialog = New-LinkDialog '资料标签与收藏' 720 480
  $hint = New-Object Windows.Forms.Label; $hint.Text='每行一个标签，最多 20 个；标签可用于全文搜索和筛选。'; $hint.SetBounds(20,20,680,44); $dialog.Controls.Add($hint)
  $box = New-Object Windows.Forms.TextBox; $box.Multiline=$true; $box.ScrollBars='Vertical'; $box.SetBounds(20,72,680,300); $box.Anchor='Top, Bottom, Left, Right'; $box.Text=@($Item.tags) -join "`r`n"; $dialog.Controls.Add($box)
  $favorite = New-Object Windows.Forms.CheckBox; $favorite.Text='收藏此资料'; $favorite.Checked=[bool]$Item.favorite; $favorite.SetBounds(20,390,260,30); $favorite.Anchor='Bottom, Left'; $dialog.Controls.Add($favorite)
  $save = New-Object Windows.Forms.Button; $save.Text='保存'; $save.SetBounds(464,428,108,34); $save.Anchor='Bottom, Right'; $save.DialogResult='OK'; $dialog.Controls.Add($save)
  $cancel = New-Object Windows.Forms.Button; $cancel.Text='取消'; $cancel.SetBounds(592,428,108,34); $cancel.Anchor='Bottom, Right'; $cancel.DialogResult='Cancel'; $dialog.Controls.Add($cancel); $dialog.CancelButton=$cancel
  try {
    if($dialog.ShowDialog($form) -eq 'OK') {
      $tags=@($box.Lines | ForEach-Object {$_.Trim()} | Where-Object {$_})
      $patch=@{tags=$tags;favorite=$favorite.Checked}|ConvertTo-Json -Compress
      Start-LinkOperation @('organize',[string]$Item.contentId,$patch) '正在保存标签和收藏…'
    }
  } finally {$dialog.Dispose()}
}
function Show-LinkTranscriptEditor($Payload) {
  $dialog = New-LinkDialog ('校订文字稿 · ' + [string]$Payload.title) 940 700
  $hint = New-Object Windows.Forms.Label; $hint.Text='编辑当前稿后保存为用户校订版本。机器原稿保持不变；关闭或取消不会写入资料库。'; $hint.SetBounds(20,16,900,40); $hint.Anchor='Top, Left, Right'; $dialog.Controls.Add($hint)
  $tabs = New-Object Windows.Forms.TabControl; $tabs.SetBounds(20,64,900,500); $tabs.Anchor='Top, Bottom, Left, Right'
  $editPage=New-Object Windows.Forms.TabPage; $editPage.Text='校订稿'
  $originalPage=New-Object Windows.Forms.TabPage; $originalPage.Text='机器 / 平台原稿（只读）'
  $editor=New-Object Windows.Forms.TextBox; $editor.Name='TranscriptEditor'; $editor.AccessibleName='可编辑校订稿'; $editor.Multiline=$true; $editor.ScrollBars='Both'; $editor.Dock='Fill'; $editor.AcceptsReturn=$true; $editor.AcceptsTab=$true; $editor.MaxLength=2097152; $editor.Text=[string]$Payload.text; $editPage.Controls.Add($editor)
  $original=New-Object Windows.Forms.TextBox; $original.Multiline=$true; $original.ReadOnly=$true; $original.ScrollBars='Both'; $original.Dock='Fill'; $original.Text=[string]$Payload.originalText; $originalPage.Controls.Add($original)
  [void]$tabs.TabPages.Add($editPage); [void]$tabs.TabPages.Add($originalPage); $dialog.Controls.Add($tabs)
  if($Payload.staleEdition){
    $hint.Text=[string]$Payload.staleReason
    $stalePage=New-Object Windows.Forms.TabPage;$stalePage.Text='旧校订与原稿（只读）'
    $staleBox=New-Object Windows.Forms.TextBox;$staleBox.Multiline=$true;$staleBox.ReadOnly=$true;$staleBox.ScrollBars='Both';$staleBox.Dock='Fill'
    $staleBox.Text="旧校订：`r`n$($Payload.staleText)`r`n`r`n旧来源原稿：`r`n$($Payload.staleOriginalText)"
    $stalePage.Controls.Add($staleBox);[void]$tabs.TabPages.Add($stalePage)
  }
  $from=New-Object Windows.Forms.TextBox; $from.MaxLength=200; $from.Name='ReplacementFrom'; $from.AccessibleName='需要纠正的原词'; $from.SetBounds(20,580,230,30); $from.Anchor='Bottom, Left'; $dialog.Controls.Add($from)
  $to=New-Object Windows.Forms.TextBox; $to.MaxLength=200; $to.Name='ReplacementTo'; $to.AccessibleName='替换词'; $to.SetBounds(270,580,230,30); $to.Anchor='Bottom, Left'; $dialog.Controls.Add($to)
  $replace=New-Object Windows.Forms.Button; $replace.Text='替换预览'; $replace.SetBounds(520,578,112,34); $replace.Anchor='Bottom, Left'; $dialog.Controls.Add($replace)
  $replaceHint=New-Object Windows.Forms.Label; $replaceHint.Text='左侧原词，右侧新词；按字面替换，可用 Ctrl+Z 撤销。'; $replaceHint.SetBounds(20,618,760,28); $replaceHint.Anchor='Bottom, Left'; $dialog.Controls.Add($replaceHint)
  $replace.add_Click({
    if([string]::IsNullOrEmpty($from.Text)) {$replaceHint.Text='请先填入需要纠正的原词。'; return}
    $count=0;$offset=0
    while($true){$found=$editor.Text.IndexOf($from.Text,$offset,[StringComparison]::Ordinal);if($found -lt 0){break};$count++;$offset=$found+$from.Text.Length}
    $characters=[long]$editor.Text.Length+[long]$count*($to.Text.Length-$from.Text.Length)
    $bytes=[long][Text.Encoding]::UTF8.GetByteCount($editor.Text)+[long]$count*([Text.Encoding]::UTF8.GetByteCount($to.Text)-[Text.Encoding]::UTF8.GetByteCount($from.Text))
    if($characters -gt 2097152 -or $bytes -gt 2097152){$replaceHint.Text='替换会超过 2 MiB 上限，当前稿未改动。请减少替换范围。';return}
    if($count -gt 0) {$preview=$editor.Text.Replace($from.Text,$to.Text);if([Text.Encoding]::UTF8.GetByteCount($preview) -gt 2097152){$replaceHint.Text='替换超过 2 MiB，当前稿未改动。';return};$editor.SelectAll(); $editor.SelectedText=$preview}
    $replaceHint.Text="预览已替换 $count 处。点击保存才会写入资料库；Ctrl+Z 可撤销。"
  }.GetNewClosure())
  $save=New-Object Windows.Forms.Button; $save.Text='保存校订稿'; $save.SetBounds(664,654,128,34); $save.Anchor='Bottom, Right'; $save.DialogResult='OK'; $dialog.Controls.Add($save)
  $cancel=New-Object Windows.Forms.Button; $cancel.Text='取消'; $cancel.SetBounds(812,654,108,34); $cancel.Anchor='Bottom, Right'; $cancel.DialogResult='Cancel'; $dialog.Controls.Add($cancel); $dialog.CancelButton=$cancel
  $draftText=$null
  try { if($dialog.ShowDialog($form) -eq 'OK') {$draftText=$editor.Text} } finally {$dialog.Dispose()}
  if($null -ne $draftText) {
    if([string]::IsNullOrWhiteSpace($draftText)) {Set-LinkStatus '校订稿为空，未保存。'; return}
    $draftRoot=Join-Path $programRoot 'logs\drafts'; [void][IO.Directory]::CreateDirectory($draftRoot)
    $script:linkTranscriptDraft=Join-Path $draftRoot (([Guid]::NewGuid().ToString('N'))+'.json')
    $draft=@{sourceAssetId=[string]$Payload.sourceAssetId;expectedSha256=[string]$Payload.expectedSha256;text=$draftText}|ConvertTo-Json -Depth 4 -Compress
    [IO.File]::WriteAllText($script:linkTranscriptDraft,$draft,(New-Object Text.UTF8Encoding($false)))
    Start-LinkOperation @('transcript-save',[string]$Payload.contentId,$script:linkTranscriptDraft) '正在保存独立校订版本…'
  }
}
function Show-LinkHistoryDialog($Payload) {
  $dialog=New-LinkDialog '已归档任务 · 可恢复' 840 600
  $list=New-Object Windows.Forms.ListBox; $list.DisplayMember='Text'; $list.SetBounds(20,20,800,516); $list.Anchor='Top, Bottom, Left, Right'
  foreach($job in @($Payload.jobs)) {[void]$list.Items.Add([pscustomobject]@{Text=([string]$job.title+' · '+(Convert-LinkState ([string]$job.state))+' · '+[string]$job.archivedAt+$(if($job.inQueue){' · 已恢复'}));Value=[string]$job.archiveId;InQueue=[bool]$job.inQueue})}
  $dialog.Controls.Add($list)
  $restore=New-Object Windows.Forms.Button; $restore.Text='恢复选中任务'; $restore.SetBounds(568,550,144,34); $restore.Anchor='Bottom, Right'; $restore.DialogResult='OK'; $dialog.Controls.Add($restore)
  $cancel=New-Object Windows.Forms.Button; $cancel.Text='关闭'; $cancel.SetBounds(724,550,96,34); $cancel.Anchor='Bottom, Right'; $cancel.DialogResult='Cancel'; $dialog.Controls.Add($cancel); $dialog.CancelButton=$cancel
  $selected=$null
  try {if($dialog.ShowDialog($form) -eq 'OK') {$selected=$list.SelectedItem}} finally {$dialog.Dispose()}
  if($selected -and -not $selected.InQueue) {Start-LinkOperation @('restore-jobs',[string]$selected.Value) '正在恢复任务记录…'}
}
function Show-LinkLogPlanDialog($Plan) {
  $dialog=New-LinkDialog '历史日志归档计划' 840 600
  $box=New-Object Windows.Forms.TextBox;$box.Multiline=$true;$box.ReadOnly=$true;$box.ScrollBars='Vertical';$box.SetBounds(20,20,800,516);$box.Anchor='Top, Bottom, Left, Right'
  $box.Text='创建可恢复 ZIP 前，逐文件核对字节和哈希。原目录保留。'+"`r`n`r`n"+(@($Plan.entries|ForEach-Object {([string]$_.directory)+"`r`n"+$(if($_.eligible){'可归档 · '+@($_.files).Count+' 个文件 · '+[Math]::Round([double]$_.bytes/1024/1024,1)+' MiB'}else{[string]$_.reason})})-join "`r`n`r`n")
  $dialog.Controls.Add($box)
  $save=New-Object Windows.Forms.Button;$save.Text='创建归档';$save.SetBounds(568,550,132,34);$save.Anchor='Bottom, Right';$save.DialogResult='OK';$save.Enabled=@($Plan.entries|Where-Object {-not $_.eligible}).Count -eq 0;$dialog.Controls.Add($save)
  $close=New-Object Windows.Forms.Button;$close.Text='关闭';$close.SetBounds(712,550,108,34);$close.Anchor='Bottom, Right';$close.DialogResult='Cancel';$dialog.Controls.Add($close);$dialog.CancelButton=$close
  $apply=$false
  try{$apply=$dialog.ShowDialog($form) -eq 'OK'}finally{$dialog.Dispose()}
  if($apply){$options=@{};foreach($key in $script:linkLogOptions.Keys){$options[$key]=$script:linkLogOptions[$key]};$options.expectedPlanId=[string]$Plan.planId;Start-LinkOperation @('logs','archive',($options|ConvertTo-Json -Compress)) '正在创建并核验可恢复日志 ZIP…'}
}
function Show-LinkLogArchivesDialog($Archives) {
  $dialog=New-LinkDialog '已核验日志归档 · 可恢复' 840 600
  $list=New-Object Windows.Forms.ListBox;$list.DisplayMember='Text';$list.SetBounds(20,20,800,516);$list.Anchor='Top, Bottom, Left, Right'
  foreach($archive in @($Archives)){[void]$list.Items.Add([pscustomobject]@{Text=([string]$archive.createdAt+' · '+(@($archive.directories)-join ', ')+' · '+[Math]::Round([double]$archive.bytes/1024/1024,1)+' MiB');Value=[string]$archive.archiveId})}
  $dialog.Controls.Add($list)
  $restore=New-Object Windows.Forms.Button;$restore.Text='核验并恢复';$restore.SetBounds(568,550,144,34);$restore.Anchor='Bottom, Right';$restore.DialogResult='OK';$dialog.Controls.Add($restore)
  $close=New-Object Windows.Forms.Button;$close.Text='关闭';$close.SetBounds(724,550,96,34);$close.Anchor='Bottom, Right';$close.DialogResult='Cancel';$dialog.Controls.Add($close);$dialog.CancelButton=$close
  $selected=$null
  try{if($dialog.ShowDialog($form) -eq 'OK'){$selected=$list.SelectedItem}}finally{$dialog.Dispose()}
  if($selected){Start-LinkOperation @('logs','restore',[string]$selected.Value) '正在核验并恢复历史日志…'}
}
