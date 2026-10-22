import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {atomicJson,contentDirectory,fileHash,saveContent,listManifests,findContent} from "../src/content-library.js";
import {saveArticle,findArticles,readArticle} from "../src/article-library.js";
import {writeVerifiedZip} from "../src/content-organization.js";
import {storageInventory} from "../src/content-storage-upgrade.js";
import {prepareSingleLibrary,publishSingleLibrary,rollbackSingleLibrary} from "../src/single-library-migration.js";

async function fixture(t:any,offsetCapture=false,secondItem=false){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),"single-migration-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const project=path.join(temp,"项目"),legacy=path.join(project,"文章库"),root=path.join(project,"资料库"),backup=path.join(project,"版本备份","本次整理");await fs.mkdir(legacy,{recursive:true});await fs.mkdir(root);
 const article=await saveArticle(legacy,{title:"历史文章",sourceUrl:"https://mp.weixin.qq.com/s/history",markdown:"首段原文\n\n末段原文",sourceHtml:'<div id="js_content"><p style="border:1px solid purple">首段原文</p><p>末段原文</p></div>',status:"complete",extractedAt:"2026-10-20T15:49:38Z"});
 await fs.writeFile(path.join(article.directory,"original.pdf"),"%PDF-old-current");
 await atomicJson(path.join(root,".library-layout.json"),{version:2});await atomicJson(path.join(legacy,".unified-library.json"),{version:1,contentRoot:"../资料库"});
 const saved=await saveContent(root,{platform:"wechat",title:"历史文章",sourceUrl:article.manifest.sourceUrl,canonicalUrl:article.manifest.sourceUrl,capturedAt:offsetCapture?"2026-10-20T15:00:00Z":article.manifest.extractedAt,kind:"article",markdown:offsetCapture?await fs.readFile(path.join(article.directory,article.manifest.markdownFile!),"utf8"):"首段原文\n\n末段原文",coverage:{legacyArticleId:article.articleId},warnings:[],assets:[
  {id:"wechat-source-html",role:"source",status:"saved",path:"source.html",provenance:"original"},
  {id:"wechat-source-markdown",role:"source",status:"saved",path:article.manifest.markdownFile,provenance:"original"},
  {id:"wechat-source-manifest",role:"source",status:"saved",path:"manifest.json",provenance:"original"},
  {id:"reading-pdf",role:"pdf",status:"saved",path:"original.pdf",provenance:"generated"}
 ]},article.directory),directory=await contentDirectory(root,saved.contentId);
 await atomicJson(path.join(directory,"manifest.json"),{...article.manifest,contentId:saved.contentId,articleIds:[article.articleId],markdownFile:saved.markdownFile,htmlFile:saved.assets.find(a=>a.id==="wechat-source-html")!.path,pdf:{status:"saved",path:"阅读.pdf"}});
 await fs.mkdir(path.join(directory,"校订历史"));await fs.writeFile(path.join(directory,"校订历史","用户旧稿.md"),"保留用户校订");await fs.writeFile(path.join(directory,"未知资料.bin"),"unknown-preserved");
 await fs.mkdir(path.join(root,"staging","unknown"),{recursive:true});await fs.writeFile(path.join(root,"staging","unknown","recovery.bin"),"unfinished-recovery");await fs.writeFile(path.join(root,"queue.json"),'{"version":1,"jobs":[]}');
 await atomicJson(path.join(root,".organization","items.json"),{version:1,items:{[saved.contentId]:{tags:["用户标签"],favorite:true}}});
 if(secondItem)await saveContent(root,{platform:"web",kind:"article",title:"另一条独立资料",sourceUrl:"https://example.com/second",canonicalUrl:"https://example.com/second",capturedAt:"2026-10-19T00:00:00Z",markdown:"另一个条目也不能提前移动",warnings:[],assets:[]},article.directory);
 await fs.mkdir(backup,{recursive:true});const snapshot=path.join(temp,"snapshot");await fs.mkdir(snapshot);await fs.cp(root,path.join(snapshot,"资料库"),{recursive:true});await fs.cp(legacy,path.join(snapshot,"文章库"),{recursive:true});
 const inventory=await storageInventory(snapshot),archive=await writeVerifiedZip(snapshot,path.join(backup,"完整资料.zip"));
 await atomicJson(path.join(backup,"整理前完整资料-清单.json"),inventory);await atomicJson(path.join(backup,"备份核验.json"),{complete:true,data:{verified:true,files:inventory.length,path:archive.path}});
 return{temp,project,legacy,root,backup,directory,saved,article};
}

test("prepare leaves live data intact; publishing unifies names and legacy IDs, and rollback restores exact data twice",async t=>{
 const f=await fixture(t),before=await storageInventory(f.root),oldLegacy=await storageInventory(f.legacy),queueHash=await fileHash(path.join(f.root,"queue.json"));
 const result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});assert.equal(result.items,1);assert.deepEqual(await storageInventory(f.root),before);
 await publishSingleLibrary(f.project,result.journal);const item=(await findContent(f.root))[0];
 assert.equal(path.basename(item.directory),"2026-10-20_微信_历史文章");assert.equal(path.basename(item.textPath!),"历史文章.md");assert.equal(path.basename(item.pdfPath!),"历史文章.pdf");
 assert.equal(await fs.stat(f.legacy).then(()=>true,()=>false),false);assert.equal((await readArticle(f.legacy,f.article.articleId)).ok,true);assert.ok((await findArticles(f.legacy,"")).some(a=>a.articleId===f.article.articleId));
 assert.equal(await fs.readFile(path.join(item.directory,"校订历史","用户旧稿.md"),"utf8"),"保留用户校订");assert.equal(await fs.readFile(path.join(item.directory,".内部","保留文件","未知资料.bin"),"utf8"),"unknown-preserved");
 assert.equal(await fs.readFile(path.join(f.root,"staging","unknown","recovery.bin"),"utf8"),"unfinished-recovery");assert.equal(await fileHash(path.join(f.root,"queue.json")),queueHash);
 assert.equal((await prepareSingleLibrary(f.project,{backupDirectory:f.backup})).skipped,true);
 await rollbackSingleLibrary(f.project,result.journal);await rollbackSingleLibrary(f.project,result.journal);assert.deepEqual(await storageInventory(f.root),before);assert.deepEqual(await storageInventory(f.legacy),oldLegacy);
});

test("publication rejects changes after preparation before moving the first current item",async t=>{
 const f=await fixture(t),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});await fs.writeFile(path.join(f.directory,"用户刚添加.txt"),"new user work");
 await assert.rejects(publishSingleLibrary(f.project,result.journal),/变化/);assert.equal(await fs.readFile(path.join(f.directory,"用户刚添加.txt"),"utf8"),"new user work");assert.equal(await fs.stat(f.legacy).then(()=>true,()=>false),true);
});

test("rollback refuses newer user text without touching the current library or archived originals",async t=>{
 const f=await fixture(t),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});await publishSingleLibrary(f.project,result.journal);
 const item=(await findContent(f.root))[0];await fs.appendFile(item.textPath!,"\n用户新的校订");await assert.rejects(rollbackSingleLibrary(f.project,result.journal),/新变化/);
 assert.match(await fs.readFile(item.textPath!,"utf8"),/用户新的校订/);assert.equal(await fs.stat(path.join(f.backup,"旧文章库")).then(()=>true,()=>false),true);assert.equal((await listManifests(f.root))[0].manifest.storageVersion,3);
});

test("preparation refuses saved data changed since the verified full backup",async t=>{
 const f=await fixture(t);await fs.appendFile(path.join(f.directory,"content.json")," ");await assert.rejects(prepareSingleLibrary(f.project,{backupDirectory:f.backup}),/备份后资料已变化/);assert.equal(await fs.stat(f.legacy).then(()=>true,()=>false),true);
});

test("publication refuses an additional item created after preparation",async t=>{
 const f=await fixture(t),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});
 await saveContent(f.root,{platform:"web",kind:"article",title:"后来新增",sourceUrl:"https://example.com/new",canonicalUrl:"https://example.com/new",capturedAt:"2026-10-21T00:00:00Z",markdown:"新增不能漏备份",assets:[],warnings:[]},f.directory);
 await assert.rejects(publishSingleLibrary(f.project,result.journal),/集合|条目/);assert.equal((await listManifests(f.root)).length,2);assert.equal(await fs.stat(f.legacy).then(()=>true,()=>false),true);
});

test("rollback checks all rollback destinations before moving any current item",async t=>{
 const f=await fixture(t),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});await publishSingleLibrary(f.project,result.journal);
 const item=(await findContent(f.root))[0],conflict=path.join(f.backup,"已回退的新目录",path.basename(item.directory));await fs.mkdir(conflict,{recursive:true});await fs.writeFile(path.join(conflict,"用户文件.txt"),"keep");
 await assert.rejects(rollbackSingleLibrary(f.project,result.journal),/回退.*目标|目标.*已有/);assert.equal(await fs.stat(item.directory).then(()=>true,()=>false),true);assert.equal(await fs.readFile(path.join(conflict,"用户文件.txt"),"utf8"),"keep");
});

test("preparation refuses files added after the full backup even inside an existing item",async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.directory,"新增不能漏备份.txt"),"user original");await assert.rejects(prepareSingleLibrary(f.project,{backupDirectory:f.backup}),/文件集合发生变化/);assert.equal(await fs.readFile(path.join(f.directory,"新增不能漏备份.txt"),"utf8"),"user original");
});

test("legacy wrapper removal uses the article capture metadata when the content was first indexed earlier",async t=>{
 const f=await fixture(t,true),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup}),journal=JSON.parse(await fs.readFile(result.journal,"utf8"));
 const item=(await findContent(journal.preparedRoot))[0],text=await fs.readFile(item.textPath!,"utf8");assert.match(text,/首段原文/);assert.match(text,/末段原文/);assert.doesNotMatch(text,/source:|status:|captured:/);
});

test("rollback refuses missing original-item recovery material before moving any current item",async t=>{
 const f=await fixture(t,false,true),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});await publishSingleLibrary(f.project,result.journal);
 const journal=JSON.parse(await fs.readFile(result.journal,"utf8"));
 assert.equal(journal.entries.length,2);await fs.rename(journal.entries[1].backupDirectory,path.join(f.backup,"暂时移开的原目录"));
 const before=await storageInventory(f.root),legacyBefore=await storageInventory(journal.legacyArchive),logBefore=await fs.readFile(result.journal,"utf8");
 await assert.rejects(rollbackSingleLibrary(f.project,result.journal),/缺失|校验|恢复/);
 assert.deepEqual(await storageInventory(f.root),before);assert.deepEqual(await storageInventory(journal.legacyArchive),legacyBefore);assert.equal(await fs.readFile(result.journal,"utf8"),logBefore);
});

test("rollback refuses a missing legacy archive unless the verified old library is already restored",async t=>{
 const f=await fixture(t),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});await publishSingleLibrary(f.project,result.journal);
 const journal=JSON.parse(await fs.readFile(result.journal,"utf8"));
 await fs.rename(journal.legacyArchive,path.join(f.backup,"暂时移开的旧文章库"));
 const before=await storageInventory(f.root),logBefore=await fs.readFile(result.journal,"utf8");
 await assert.rejects(rollbackSingleLibrary(f.project,result.journal),/缺失|校验|恢复/);
 assert.deepEqual(await storageInventory(f.root),before);assert.equal(await fs.readFile(result.journal,"utf8"),logBefore);
 assert.equal(await fs.stat(journal.entries[0].backupDirectory).then(()=>true,()=>false),true);
});

test("rollback can finish an interrupted restore whose original directories are already verified in place",async t=>{
 const f=await fixture(t),before=await storageInventory(f.root),legacyBefore=await storageInventory(f.legacy),result=await prepareSingleLibrary(f.project,{backupDirectory:f.backup});await publishSingleLibrary(f.project,result.journal);
 const journal=JSON.parse(await fs.readFile(result.journal,"utf8")),entry=journal.entries[0],retained=path.join(f.backup,"已回退的新目录",path.basename(entry.newDirectory));
 await fs.mkdir(path.dirname(retained),{recursive:true});await fs.rename(entry.newDirectory,retained);await fs.rename(entry.backupDirectory,entry.oldDirectory);await fs.rename(journal.legacyArchive,f.legacy);
 await rollbackSingleLibrary(f.project,result.journal);await rollbackSingleLibrary(f.project,result.journal);
 assert.deepEqual(await storageInventory(f.root),before);assert.deepEqual(await storageInventory(f.legacy),legacyBefore);assert.equal(JSON.parse(await fs.readFile(result.journal,"utf8")).status,"rolled_back");
});
