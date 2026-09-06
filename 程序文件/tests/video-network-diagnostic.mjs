import { openEdgePage } from '../dist/browser/edge.js';
import { load } from 'cheerio';
import { extractArticleVideos } from '../dist/article-videos.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const articleUrl = 'https://mp.weixin.qq.com/s/QYn2OeBXhsO2O7XLwE0lfA';
const observation = [];
const pending = new Set();
await fs.mkdir('logs', { recursive: true });
const diagnosticRoot = process.argv.includes('--cold') ? await fs.mkdtemp(path.resolve('logs', 'video-cold-diagnostic-')) : process.cwd();
const { context, page } = await openEdgePage(diagnosticRoot);
function safeUrl(value) {
  const url = new URL(value);
  return { host: url.hostname, videoId: url.searchParams.get('vid'), signedAgeSeconds: url.searchParams.has('dis_t') ? Math.round(Date.now() / 1000) - Number(url.searchParams.get('dis_t')) : undefined };
}
page.on('response', response => {
  if (new URL(response.url()).hostname !== 'mpvideo.qpic.cn') return;
  const task = (async () => {
    const req = await response.request().allHeaders();
    const res = await response.allHeaders();
    observation.push({ kind: 'browser-media', ...safeUrl(response.url()), status: response.status(), method: response.request().method(), type: res['content-type'], length: res['content-length'], contentRange: res['content-range'], serverDate: res.date,
      request: Object.fromEntries(['user-agent', 'referer', 'origin', 'range', 'accept', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].filter(k => req[k]).map(k => [k, req[k]])), cookiePresent: Boolean(req.cookie) });
  })();
  pending.add(task);
  task.finally(() => pending.delete(task));
});
try {
  const response = await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#js_content', { state: 'visible', timeout: 30000 });
  const earlyHtml = await page.content();
  const readinessSelection = await page.evaluate(() => {
    const selector = 'video, mp-video, span.video_iframe[id^="js_mp_video_container_"][vid]';
    return Array.from(document.querySelectorAll(selector.split(', ').map(s => '#js_content ' + s).join(', '))).map(element => ({ tag: element.tagName, id: element.id, parentMatch: element.parentElement?.closest(selector)?.id, readyState: (element.tagName === 'VIDEO' ? element : element.querySelector('video'))?.readyState }));
  });
  const $ = load(earlyHtml);
  const early = extractArticleVideos($, $('#js_content'), articleUrl).candidates;
  async function probe(url) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Referer: articleUrl } });
      const result = { ...safeUrl(url), status: r.status, type: r.headers.get('content-type'), length: r.headers.get('content-length') };
      await r.body?.cancel();
      return result;
    } catch (e) { return { ...safeUrl(url), error: e.name, code: e.cause?.code }; }
  }
  const earlyProbe = await Promise.all(early.map(async c => ({ index: c.index, urls: await Promise.all(c.urls.map(probe)) })));
  await page.waitForSelector('#js_content video', { timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#js_content video')].every(v => v.readyState >= 1 || v.error), undefined, { timeout: 15000 }).catch(() => {});
  const freshUrls = await page.locator('#js_content video').evaluateAll(nodes => nodes.map(v => v.currentSrc || v.src));
  const readyProbe = await Promise.all(freshUrls.map(async (u, i) => ({ index: i + 1, sameAsEarly: early[i]?.urls.includes(u), ...await probe(u) })));
  const before = await page.locator('#js_content video').evaluateAll(nodes => nodes.map((v, i) => ({ index: i + 1, readyState: v.readyState, networkState: v.networkState, duration: Number.isFinite(v.duration) ? v.duration : null, error: v.error ? { code: v.error.code, message: v.error.message } : null,
    identity: Object.fromEntries(['id', 'vid', 'data-vid', 'data-videoid', 'data-video-id'].filter(k => v.hasAttribute(k)).map(k => [k, v.getAttribute(k)])),
    containerIdentity: { id: v.closest('span.video_iframe')?.id, vid: v.closest('span.video_iframe')?.getAttribute('vid') } })));
  const playback = await page.locator('#js_content video').first().evaluate(async v => {
    v.muted = true;
    try { await v.play(); return { started: true }; }
    catch (error) { return { started: false, error: error.name }; }
  });
  if (playback.started) await page.waitForFunction(() => document.querySelector('#js_content video').currentTime > 0.25, { timeout: 10000 }).catch(() => {});
  const after = await page.locator('#js_content video').first().evaluate(v => ({ readyState: v.readyState, currentTime: v.currentTime, errorCode: v.error?.code }));
  const firstUrl = await page.locator('#js_content video').first().getAttribute('src');
  let baseline;
  if (firstUrl) {
    const direct = await fetch(firstUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Referer: articleUrl } });
    baseline = { kind: 'current-node-downloader', ...safeUrl(firstUrl), status: direct.status, type: direct.headers.get('content-type'), length: direct.headers.get('content-length'), serverDate: direct.headers.get('date') };
    await direct.body?.cancel();
  }
  await Promise.allSettled([...pending]);
  await page.close();
  const closedProbe = await Promise.all(freshUrls.map(async (u, i) => ({ index: i + 1, ...await probe(u) })));
  const report = { articleStatus: response.status(), coldProfile: process.argv.includes('--cold'), readinessSelection, earlyProbe, readyProbe, before, playback, after, observation, baseline, closedProbe };
  if (process.argv.includes('--cold')) await fs.writeFile(path.join(diagnosticRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await context.close(); }
