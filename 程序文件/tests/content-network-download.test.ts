import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promises as dns } from "node:dns";
import { createHash } from "node:crypto";
import { savePublicAsset, fetchPublic } from "../src/content-network.js";
import type { ContentAsset } from "../src/content-types.js";

const source = "https://example.com/movie.mp4";
const full = Buffer.from("abcdefgh");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const headers = { "content-type": "video/mp4", "content-length": "8", etag: '"version-1"', "accept-ranges": "bytes" };
type Plan = { status?: number; headers?: Record<string, string>; bytes?: Uint8Array; disconnect?: string; keepOpen?: boolean; errorCode?: string };
type Sent = { url: URL; headers: Record<string, string> };

function transport(t: TestContext, plans: Plan[]) {
  const sent: Sent[] = [];
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    sent.push({ url, headers: Object.fromEntries(new Headers(options.headers)) });
    const plan = plans[Math.min(sent.length - 1, plans.length - 1)];
    if (plan.errorCode) throw Object.assign(new Error("request failed"), { code: plan.errorCode });
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(plan.bytes ?? full);
          if (!plan.disconnect && !plan.keepOpen) controller.close();
        } else if (plan.disconnect) {
          controller.error(Object.assign(new Error("connection interrupted"), { code: plan.disconnect }));
        }
      },
    }, { highWaterMark: 0 }); // Interrupt on the read after the previous chunk was durably written.
    return new Response(body, { status: plan.status ?? 200, headers: plan.headers ?? headers });
  });
  return sent;
}

async function directory(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "content-network-download-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("content-network-download-")) throw new Error("unexpected test directory");
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

async function saved(root: string, asset: ContentAsset, bytes = full) {
  assert.equal(asset.status, "saved", asset.reason);
  assert.equal(asset.bytes, bytes.length);
  assert.equal(asset.sha256, digest(bytes));
  assert.deepEqual(await fs.readFile(path.join(root, asset.path!)), bytes);
  assert.equal(await fs.stat(path.join(root, `${asset.path}.part`)).then(() => true, () => false), false);
}

test("download: verified complete files are reused without an HTTP request", async t => {
  const root = await directory(t); await fs.mkdir(path.join(root, "video")); await fs.writeFile(path.join(root, "video/001.mp4"), full);
  const trusted: ContentAsset = { id: "video/001", role: "video", path: "video/001.mp4", status: "saved", sourceUrl: source, bytes: full.length, sha256: digest(full), mime: "video/mp4", provenance: "original" };
  const sent = transport(t, [{ status: 403 }]);
  const asset = await savePublicAsset(source, root, "video/001", "video", undefined, 32, trusted);
  await saved(root, asset); assert.equal(sent.length, 0);
});

test("download: a changed file cannot reuse the old verified digest", async t => {
  const root = await directory(t); await fs.mkdir(path.join(root, "video")); await fs.writeFile(path.join(root, "video/001.mp4"), "badbytes");
  const trusted: ContentAsset = { id: "video/001", role: "video", path: "video/001.mp4", status: "saved", sourceUrl: source, bytes: full.length, sha256: digest(full) };
  const sent = transport(t, [{ bytes: full }]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video", undefined, 32, trusted)); assert.equal(sent.length, 1);
});

test("download: an official playback redirect preserves the final MOV extension and original bytes", async t => {
  const root = await directory(t);
  transport(t, [{ status: 302, headers: { location: "https://cdn.example.com/photo.mov" }, bytes: new Uint8Array() }, { bytes: full, headers: { "content-type": "application/octet-stream", "content-length": "8" } }]);
  const asset = await savePublicAsset("https://example.com/media/play?livephoto=photo", root, "video/live-photo", "video");
  await saved(root, asset); assert.equal(asset.path, "video/live-photo.mov");
});

test("download: QuickTime MIME preserves MOV even when the public URL has no file suffix", async t => {
  const root = await directory(t); transport(t, [{ bytes: full, headers: { "content-type": "video/quicktime", "content-length": "8" } }]);
  const asset = await savePublicAsset("https://example.com/media/play", root, "video/live-photo", "video");
  await saved(root, asset); assert.equal(asset.path, "video/live-photo.mov");
});

test("download: a two-frame GIF keeps both image descriptors and exactly the original bytes", async t => {
  const root = await directory(t);
  const gif = Buffer.from("47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b", "hex");
  transport(t, [{ bytes: gif, headers: { "content-type": "image/gif", "content-length": String(gif.length) } }]);
  const asset = await savePublicAsset("https://example.com/image", root, "image/animated", "image");
  await saved(root, asset, gif); assert.equal(asset.path, "image/animated.gif");
  assert.equal((await fs.readFile(path.join(root, asset.path!))).filter(byte => byte === 0x2c).length, 2);
});

for (const disconnect of [undefined, "ECONNRESET"] as const) {
  test(`download: ${disconnect ?? "declared truncation"} resumes only the missing bytes with a strong validator`, async t => {
    const root = await directory(t);
    const sent = transport(t, [
      { bytes: full.subarray(0, 4), disconnect },
      { status: 206, headers: { ...headers, "content-length": "4", "content-range": "bytes 4-7/8" }, bytes: full.subarray(4) },
    ]);
    await saved(root, await savePublicAsset(source, root, "video/001", "video"));
    assert.equal(sent.length, 2); assert.equal(sent[1].headers.range, "bytes=4-"); assert.equal(sent[1].headers["if-range"], '"version-1"');
    assert.equal(sent[1].headers["accept-encoding"], "identity");
  });
}

for (const status of [408, 429, 500, 503]) {
  test(`download: HTTP ${status} retries the same media URL within the bounded attempt budget`, async t => {
    const root = await directory(t); const sent = transport(t, [{ status, headers: { "retry-after": "0" } }, { bytes: full }]);
    await saved(root, await savePublicAsset(source, root, "video/001", "video"));
    assert.equal(sent.length, 2); assert(sent.every(item => item.url.toString() === source));
  });
}

for (const etag of [undefined, 'W/"version-1"', "invalid-tag"]) {
  test(`download: interrupted files restart from zero when ETag is ${etag ?? "missing"}`, async t => {
    const root = await directory(t); const initial = { "content-type": "video/mp4", "content-length": "8", ...(etag ? { etag } : {}) };
    const sent = transport(t, [{ headers: initial, bytes: full.subarray(0, 4), disconnect: "ECONNRESET" }, { bytes: full }]);
    await saved(root, await savePublicAsset(source, root, "video/001", "video"));
    assert.equal(sent.length, 2); assert.equal(sent[1].headers.range, undefined);
  });
}

for (const changed of [false, true]) {
  test(`download: a full 200 response to Range safely restarts ${changed ? "a changed resource" : "a server without Range"}`, async t => {
    const root = await directory(t); const replacement = changed ? Buffer.from("new-version!") : full;
    const sent = transport(t, [{ bytes: full.subarray(0, 4), disconnect: "ECONNRESET" }, { headers: { ...headers, etag: changed ? '"version-2"' : headers.etag, "content-length": String(replacement.length) }, bytes: replacement }]);
    await saved(root, await savePublicAsset(source, root, "video/001", "video"), replacement);
    assert.equal(sent.length, 2); assert.equal(sent[1].headers.range, "bytes=4-");
  });
}

for (const invalid of [
  { "content-range": "bytes 3-7/8", "content-length": "5" },
  { "content-range": "bytes 4-8/9", "content-length": "5" },
  { "content-range": "bytes 4-7/8", "content-length": "4", etag: '"version-2"' },
]) {
  test(`download: inconsistent resumed metadata discards the partial copy before a fresh GET (${JSON.stringify(invalid)})`, async t => {
    const root = await directory(t);
    const sent = transport(t, [{ bytes: full.subarray(0, 4), disconnect: "ECONNRESET" }, { status: 206, headers: { ...headers, ...invalid }, bytes: Buffer.from("XXXXX") }, { bytes: full }]);
    await saved(root, await savePublicAsset(source, root, "video/001", "video"));
    assert.equal(sent.length, 3); assert.equal(sent[2].headers.range, undefined); assert.equal(sent[2].headers["if-range"], undefined);
  });
}

test("download: repeated truncation exhausts three attempts, removes partial bytes and preserves the old file", async t => {
  const root = await directory(t); await fs.mkdir(path.join(root, "video")); await fs.writeFile(path.join(root, "video/001.mp4"), "previous-good-file");
  const sent = transport(t, [{ headers: { "content-type": "video/mp4", "content-length": "8" }, bytes: full.subarray(0, 4) }]);
  const asset = await savePublicAsset(source, root, "video/001", "video");
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /不完整/); assert.equal(sent.length, 3);
  assert.equal(await fs.readFile(path.join(root, "video/001.mp4"), "utf8"), "previous-good-file");
  assert.deepEqual(await fs.readdir(path.join(root, "video")), ["001.mp4"]);
});

for (const status of [401, 403, 404]) {
  test(`download: deterministic HTTP ${status} is never retried`, async t => {
    const root = await directory(t); const sent = transport(t, [{ status }]);
    const asset = await savePublicAsset(source, root, "video/001", "video");
    assert.equal(asset.status, "failed"); assert.equal(asset.reason, `HTTP ${status}`); assert.equal(sent.length, 1);
  });
}

test("download: declared and streamed size overflow never retry or replace the target", async t => {
  const root = await directory(t); const sent = transport(t, [{ bytes: full }]);
  const declared = await savePublicAsset(source, root, "video/001", "video", undefined, 4);
  assert.equal(declared.status, "failed"); assert.match(declared.reason ?? "", /上限/); assert.equal(sent.length, 1);
  t.mock.restoreAll(); const streamed = transport(t, [{ headers: { "content-type": "video/mp4" }, bytes: full }]);
  const asset = await savePublicAsset(source, root, "video/002", "video", undefined, 4);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /上限/); assert.equal(streamed.length, 1);
});

test("download: user cancellation during backoff prevents further requests", async t => {
  const root = await directory(t); const sent = transport(t, [{ status: 503 }]); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50); t.after(() => clearTimeout(timer));
  const asset = await savePublicAsset(source, root, "video/001", "video", controller.signal);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /取消/); assert.equal(sent.length, 1);
});

test("download: an already cancelled caller cannot reuse or download a file", async t => {
  const root = await directory(t); const sent = transport(t, [{ bytes: full }]); const controller = new AbortController(); controller.abort();
  const asset = await savePublicAsset(source, root, "video/001", "video", controller.signal);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /取消/); assert.equal(sent.length, 0);
});

test("download: private and credentialed targets are rejected without HTTP retries", async t => {
  const root = await directory(t); const sent = transport(t, [{ bytes: full }]);
  for (const url of ["https://127.0.0.1/movie.mp4", "https://user:password@example.com/movie.mp4"]) {
    const asset = await savePublicAsset(url, root, "video/001", "video"); assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /私网|账号/);
  }
  assert.equal(sent.length, 0);
});

test("download: an unowned .part file is discarded rather than resumed across separate calls", async t => {
  const root = await directory(t); await fs.mkdir(path.join(root, "video")); await fs.writeFile(path.join(root, "video/001.mp4.part"), "untrusted-partial");
  const sent = transport(t, [{ bytes: full }]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video")); assert.equal(sent.length, 1); assert.equal(sent[0].headers.range, undefined);
});

test("download: media retries do not cause parser POST requests to retry or follow redirects", async t => {
  const sent = transport(t, [{ status: 503 }]);
  const response = await fetchPublic("https://example.com/parser", { method: "POST", redirect: "error", body: JSON.stringify({ url: source }) });
  assert.equal(response.status, 503); await response.body?.cancel(); assert.equal(sent.length, 1);
});

test("download: a transient connection failure before headers retries without a Range request", async t => {
  const root = await directory(t); const sent = transport(t, [{ errorCode: "ECONNRESET" }, { bytes: full }]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video"));
  assert.equal(sent.length, 2); assert.equal(sent[1].headers.range, undefined);
});

test("download: certificate validation failures never retry", async t => {
  const root = await directory(t); const sent = transport(t, [{ errorCode: "CERT_HAS_EXPIRED" }]);
  const asset = await savePublicAsset(source, root, "video/001", "video");
  assert.equal(asset.status, "failed"); assert.equal(sent.length, 1);
});

test("download: full and resumed length headers must be valid safe integers", async t => {
  const root = await directory(t);
  for (const length of ["-1", "garbage", "9007199254740993"]) {
    t.mock.restoreAll(); const sent = transport(t, [{ headers: { ...headers, "content-length": length } }]);
    const asset = await savePublicAsset(source, root, "video/001", "video");
    assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /长度无效/); assert.equal(sent.length, 1);
  }
});

test("download: Range total enforces the budget even when Content-Length is missing", async t => {
  const root = await directory(t); const sent = transport(t, [{ status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-7/8" } }]);
  const asset = await savePublicAsset(source, root, "video/001", "video", undefined, 4);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /上限/); assert.equal(sent.length, 1);
});

test("download: Range rejection starts from zero and cannot mark a partial file saved", async t => {
  const root = await directory(t);
  const sent = transport(t, [{ bytes: full.subarray(0, 4), disconnect: "ECONNRESET" }, { status: 416 }, { bytes: full }]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video"));
  assert.equal(sent.length, 3); assert.equal(sent[2].headers.range, undefined);
});

test("download: a complete response without a trusted total restarts after interruption", async t => {
  const root = await directory(t);
  const sent = transport(t, [{ headers: { "content-type": "video/mp4", etag: headers.etag }, bytes: full.subarray(0, 4), disconnect: "ECONNRESET" }, { bytes: full }]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video")); assert.equal(sent[1].headers.range, undefined);
});

test("download: the acquisition deadline also interrupts a body that stops sending bytes", async t => {
  const root = await directory(t); const sent = transport(t, [{ bytes: full.subarray(0, 4), keepOpen: true }]);
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    if (delay !== 5 * 60000) return originalTimeout(delay);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 40);
    t.after(() => clearTimeout(timer)); return controller.signal;
  });
  const started = Date.now(); const asset = await savePublicAsset(source, root, "video/001", "video");
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /超时/); assert.equal(sent.length, 1); assert(Date.now() - started < 1500);
  assert.deepEqual(await fs.readdir(path.join(root, "video")), []);
});

test("download: user cancellation while waiting for body bytes removes the partial file", async t => {
  const root = await directory(t); const sent = transport(t, [{ bytes: full.subarray(0, 4), keepOpen: true }]); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40); t.after(() => clearTimeout(timer));
  const asset = await savePublicAsset(source, root, "video/001", "video", controller.signal);
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /取消/); assert.equal(sent.length, 1);
  assert.deepEqual(await fs.readdir(path.join(root, "video")), []);
});

test("download: retries recheck DNS and reject a host that becomes private", async t => {
  const root = await directory(t); const sent = transport(t, [{ status: 503 }, { bytes: full }]);
  let lookups = 0; t.mock.method(dns, "lookup", async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]);
  const asset = await savePublicAsset(source, root, "video/001", "video");
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /私网/); assert.equal(sent.length, 1);
});

test("download: a changed redirect target cannot be combined with the previous partial bytes", async t => {
  const root = await directory(t);
  const sent = transport(t, [
    { status: 302, headers: { location: "https://cdn.example.com/old.mp4" } },
    { bytes: full.subarray(0, 4), disconnect: "ECONNRESET" },
    { status: 302, headers: { location: "https://cdn.example.com/new.mp4" } },
    { status: 206, headers: { ...headers, "content-length": "4", "content-range": "bytes 4-7/8" }, bytes: Buffer.from("XXXX") },
    { bytes: full },
  ]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video"));
  assert.equal(sent.length, 5); assert.equal(sent[4].headers.range, undefined);
});

test("download: short filesystem writes still produce every byte and the verified digest", async t => {
  const root = await directory(t); transport(t, [{ bytes: full }]); const open = fs.open.bind(fs); let writes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args); const write = handle.write.bind(handle);
    t.mock.method(handle, "write", async (buffer: Uint8Array, offset: number, length: number, position: number) => {
      writes++; return write(buffer, offset, Math.max(1, Math.floor(length / 2)), position);
    });
    return handle;
  });
  await saved(root, await savePublicAsset(source, root, "video/001", "video")); assert(writes > 1);
});

test("download: a symbolic parent cannot redirect an asset write outside its directory", async t => {
  const root = await directory(t); const outside = await directory(t);
  await fs.symlink(outside, path.join(root, "video"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(outside, "001.mp4"), "outside-original");
  const sent = transport(t, [{ bytes: full }]);
  const asset = await savePublicAsset(source, root, "video/001", "video");
  assert.equal(asset.status, "failed"); assert.match(asset.reason ?? "", /符号链接/); assert.equal(sent.length, 1);
  assert.equal(await fs.readFile(path.join(outside, "001.mp4"), "utf8"), "outside-original");
});

test("download: two interruptions retain exactly the verified byte offset for the final Range", async t => {
  const root = await directory(t);
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return open(...args);
  });
  const sent = transport(t, [
    { bytes: full.subarray(0, 4), disconnect: "ECONNRESET" },
    { status: 206, headers: { ...headers, "content-length": "4", "content-range": "bytes 4-7/8" }, bytes: full.subarray(4, 6), disconnect: "ECONNRESET" },
    { status: 206, headers: { ...headers, "content-length": "2", "content-range": "bytes 6-7/8" }, bytes: full.subarray(6) },
  ]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video"));
  assert.equal(sent.length, 3); assert.equal(sent[1].headers.range, "bytes=4-"); assert.equal(sent[2].headers.range, "bytes=6-");
});

test("download: a compressed 206 is discarded before a fresh request rather than appended", async t => {
  const root = await directory(t);
  const sent = transport(t, [
    { bytes: full.subarray(0, 4), disconnect: "ECONNRESET" },
    { status: 206, headers: { ...headers, "content-length": "4", "content-range": "bytes 4-7/8", "content-encoding": "gzip" }, bytes: Buffer.from("xxxx") },
    { bytes: full },
  ]);
  await saved(root, await savePublicAsset(source, root, "video/001", "video")); assert.equal(sent.length, 3); assert.equal(sent[2].headers.range, undefined);
});

test("download: a changed source URL cannot reuse an otherwise verified local file", async t => {
  const root = await directory(t); await fs.mkdir(path.join(root, "video")); await fs.writeFile(path.join(root, "video/001.mp4"), full);
  const trusted: ContentAsset = { id: "video/001", role: "video", path: "video/001.mp4", status: "saved", sourceUrl: `${source}?old=1`, bytes: full.length, sha256: digest(full) };
  const sent = transport(t, [{ status: 403 }]);
  const asset = await savePublicAsset(source, root, "video/001", "video", undefined, 32, trusted);
  assert.equal(asset.status, "failed"); assert.equal(sent.length, 1); assert.deepEqual(await fs.readFile(path.join(root, "video/001.mp4")), full);
});

test("download: crossing origins strips request credentials on every redirect", async t => {
  const sent = transport(t, [{ status: 302, headers: { location: "https://cdn.example.com/movie.mp4" } }, { bytes: full }]);
  const response = await fetchPublic(source, { headers: { authorization: "Bearer test-only", cookie: "test-only=value", "proxy-authorization": "test-only", accept: "video/mp4" } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), full); assert.equal(sent.length, 2);
  for (const key of ["authorization", "cookie", "proxy-authorization"]) assert.equal(sent[1].headers[key], undefined);
  assert.equal(sent[1].headers.accept, "video/mp4");
});

test("download: a temporary DNS failure is retried before any media request", async t => {
  const root = await directory(t); const sent = transport(t, [{ bytes: full }]); let lookups = 0;
  t.mock.method(dns, "lookup", async () => {
    if (++lookups === 1) throw Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
    return [{ address: "93.184.216.34", family: 4 }];
  });
  await saved(root, await savePublicAsset(source, root, "video/001", "video"));
  assert.equal(lookups, 2); assert.equal(sent.length, 1);
});

test("download: an internal DNS deadline is retryable while the caller remains active", async t => {
  const root = await directory(t); const sent = transport(t, [{ bytes: full }]); let lookups = 0;
  t.mock.method(dns, "lookup", async () => {
    if (++lookups === 1) throw new DOMException("DNS deadline", "TimeoutError");
    return [{ address: "93.184.216.34", family: 4 }];
  });
  await saved(root, await savePublicAsset(source, root, "video/001", "video"));
  assert.equal(lookups, 2); assert.equal(sent.length, 1);
});
