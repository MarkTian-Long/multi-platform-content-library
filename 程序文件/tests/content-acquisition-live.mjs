import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseContentLinks, resolveContentInput } from "../src/content-input.js";
import { acquireContent } from "../src/content-acquisition.js";

const supplied = process.argv[2] ?? "https://example.com/";
const inputs = parseContentLinks(supplied);
if (inputs.length !== 1) throw new Error("请只传入一个公开 HTTP(S) 链接");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-acquisition-live-"));
const runtimeRoot = process.env.CONTENT_RUNTIME_ROOT ? path.resolve(process.env.CONTENT_RUNTIME_ROOT) : directory;
try {
  const input = await resolveContentInput(inputs[0]);
  const captured = await acquireContent(input, { runtimeRoot, directory, onProgress: (message) => console.log(message) });
  console.log(JSON.stringify({ platform: captured.platform, canonicalUrl: captured.canonicalUrl, title: captured.title, kind: captured.kind, assets: captured.assets.map(({ role, status, path, reason }) => ({ role, status, path, reason })), coverage: captured.coverage, warnings: captured.warnings }, null, 2));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
