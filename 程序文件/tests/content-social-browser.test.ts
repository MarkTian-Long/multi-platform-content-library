import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type { BrowserContext, Response as BrowserResponse } from "playwright-core";
import { captureSocialBrowser, socialBrowserJsonEndpoint } from "../src/content-social-browser.js";
import { parseContentLinks } from "../src/content-input.js";
import type { ContentContext, ContentInput } from "../src/content-types.js";

const douyin = parseContentLinks("https://www.douyin.com/video/6961737553342991651")[0];
const weibo = parseContentLinks("https://weibo.com/7827771738/N4xlMvjhI")[0];
async function context(t: TestContext): Promise<ContentContext> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "social-edge-"));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^social-edge-/); await fs.rm(directory, { recursive: true, force: true }); });
  return { runtimeRoot: directory, directory };
}
function fakeBrowser(input: ContentInput, options: { gated?: boolean; responses?: BrowserResponse[]; html?: string; goto?: () => Promise<void>; closeError?: boolean; evaluateFetch?: boolean; navigationOnce?: boolean; checkWait?: (predicate: () => unknown) => void } = {}) {
  let current = input.url, closed = 0, launched = 0, launchProfile = "", launchOptions: Record<string, unknown> = {}, listener: ((response: BrowserResponse) => void) | undefined;
  let routeHandler: ((route: unknown) => Promise<void>) | undefined;
  const page = {
    on: (_event: string, callback: typeof listener) => { listener = callback; },
    off: () => { listener = undefined; },
    goto: async (url: string) => { current = url; for (const response of options.responses ?? []) listener?.(response); await options.goto?.(); },
    waitForFunction: async (predicate: () => unknown) => { options.checkWait?.(predicate); },
    evaluate: async (fn: (argument: unknown) => unknown, argument?: unknown) => { if (argument !== undefined && options.navigationOnce) { options.navigationOnce = false; throw new Error("Execution context was destroyed, most likely because of a navigation"); } return argument === undefined ? options.gated ?? false : options.evaluateFetch ? fn(argument) : undefined; },
    waitForLoadState: async () => {},
    content: async () => options.html ?? "<main>精确目标页面</main>",
    url: () => current,
  };
  const browser = { route: async (_pattern: string, callback: typeof routeHandler) => { routeHandler = callback; }, newPage: async () => page, close: async () => { closed++; if (options.closeError) throw new Error("cleanup failed with private URL"); } };
  return {
    deps: { launch: (async (profile: string, config: Record<string, unknown>) => { launched++; launchProfile = profile; launchOptions = config; return browser as unknown as BrowserContext; }) as never, executable: () => "C:\\test\\msedge.exe", validateUrl: async (value: string | URL) => new URL(value) },
    stats: () => ({ closed, launched, launchProfile, launchOptions, listener, current }),
    route: async (url: string) => { let allowed = false; await routeHandler?.({ request: () => ({ url: () => url }), continue: async () => { allowed = true; }, abort: async () => {} }); return allowed; },
  };
}
function response(url: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }, onBody?: () => void): BrowserResponse {
  return { url: () => url, status: () => 200, allHeaders: async () => headers, body: async () => { onBody?.(); return Buffer.from(body); } } as unknown as BrowserResponse;
}

test("social Edge API allowlist excludes credentials, foreign sites and mutation endpoints", () => {
  assert.equal(socialBrowserJsonEndpoint("douyin", "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=6961737553342991651"), true);
  assert.equal(socialBrowserJsonEndpoint("weibo", "https://m.weibo.cn/api/statuses/show?id=4910815147462302"), true);
  for (const value of ["http://weibo.com/ajax/statuses/show", "https://user:pass@weibo.com/ajax/statuses/show", "https://weibo.com.evil.test/ajax/statuses/show", "https://weibo.com/ajax/statuses/update", "https://127.0.0.1/ajax/statuses/show"]) assert.equal(socialBrowserJsonEndpoint("weibo", value), false);
});

for (const input of [douyin, weibo]) test(`${input.platform} Edge captures use only their own profile and preserve the target page`, async t => {
  const current = await context(t), fake = fakeBrowser(input, { closeError: true });
  const snapshot = await captureSocialBrowser(input, current, [], fake.deps);
  assert.equal(fake.stats().launchProfile, path.join(current.runtimeRoot, ".content-profile", input.platform));
  assert.equal(fake.stats().launchOptions.headless, true); assert.equal(fake.stats().launchOptions.serviceWorkers, "block");
  assert.equal(snapshot.finalUrl, input.url); assert.equal(snapshot.gated, false); assert.equal(fake.stats().closed, 1);
  assert.equal(fake.stats().listener, undefined);
});

test("rendered network collection retains only bounded official JSON in memory", async t => {
  const current = await context(t); let oversizedRead = false;
  const api = "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=6961737553342991651";
  const fake = fakeBrowser(douyin, { responses: [response(api, '{"aweme_detail":{"aweme_id":"6961737553342991651"}}'), response("https://example.com/private", '{"token":"private"}'), response(api, "x", { "content-type": "application/json", "content-length": String(3 * 1024 * 1024) }, () => { oversizedRead = true; }), response(api, "not JSON")] });
  const snapshot = await captureSocialBrowser(douyin, current, [], fake.deps);
  assert.equal(snapshot.responses.length, 1); assert.equal(oversizedRead, false);
  assert.deepEqual(await fs.readdir(path.join(current.runtimeRoot, ".content-profile", "douyin")), []);
});

test("browser same-site read uses bounded fetch without exporting Cookie headers", async t => {
  const current = await context(t), fake = fakeBrowser(weibo, { evaluateFetch: true }); let request: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { request = init; return new Response('{"data":{"idstr":"4910815147462302"}}'); });
  const api = "https://weibo.com/ajax/statuses/show?id=N4xlMvjhI";
  const snapshot = await captureSocialBrowser(weibo, current, [{ url: api, headers: { Accept: "application/json" } }], fake.deps);
  assert.equal(request?.credentials, "include"); assert.equal(request?.redirect, "error");
  assert.equal(new Headers(request?.headers).has("Cookie"), false); assert.equal(snapshot.responses.length, 1);
});

test("browser fetch cancels oversized streaming JSON", async t => {
  const current = await context(t), fake = fakeBrowser(weibo, { evaluateFetch: true }); let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } })));
  const snapshot = await captureSocialBrowser(weibo, current, [{ url: "https://weibo.com/ajax/statuses/show?id=N4xlMvjhI" }], fake.deps);
  assert.equal(snapshot.responses.length, 0); assert.equal(cancelled, true);
});

test("normal visitor-page navigation retries a read without discarding valid observed data", async t => {
  const current = await context(t), api = "https://weibo.com/ajax/statuses/show?id=N4xlMvjhI";
  const fake = fakeBrowser(weibo, { navigationOnce: true, evaluateFetch: true, responses: [response(api, '{"mblogid":"N4xlMvjhI"}')] });
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => { reads++; return new Response('{"mblogid":"N4xlMvjhI"}'); });
  const snapshot = await captureSocialBrowser(weibo, current, [{ url: api }], fake.deps);
  assert.equal(snapshot.responses.length, 2); assert.equal(reads, 1); assert.equal(fake.stats().closed, 1);
});

test("an intermediary Weibo visitor bootstrap is allowed to finish before reading the target", async t => {
  const current = await context(t); let checked = false;
  const fake = fakeBrowser(weibo, { checkWait: predicate => {
    const ready = runInNewContext(`(${predicate.toString()})()`, { location: { hostname: "visitor.passport.weibo.cn", pathname: "/visitor/visitor" }, document: { querySelectorAll: () => [] } });
    assert.equal(ready, false); checked = true;
  } });
  await captureSocialBrowser(weibo, current, [], fake.deps); assert.equal(checked, true);
});

test("invalid identity and request headers stop before launching Edge", async t => {
  const current = await context(t), fake = fakeBrowser(douyin);
  await assert.rejects(captureSocialBrowser({ ...douyin, nativeId: "6961737553342991652" }, current, [], fake.deps), /身份/);
  await assert.rejects(captureSocialBrowser(douyin, current, [{ url: "https://www.douyin.com/aweme/v1/web/aweme/detail/", headers: { Cookie: "secret" } }], fake.deps), /官方读取/);
  await assert.rejects(captureSocialBrowser(douyin, current, [{ url: "https://www.douyin.com/aweme/v1/web/aweme/detail/", method: "POST", body: "mutation" }], fake.deps), /官方读取/);
  assert.equal(fake.stats().launched, 0);
});

test("gated pages report the gate while retaining independently validated candidate data", async t => {
  const current = await context(t), fake = fakeBrowser(weibo, { gated: true });
  const snapshot = await captureSocialBrowser(weibo, current, [], fake.deps);
  assert.equal(snapshot.gated, true); assert.equal(snapshot.html, "<main>精确目标页面</main>");
});

test("cancellation closes Edge and releases the profile for a later retry", async t => {
  const current = await context(t), controller = new AbortController(), fake = fakeBrowser(douyin, { goto: async () => { controller.abort(new DOMException("cancelled", "AbortError")); throw controller.signal.reason; } });
  await assert.rejects(captureSocialBrowser(douyin, { ...current, signal: controller.signal }, [], fake.deps), error => (error as Error).name === "AbortError");
  assert.ok(fake.stats().closed >= 1);
  const retry = fakeBrowser(douyin); await captureSocialBrowser(douyin, current, [], retry.deps); assert.equal(retry.stats().closed, 1);
});

test("concurrent captures of one persistent profile fail clearly without killing the first window", async t => {
  const current = await context(t); let release: (() => void) | undefined, started: (() => void) | undefined;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const first = fakeBrowser(douyin, { goto: async () => { started?.(); await gate; } }), second = fakeBrowser(douyin);
  const pending = captureSocialBrowser(douyin, current, [], first.deps); await began;
  await assert.rejects(captureSocialBrowser(douyin, current, [], second.deps), /正在进行/);
  assert.equal(first.stats().closed, 0); assert.equal(second.stats().launched, 0); release?.(); await pending;
});

test("missing Edge is reported separately and releases the profile", async t => {
  const current = await context(t), fake = fakeBrowser(douyin);
  await assert.rejects(captureSocialBrowser(douyin, current, [], { ...fake.deps, executable: () => { throw new Error("missing binary"); } }), error => (error as { status?: string }).status === "missing_dependency");
  await captureSocialBrowser(douyin, current, [], fake.deps); assert.equal(fake.stats().launched, 1);
});
