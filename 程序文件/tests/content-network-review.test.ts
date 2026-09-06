import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { promises as dns } from "node:dns";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { fetchPublic, savePublicAsset, resolvePublicHost } from "../src/content-network.js";

type ResponsePlan = { status?: number; headers?: Record<string, string>; bytes?: Uint8Array; keepOpen?: boolean; noHeaders?: boolean };
function transport(t: any, plan: ResponsePlan) {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const incoming = new PassThrough() as PassThrough & { headers: Record<string, string>; statusCode: number };
  incoming.headers = plan.headers ?? {}; incoming.statusCode = plan.status ?? 200;
  // A real IncomingMessage does not exist before headers; the injected placeholder
  // must not turn a request-only abort into an unrelated unhandled stream error.
  incoming.on("error", () => {});
  t.after(() => incoming.destroy());
  t.mock.method(https, "request", (_url: URL, options: any, callback: (response: any) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void; setTimeout(ms: number, callback: () => void): unknown };
    request.destroy = error => { incoming.destroy(error); if (error) request.emit("error", error); };
    request.setTimeout = (_ms, _callback) => request;
    request.end = () => queueMicrotask(() => {
      const abort = () => request.destroy(Object.assign(new Error("network request aborted"), { name: "AbortError" }));
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener("abort", abort, { once: true });
      if (plan.noHeaders) return;
      callback(incoming);
      if (plan.keepOpen) { if (plan.bytes) incoming.write(plan.bytes); }
      else incoming.end(plan.bytes);
    });
    return request;
  });
  return incoming;
}
async function directory(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-network-review-"));
  t.after(async () => { if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("content-network-review-")) await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
  test(`review: native pinned HTTP decodes ${encoding} before returning readable text`, async t => {
    const plain = "<article><h1>正文</h1><p>可阅读文字</p></article>";
    const bytes = compress(Buffer.from(plain));
    transport(t, { headers: { "content-encoding": encoding, "content-type": "text/html", "content-length": String(bytes.length) }, bytes });
    const response = await fetchPublic("https://example.com/article");
    assert.equal(await response.text(), plain);
  });
}

test("review: cancellation interrupts a native response body and removes partial asset bytes", async t => {
  const root = await directory(t); const controller = new AbortController();
  const incoming = transport(t, { headers: { "content-type": "image/png" }, bytes: Uint8Array.of(1, 2, 3), keepOpen: true });
  const timer = setTimeout(() => controller.abort(), 25); t.after(() => clearTimeout(timer));
  const asset = await savePublicAsset("https://example.com/image.png", root, "images/1", "image", controller.signal);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /取消/); assert.equal(incoming.destroyed, true);
  assert.deepEqual(await fs.readdir(path.join(root, "images")), []);
});

test("review: a caller deadline interrupts a native request that never sends headers", async t => {
  transport(t, { noHeaders: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 25); t.after(() => clearTimeout(timer));
  await assert.rejects(fetchPublic("https://example.com/hanging", {}, controller.signal), /abort|deadline/i);
});

test("review: rejecting a declared oversized asset cancels its open response body", async t => {
  const root = await directory(t);
  const incoming = transport(t, { headers: { "content-type": "image/png", "content-length": "32" }, keepOpen: true });
  const asset = await savePublicAsset("https://example.com/large.png", root, "images/large", "image", undefined, 8);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /上限/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(incoming.destroyed, true, "The rejected response must not keep its socket/body alive");
});

test("review: streaming budget overflow cancels the source and removes partial files", async t => {
  const root = await directory(t);
  const incoming = transport(t, { headers: { "content-type": "image/png" }, bytes: new Uint8Array(16), keepOpen: true });
  const asset = await savePublicAsset("https://example.com/large.png", root, "images/large", "image", undefined, 8);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /上限/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(incoming.destroyed, true, "Budget overflow must cancel the response reader");
  assert.deepEqual(await fs.readdir(path.join(root, "images")), []);
});

test("review: full Content-Range still requires actual bytes to equal its total without Content-Length", async t => {
  const root = await directory(t);
  transport(t, { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-7/8" }, bytes: Uint8Array.of(1, 2, 3, 4) });
  const asset = await savePublicAsset("https://example.com/video.mp4", root, "video/1", "video");
  assert.equal(asset.status, "failed", "A four-byte partial response is not the advertised eight-byte file");
  assert.equal(await fs.stat(path.join(root, "video", "1.mp4")).then(() => true, () => false), false);
});

test("review: a public hostname resolving to any IPv6 link-local or multicast address is rejected", async t => {
  let address = "fe90::1";
  t.mock.method(dns, "lookup", async () => [{ address, family: 6 }]);
  for (address of ["fe90::1", "febf::1", "ff02::1"]) {
    await assert.rejects(resolvePublicHost("example.com"), /私网|不允许/, `must reject ${address}`);
  }
});

test("a nonempty old asset without verified manifest evidence is downloaded again",async t=>{
 const root=await directory(t);await fs.mkdir(path.join(root,"images"));await fs.writeFile(path.join(root,"images","1.png"),"unverified-old-bytes");
 transport(t,{headers:{"content-type":"image/png","content-length":"4"},bytes:Uint8Array.of(1,2,3,4)});
 const result=await savePublicAsset("https://example.com/image.png",root,"images/1","image");
 assert.equal(result.status,"saved");assert.equal(result.bytes,4);assert.deepEqual([...await fs.readFile(path.join(root,"images","1.png"))],[1,2,3,4]);
});

test("default network deadline applies without a caller-provided signal",async t=>{
 transport(t,{noHeaders:true});const original=AbortSignal.timeout.bind(AbortSignal);let bounded=false;
 t.mock.method(AbortSignal,"timeout",(delay:number)=>{if(delay!==5*60000)return original(delay);bounded=true;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new DOMException("network deadline","TimeoutError")),20);t.after(()=>clearTimeout(timer));return controller.signal;});
 await assert.rejects(fetchPublic("https://example.com/hanging"),/abort|deadline/i);assert.equal(bounded,true);
});
