import test from "node:test";
import assert from "node:assert/strict";
import {rewriteLocalAssetLinks} from "../src/content-paths.js";
test("local Markdown targets support Chinese spaces and parentheses without altering prose or remote URLs",()=>{
 const old="images/中文 (1).jpg",target="图片/截图 001（中文）.jpg",encoded="%E5%9B%BE%E7%89%87/%E6%88%AA%E5%9B%BE%20001%EF%BC%88%E4%B8%AD%E6%96%87%EF%BC%89.jpg";
 const text=`普通句子 ${old}\n![图](${old})\n[图](${encodeURI(old)})\n[远端](https://example.com/${old})\n[查询](${old}?x=1)\n\`[代码](${old})\``;
 const result=rewriteLocalAssetLinks(text,new Map([[old,target]]));
 assert.ok(result.includes(`普通句子 ${old}`));assert.ok(result.includes(`![图](${encoded})`));assert.ok(result.includes(`[图](${encoded})`));
 assert.ok(result.includes(`https://example.com/${old}`));assert.ok(result.includes(`${old}?x=1`));assert.ok(result.includes(`\`[代码](${old})\``));
});
test("mappings are simultaneous, reversible and do not rewrite path prefixes",()=>{
 assert.equal(rewriteLocalAssetLinks("[a](a.png) [b](b.png) [prefix](a.png.extra)",new Map([["a.png","b.png"],["b.png","c.png"]])),"[a](b.png) [b](c.png) [prefix](a.png.extra)");
 assert.equal(rewriteLocalAssetLinks("[原片](%E8%A7%86%E9%A2%91/a.mp4)",new Map([["视频/a.mp4","media/a (1).mp4"]])),"[原片](media/a%20%281%29.mp4)");
});
test("reference definitions and quoted HTML attributes escape new targets safely",()=>{
 const result=rewriteLocalAssetLinks('[x]: old.png\n<img src="old.png"><a href="old.png">图</a>',new Map([["old.png","图片/a\"b(1).png"]]));
 assert.match(result,/%22b%281%29/);assert.doesNotMatch(result,/src="图片/);assert.equal((result.match(/old\.png/g)||[]).length,0);
});
