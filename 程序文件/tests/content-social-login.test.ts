import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { persistContentLoginCookies } from "../src/content-network.js";

test("social login exports only matching dedicated domains, with expired and malformed rows removed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "social-login-"));
  t.after(async () => { if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("social-login-")) await fs.rm(root, { recursive: true, force: true }); });
  const cookie = { path: "/", secure: true, expires: -1, name: "session", value: "app-profile" };
  for (const platform of ["douyin", "weibo"] as const) {
    const domain = platform === "douyin" ? ".douyin.com" : ".weibo.com";
    assert.equal(await persistContentLoginCookies(root, platform, [
      { ...cookie, domain }, { ...cookie, domain: ".example.com", value: "unrelated" },
      { ...cookie, domain: `${domain}.evil.example`, value: "spoof" },
      { ...cookie, domain, expires: 1, value: "expired" }, { ...cookie, domain, value: "injected\nvalue" },
    ]), true);
    const target = path.join(root, ".content-profile", platform, "cookies.txt");
    const text = await fs.readFile(target, "utf8"); assert.match(text, /app-profile/); assert.doesNotMatch(text, /unrelated|spoof|expired|injected/);
    assert.equal(await persistContentLoginCookies(root, platform, []), false);
    assert.equal(await fs.readFile(target, "utf8"), text);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ["cookies.txt"]);
  }
});

test("social login refuses a linked profile without modifying files beyond its runtime root", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "social-login-link-"));
  t.after(async () => { if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("social-login-link-")) await fs.rm(root, { recursive: true, force: true }); });
  const outside = path.join(root, "outside"); await fs.mkdir(outside);
  const profiles = path.join(root, ".content-profile"); await fs.mkdir(profiles);
  await fs.symlink(outside, path.join(profiles, "douyin"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(persistContentLoginCookies(root, "douyin", [{ domain: ".douyin.com", path: "/", secure: true, expires: -1, name: "session", value: "app-only" }]), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});
