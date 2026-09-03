import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPdfHtml, generateArticlePdf } from "../src/article-pdf.js";

const manifest = { articleId: "b758e4d800cb74b5fd3ce525", title: "测试文章", sourceUrl: "https://mp.weixin.qq.com/s/a", status: "complete" as const, extractedAt: "2026-09-03T00:00:00.000Z", contentHash: "hash", images: [{ index: 1, sourceUrl: "https://example.com/a.png", status: "saved" as const, localPath: "images/001.png" }] };
test("creates an article PDF from saved local evidence", async () => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-pdf-")); await fs.writeFile(path.join(directory, "source.html"), '<div id="js_content"><p>正文</p><img src="https://example.com/a.png"></div>'); const result = await generateArticlePdf(directory, manifest, async () => Uint8Array.of(37, 80, 68, 70)); assert.deepEqual(result, { status: "saved", path: "测试文章.pdf" }); assert.deepEqual([...await fs.readFile(path.join(directory, "测试文章.pdf"))], [37, 80, 68, 70]); assert.match(buildPdfHtml('<div id="js_content"><p>正文</p></div>', manifest, directory), /测试文章/); });
test("reports PDF failure without deleting a saved article", async () => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-pdf-")); await fs.writeFile(path.join(directory, "source.html"), '<div id="js_content">正文</div>'); const result = await generateArticlePdf(directory, manifest, async () => { throw new Error("renderer unavailable"); }); assert.deepEqual(result, { status: "failed", reason: "renderer unavailable" }); assert.equal(await fs.readFile(path.join(directory, "source.html"), "utf8"), '<div id="js_content">正文</div>'); });