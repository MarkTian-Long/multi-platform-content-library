// Explicit live check for the two user-provided links; uses an isolated library.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContentLinks } from '../dist/content-input.js';
import { enqueueInputs, updateJob } from '../dist/content-jobs.js';
import { processContentJob } from '../dist/content-service.js';
import { contentDirectory, publicValue } from '../dist/content-library.js';
import { runContentTool } from '../dist/content-tools.js';

const runtimeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reportRoot=path.join(runtimeRoot,'logs','video-support-20261013');
const root=path.join(reportRoot,'library');
const shares=['https://xhslink.cn/o/Ao78ExGkuj9','https://weixin.qq.com/sph/AiFpm2ZuMh'];
await fs.mkdir(reportRoot,{recursive:true});
const jobs=await enqueueInputs(root,shares.flatMap(parseContentLinks));
const results=[];
for(const job of jobs){
  console.log(JSON.stringify({stage:'start',platform:job.platform}));
  const outcome=await processContentJob(runtimeRoot,root,job,AbortSignal.timeout(120000),{enrich:async record=>record});
  await updateJob(root,job.id,{...outcome,stage:'素材实测结束'});
  const directory=await contentDirectory(root,outcome.contentId);
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'content.json'),'utf8'));
  const video=manifest.assets.find(asset=>asset.role==='video'&&asset.status==='saved'&&asset.path);
  let probe;
  if(video){
    const checked=await runContentTool({command:path.join(runtimeRoot,'tools','ffprobe.exe'),args:['-protocol_whitelist','file,pipe','-v','error','-show_entries','stream=codec_type,codec_name:format=duration','-of','json',path.join(directory,video.path)],timeoutMs:30000,maxOutputBytes:65536});
    if(checked.code===0)probe=JSON.parse(checked.stdout);
  }
  const result=publicValue({platform:manifest.platform,title:manifest.title,state:outcome.state,originalVideoSaved:!!video,directory,readingFile:manifest.readingFile,assets:manifest.assets.map(({role,status,path,bytes,reason})=>({role,status,path,bytes,reason})),warnings:manifest.warnings,coverage:manifest.coverage,probe});
  results.push(result);console.log(JSON.stringify(result));
  await fs.writeFile(path.join(reportRoot,'report.json'),JSON.stringify({date:'2026-10-13',scope:'实际应用路由、素材采集、视频核验和阅读页；未执行ASR/OCR派生',results},null,2)+'\n');
}
