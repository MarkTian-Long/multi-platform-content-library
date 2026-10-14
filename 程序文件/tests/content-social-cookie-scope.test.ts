import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promises as dns } from "node:dns";
import { acquireWeibo } from "../src/content-weibo.js";
import { acquireDouyin } from "../src/content-douyin.js";
import { parseContentLinks } from "../src/content-input.js";

async function temporary(t: { after(fn: () => Promise<void>): void }, platform: string, rows = "") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "social-cookie-scope-"));
  t.after(async () => { if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("social-cookie-scope-")) await fs.rm(root, { recursive: true, force: true }); });
  if (rows) { const profile = path.join(root, ".content-profile", platform); await fs.mkdir(profile, { recursive: true }); await fs.writeFile(path.join(profile, "cookies.txt"), `# Netscape HTTP Cookie File\n${rows}\n`); }
  return { runtimeRoot: root, directory: root };
}
const post = { mblogid: "N4xlMvjhI", idstr: "4910815147462302", text_raw: "目标正文" };
const responseAt = (value: unknown, url: string, headers?: Headers) => { const result = new Response(typeof value === "string" ? value : JSON.stringify(value), { headers }); Object.defineProperty(result, "url", { value: url }); return result; };

test("Weibo Netscape host-only cookies stay on their exact host while domain cookies can reach the visitor subdomain", async t => {
  const context = await temporary(t, "weibo", ["weibo.com\tFALSE\t/\tTRUE\t0\thostOnly\tprofile-root", ".weibo.com\tTRUE\t/\tTRUE\t0\tdomainCookie\tprofile-domain", ".weibo.com\tTRUE\t/ajax/status\tTRUE\t0\tpathPrefixOnly\twrong-path"].join("\n"));
  const calls: { host: string; path: string; cookie: string }[] = []; let first = true;
  const result = await acquireWeibo(parseContentLinks("https://m.weibo.cn/status/N4xlMvjhI")[0], context, { fetch: async (value, init) => {
    const url = new URL(value), cookie = new Headers(init?.headers).get("cookie") ?? ""; calls.push({ host: url.hostname, path: url.pathname, cookie });
    if (url.hostname === "weibo.com" && first) { first = false; return responseAt("visitor", "https://passport.weibo.com/visitor/visitor"); }
    if (url.pathname.endsWith("genvisitor")) return responseAt({ data: { tid: "test-visitor", new_tid: true, confidence: 100 } }, url.toString());
    if (url.hostname === "passport.weibo.com") return responseAt({}, url.toString());
    return responseAt(post, url.toString());
  } });
  assert.equal(result.markdown, post.text_raw);
  for (const call of calls) { assert.match(call.cookie, /domainCookie=/); assert.doesNotMatch(call.cookie, /pathPrefixOnly=/); if (call.host === "weibo.com") assert.match(call.cookie, /hostOnly=/); else assert.doesNotMatch(call.cookie, /hostOnly=/); }
  assert.equal(calls.filter(call => call.host === "passport.weibo.com").length, 2);
});

test("Weibo Set-Cookie without Domain remains host-only during later visitor initialization", async t => {
  const context = await temporary(t, "weibo"), calls: { host: string; cookie: string }[] = []; let challenge = true;
  const result = await acquireWeibo(parseContentLinks("https://m.weibo.cn/status/N4xlMvjhI")[0], context, { fetch: async (value, init) => {
    const url = new URL(value); calls.push({ host: url.hostname, cookie: new Headers(init?.headers).get("cookie") ?? "" });
    if (url.pathname.endsWith("/show")) { const headers = new Headers(); headers.append("set-cookie", "serverHostOnly=root; Path=/; Secure"); headers.append("set-cookie", "serverDomain=domain; Domain=.weibo.com; Path=/; Secure"); return responseAt({ ...post, isLongText: true }, url.toString(), headers); }
    if (url.pathname.endsWith("/longtext") && challenge) { challenge = false; return responseAt("visitor", "https://passport.weibo.com/visitor/visitor"); }
    if (url.pathname.endsWith("genvisitor")) return responseAt({ data: { tid: "test-visitor", new_tid: true } }, url.toString());
    if (url.hostname === "passport.weibo.com") return responseAt({}, url.toString());
    return responseAt({ data: { longTextContent: "取得的完整长正文" } }, url.toString());
  } });
  assert.equal(result.markdown, "取得的完整长正文");
  const visitorCalls = calls.filter(call => call.host === "passport.weibo.com"); assert.equal(visitorCalls.length, 2);
  for (const call of visitorCalls) { assert.doesNotMatch(call.cookie, /serverHostOnly=/); assert.match(call.cookie, /serverDomain=/); }
});

test("Douyin respects host-only scope and complete cookie path boundaries for the actual work URL", async t => {
  const id = "6961737553342991651", context = await temporary(t, "douyin", ["douyin.com\tFALSE\t/\tTRUE\t0\trootHostOnly\twrong-host", ".douyin.com\tTRUE\t/\tTRUE\t0\tdomainCookie\tallowed-domain", "www.douyin.com\tFALSE\t/\tTRUE\t0\twwwHostOnly\tallowed-host", `www.douyin.com\tFALSE\t/video/${id}\tTRUE\t0\tworkPath\tallowed-path`, ".douyin.com\tTRUE\t/v\tTRUE\t0\tpathPrefixOnly\twrong-path"].join("\n"));
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  let cookie = ""; t.mock.method(globalThis, "fetch", async (_value, init) => { cookie = new Headers(init?.headers).get("cookie") ?? ""; return new Response("<title>安全验证</title><p>请完成人工验证</p>"); });
  const input = parseContentLinks(`https://www.douyin.com/video/${id}`)[0]; let captures = 0;
  const result = await acquireDouyin(input, context, {
    captureBrowser: async target => { captures++; assert.equal(target.nativeId, id); return { finalUrl: input.canonicalUrl, html: "<main>请完成验证</main>", responses: [], gated: true }; },
    ytDlpPath: process.execPath,
    runTool: async () => ({ code: 1, stdout: "", stderr: "Fresh cookies needed", timedOut: false, cancelled: false, outputTruncated: false }),
  });
  assert.equal(captures, 1);
  assert.ok(result.assets.some(asset => asset.status === "login_required"));
  for (const name of ["domainCookie", "wwwHostOnly", "workPath"]) assert.match(cookie, new RegExp(`${name}=`));
  assert.doesNotMatch(cookie, /rootHostOnly=|pathPrefixOnly=/);
});

test("Weibo response cookies without Path default to the request directory rather than all site paths", async t => {
  const context = await temporary(t, "weibo"), fid = "1034:4797699866951785";
  let postCookie = "unobserved";
  const result = await acquireWeibo(parseContentLinks(`https://weibo.com/tv/show/${fid}`)[0], context, { fetch: async (value, init) => {
    const url = new URL(value);
    if (url.pathname.endsWith("/component")) return responseAt({ data: { Component_Play_Playinfo: { mid: post.idstr, oid: fid } } }, url.toString(), new Headers({ "set-cookie": "tvDirectoryOnly=component; Secure" }));
    postCookie = new Headers(init?.headers).get("cookie") ?? "";
    return responseAt({ ...post, page_info: { type: "video", object_id: fid, media_info: {} } }, url.toString());
  } });
  assert.equal(result.markdown, post.text_raw); assert.notEqual(postCookie, "unobserved"); assert.doesNotMatch(postCookie, /tvDirectoryOnly=/);
});
