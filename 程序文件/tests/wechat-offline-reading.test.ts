import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { contentDirectory, exportContent, saveContent } from "../src/content-library.js";
import { saveArticle } from "../src/article-library.js";
import type { CapturedContent } from "../src/content-types.js";

const imageUrl="https://mmbiz.qpic.cn/test/banner.png";
const source=`<html><head><script>window.secret="private"</script></head><body>
<h1 id="activity-name">原文排版样本</h1><span id="js_name">作者名字</span>
<div id="js_content"><section style="border:1px solid #8574ff;padding:24px;color:rgb(71,71,71);font-size:15px">
<a href="https://example.com/album?token=private"><img data-src="${imageUrl}" src="data:image/gif;base64,AA" style="width:640px;height:1px" data-original-style="width:100%;height:auto"></a>
<p style="line-height:1.9"><strong style="color:#8574ff">原文重点</strong>必须与原图保持先后顺序。</p>
<table><tbody><tr><td>原文表格</td></tr></tbody></table>
</section></div></body></html>`;

async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"wechat-offline-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const stage=path.join(root,"stage");await fs.mkdir(stage);await fs.writeFile(path.join(stage,"snapshot.html"),source);
 await fs.writeFile(path.join(stage,"banner.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFbkAAAAASUVORK5CYII=","base64"));
 await fs.writeFile(path.join(stage,"ocr.md"),"OCR辅助内容不应重复打印到原文");
 const record:CapturedContent={platform:"wechat",kind:"article",sourceUrl:"https://mp.weixin.qq.com/s/layout",canonicalUrl:"https://mp.weixin.qq.com/s/layout",title:"原文排版样本",capturedAt:"2026-10-20T15:49:38Z",markdown:"简化Markdown已经丢失原文排版",storageVersion:2,warnings:[],assets:[
  {id:"wechat-source-html",role:"source",status:"saved",path:"snapshot.html",provenance:"original"},
  {id:"image-1",role:"image",status:"saved",path:"banner.png",sourceUrl:imageUrl,provenance:"original"},
  {id:"ocr-1",role:"ocr",status:"saved",path:"ocr.md",provenance:"machine_ocr"}
 ]};
 const manifest=await saveContent(root,record,stage),directory=await contentDirectory(root,manifest.contentId);return{root,record,stage,manifest,directory};
}

test("saved WeChat reading uses the source layout and linked local images instead of the indexing Markdown",async t=>{
 const {manifest,directory}=await fixture(t);const html=await fs.readFile(path.join(directory,manifest.readingFile),"utf8"),$=cheerio.load(html);
 assert.equal($("#js_content p").text(),"原文重点必须与原图保持先后顺序。");
 assert.match($("#js_content section").attr("style")??"",/border:\s*1px solid #8574ff/);
 assert.equal($("#js_content table td").text(),"原文表格");
 assert.equal($("#js_content a img").length,1);
 assert.equal(decodeURIComponent($("#js_content img").attr("src")??""),manifest.assets.find(a=>a.id==="image-1")!.path);
 assert.doesNotMatch($("main").text(),/简化Markdown|OCR辅助内容|source:|status:|captured:/);
 assert.doesNotMatch(html,/private|src="https?:|<script/);
 assert.equal(await fs.readFile(path.join(directory,manifest.assets.find(a=>a.id==="wechat-source-html")!.path!),"utf8"),source,"the original snapshot remains untouched");
});

test("directory exports retain the same original article layout without distributing the raw webpage",async t=>{
 const {root,manifest}=await fixture(t),result=await exportContent(root,manifest.contentId);
 const exported=JSON.parse(await fs.readFile(path.join(result.directory,"content.json"),"utf8"));
 const html=await fs.readFile(path.join(result.directory,exported.readingFile),"utf8"),$=cheerio.load(html);
 assert.match($("#js_content section").attr("style")??"",/border:\s*1px solid #8574ff/);
 const image=decodeURIComponent($("#js_content img").attr("src")??"");assert.ok(image);
 await fs.access(path.join(result.directory,image));
 assert.ok(!exported.assets.some((a:any)=>a.id==="wechat-source-html"));
 assert.doesNotMatch(html,/private|src="https?:|<script/);
});

test("source formatting cannot introduce executable content, network CSS, or paths outside saved assets",async t=>{
 const {root,record,stage,directory}=await fixture(t);
 const hostile=source.replace("</section>",`<script>alert(1)</script><iframe src="file:///C:/private"></iframe><form action="https://example.com/"><input></form><div style="color:red;background:url(https://tracker.example/x);width:expression(alert(1));position:fixed" onclick="alert(1)">保留正文</div><img src="file:///C:/private.png"><img data-src="https://tracker.example/pixel"><a href="javascript:alert(1)">文字链接</a></section>`);
 await fs.writeFile(path.join(stage,"snapshot.html"),hostile);const next=await saveContent(root,record,stage);
 const html=await fs.readFile(path.join(directory,next.readingFile),"utf8"),$=cheerio.load(html);
 assert.equal($("script,iframe,form,input").length,0);
 assert.ok($("#js_content").text().includes("保留正文"));
 assert.doesNotMatch($("#js_content").html()??"",/onclick|javascript:|file:|tracker\.example|url\s*\(|expression\s*\(|position:\s*fixed/i);
 assert.ok($("#js_content").text().includes("未保存到本地"));
});

test("new unified captures keep the Markdown body free of the legacy machine metadata header",async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),"wechat-body-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const legacy=path.join(temp,"文章库"),root=path.join(temp,"资料库");await fs.mkdir(legacy);await fs.mkdir(root);
 await fs.writeFile(path.join(legacy,".unified-library.json"),JSON.stringify({version:1,contentRoot:"../资料库"}));
 await fs.writeFile(path.join(root,".library-layout.json"),JSON.stringify({version:2}));
 const saved=await saveArticle(legacy,{title:"只保留原文",sourceUrl:"https://mp.weixin.qq.com/s/clean",extractedAt:"2026-10-20T15:00:00Z",status:"complete",markdown:"真正的文章正文",sourceHtml:'<div id="js_content"><p>真正的文章正文</p></div>'});
 const manifest=JSON.parse(await fs.readFile(path.join(saved.directory,"content.json"),"utf8"));
 assert.equal(manifest.markdown,"真正的文章正文");
 assert.equal((await fs.readFile(path.join(saved.directory,manifest.bodyFile),"utf8")).trim(),"真正的文章正文");
});
