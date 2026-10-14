import test from "node:test";
import assert from "node:assert/strict";
import { extractXiaohongshuSnapshot } from "../src/content-xiaohongshu.js";
import * as xiaohongshu from "../src/content-xiaohongshu.js";

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

// Primary field contract: ucmao/media-parser/src/parsers/xiaohongshu_parser.py,
// get_image_list: imageList[*].livePhoto and imageList[*].stream.h264[*].masterUrl.
// Public mixed-gallery report: wujunwei928/parse-video-py/issues/45 (items 1/3/4 are live).
const liveImage = (id: string, extra: Record<string, unknown> = {}) => ({
  fileId: id,
  livePhoto: true,
  urlDefault: `https://example.com/${id}.jpg`,
  stream: { h264: [{ masterUrl: `https://example.com/${id}.mp4`, duration: 3000 }] },
  ...extra
});

test("Xiaohongshu keeps original mixed gallery positions and binds each Live Photo stream", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("photo-1"),
    { fileId: "photo-2", urlDefault: "https://example.com/photo-2.webp", livePhoto: false },
    liveImage("photo-3"),
    liveImage("photo-4")
  ] }), noteUrl);
  assert.deepEqual(snapshot.photos?.map(photo => [photo.id, photo.index, photo.motionExpected]), [["photo-1", 1, true], ["photo-2", 2, false], ["photo-3", 3, true], ["photo-4", 4, true]]);
  assert.deepEqual(snapshot.photos?.map(photo => photo.motionUrls), [["https://example.com/photo-1.mp4"], [], ["https://example.com/photo-3.mp4"], ["https://example.com/photo-4.mp4"]]);
  assert.equal(snapshot.photos?.[0].durationSeconds, 3);
  assert.deepEqual(snapshot.videos, [], "photo motion must not become a separate top-level note video");
  assert.equal(snapshot.videoExpected, undefined);
});

test("Xiaohongshu keeps a declared Live Photo unavailable when its stream is missing", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("missing-motion", { stream: undefined })] }), noteUrl);
  assert.equal(snapshot.photos?.[0].motionExpected, true);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, ["https://example.com/missing-motion.jpg"]);
  assert.match(snapshot.photos?.[0].reason ?? "", /实况|动态/);
});

test("Xiaohongshu keeps supplied image and h264 fallbacks for an unrecognized image resource", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [{
    fileId: "notes_pre_post/short", livePhoto: true,
    urlDefault: "https://example.com/original.avif?format=avif&signature=placeholder",
    urlPre: "https://example.com/preview.jpg",
    infoList: [{ imageScene: "WB_DFT", url: "https://example.com/default.webp" }],
    stream: { h264: [{ masterUrl: "https://example.com/master.mp4?signature=placeholder", backupUrls: ["https://example.com/backup.mp4", "https://example.com/master.mp4?signature=placeholder"], duration: 2500 }] }
  }] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, ["https://example.com/original.avif?format=avif&signature=placeholder", "https://example.com/default.webp", "https://example.com/preview.jpg"]);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/master.mp4?signature=placeholder", "https://example.com/backup.mp4"]);
  assert.equal(snapshot.photos?.[0].id, "notes_pre_post/short");
  assert.equal(snapshot.photos?.[0].durationSeconds, 2.5);
});

test("Xiaohongshu rejects foreign photo/note identities without shifting later image positions", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("foreign-note", { noteId: otherId }),
    liveImage("contradictory-photo", { file_id: "different-photo" }),
    liveImage("valid-photo", { noteId, imageId: "native-gallery-photo" })
  ] }), noteUrl);
  assert.equal(snapshot.photos?.length, 3);
  for (const photo of snapshot.photos?.slice(0, 2) ?? []) {
    assert.deepEqual(photo.imageUrls, []);
    assert.deepEqual(photo.motionUrls, []);
    assert.match(photo.reason ?? "", /身份/);
  }
  assert.equal(snapshot.photos?.[2].index, 3);
  assert.deepEqual(snapshot.photos?.[2].motionUrls, ["https://example.com/valid-photo.mp4"]);
  assert.deepEqual(snapshot.images, ["https://example.com/valid-photo.jpg"]);
});

test("Xiaohongshu refuses a foreign motion identity while retaining the matching photo", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("target-photo", {
    imageId: "target-gallery-image",
    stream: { h264: [{ imageId: "another-photo", noteId, masterUrl: "https://example.com/foreign.mp4" }] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, ["https://example.com/target-photo.jpg"]);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.equal(snapshot.photos?.[0].motionExpected, true);
  assert.match(snapshot.photos?.[0].reason ?? "", /身份/);
});

test("Xiaohongshu rejects unsafe motion candidates and retains a stream even if the cover is missing", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("no-cover", {
    urlDefault: "file:///private.jpg",
    stream: { h264: [{ masterUrl: "blob:https://example.com/opaque", backupUrls: ["https://user:password@example.com/credential.mp4", "data:video/mp4;base64,AA", "https://example.com/valid.mp4"] }] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, []);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/valid.mp4"]);
  assert.equal(snapshot.photos?.[0].motionExpected, true);
  assert.match(snapshot.photos?.[0].reason ?? "", /原图|图片/);
});

test("Xiaohongshu keeps repeated covers and unavailable image records at their original indices", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("one", { urlDefault: "https://example.com/repeated.jpg" }), null,
    liveImage("three", { urlDefault: "https://example.com/repeated.jpg" })
  ] }), noteUrl);
  assert.deepEqual(snapshot.photos?.map(photo => photo.index), [1, 2, 3]);
  assert.deepEqual(snapshot.photos?.[1].imageUrls, []);
  assert.match(snapshot.photos?.[1].reason ?? "", /图片|照片/);
  assert.deepEqual(snapshot.photos?.[2].motionUrls, ["https://example.com/three.mp4"]);
});

test("Xiaohongshu ignores recommendation Live Photos and avoids duplicating a rendered photo player", () => {
  const html = '<div id="noteContainer"><div class="note-media"><video src="https://example.com/target.mp4"></video></div></div>' + stateHtml({
    noteId, type: "normal", imageList: [liveImage("target")],
    comments: { imageList: [liveImage("comment")] },
    recommended: { imageList: [liveImage("recommended")] }
  }, { [otherId]: { note: { noteId: otherId, imageList: [liveImage("other")] } } });
  const snapshot = extractXiaohongshuSnapshot(html, noteUrl);
  assert.deepEqual(snapshot.photos?.map(photo => photo.id), ["target"]);
  assert.deepEqual(snapshot.videos, []);
  assert.equal(snapshot.videoExpected, undefined);
});

test("Xiaohongshu distinguishes upload file IDs, gallery image IDs and renderer IDs", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("upload-file", {
    file_id: "upload-file", imageId: "gallery-image", image_id: "gallery-image", id: "renderer-item",
    stream: { h264: [{ imageId: "gallery-image", fileId: "separate-video-file", masterUrl: "https://example.com/valid-motion.mp4" }] }
  })] }), noteUrl);
  assert.equal(snapshot.photos?.[0].id, "upload-file");
  assert.deepEqual(snapshot.photos?.[0].imageUrls, ["https://example.com/upload-file.jpg"]);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/valid-motion.mp4"]);
  assert.equal(snapshot.photos?.[0].reason, undefined);
});

test("Xiaohongshu refuses conflicting declarations within the image ID namespace", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("upload-file", { imageId: "first-gallery-image", image_id: "second-gallery-image" })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, []);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.match(snapshot.photos?.[0].reason ?? "", /身份/);
});

test("Xiaohongshu keeps repeated upload resources bound to distinct original photo positions", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("same-upload", { stream: { h264: [{ masterUrl: "https://example.com/motion-one.mp4" }] } }),
    liveImage("same-upload", { stream: { h264: [{ masterUrl: "https://example.com/motion-two.mp4" }] } })
  ] }), noteUrl);
  assert.deepEqual(snapshot.photos?.map(photo => photo.index), [1, 2]);
  assert.deepEqual(snapshot.photos?.map(photo => photo.motionUrls), [["https://example.com/motion-one.mp4"], ["https://example.com/motion-two.mp4"]]);
});

test("Xiaohongshu retains a separate note video while excluding rendered photo motion", () => {
  const html = '<div id="noteContainer"><video src="https://example.com/photo.mp4"></video><video src="https://example.com/note.mp4"></video></div>'
    + stateHtml({ noteId, type: "video", video: { mainUrl: "https://example.com/note.mp4" }, imageList: [liveImage("photo")] });
  const snapshot = extractXiaohongshuSnapshot(html, noteUrl);
  assert.deepEqual(snapshot.videos, ["https://example.com/note.mp4"]);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/photo.mp4"]);
});

test("Xiaohongshu checks explicit wrapper note IDs and root note aliases", () => {
  for (const entry of [
    { note_id: otherId, note: { noteId, type: "normal", imageList: [liveImage("photo")] } },
    { note: { noteId, note_id: otherId, type: "normal", imageList: [liveImage("photo")] } },
    { note: { noteId, id: otherId, type: "normal", imageList: [liveImage("photo")] } }
  ]) {
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: entry } } })};</script>`;
    assert.equal(extractXiaohongshuSnapshot(html, noteUrl).photos, undefined);
  }
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { id: "state-wrapper-record", noteId, note: { noteId, type: "normal", imageList: [liveImage("photo")] } } } } })};</script>`;
  assert.equal(extractXiaohongshuSnapshot(html, noteUrl).photos?.length, 1);
});

test("Xiaohongshu reports photo metadata beyond its bound instead of silently claiming full coverage", () => {
  const imageList = Array.from({ length: 501 }, (_, index) => ({ fileId: `image-${index + 1}`, urlDefault: `https://example.com/image-${index + 1}.jpg` }));
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList }), noteUrl);
  assert.equal(snapshot.photos?.length, 501);
  assert.equal(snapshot.photos?.at(-1)?.index, 501);
  assert.deepEqual(snapshot.photos?.at(-1)?.imageUrls, []);
  assert.match(snapshot.photos?.at(-1)?.reason ?? "", /501.*500|500.*501/);
});

for (const flag of ["has_drm", "is_drm", "encrypted", "hasDrm"]) {
  test(`Xiaohongshu refuses an explicitly protected ${flag} photo-motion candidate`, () => {
    const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("protected-photo", {
      stream: { h264: [{ [flag]: true, masterUrl: "https://example.com/protected.mp4", backupUrls: ["https://example.com/protected-backup.mp4"], duration: 3000 }] }
    })] }), noteUrl);
    const photo = snapshot.photos?.[0];
    assert.deepEqual(photo?.imageUrls, ["https://example.com/protected-photo.jpg"]);
    assert.deepEqual(photo?.motionUrls, []);
    assert.equal(photo?.motionExpected, true);
    assert.equal(photo?.motionProtected, true);
    assert.equal(photo?.durationSeconds, undefined);
    assert.match(photo?.reason ?? "", /受保护|加密/);
    assert.deepEqual(snapshot.videos, []);
  });
}

test("Xiaohongshu applies an explicit photo or stream protection declaration to all its motion candidates", () => {
  for (const extra of [
    { encrypted: true },
    { stream: { hasDrm: true, h264: [{ masterUrl: "https://example.com/declared-protected.mp4" }] } }
  ]) {
    const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("whole-protected", extra)] }), noteUrl);
    assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
    assert.equal(snapshot.photos?.[0].motionProtected, true);
    assert.equal(snapshot.photos?.[0].motionExpected, true);
    assert.deepEqual(snapshot.photos?.[0].imageUrls, ["https://example.com/whole-protected.jpg"]);
    assert.match(snapshot.photos?.[0].reason ?? "", /受保护|加密/);
  }
});

test("Xiaohongshu keeps a usable ordinary candidate when protected candidates are also present", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("mixed-protection", {
    stream: { h264: [
      { encrypted: true, masterUrl: "https://example.com/encrypted.mp4", backupUrls: ["https://example.com/encrypted-backup.mp4"], duration: 9000 },
      { has_drm: false, masterUrl: "https://example.com/ordinary.mp4", backupUrls: ["https://example.com/ordinary-backup.mp4"], duration: 3000 }
    ] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/ordinary.mp4", "https://example.com/ordinary-backup.mp4"]);
  assert.equal(snapshot.photos?.[0].motionProtected, undefined);
  assert.equal(snapshot.photos?.[0].durationSeconds, 3);
  assert.equal(snapshot.photos?.[0].reason, undefined);
});

test("Xiaohongshu does not treat false protection values or WEB_LIVEPHOTO_19 as encryption", () => {
  for (const negative of [false, 0, "false", "0"]) {
    const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("ordinary", {
      encrypted: negative,
      stream: { hasDrm: negative, h264: [{ has_drm: negative, is_drm: negative, encrypted: negative, hasDrm: negative, masterUrl: "https://example.com/ordinary.mp4", duration: 3000, streamType: 19, streamDesc: "WEB_LIVEPHOTO_19" }] }
    })] }), noteUrl);
    assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/ordinary.mp4"]);
    assert.equal(snapshot.photos?.[0].motionProtected, undefined);
    assert.equal(snapshot.photos?.[0].durationSeconds, 3);
  }
});

test("Xiaohongshu preserves pre-filter motion expectations for explicit affirmative protection values", () => {
  for (const affirmative of [1, "1", "true", " TRUE "]) {
    const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("declared-stream", {
      livePhoto: false, stream: { h264: [{ is_drm: affirmative, masterUrl: "https://example.com/protected.mp4" }] }
    })] }), noteUrl);
    assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
    assert.equal(snapshot.photos?.[0].motionProtected, true);
    assert.equal(snapshot.photos?.[0].motionExpected, true);
  }
});

test("Xiaohongshu keeps protection visible if ordinary alternatives have no usable URL", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("no-ordinary-url", {
    stream: { h264: [{ encrypted: true, masterUrl: "https://example.com/protected.mp4" }, { encrypted: false, masterUrl: "blob:https://example.com/opaque" }] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.equal(snapshot.photos?.[0].motionProtected, true);
  assert.match(snapshot.photos?.[0].reason ?? "", /受保护|加密/);
});

test("Xiaohongshu does not reintroduce a protected photo URI through the rendered video list", () => {
  const html = '<div id="noteContainer"><video src="https://example.com/protected-photo.mp4"></video><video src="https://example.com/ordinary-note.mp4"></video></div>'
    + stateHtml({ noteId, type: "video", video: { mainUrl: "https://example.com/ordinary-note.mp4" }, imageList: [liveImage("photo", {
      stream: { h264: [{ encrypted: true, masterUrl: "https://example.com/protected-photo.mp4" }] }
    })] });
  const snapshot = extractXiaohongshuSnapshot(html, noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.equal(snapshot.photos?.[0].motionProtected, true);
  assert.deepEqual(snapshot.videos, ["https://example.com/ordinary-note.mp4"]);
});

test("Xiaohongshu keeps a protected photo URI out of note-video fallback candidates", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "video", imageList: [liveImage("photo", {
    stream: { h264: [{ has_drm: true, masterUrl: "https://example.com/protected-photo.mp4" }] }
  })], video: { media: { stream: { h264: [{ masterUrl: "https://example.com/protected-photo.mp4" }, { masterUrl: "https://example.com/ordinary-note.mp4" }] } } } }), noteUrl);
  assert.equal(snapshot.photos?.[0].motionProtected, true);
  assert.deepEqual(snapshot.videos, ["https://example.com/ordinary-note.mp4"]);
});

for (const field of ["masterUrl", "mainUrl", "backupUrls"]) {
  test(`Xiaohongshu refuses a protected URI repeated in an ordinary ${field} candidate`, () => {
    const sharedUrl = "https://example.com/shared-motion.mp4";
    const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("same-uri", {
      stream: { h264: [
        { encrypted: true, masterUrl: sharedUrl, duration: 9000 },
        { has_drm: false, [field]: field === "backupUrls" ? [sharedUrl] : sharedUrl, duration: 3000 }
      ] }
    })] }), noteUrl);
    const photo = snapshot.photos?.[0];
    assert.deepEqual(photo?.imageUrls, ["https://example.com/same-uri.jpg"]);
    assert.deepEqual(photo?.motionUrls, []);
    assert.equal(photo?.motionExpected, true);
    assert.equal(photo?.motionProtected, true);
    assert.equal(photo?.durationSeconds, undefined);
    assert.match(photo?.reason ?? "", /受保护|加密/);
  });
}

test("Xiaohongshu applies protected backup declarations to an equivalent ordinary URL", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("protected-backup", {
    stream: { h264: [
      { hasDrm: true, backupUrls: ["https://example.com:443/shared-motion.mp4"] },
      { encrypted: false, mainUrl: "//example.com/shared-motion.mp4", duration: 3000 }
    ] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.equal(snapshot.photos?.[0].motionProtected, true);
  assert.equal(snapshot.photos?.[0].durationSeconds, undefined);
});

test("Xiaohongshu chooses duration from an ordinary candidate with a remaining unprotected URI", () => {
  const sharedUrl = "https://example.com/shared-motion.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("mixed-uri", {
    stream: { h264: [
      { encrypted: true, masterUrl: sharedUrl, duration: 12000 },
      { has_drm: false, masterUrl: sharedUrl, backupUrls: [sharedUrl], duration: 9000 },
      { encrypted: false, masterUrl: "https://example.com/ordinary.mp4", backupUrls: [sharedUrl, "https://example.com/ordinary-backup.mp4"], duration: 2500 }
    ] }
  })] }), noteUrl);
  const photo = snapshot.photos?.[0];
  assert.deepEqual(photo?.motionUrls, ["https://example.com/ordinary.mp4", "https://example.com/ordinary-backup.mp4"]);
  assert.equal(photo?.motionProtected, undefined);
  assert.equal(photo?.durationSeconds, 2.5);
  assert.equal(photo?.reason, undefined);
});

test("Xiaohongshu keeps a distinct ordinary backup when its primary URI is protected", () => {
  const sharedUrl = "https://example.com/shared-motion.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("ordinary-backup", {
    stream: { h264: [
      { is_drm: true, masterUrl: sharedUrl },
      { has_drm: false, masterUrl: sharedUrl, backupUrls: ["https://example.com/ordinary-backup.mp4"], duration: 4000 }
    ] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/ordinary-backup.mp4"]);
  assert.equal(snapshot.photos?.[0].motionProtected, undefined);
  assert.equal(snapshot.photos?.[0].durationSeconds, 4);
});

test("Xiaohongshu filters an earlier ordinary photo URI declared protected by a later matching photo", () => {
  const sharedUrl = "https://example.com/shared-motion.mp4";
  const ordinary = liveImage("first-photo", { stream: { h264: [{ encrypted: false, masterUrl: sharedUrl, duration: 3000 }] } });
  const protectedPhoto = liveImage("second-photo", { stream: { h264: [{ encrypted: true, masterUrl: sharedUrl }] } });
  for (const imageList of [[ordinary, protectedPhoto], [protectedPhoto, ordinary]]) {
    const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList }), noteUrl);
    assert.deepEqual(snapshot.photos?.map(photo => photo.motionUrls), [[], []]);
    assert.deepEqual(snapshot.photos?.map(photo => photo.motionProtected), [true, true]);
    assert.deepEqual(snapshot.photos?.map(photo => photo.motionExpected), [true, true]);
    assert.deepEqual(snapshot.photos?.map(photo => photo.durationSeconds), [undefined, undefined]);
    assert.equal(snapshot.images.length, 2);
  }
});

test("Xiaohongshu does not let foreign or contradictory protected identities poison an ordinary URI", () => {
  const sharedUrl = "https://example.com/shared-motion.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("ordinary", { imageId: "target-image", stream: { h264: [
      { encrypted: true, noteId: otherId, masterUrl: sharedUrl },
      { encrypted: true, imageId: "foreign-image", masterUrl: sharedUrl },
      { encrypted: false, imageId: "target-image", masterUrl: sharedUrl, duration: 3000 }
    ] } }),
    liveImage("contradictory-photo", { file_id: "different-upload", encrypted: true, stream: { h264: [{ masterUrl: sharedUrl }] } }),
    liveImage("foreign-note-photo", { noteId: otherId, encrypted: true, stream: { h264: [{ masterUrl: sharedUrl }] } })
  ] }, { [otherId]: { note: { noteId: otherId, type: "normal", imageList: [liveImage("recommend", { encrypted: true, stream: { h264: [{ masterUrl: sharedUrl }] } })] } } }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, [sharedUrl]);
  assert.equal(snapshot.photos?.[0].motionProtected, undefined);
  assert.equal(snapshot.photos?.[0].durationSeconds, 3);
  assert.deepEqual(snapshot.photos?.slice(1).map(photo => photo.motionUrls), [[], []]);
  assert.deepEqual(snapshot.images, ["https://example.com/ordinary.jpg"]);
});

const originalResource = "notes_pre_post/image_resource_0123456789";
const otherResource = "notes_pre_post/foreign_resource_0123456789";
const originalPreview = `https://sns-webpic-qc.xhscdn.com/2026101412/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${originalResource}!h5_1080jpg?signature=placeholder&expires=42`;
const originalObjectUrls = [`https://sns-img-bd.xhscdn.com/${originalResource}`, `https://ci.xiaohongshu.com/${originalResource}`];

test("Xiaohongshu exposes narrow original-object image candidates and preserves its supplied fallback URL", () => {
  const candidates = xiaohongshu.xiaohongshuOriginalImageCandidates([originalPreview], originalResource);
  assert.deepEqual(candidates.map(candidate => candidate.url), [...originalObjectUrls, originalPreview]);
  assert.deepEqual(candidates.slice(0, 2).map(candidate => [candidate.source, candidate.rendition, candidate.watermark, candidate.evidence]), [
    ["platform_object", "original", "unknown", "known_template"], ["platform_object", "original", "unknown", "known_template"]
  ]);
  assert.equal(candidates.at(-1)?.source, "provided");
  assert.equal(candidates.at(-1)?.watermark, "unknown");
});

test("Xiaohongshu maps only an explicit notes_pre_post resource from a platform image URL", () => {
  assert.deepEqual(xiaohongshu.xiaohongshuOriginalImageCandidates([originalPreview]).slice(0, 2).map(candidate => candidate.url), originalObjectUrls);
  assert.deepEqual(xiaohongshu.xiaohongshuOriginalImageCandidates([], originalResource).map(candidate => candidate.url), originalObjectUrls);
  for (const url of [
    `https://example.com/${originalResource}!h5_1080jpg`, `https://xhscdn.com.example.com/${originalResource}!h5_1080jpg`,
    "https://sns-webpic-qc.xhscdn.com/spectrum/image_resource_0123456789!h5_1080jpg",
    "https://sns-webpic-qc.xhscdn.com/notes_pre_post/short!h5_1080jpg",
    "https://sns-webpic-qc.xhscdn.com/notes_pre_post%2Fimage_resource_0123456789!h5_1080jpg"
  ]) assert.equal(xiaohongshu.xiaohongshuOriginalImageCandidates([url]).some(candidate => candidate.source === "platform_object"), false);
});

test("Xiaohongshu refuses original image mappings for invalid or conflicting resource namespaces", () => {
  for (const fileId of ["../notes_pre_post/image_resource_0123456789", "notes_pre_post/short", "spectrum/image_resource_0123456789", "notes_pre_post/image_resource_0123456789?signature=placeholder"]) {
    assert.equal(xiaohongshu.xiaohongshuOriginalImageCandidates([originalPreview], fileId).some(candidate => candidate.source === "platform_object"), false);
  }
  assert.deepEqual(xiaohongshu.xiaohongshuOriginalImageCandidates([originalPreview], otherResource), []);
  assert.deepEqual(xiaohongshu.xiaohongshuOriginalImageCandidates([originalPreview, originalPreview.replace(originalResource, otherResource)]), []);
  assert.deepEqual(xiaohongshu.xiaohongshuOriginalImageCandidates(["file:///private.jpg", "https://user:password@sns-webpic-qc.xhscdn.com/notes_pre_post/image_resource_0123456789"]), []);
});

test("Xiaohongshu ranks an original image object first while retaining declared dimensions and the signed preview", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [{
    fileId: originalResource, imageId: "separate-gallery-id", width: 3024, height: 4032, urlDefault: originalPreview,
    livePhoto: true, stream: { h264: [{ masterUrl: "https://example.com/web-live.mp4", streamType: 19, streamDesc: "WEB_LIVEPHOTO_19", width: 1080, height: 1440, duration: 3000 }] }
  }] }), noteUrl);
  const photo = snapshot.photos?.[0];
  assert.deepEqual(photo?.imageUrls, [...originalObjectUrls, originalPreview]);
  assert.deepEqual(snapshot.images, [originalObjectUrls[0]]);
  assert.equal(photo?.width, 3024);
  assert.equal(photo?.height, 4032);
  assert.deepEqual(photo?.imageCandidates?.slice(0, 2).map(candidate => [candidate.width, candidate.height]), [[3024, 4032], [3024, 4032]]);
  assert.equal(photo?.motionCandidates?.[0].watermark, "present");
  assert.equal(photo?.motionCandidates?.[0].evidence, "known_stream_type");
  assert.equal(photo?.motionCandidates?.[0].durationSeconds, 3);
});

test("Xiaohongshu does not reintroduce an image with contradictory resource identity through rendered media", () => {
  const html = `<div id="noteContainer"><div class="note-media"><img src="${originalPreview}"></div></div>`
    + stateHtml({ noteId, type: "normal", imageList: [{ fileId: otherResource, urlDefault: originalPreview }] });
  const snapshot = extractXiaohongshuSnapshot(html, noteUrl);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, []);
  assert.deepEqual(snapshot.images, []);
  assert.match(snapshot.photos?.[0].reason ?? "", /身份|资源/);
});

test("Xiaohongshu prefers unknown-watermark H265 over a larger known-logo H264 and ranks remaining streams by pixels and bitrate", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("quality", {
    stream: { h264: [
      { masterUrl: "https://example.com/logo.mp4", streamType: 19, width: 1080, height: 1440, videoBitrate: 4000000, duration: 3000 },
      { masterUrl: "https://example.com/small.mp4", width: 240, height: 320, videoBitrate: 500000, duration: 3000 }
    ], h265: [
      { masterUrl: "https://example.com/hevc-low.mp4", width: 720, height: 960, videoBitrate: 1000000, duration: 3000 },
      { masterUrl: "https://example.com/hevc-high.mp4", width: 720, height: 960, videoBitrate: 2000000, duration: 3000 }
    ] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/hevc-high.mp4", "https://example.com/hevc-low.mp4", "https://example.com/small.mp4", "https://example.com/logo.mp4"]);
  assert.equal(snapshot.photos?.[0].motionCandidates?.[0].watermark, "unknown");
  assert.equal(snapshot.photos?.[0].motionCandidates?.[0].bitrate, 2000000);
  assert.equal(snapshot.photos?.[0].motionCandidates?.at(-1)?.watermark, "present");
  assert.deepEqual(snapshot.videos, []);
});

for (const flags of [{ streamType: 19 }, { streamType: 259 }, { streamType: 309 }, { streamDesc: "WEB_LIVEPHOTO_19" }]) {
  test(`Xiaohongshu marks a known platform-watermark stream ${JSON.stringify(flags)} without claiming others clean`, () => {
    const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("watermark", {
      stream: { h264: [{ ...flags, masterUrl: "https://example.com/watermarked.mp4" }], h265: [{ masterUrl: "https://example.com/unknown-hevc.mp4", streamType: 258 }] }
    })] }), noteUrl);
    assert.deepEqual(snapshot.photos?.[0].motionCandidates?.map(candidate => candidate.watermark), ["unknown", "present"]);
    assert.equal(snapshot.photos?.[0].motionCandidates?.at(-1)?.evidence, "known_stream_type");
  });
}

test("Xiaohongshu reads an actual nested Live Photo component and supplied original Key without guessing from stream IDs", () => {
  const key = "spectrum/actual_live_origin_resource.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("nested-live", {
    stream: undefined,
    livePhoto: { noteId, consumer: { originVideoKey: key }, media: { stream: { h265: [{ masterUrl: "https://example.com/nested-hevc.mp4", width: 1080, height: 1440, duration: 3000 }] } } }
  }), liveImage("no-origin", { stream: { h264: [{ masterUrl: "https://example.com/stream/1/10/19/opaque_19.mp4", videoId: "not-an-origin-key" }] } })] }), noteUrl);
  const photo = snapshot.photos?.[0];
  assert.deepEqual(photo?.motionUrls, [`https://sns-video-bd.xhscdn.com/${key}`, "https://example.com/nested-hevc.mp4"]);
  assert.equal(photo?.motionCandidates?.[0].source, "platform_object");
  assert.equal(photo?.motionCandidates?.[0].rendition, "original");
  assert.equal(photo?.motionCandidates?.[0].watermark, "unknown");
  assert.equal(photo?.motionExpected, true);
  assert.equal(snapshot.photos?.[1].motionCandidates?.some(candidate => candidate.rendition === "original"), false);
  assert.deepEqual(snapshot.videos, []);
});

test("Xiaohongshu preserves a supplied original HTTP URL and refuses malformed Keys or foreign consumers", () => {
  const supplied = "https://example.com/original.mp4?signature=placeholder&expires=42";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("http-original", { consumer: { originVideoKey: supplied } }),
    liveImage("foreign-origin", { consumer: { noteId: otherId, originVideoKey: "spectrum/foreign.mp4" } }),
    ...["../private.mp4", "spectrum/../private.mp4", "blob:https://example.com/key", "https://user:password@example.com/private.mp4", "spectrum/key.mp4?signature=placeholder"].map((originVideoKey, index) => liveImage(`invalid-origin-${index}`, { consumer: { originVideoKey } }))
  ] }), noteUrl);
  assert.equal(snapshot.photos?.[0].motionCandidates?.[0].url, supplied);
  assert.equal(snapshot.photos?.[0].motionCandidates?.[0].source, "provided");
  assert.equal(snapshot.photos?.[0].motionCandidates?.[0].rendition, "original");
  for (const photo of snapshot.photos?.slice(1) ?? []) assert.equal(photo.motionCandidates?.some(candidate => candidate.rendition === "original"), false);
});

test("Xiaohongshu applies cross-photo protection to H265 and supplied original addresses before ranking", () => {
  const key = "spectrum/shared_origin_resource.mp4", shared = `https://sns-video-bd.xhscdn.com/${key}`;
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("ordinary-origin", { stream: undefined, consumer: { originVideoKey: key } }),
    liveImage("ordinary-hevc", { stream: { h265: [{ masterUrl: shared, duration: 3000 }] } }),
    liveImage("protected-hevc", { stream: { h265: [{ hasDrm: true, masterUrl: shared }] } }),
    liveImage("different-hevc", { stream: { h265: [{ masterUrl: "https://example.com/ordinary-hevc.mp4", duration: 2500 }] } })
  ] }), noteUrl);
  assert.deepEqual(snapshot.photos?.slice(0, 3).map(photo => photo.motionUrls), [[], [], []]);
  assert.deepEqual(snapshot.photos?.slice(0, 3).map(photo => photo.motionProtected), [true, true, true]);
  assert.deepEqual(snapshot.photos?.slice(0, 3).map(photo => photo.motionExpected), [true, true, true]);
  assert.deepEqual(snapshot.photos?.[3].motionUrls, ["https://example.com/ordinary-hevc.mp4"]);
  assert.equal(snapshot.photos?.[3].durationSeconds, 2.5);
});

test("Xiaohongshu treats a whole protected photo stream as protected even when it supplies an original Key", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("whole-stream", {
    stream: { encrypted: true, h265: [{ masterUrl: "https://example.com/protected-hevc.mp4" }] },
    consumer: { originVideoKey: "spectrum/protected_origin_resource.mp4" }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.deepEqual(snapshot.photos?.[0].motionCandidates, []);
  assert.equal(snapshot.photos?.[0].motionProtected, true);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, ["https://example.com/whole-stream.jpg"]);
});

test("Xiaohongshu exposes ranked normal-note video candidates and keeps photo motion separate", () => {
  const key = "spectrum/actual_note_origin_resource.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "video", video: {
    consumer: { originVideoKey: key }, media: { stream: { h264: [{ masterUrl: "https://example.com/download.mp4", streamType: 259, width: 1920, height: 1080 }] } }
  }, imageList: [liveImage("photo-motion")] }), noteUrl);
  assert.equal(snapshot.videoCandidates?.[0].url, `https://sns-video-bd.xhscdn.com/${key}`);
  assert.equal(snapshot.videoCandidates?.[0].rendition, "original");
  assert.equal(snapshot.videoCandidates?.[0].watermark, "unknown");
  assert.equal(snapshot.videoCandidates?.at(-1)?.watermark, "present");
  assert.deepEqual(snapshot.videos, [`https://sns-video-bd.xhscdn.com/${key}`]);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/photo-motion.mp4"]);
});

test("Xiaohongshu considers later H265 primary quality candidates even with many earlier H264 backups", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("bounded-quality", {
    stream: { h264: Array.from({ length: 32 }, (_, index) => ({ masterUrl: `https://example.com/h264-${index}.mp4`, width: 240, height: 320, backupUrls: Array.from({ length: 16 }, (_, backup) => `https://example.com/h264-${index}-backup-${backup}.mp4`) })),
      h265: [{ masterUrl: "https://example.com/best-hevc.mp4", width: 1080, height: 1440, duration: 3000 }] }
  })] }), noteUrl);
  assert.equal(snapshot.photos?.[0].motionUrls[0], "https://example.com/best-hevc.mp4");
});

test("Xiaohongshu rejects an explicitly conflicting image resource even in a supplied fallback host", () => {
  const foreign = `https://example.com/${otherResource}!h5_1080jpg`;
  assert.deepEqual(xiaohongshu.xiaohongshuOriginalImageCandidates([foreign], originalResource), []);
});

test("Xiaohongshu keeps a contradictory image resource out of photo motion and the global protection set", () => {
  const shared = "https://example.com/ordinary-shared.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("ordinary", { stream: { h265: [{ masterUrl: shared, duration: 3000 }] } }),
    { fileId: otherResource, urlDefault: originalPreview, livePhoto: true, stream: { h265: [{ encrypted: true, masterUrl: shared }] } }
  ] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, [shared]);
  assert.equal(snapshot.photos?.[0].motionProtected, undefined);
  assert.deepEqual(snapshot.photos?.[1].motionUrls, []);
  assert.deepEqual(snapshot.photos?.[1].imageUrls, []);
  assert.equal(snapshot.photos?.[1].motionExpected, true);
  assert.match(snapshot.photos?.[1].reason ?? "", /身份/);
});

test("Xiaohongshu does not let a foreign nested Live Photo poison valid H265 or supplied origin candidates", () => {
  const shared = "https://example.com/ordinary-shared.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("ordinary-nested", {
    imageId: "target-gallery-id", stream: { h265: [{ masterUrl: shared, duration: 3000 }] },
    livePhoto: { noteId: otherId, encrypted: true, consumer: { originVideoKey: shared }, media: { stream: { h265: [{ masterUrl: shared }] } } }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, [shared]);
  assert.equal(snapshot.photos?.[0].motionProtected, undefined);
  assert.equal(snapshot.photos?.[0].motionCandidates?.[0].rendition, "playback");
});

test("Xiaohongshu blocks a protected consumer original URI repeated by ordinary codec aliases", () => {
  const shared = "https://example.com/shared-origin.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("protected-origin", {
    consumer: { encrypted: true, originVideoKey: shared },
    stream: { h264: [{ masterUrl: shared }], h265: [{ masterUrl: shared }] }
  })] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.equal(snapshot.photos?.[0].motionProtected, true);
});

test("Xiaohongshu keeps the declared image resource identity stable across object and refreshed preview candidates", () => {
  const first = xiaohongshu.xiaohongshuOriginalImageCandidates([originalPreview], originalResource);
  const refreshed = originalPreview.replace("2026101412", "2026101413").replace("signature=placeholder&expires=42", "signature=refreshed&expires=43");
  const second = xiaohongshu.xiaohongshuOriginalImageCandidates([refreshed]);
  assert.equal(typeof first[0].resourceId, "string");
  assert.notEqual(first[0].resourceId, originalResource);
  assert.equal(new Set([...first, ...second].map(candidate => candidate.resourceId)).size, 1);
  assert.equal(second.at(-1)?.url, refreshed);
});

test("Xiaohongshu binds resource metadata only to actual original Keys, preserving a same-URI codec alias", () => {
  const key = "spectrum/actual_origin_resource.mp4", original = `https://sns-video-bd.xhscdn.com/${key}`;
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("actual-key", { consumer: { originVideoKey: key }, stream: { h265: [{ masterUrl: original, width: 1080, height: 1440, duration: 3000 }] } }),
    liveImage("stream-id-only", { stream: { h264: [{ masterUrl: "https://example.com/opaque_19.mp4", videoId: key }] } })
  ] }), noteUrl);
  const candidate = snapshot.photos?.[0].motionCandidates?.[0];
  assert.equal(candidate?.url, original);
  assert.equal(candidate?.rendition, "original");
  assert.equal(typeof candidate?.resourceId, "string");
  assert.notEqual(candidate?.resourceId, key);
  assert.equal(snapshot.photos?.[1].motionCandidates?.[0].resourceId, undefined);
});

test("Xiaohongshu refuses all top-level DOM and state fallbacks when the note video or its stream is wholly protected", () => {
  const protectedUrl = "https://example.com/protected-note.mp4";
  for (const video of [
    { has_drm: true, media: { stream: { h264: [{ masterUrl: protectedUrl }] } } },
    { media: { is_drm: true, stream: { h264: [{ masterUrl: protectedUrl }] } } },
    { media: { stream: { encrypted: true, h264: [{ masterUrl: protectedUrl }] } } }
  ]) {
    const html = '<div id="noteContainer"><video src="https://example.com/rendered-alternate.mp4"></video></div>'
      + stateHtml({ noteId, type: "video", video, imageList: [liveImage("independent-photo")] });
    const snapshot = extractXiaohongshuSnapshot(html, noteUrl);
    assert.deepEqual(snapshot.videos, []);
    assert.deepEqual(snapshot.videoCandidates ?? [], []);
    assert.equal(snapshot.videoProtected, true);
    assert.equal(snapshot.videoExpected, true);
    assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/independent-photo.mp4"]);
    assert.equal(snapshot.photos?.[0].motionProtected, undefined);
    assert.deepEqual(snapshot.images, ["https://example.com/independent-photo.jpg"]);
  }
});

test("Xiaohongshu retains an ordinary top-level video candidate when only another stream row is protected", () => {
  const ordinary = "https://example.com/ordinary-note.mp4";
  const html = `<div id="noteContainer"><video src="${ordinary}"></video></div>`
    + stateHtml({ noteId, type: "video", video: { media: { stream: { h264: [
      { encrypted: true, masterUrl: "https://example.com/protected-note.mp4" }, { encrypted: false, masterUrl: ordinary }
    ] } } } });
  const snapshot = extractXiaohongshuSnapshot(html, noteUrl);
  assert.deepEqual(snapshot.videos, [ordinary]);
  assert.deepEqual(snapshot.videoCandidates?.map(candidate => candidate.url), [ordinary]);
  assert.equal(snapshot.videoProtected, undefined);
});

test("Xiaohongshu does not mark an independent gallery as a protected top-level note video", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", video: { has_drm: true }, imageList: [liveImage("gallery-photo")] }), noteUrl);
  assert.deepEqual(snapshot.videos, []);
  assert.equal(snapshot.videoProtected, undefined);
  assert.equal(snapshot.videoExpected, undefined);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/gallery-photo.mp4"]);
  assert.equal(snapshot.photos?.[0].motionProtected, undefined);
});

test("Xiaohongshu exposes only identity-validated protected video URIs for temporary cross-snapshot propagation", () => {
  const shared = "https://example.com/protected-shared.mp4", backup = "https://example.com/protected-backup.mp4";
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [
    liveImage("protected-photo-a", { stream: { h264: [{ encrypted: true, masterUrl: shared, backupUrls: [backup] }] } }),
    liveImage("missing-photo-b", { stream: undefined }),
    liveImage("foreign-note", { noteId: otherId, stream: { h265: [{ encrypted: true, masterUrl: "https://example.com/foreign-note.mp4" }] } }),
    liveImage("contradictory-photo", { file_id: "different-upload", stream: { h265: [{ encrypted: true, masterUrl: "https://example.com/contradictory-photo.mp4" }] } }),
    liveImage("foreign-stream", { imageId: "target-gallery-id", stream: { h265: [{ imageId: "other-gallery-id", encrypted: true, masterUrl: "https://example.com/foreign-stream.mp4" }] } })
  ] }, { [otherId]: { note: { noteId: otherId, imageList: [liveImage("recommendation", { stream: { h264: [{ encrypted: true, masterUrl: "https://example.com/recommended.mp4" }] } })] } } }), noteUrl);
  assert.deepEqual(snapshot.protectedVideoUrls, [shared, backup]);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, []);
  assert.equal(snapshot.photos?.[0].motionProtected, true);
  assert.deepEqual(snapshot.photos?.[1].motionUrls, []);
  assert.equal(snapshot.photos?.[1].motionProtected, undefined);
  assert.equal(extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [liveImage("ordinary")] }), noteUrl).protectedVideoUrls, undefined);
});
