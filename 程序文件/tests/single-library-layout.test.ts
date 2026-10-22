import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {saveContent,contentDirectory,findContent,exportContent} from "../src/content-library.js";
import type {CapturedContent} from "../src/content-types.js";

async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"single-library-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const stage=path.join(root,"stage");await fs.mkdir(stage);await fs.writeFile(path.join(root,".library-layout.json"),JSON.stringify({version:3}));
 await fs.writeFile(path.join(stage,"one.png"),"original-one");await fs.writeFile(path.join(stage,"two.png"),"original-two");await fs.writeFile(path.join(stage,"ocr.md"),"图片识别辅助文字");await fs.writeFile(path.join(stage,"current.pdf"),"%PDF-current");
 const record:CapturedContent={platform:"wechat",title:"给人阅读的文章标题",sourceUrl:"https://mp.weixin.qq.com/s/full",canonicalUrl:"https://mp.weixin.qq.com/s/full",kind:"article",capturedAt:"2026-10-20T15:49:38Z",markdown:"第一段原文\n\n![原图](one.png)\n\n最后一段原文",warnings:[],assets:[
  {id:"image-1",role:"image",status:"saved",path:"one.png",provenance:"original"},
  {id:"image-2",role:"image",status:"saved",path:"two.png",provenance:"original"},
  {id:"ocr-1",role:"ocr",status:"saved",path:"ocr.md",provenance:"machine_ocr"},
  {id:"reading-pdf",role:"pdf",status:"saved",path:"current.pdf",provenance:"generated"}
 ]};
 const manifest=await saveContent(root,record,stage),directory=await contentDirectory(root,manifest.contentId);return{root,stage,record,manifest,directory};
}

test("version 3 uses dated folders and title-named current reading files with numbered original images",async t=>{
 const {manifest,directory}=await fixture(t);
 assert.equal(path.basename(directory),"2026-10-20_微信_给人阅读的文章标题");assert.equal(manifest.storageVersion,3);
 assert.equal(manifest.readingFile,"给人阅读的文章标题.html");assert.equal(manifest.markdownFile,"给人阅读的文章标题.md");
 assert.equal(manifest.bodyFile,manifest.markdownFile,"articles have one human-facing full body file");
 assert.equal(manifest.assets.find(a=>a.id==="image-1")!.path,"图片/001.png");assert.equal(manifest.assets.find(a=>a.id==="image-2")!.path,"图片/002.png");
 assert.equal(manifest.assets.find(a=>a.id==="ocr-1")!.path,"处理结果/图片文字/001.md");
 assert.equal(manifest.assets.find(a=>a.id==="reading-pdf")!.path,"给人阅读的文章标题.pdf");
 assert.equal(await fs.readFile(path.join(directory,"图片","001.png"),"utf8"),"original-one");
});

test("full-text path opens the entire article while OCR and its editor retain an independent target",async t=>{
 const {root,directory,manifest}=await fixture(t),item=(await findContent(root))[0];
 assert.equal(item.textPath,path.join(directory,manifest.markdownFile));assert.notEqual(item.textPath,item.transcriptPath);
 const text=await fs.readFile(item.textPath!,"utf8");assert.match(text,/第一段原文/);assert.match(text,/最后一段原文/);assert.doesNotMatch(text,/图片识别辅助文字/);
 assert.match(text,/图片\/001\.png|%E5%9B%BE%E7%89%87\/001\.png/);
 assert.match(await fs.readFile(item.transcriptPath!,"utf8"),/图片识别辅助文字/);
 assert.match(manifest.markdown,/图片识别辅助文字/,"OCR remains searchable in the index");
});

test("title collisions retain separate identities and retries keep assigned readable paths",async t=>{
 const {root,stage,record,manifest,directory}=await fixture(t);
 const second=await saveContent(root,{...record,canonicalUrl:"https://mp.weixin.qq.com/s/another",sourceUrl:"https://mp.weixin.qq.com/s/another"},stage);
 assert.notEqual(second.contentId,manifest.contentId);assert.equal(path.basename(await contentDirectory(root,second.contentId)),"2026-10-20_微信_给人阅读的文章标题 (2)");
 const retried=await saveContent(root,manifest,directory);assert.equal(await contentDirectory(root,retried.contentId),directory);assert.equal(retried.assets[0].path,manifest.assets[0].path);
 assert.equal((retried.markdown.match(/图片识别辅助文字/g)??[]).length,1);
 assert.doesNotMatch(await fs.readFile(path.join(directory,retried.markdownFile),"utf8"),/图片识别辅助文字/);
});

test("version 3 exports keep matching title-named HTML Markdown and current PDF",async t=>{
 const {root,manifest}=await fixture(t),result=await exportContent(root,manifest.contentId),exported=JSON.parse(await fs.readFile(path.join(result.directory,"content.json"),"utf8"));
 assert.equal(exported.markdownFile,"给人阅读的文章标题.md");assert.equal(exported.readingFile,"给人阅读的文章标题.html");
 assert.equal(await fs.readFile(path.join(result.directory,"给人阅读的文章标题.pdf"),"utf8"),"%PDF-current");
 assert.doesNotMatch(await fs.readFile(path.join(result.directory,exported.markdownFile),"utf8"),/图片识别辅助文字/);
});

test("a changed title assigns the current PDF the same new title as the HTML and full text",async t=>{
 const {root,manifest,directory}=await fixture(t),next=await saveContent(root,{...manifest,title:"更新后的文章标题"},directory);
 assert.equal(next.markdownFile,"更新后的文章标题.md");assert.equal(next.readingFile,"更新后的文章标题.html");assert.equal(next.assets.find(a=>a.id==="reading-pdf")!.path,"更新后的文章标题.pdf");
 assert.equal(await fs.stat(path.join(directory,"给人阅读的文章标题.pdf")).then(()=>true,()=>false),false);
 const historical=next.assets.find(a=>a.label?.includes("历史阅读文件 给人阅读的文章标题.pdf"));assert.ok(historical?.path);assert.equal(await fs.readFile(path.join(directory,historical.path!),"utf8"),"%PDF-current");
});

test("case-only title changes cannot retire the current reading files on Windows",async t=>{
 const {root,manifest,directory}=await fixture(t),first=await saveContent(root,{...manifest,title:"GPT-6样本"},directory),next=await saveContent(root,{...first,title:"gpt-6样本"},directory);
 for(const relative of [next.markdownFile,next.readingFile,next.assets.find(a=>a.id==="reading-pdf")!.path!])await fs.access(path.join(directory,relative));
 assert.match(await fs.readFile(path.join(directory,next.markdownFile),"utf8"),/最后一段原文/);
});
