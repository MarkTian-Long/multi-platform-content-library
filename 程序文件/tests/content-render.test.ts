import test from "node:test";
import assert from "node:assert/strict";
import { renderContentHtml } from "../src/content-library.js";
import type { ContentManifest } from "../src/content-types.js";

const item:ContentManifest={schemaVersion:1,contentId:"a".repeat(24),contentHash:"hash",platform:"bilibili",kind:"video",sourceUrl:"https://www.bilibili.com/video/BV1NJ411C77L",canonicalUrl:"https://www.bilibili.com/video/BV1NJ411C77L",title:"测试资料",capturedAt:"2026-09-06T12:00:00Z",updatedAt:"2026-09-06T12:00:00Z",aliases:[],status:"partial",markdown:"",markdownFile:"content.md",readingFile:"reading.html",assets:[{id:"img",role:"image",status:"saved",path:"images/1.png"}],warnings:[],coverage:{danmaku:"unknown: yt-dlp does not reliably export Bilibili danmaku"}};
test("offline markdown renders readable formatting and local media while refusing active content",()=>{
 const html=renderContentHtml(item,'## 重点\n\n**加粗**和[来源](https://example.com/)\n\n![图片](images/1.png)\n\n![外部图](https://example.com/tracker.png)\n\n[坏链接](javascript:alert(1))\n\n[越界](../../private.txt)\n\n<script>alert(1)</script>');
 assert.match(html,/<strong>加粗<\/strong>/);assert.match(html,/href="https:\/\/example.com\/"/);assert.match(html,/src="images\/1.png"/);
 assert.doesNotMatch(html,/src="https:|href="javascript:|href="\.\.\/|<script>/);
 assert.match(html,/B 站/);assert.match(html,/部分保存/);assert.match(html,/弹幕/);assert.doesNotMatch(html,/"danmaku"|yt-dlp does not/);
});
