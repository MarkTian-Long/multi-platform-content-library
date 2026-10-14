import test from "node:test";
import assert from "node:assert/strict";
import { extractXiaohongshuSnapshot } from "../src/content-xiaohongshu.js";

test("a declared image note is not misclassified by empty video metadata", () => {
  const url="https://www.xiaohongshu.com/explore/123456789012345678901234";
  const snapshot=extractXiaohongshuSnapshot('<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"123456789012345678901234":{"note":{"type":"normal","desc":"图文","video":{"media":{}},"imageList":[{"urlDefault":"https://example.com/image.jpg"}]}}}}};</script>',url);
  assert.equal(snapshot.videoExpected,undefined);assert.deepEqual(snapshot.videos,[]);assert.equal(snapshot.images.length,1);
});

const noteId = "66aa11bb22cc33dd44ee55ff";
const otherId = "77aa11bb22cc33dd44ee55ff";
const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=placeholder`;
const stateHtml = (note: Record<string, unknown>, extraNotes: Record<string, unknown> = {}) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { note }, ...extraNotes } } })};</script>`;

test("Xiaohongshu reads src, source and lazy video attributes from the target note", () => {
  const snapshot = extractXiaohongshuSnapshot(`<div id="noteContainer">
    <div class="note-content">目标正文</div>
    <video src="https://example.com/direct.mp4"></video>
    <video><source src="https://example.com/source.mp4?part=1&amp;token=placeholder" type="video/mp4"></video>
    <video src="blob:https://www.xiaohongshu.com/opaque" data-src="//example.com/lazy.mp4"></video>
    <div class="recommend"><video src="https://example.com/recommended.mp4"></video></div>
  </div>`, noteUrl);
  assert.deepEqual(snapshot.videos, ["https://example.com/direct.mp4", "https://example.com/source.mp4?part=1&token=placeholder", "https://example.com/lazy.mp4"]);
});

test("Xiaohongshu state reads only URL-matched note h264 video and ordered images", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({
    noteId, title: "目标标题", desc: "目标正文", user: { nickname: "目标作者", avatar: "https://example.com/avatar.jpg" },
    imageList: [{ urlDefault: "https://example.com/first.jpg", urlPre: "https://example.com/thumbnail.jpg" }, { infoList: [{ imageScene: "WB_PRV", url: "https://example.com/second-preview.jpg" }, { imageScene: "WB_DFT", url: "https://example.com/second.jpg" }] }],
    video: { media: { stream: { h264: [{ masterUrl: "https://example.com/target.mp4", backupUrls: ["https://example.com/backup.mp4"] }] } } },
    comments: [{ imageList: [{ urlDefault: "https://example.com/comment.jpg" }] }],
    recommended: { video: { masterUrl: "https://example.com/nested-recommendation.mp4" } }
  }, { [otherId]: { note: { noteId: otherId, title: "推荐标题", desc: "推荐正文", imageList: [{ urlDefault: "https://example.com/recommend.jpg" }], video: { mainUrl: "https://example.com/recommend.mp4" } } } }), noteUrl);
  assert.equal(snapshot.title, "目标标题");
  assert.equal(snapshot.body, "目标正文");
  assert.equal(snapshot.author, "目标作者");
  assert.deepEqual(snapshot.images, ["https://example.com/first.jpg", "https://example.com/second.jpg"]);
  assert.deepEqual(snapshot.videos, ["https://example.com/target.mp4"]);
});

test("Xiaohongshu blob video falls back to matching state without evaluating JavaScript", () => {
  const marker = "__xhs_parser_should_not_execute__";
  assert.equal(Object.hasOwn(globalThis, marker), false);
  const html = `<div id="noteContainer"><h1>当前标题</h1><div class="note-content">当前正文</div><video src="blob:https://www.xiaohongshu.com/opaque"></video></div>`
    + stateHtml({ noteId, title: "状态标题", desc: "a literal undefined word", unloaded: null, video: { media: { stream: { h264: [{ mainUrl: "https://example.com/state.mp4" }] } } } }).replace('"unloaded":null', '"unloaded":undefined')
    + `<script>globalThis.${marker}=true;</script>`;
  const snapshot = extractXiaohongshuSnapshot(html, noteUrl);
  assert.equal(snapshot.title, "当前标题");
  assert.equal(snapshot.body, "当前正文");
  assert.deepEqual(snapshot.videos, ["https://example.com/state.mp4"]);
  assert.equal(Object.hasOwn(globalThis, marker), false);
});

test("Xiaohongshu recognizes top-level mainUrl and masterUrl video fallbacks", () => {
  assert.deepEqual(extractXiaohongshuSnapshot(stateHtml({ noteId, video: { mainUrl: "https://example.com/main.mp4" } }), noteUrl).videos, ["https://example.com/main.mp4"]);
  assert.deepEqual(extractXiaohongshuSnapshot(stateHtml({ noteId, video: { masterUrl: "https://example.com/master.mp4" } }), noteUrl).videos, ["https://example.com/master.mp4"]);
});

test("Xiaohongshu uses a bounded h264 backup URL when primary URLs are absent or invalid", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, video: { media: { stream: { h264: [{ masterUrl: "blob:https://example.com/opaque", backupUrls: ["file:///C:/not-a-video", "https://example.com/backup.mp4", "https://example.com/extra-quality.mp4"] }] } } } }), noteUrl);
  assert.deepEqual(snapshot.videos, ["https://example.com/backup.mp4"]);
});

test("Xiaohongshu preserves JSON string contents when normalizing undefined fields", () => {
  const desc = 'literal undefined with {braces} and a "quoted" word';
  const html = stateHtml({ noteId, desc, unloaded: null, imageList: [{ urlDefault: "https://example.com/undefined.jpg" }] }).replace('"unloaded":null', '"unloaded":undefined');
  const snapshot = extractXiaohongshuSnapshot(html, `https://www.xiaohongshu.com/discovery/item/${noteId}`);
  assert.equal(snapshot.body, desc);
  assert.deepEqual(snapshot.images, ["https://example.com/undefined.jpg"]);
});

test("Xiaohongshu picks target DOM id among other notes and excludes comment/avatar media", () => {
  const snapshot = extractXiaohongshuSnapshot(`<div class="note-detail-mask">
    <div data-note-id="${otherId}"><h1>其他笔记</h1><video src="https://example.com/other.mp4"></video></div>
    <div class="note-container" data-note-id="${noteId}"><h1>目标标题</h1><div class="note-content">正文<div class="comments">评论正文</div></div>
      <div class="note-media"><img src="https://example.com/photo.jpg"><div class="comments"><img src="https://example.com/comment.jpg"><video src="https://example.com/comment.mp4"></video></div><div class="author"><img src="https://example.com/avatar.jpg"></div></div>
      <video src="https://example.com/target.mp4"></video>
    </div>
  </div>`, noteUrl);
  assert.equal(snapshot.title, "目标标题");
  assert.equal(snapshot.body, "正文");
  assert.deepEqual(snapshot.images, ["https://example.com/photo.jpg"]);
  assert.deepEqual(snapshot.videos, ["https://example.com/target.mp4"]);
});

test("Xiaohongshu preserves existing unique nested note and recommendation isolation", () => {
  const snapshot = extractXiaohongshuSnapshot('<div class="note-detail-mask"><div class="note-container"><h1>标题</h1><span class="author">作者</span><div class="note-content">正文<div class="recommend">推荐正文</div></div><div class="note-media"><img data-src="https://example.com/note.jpg"></div><video src="https://example.com/note.mp4"></video></div></div><aside class="recommend"><div data-note-id="other"><img src="https://example.com/outside.jpg"></div></aside>', noteUrl);
  assert.deepEqual(snapshot, { finalUrl: noteUrl, title: "标题", author: "作者", body: "正文", images: ["https://example.com/note.jpg"], videos: ["https://example.com/note.mp4"] });
});

test("Xiaohongshu keeps a rendered direct video over state quality variants", () => {
  const html = '<div id="noteContainer"><video src="https://example.com/rendered.mp4"></video></div>' + stateHtml({ noteId, video: { media: { stream: { h264: [{ masterUrl: "https://example.com/variant1.mp4" }, { masterUrl: "https://example.com/variant2.mp4" }] } } } });
  assert.deepEqual(extractXiaohongshuSnapshot(html, noteUrl).videos, ["https://example.com/rendered.mp4"]);
});

test("Xiaohongshu ignores state entries whose embedded identity disagrees with the key", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId: otherId, title: "错误笔记", desc: "错误正文", video: { mainUrl: "https://example.com/wrong.mp4" } }), noteUrl);
  assert.deepEqual(snapshot, { finalUrl: noteUrl, title: "", body: "", images: [], videos: [] });
});

test("Xiaohongshu never guesses another state entry or uses generic page media", () => {
  const html = `<main><h1>推荐首页</h1><img src="https://example.com/generic.jpg"><video src="https://example.com/generic.mp4"></video></main><script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [otherId]: { note: { noteId: otherId, title: "其他", video: { masterUrl: "https://example.com/other.mp4" } } } } } })};</script>`;
  assert.deepEqual(extractXiaohongshuSnapshot(html, noteUrl), { finalUrl: noteUrl, title: "", body: "", images: [], videos: [] });
  assert.deepEqual(extractXiaohongshuSnapshot(stateHtml({ noteId, video: { mainUrl: "https://example.com/target.mp4" } }), "https://www.xiaohongshu.com/explore"), { finalUrl: "https://www.xiaohongshu.com/explore", title: "", body: "", images: [], videos: [] });
});

test("Xiaohongshu rejects unsafe schemes and credentials, using valid alternatives only", () => {
  const snapshot = extractXiaohongshuSnapshot(`<div id="noteContainer"><div class="note-media"><img data-src="data:image/jpeg;base64,AA" src="https://example.com/good.jpg"></div><video src="javascript:alert(1)"><source src="https://user:password@example.com/video.mp4"></video></div>` + stateHtml({
    noteId, imageList: [{ urlDefault: "file:///C:/private.jpg" }],
    video: { media: { stream: { h264: [{ masterUrl: "blob:https://example.com/invalid", mainUrl: "https://example.com/safe.mp4" }] } } }
  }), noteUrl);
  assert.deepEqual(snapshot.images, ["https://example.com/good.jpg"]);
  assert.deepEqual(snapshot.videos, ["https://example.com/safe.mp4"]);
});

test("Xiaohongshu leaves ambiguous generic roots and malformed script state unavailable", () => {
  const snapshot = extractXiaohongshuSnapshot('<div class="note-container"><video src="https://example.com/one.mp4"></video></div><div class="note-container"><video src="https://example.com/two.mp4"></video></div><script>window.__INITIAL_STATE__={"note": (() => ({video: "https://example.com/script.mp4"}))()};</script>', noteUrl);
  assert.deepEqual(snapshot, { finalUrl: noteUrl, title: "", body: "", images: [], videos: [] });
});
