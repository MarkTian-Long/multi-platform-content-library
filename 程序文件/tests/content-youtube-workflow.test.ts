import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import { runLinkCli } from "../src/link-cli.js";
import { openContentLogin, persistContentLoginCookies } from "../src/content-network.js";

async function fixture(t: TestContext) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-workflow-"));
  t.after(async () => { if (path.dirname(runtimeRoot) !== os.tmpdir() || !path.basename(runtimeRoot).startsWith("youtube-workflow-")) throw new Error("fixture boundary"); await fs.rm(runtimeRoot, { recursive: true, force: true }); });
  return { root: path.join(runtimeRoot, "library"), runtimeRoot };
}

test("YouTube network choices persist across CLI calls and video-parser changes", async t => {
  const options = await fixture(t);
  assert.equal((await runLinkCli(["youtube-network"], options)).mode, "auto");
  await runLinkCli(["video-parser", "on", "https://example.com/parser", "http://127.0.0.1:7890"], options);
  const proxy = await runLinkCli(["youtube-network", "proxy", "http://127.0.0.1:7897"], options);
  assert.equal(proxy.ok, true); assert.equal(proxy.mode, "proxy"); assert.equal(proxy.proxyUrl, "http://127.0.0.1:7897/");
  await runLinkCli(["video-parser", "off"], options);
  assert.equal((await runLinkCli(["youtube-network"], options)).proxyUrl, proxy.proxyUrl);
  assert.equal((await runLinkCli(["video-parser"], options)).endpoint, "https://example.com/parser");
  assert.equal((await runLinkCli(["youtube-network", "direct"], options)).mode, "direct");
  assert.equal((await runLinkCli(["youtube-network", "auto"], options)).mode, "auto");
});

test("invalid YouTube network settings never replace an existing setting or echo credentials", async t => {
  const options = await fixture(t);
  assert.equal((await runLinkCli(["youtube-network", "proxy", "http://localhost:7897"], options)).ok, true);
  const file = path.join(options.runtimeRoot, ".content-settings.json"), before = await fs.readFile(file, "utf8");
  for (const args of [["proxy"], ["wrong"], ["direct", "http://localhost:7897"], ["proxy", "http://user:SECRET@localhost:7897"], ["proxy", "socks5://localhost:7897"], ["proxy", "http://other.example:7897"], ["proxy", "http://localhost:7897/path"]]) {
    const result = await runLinkCli(["youtube-network", ...args], options);
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /SECRET/); assert.equal(await fs.readFile(file, "utf8"), before);
  }
});

test("YouTube dedicated login uses its saved proxy and exports only YouTube cookies", async t => {
  const options = await fixture(t);
  await runLinkCli(["youtube-network", "proxy", "http://localhost:7897"], options);
  let visited = "", selectedProfile = "", launchProxy: string | undefined;
  const cookie = { domain: ".youtube.com", path: "/", secure: true, expires: -1, name: "session", value: "dedicated-only" };
  const page = { goto: async (url: string) => { visited = url; }, waitForEvent: async () => {} };
  t.mock.method(chromium, "launchPersistentContext", async (profile, launchOptions) => {
    selectedProfile = profile; launchProxy = launchOptions?.proxy?.server;
    return { pages: () => [page], cookies: async () => [cookie, { ...cookie, domain: ".google.com", value: "other-domain" }], waitForEvent: async () => {}, close: async () => {} } as unknown as Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  });
  await openContentLogin("youtube", options.runtimeRoot);
  assert.equal(visited, "https://www.youtube.com/"); assert.equal(launchProxy, "http://localhost:7897/");
  assert.equal(selectedProfile, path.join(options.runtimeRoot, ".content-profile", "youtube"));
  const cookieFile = path.join(selectedProfile, "cookies.txt");
  assert.match(await fs.readFile(cookieFile, "utf8"), /dedicated-only/); assert.doesNotMatch(await fs.readFile(cookieFile, "utf8"), /other-domain/);
  assert.equal(await persistContentLoginCookies(options.runtimeRoot, "youtube", [{ ...cookie, domain: ".youtube.com.evil.example" }, { ...cookie, expires: 1 }]), false);
  assert.match(await fs.readFile(cookieFile, "utf8"), /dedicated-only/);
});

test("YouTube network window validates and preserves settings through real hidden controls", { skip: process.platform !== "win32" }, async t => {
  const options = await fixture(t);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.resolve("tests/youtube-window-harness.ps1"), "-ProjectRoot", path.resolve(".."), "-ContentRoot", options.root], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout.trim()); assert.equal(receipt.ok, true); assert(receipt.checks >= 8);
});
