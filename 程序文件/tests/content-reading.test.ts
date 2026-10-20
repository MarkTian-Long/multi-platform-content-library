import test from "node:test";
import assert from "node:assert/strict";
import { selectReadingPdf } from "../src/content-reading.js";
import type { ContentAsset } from "../src/content-types.js";

const legacy: ContentAsset = { id: "legacy-pdf", role: "pdf", status: "saved", path: "旧阅读.pdf", provenance: "generated", bytes: 32 };
const reading: ContentAsset = { id: "reading-pdf", role: "pdf", status: "saved", path: "阅读资料/阅读.pdf", provenance: "generated", bytes: 64 };
const original: ContentAsset = { id: "original-document", role: "source", status: "saved", path: "原始资料/原文件.PDF", provenance: "original", mime: "application/pdf", bytes: 128 };

test("selects the current generated reading PDF regardless of legacy asset order without mutating assets", () => {
  const assets = Object.freeze([Object.freeze({ ...legacy }), Object.freeze({ ...original }), Object.freeze({ ...reading })]);
  assert.equal(selectReadingPdf(assets), assets[2]);
  assert.deepEqual(assets.map(asset => asset.id), ["legacy-pdf", "original-document", "reading-pdf"]);
});

test("falls back to the saved legacy PDF, another PDF, or the original PDF when no current reading PDF is usable", () => {
  const failed: ContentAsset = { ...reading, status: "failed" };
  assert.equal(selectReadingPdf([failed, original, legacy]), legacy);
  const previous: ContentAsset = { ...legacy, id: "previous-generated-pdf" };
  assert.equal(selectReadingPdf([failed, original, previous]), previous);
  assert.equal(selectReadingPdf([failed, original]), original);
});

test("never selects failed, empty, integrity-failed, remote, or escaping PDF paths", () => {
  const invalid: ContentAsset[] = [
    { ...reading, status: "unavailable" },
    { ...reading, path: undefined },
    { ...reading, path: "../其他资料.pdf" },
    { ...reading, path: "资料/../../其他资料.pdf" },
    { ...reading, path: "C:\\其他资料.pdf" },
    { ...reading, path: "\\\\server\\private.pdf" },
    { ...reading, path: "https://example.com/current.pdf" },
    { ...reading, path: "不是PDF.txt" },
    { ...reading, path: "reading.pdf:private" },
    { ...reading, bytes: 0 },
    { ...reading, bytes: -1 },
    { ...reading, integrityFailed: true }
  ];
  assert.equal(selectReadingPdf(invalid), undefined);
  assert.equal(selectReadingPdf([...invalid, original]), original);
});

test("accepts legacy PDF metadata without byte counts and does not mistake arbitrary source files for a PDF", () => {
  const old: ContentAsset = { ...legacy, bytes: undefined };
  assert.equal(selectReadingPdf([old]), old);
  assert.equal(selectReadingPdf([{ ...original, path: "原始资料/网页.html", mime: "text/html" }]), undefined);
  assert.equal(selectReadingPdf([]), undefined);
});
