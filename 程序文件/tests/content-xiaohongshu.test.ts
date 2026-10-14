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

test("Xiaohongshu keeps supplied image and h264 fallback candidates without guessing CDN URLs", () => {
  const snapshot = extractXiaohongshuSnapshot(stateHtml({ noteId, type: "normal", imageList: [{
    fileId: "notes_pre_post/original-file-id", livePhoto: true,
    urlDefault: "https://example.com/original.avif?format=avif&signature=placeholder",
    urlPre: "https://example.com/preview.jpg",
    infoList: [{ imageScene: "WB_DFT", url: "https://example.com/default.webp" }],
    stream: { h264: [{ masterUrl: "https://example.com/master.mp4?signature=placeholder", backupUrls: ["https://example.com/backup.mp4", "https://example.com/master.mp4?signature=placeholder"], duration: 2500 }] }
  }] }), noteUrl);
  assert.deepEqual(snapshot.photos?.[0].imageUrls, ["https://example.com/original.avif?format=avif&signature=placeholder", "https://example.com/default.webp", "https://example.com/preview.jpg"]);
  assert.deepEqual(snapshot.photos?.[0].motionUrls, ["https://example.com/master.mp4?signature=placeholder", "https://example.com/backup.mp4"]);
  assert.equal(snapshot.photos?.[0].id, "notes_pre_post/original-file-id");
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
