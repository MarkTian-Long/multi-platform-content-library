import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runContentTool } from "../src/content-tools.js";

test("the window shows attempt duration, current wait and real enqueue state", { skip: process.platform !== "win32" }, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"link-review-ui-")),program=path.join(root,"程序文件");
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(program,"dist"),{recursive:true});
  for(const name of ["link-window.ps1","reader-process.ps1","link-library-dialogs.ps1"])await fs.copyFile(path.join(process.cwd(),name),path.join(program,name));
  await fs.writeFile(path.join(program,"dist","link-cli.js"),"process.stdout.write(JSON.stringify({ok:true,message:'isolated',jobs:[]}));");
  const harness=path.join(root,"harness.ps1");
  await fs.writeFile(harness,"\ufeff"+[
    "param([string]$Root)","$ErrorActionPreference='Stop'","[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    ". (Join-Path $Root '程序文件\\link-window.ps1') -ProjectRoot $Root -NoShow",
    "try {",
    "$now=[DateTime]::UtcNow; $old=$now.AddDays(-2).ToString('o')",
    "$job=[pscustomobject]@{id='current';input=[pscustomobject]@{url='https://example.com/ui'};state='running';title='current';stage='ASR';createdAt=$old;updatedAt=$now.ToString('o');startedAt=$now.AddSeconds(-3).ToString('o');finishedAt=$null;queuedAt=$now.AddSeconds(-5).ToString('o')}",
    "$row=Format-LinkJob $job; if($row.Text -notmatch '耗时 (\\d+)s' -or [int]$Matches[1] -gt 10){throw 'duration includes the enqueue date'}",
    "$job.state='completed';$job.finishedAt=$now.AddSeconds(2).ToString('o');$job.updatedAt=$now.AddMinutes(2).ToString('o');$row=Format-LinkJob $job;if($row.Text -notmatch '耗时 5s'){throw 'finished duration keeps growing'}",
    "$job.state='queued';$row=Format-LinkJob $job;if($row.Text -notmatch '等待 (\\d+)s' -or [int]$Matches[1] -gt 10){throw 'queue wait includes an earlier attempt'}",
    "$job.state='completed';$script:linkStartWorkerAfterEnqueue=$true;Complete-LinkOperation ([pscustomobject]@{ok=$true;message='already saved';jobs=@($job);readyCount=0;focusJobId='current'}) 'enqueue';if($script:linkWorkJob -or $script:linkStartWorkerAfterEnqueue){throw 'completed duplicate started an empty worker'}",
    "$job.state='queued';$script:linkStartWorkerAfterEnqueue=$false;Complete-LinkOperation ([pscustomobject]@{ok=$true;message='retry queued';jobs=@($job);focusJobId='current'}) 'enqueue';if($script:linkSelectedJobId -ne 'current'){throw 'the retry task was not focused'}",
    "[pscustomobject]@{ok=$true;checks=5}|ConvertTo-Json -Compress",
    "} finally {if($script:linkJob){Stop-ReaderProcess $script:linkJob};$linkTimer.Dispose();$tooltip.Dispose();$form.Dispose()}",""
  ].join("\r\n"));
  const run=await runContentTool({command:"powershell.exe",args:["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",harness,"-Root",root],env:{...process.env,CONTENT_LIBRARY_ROOT:path.join(root,"library")},timeoutMs:15000});
  assert.equal(run.code,0,run.stderr);assert.equal(JSON.parse(run.stdout).checks,5);
});
