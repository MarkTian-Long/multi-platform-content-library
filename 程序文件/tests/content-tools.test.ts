import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function pidIsAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

test("runs an executable with an argument array and captures bounded output", async () => {
  const tools = await import("../src/content-tools.js");
  const result = await tools.runContentTool({
    command: process.execPath,
    args: ["-e", "process.stdout.write('abcdef')"],
    maxOutputBytes: 4,
    timeoutMs: 5_000
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "abcd");
  assert.equal(result.outputTruncated, true);
});

test("reports cancellation without leaving a successful result", async () => {
  const tools = await import("../src/content-tools.js");
  const controller = new AbortController();
  const pending = tools.runContentTool({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: controller.signal,
    timeoutMs: 5_000
  });
  setTimeout(() => controller.abort(), 40);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.notEqual(result.code, 0);
});

test("cancellation terminates a Windows child-process tree", async (t) => {
  if (process.platform !== "win32") return t.skip("taskkill tree semantics are Windows-only");
  const tools = await import("../src/content-tools.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-tree-"));
  const ready = path.join(directory, "grandchild-ready.txt");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sidecar = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { sidecar.once("spawn", resolve); sidecar.once("error", reject); });
  t.after(() => { try { sidecar.kill(); } catch { /* already stopped */ } });
  // The test only aborts once the descendant has proved it is alive. Its PID, not
  // a timer marker, is the proof that taskkill traversed the owned tree.
  const grandchild = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const pending = tools.runContentTool({ command: process.execPath, args: ["-e", parent], signal: controller.signal, timeoutMs: 5_000 });
  const deadline = Date.now() + 2_000;
  while (!(await fs.stat(ready).then(() => true, () => false))) {
    assert.ok(Date.now() < deadline, "grandchild did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const grandchildPid = Number((await fs.readFile(ready, "utf8")).trim());
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, "grandchild did not report a valid PID");
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(pidIsAlive(grandchildPid), false, "owned grandchild survived cancellation");
  assert.equal(pidIsAlive(sidecar.pid), true, "cancellation terminated an unrelated process");
});

test("probes a runtime-local tool before PATH", async () => {
  const tools = await import("../src/content-tools.js");
  const root = path.join(process.cwd(), "tests", "fixtures", "no-tool-runtime");
  const availability = await tools.probeContentTools(root);
  assert.ok(availability.some((entry: { id: string }) => entry.id === "ffmpeg"));
  assert.ok(availability.some((entry: { id: string }) => entry.id === "asr"));
});
