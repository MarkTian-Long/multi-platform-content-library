import test from "node:test";
import assert from "node:assert/strict";
import { renderContentHtml } from "../src/content-library.js";
import type { ContentManifest } from "../src/content-types.js";
import { renderReadingPage } from "../src/content-render.js";
import { chromium } from "playwright-core";
import { resolveEdgeExecutable } from "../src/url-policy.js";

const item:ContentManifest={schemaVersion:1,contentId:"a".repeat(24),contentHash:"hash",platform:"bilibili",kind:"video",sourceUrl:"https://www.bilibili.com/video/BV1NJ411C77L",canonicalUrl:"https://www.bilibili.com/video/BV1NJ411C77L",title:"测试资料",capturedAt:"2026-09-06T12:00:00Z",updatedAt:"2026-09-06T12:00:00Z",aliases:[],status:"partial",markdown:"",markdownFile:"content.md",readingFile:"reading.html",assets:[{id:"img",role:"image",status:"saved",path:"images/1.png"}],warnings:[],coverage:{danmaku:"unknown: yt-dlp does not reliably export Bilibili danmaku"}};
test("offline markdown renders readable formatting and local media while refusing active content",()=>{
 const html=renderContentHtml(item,'## 重点\n\n**加粗**和[来源](https://example.com/)\n\n![图片](images/1.png)\n\n![外部图](https://example.com/tracker.png)\n\n[坏链接](javascript:alert(1))\n\n[越界](../../private.txt)\n\n<script>alert(1)</script>');
 assert.match(html,/<strong>加粗<\/strong>/);assert.match(html,/href="https:\/\/example.com\/"/);assert.match(html,/src="images\/1.png"/);
 assert.doesNotMatch(html,/src="https:|href="javascript:|href="\.\.\/|<script>/);
 assert.match(html,/B 站/);assert.match(html,/部分保存/);assert.match(html,/弹幕/);assert.doesNotMatch(html,/"danmaku"|yt-dlp does not/);
});

test("print view retains article images and original media without repeating management cards or body images", async () => {
 const manifest:ContentManifest={...item,platform:"wechat",kind:"article",assets:[
  {id:"body-image",role:"image",status:"saved",path:"图片/正文.png",provenance:"original"},
  {id:"extra-image",role:"image",status:"saved",path:"图片/补图.png",provenance:"original"},
  {id:"source-data",role:"source",status:"saved",path:"来源资料/网页.json",provenance:"generated"},
  {id:"ocr",role:"ocr",status:"saved",path:"图片文字/识别.md",provenance:"machine_ocr"},
  {id:"legacy-pdf",role:"pdf",status:"saved",path:"旧阅读.pdf",provenance:"generated"},
  {id:"reading-pdf",role:"pdf",status:"saved",path:"阅读.pdf",provenance:"generated"},
  {id:"video",role:"video",status:"saved",path:"视频/原视频.mp4",provenance:"original"},
  {id:"audio",role:"audio",status:"saved",path:"音频/原音频.mp3",provenance:"original"},
  {id:"failed-image",role:"image",status:"failed",path:"图片/失败.png"}
 ],warnings:["部分图片文字需要核对"]};
 const markdown="原始正文必须保留。\n\n![正文内的图片](图片/正文.png)\n\n`![只作代码示例](图片/补图.png)`\n\n## 图片文字\n\n识别全文仍然留在正文。";
 const browser=await chromium.launch({executablePath:resolveEdgeExecutable(),headless:true});
 try{
  const page=await browser.newPage();await page.route("**/*",route=>route.abort());
  await page.setContent(renderReadingPage(manifest,markdown),{waitUntil:"domcontentloaded"});
  const summary=()=>page.evaluate(`(() => {
   const visible=element=>!!element&&getComputedStyle(element).display!=="none"&&(!element.parentElement||visible(element.parentElement));
   return {
    text:document.querySelector("main").innerText,
    images:[...document.querySelectorAll("img")].filter(visible).map(image=>decodeURIComponent(image.getAttribute("src"))),
    cards:[...document.querySelectorAll(".asset")].filter(visible).map(card=>card.textContent),
    media:[...document.querySelectorAll("video,audio")].filter(visible).map(media=>media.tagName),
    links:[...document.querySelectorAll("a")].filter(visible).map(link=>decodeURIComponent(link.getAttribute("href")))
   };
  })()` ) as Promise<{text:string|null;images:string[];cards:(string|null)[];media:string[];links:string[]}>;
  const screen=await summary();
  assert.equal(screen.cards.length,manifest.assets.length,"normal reading retains all existing asset sections");
  assert.deepEqual(screen.media,["VIDEO","AUDIO"],"offline playback controls remain visible on screen");
  await page.emulateMedia({media:"print"});const printed=await summary();
  assert.deepEqual(printed.images,["图片/正文.png","图片/补图.png"],"the body image prints once, and an otherwise unseen image remains");
  assert.equal(printed.cards.length,3,"only the supplementary image and two original media cards print");
  assert.deepEqual(printed.media,[],"print does not include inactive playback controls");
  assert.ok(printed.links.includes("视频/原视频.mp4"));assert.ok(printed.links.includes("音频/原音频.mp3"));
  assert.ok(!printed.links.some(value=>/来源资料|图片文字|\.pdf$/.test(value)),"management links must not consume PDF pages");
  assert.doesNotMatch(printed.text??"",/打开来源资料|打开图片文字|打开PDF|文件与处理结果/);
  assert.match(printed.text??"",/原始正文必须保留/);assert.match(printed.text??"",/识别全文仍然留在正文/);assert.match(printed.text??"",/部分图片文字需要核对/);
 }finally{await browser.close();}
});
