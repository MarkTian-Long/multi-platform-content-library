import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveContent,contentDirectory,containedFile,fileHash } from "../src/content-library.js";
import { saveArticle } from "../src/article-library.js";
import { startContentWorker } from "../src/mcp/content-handlers.js";
import { enqueueInputs,getJobs,isContentWorkerActive,cancelJob } from "../src/content-jobs.js";

test("real MCP subprocess preserves old tools and exposes bounded source-aware content",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"content-mcp-"));const stage=path.join(root,"stage");await fs.mkdir(stage);
 const saved=await saveContent(root,{platform:"web",sourceUrl:"https://example.com/a?token=SECRET",canonicalUrl:"https://example.com/a",title:"MCP验证资料",kind:"article",capturedAt:new Date().toISOString(),markdown:"MCP测试正文 "+"内容".repeat(100),assets:[],warnings:[]},stage);
 const legacyRoot=path.join(root,"legacy");const legacy=await saveArticle(legacyRoot,{title:"旧微信资料",sourceUrl:"https://mp.weixin.qq.com/s/abc?token=SECRET",extractedAt:new Date().toISOString(),status:"complete",markdown:"文字与签名 https://media.example/v.mp4?auth_key=SECRET"});
 const runtime=process.cwd();const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
 const client=new Client({name:"link-library-test",version:"1.0.0"});
 const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx",path.join(runtime,"src","index.ts")],env:{...env,WECHAT_ARTICLE_READER_ROOT:runtime,CONTENT_LIBRARY_ROOT:root,WECHAT_ARTICLE_LIBRARY_ROOT:legacyRoot},stderr:"pipe"});
 t.after(async()=>{await client.close();await fs.rm(root,{recursive:true,force:true});});await client.connect(transport);
 const tools=await client.listTools();for(const name of ["capture_wechat_article","find_saved_articles","read_saved_article","capture_link","find_saved_content","read_saved_content","get_capture_jobs"])assert.ok(tools.tools.some(tool=>tool.name===name));
 const response=await client.callTool({name:"read_saved_content",arguments:{contentId:saved.contentId,limit:30}});const result=JSON.parse((response.content as Array<{text:string}>)[0].text);
 assert.equal(result.ok,true);assert.equal(result.text.length,30);assert.equal(result.nextOffset,30);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 const queued=await client.callTool({name:"capture_link",arguments:{text:"https://example.com/b?token=SECRET",start:false}});assert.doesNotMatch(JSON.stringify(queued),/SECRET/);
 for(const [name,args] of [["find_saved_articles",{query:"旧微信"}],["read_saved_article",{articleId:legacy.articleId}]] as const){const response=await client.callTool({name,arguments:args});assert.doesNotMatch(JSON.stringify(response),/SECRET/);}
});

test("worker startup detects a missing build and an early process exit",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"content-worker-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await assert.rejects(startContentWorker(root,path.join(root,"library")),/尚未构建/);
 await fs.mkdir(path.join(root,"dist"));await fs.writeFile(path.join(root,"dist","link-cli.js"),"process.exit(7)");
 await assert.rejects(startContentWorker(root,path.join(root,"library")),/启动前退出/);
});

test("actual built worker confirms readiness and consumes a queued task",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"content-real-worker-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 // Inject a rejected target directly into the durable queue so this checks worker IPC without DNS timing.
 await enqueueInputs(root,[{platform:"web",url:"http://127.0.0.1/",canonicalUrl:"http://127.0.0.1/"}]);
 await startContentWorker(process.cwd(),root);
 const deadline=Date.now()+20000;let jobs=await getJobs(root);
 while((jobs.some(job=>["queued","running"].includes(job.state))||await isContentWorkerActive(root))&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));jobs=await getJobs(root);}
 assert.equal(jobs[0].attempts,1);assert.equal(jobs[0].state,"failed");assert.equal(await isContentWorkerActive(root),false);
});
test("MCP upgrade tools complete private-safe editing, metadata, exports and recoverable task history",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"content-mcp-upgrade-")),stage=path.join(root,"stage"),legacyRoot=path.join(root,"legacy-empty");await fs.mkdir(stage);await fs.mkdir(legacyRoot);await fs.writeFile(path.join(stage,"machine.md"),"# 原稿\n\n萨斯可以记录语音。\n");
 const saved=await saveContent(root,{platform:"web",sourceUrl:"https://example.com/upgrade?token=SECRET",canonicalUrl:"https://example.com/upgrade",title:"MCP校订",kind:"article",capturedAt:new Date().toISOString(),markdown:"离线正文",assets:[{id:"asr",role:"transcript",status:"saved",path:"machine.md",provenance:"machine_asr"}],warnings:[]},stage),directory=await contentDirectory(root,saved.contentId),original=saved.assets.find(a=>a.id==="asr")!;
 const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),client=new Client({name:"upgrade-test",version:"1"}),runtime=process.cwd();
 const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx",path.join(runtime,"src","index.ts")],env:{...env,WECHAT_ARTICLE_READER_ROOT:runtime,CONTENT_LIBRARY_ROOT:root,WECHAT_ARTICLE_LIBRARY_ROOT:legacyRoot},stderr:"pipe"});t.after(async()=>{await client.close();await fs.rm(root,{recursive:true,force:true});});await client.connect(transport);
 const tools=await client.listTools();for(const name of ["get_content_details","read_transcript_edition","save_transcript_edition","import_content_files","organize_saved_content","export_saved_content","archive_capture_jobs","get_archived_capture_jobs","restore_capture_jobs","manage_content_logs"])assert.ok(tools.tools.some(tool=>tool.name===name));
 const call=async(name:string,args:Record<string,unknown>={})=>{const result=await client.callTool({name,arguments:args});assert.doesNotMatch(JSON.stringify(result),/SECRET/);return JSON.parse((result.content as Array<{text:string}>)[0].text);};
 const queued=await call("capture_link",{text:"https://example.com/queued?token=SECRET",processing:"original",start:false});assert.equal(queued.ok,true);assert.equal(queued.jobs[0].input.processing,"original");
 const queueBefore=await fs.readFile(path.join(root,"queue.json"),"utf8");
 for(const args of [{text:"https://example.com/invalid-start",start:"false"},{text:"https://example.com/invalid-start",start:0},{text:"https://example.com/invalid-processing",start:false,processing:{}},{text:"https://example.com/invalid-null",start:null}]){const invalid=await client.callTool({name:"capture_link",arguments:args});assert.equal(invalid.isError,true);assert.equal(await fs.readFile(path.join(root,"queue.json"),"utf8"),queueBefore);}
 for(const args of [{paths:[path.join(root,"not-created.txt")],start:"false"},{paths:[path.join(root,"not-created.txt")],start:false,encoding:"invalid"}]){const invalid=await client.callTool({name:"import_content_files",arguments:args});assert.equal(invalid.isError,true);assert.equal(await fs.readFile(path.join(root,"queue.json"),"utf8"),queueBefore);}
 const read=await call("read_transcript_edition",{contentId:saved.contentId});assert.equal(read.edited,false);assert.equal((await call("save_transcript_edition",{contentId:saved.contentId,sourceAssetId:read.sourceAssetId,expectedSha256:read.expectedSha256,text:read.text.replace("萨斯","SaaS")})).ok,true);assert.equal(await fileHash(await containedFile(directory,original.path!)),original.sha256);
 assert.equal((await call("organize_saved_content",{contentId:saved.contentId,tags:["MCP术语"],favorite:true})).ok,true);const found=await call("find_saved_content",{query:"MCP术语",favoritesOnly:true});assert.equal(found.items.length,1);assert.equal(found.items[0].contentId,saved.contentId);assert.equal((await call("find_saved_content",{query:"SaaS"})).items.length,1);
 const details=await call("get_content_details",{contentId:saved.contentId});assert.equal(details.assets.some((a:{provenance?:string})=>a.provenance==="user_edited"),true);const exported=await call("export_saved_content",{contentId:saved.contentId,format:"zip"});assert.equal(exported.ok,true);assert.ok(exported.entries.some((a:{path:string})=>a.path==="organization.json"));
 await cancelJob(root,queued.jobs[0].id);const archived=await call("archive_capture_jobs",{jobIds:[queued.jobs[0].id]});assert.equal(archived.ok,true);const history=await call("get_archived_capture_jobs");assert.equal(history.jobs.length,1);assert.equal((await call("restore_capture_jobs",{archiveIds:[history.jobs[0].archiveId]})).ok,true);assert.equal((await getJobs(root,false))[0].state,"cancelled");
 const file=path.join(root,"local.txt");await fs.writeFile(file,"明确选定的本地文字");assert.equal((await call("import_content_files",{paths:[file],processing:"original",start:false})).ok,true);assert.equal((await call("manage_content_logs",{action:"list"})).ok,true);
});
