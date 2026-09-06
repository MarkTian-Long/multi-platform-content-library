// Opt-in real-article verification; never run as part of the offline unit suite.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { openEdgePage } from '../dist/browser/edge.js';
import { captureRenderedPage } from '../dist/browser/capture-page.js';
import { saveArticle } from '../dist/article-library.js';
import { resolveEdgeExecutable } from '../dist/url-policy.js';

const articleUrl = 'https://mp.weixin.qq.com/s/QYn2OeBXhsO2O7XLwE0lfA';
const originalDirectory = path.resolve('..', '文章库', '2026-09-06_GPT-6最佳拍档＝字节Seedance');
await fs.mkdir('logs', { recursive: true });
const work = await fs.mkdtemp(path.resolve('logs', 'video-live-verification-'));
const requests = [];
const offlineOnly = process.argv.includes('--offline-only');
const selectedIndex = Number(process.argv.find(arg => arg.startsWith('--video='))?.slice(8)) || undefined;
let cold;
if (offlineOnly) {
  cold = { directory: originalDirectory, manifest: JSON.parse(await fs.readFile(path.join(originalDirectory, 'manifest.json'), 'utf8')) };
} else {
const { context, page } = await openEdgePage(work);
try {
  // Exact production capture lifecycle, without an added playback/wait step.
  const record = await captureRenderedPage(page, articleUrl);
  assert.equal(record.videos?.length, 8);
  cold = await saveArticle(path.join(work, 'library'), record, {
    videoFetcher: async (url, init) => {
      const r = await fetch(url, init);
      const u = new URL(url);
      requests.push({ videoId: u.searchParams.get('vid'), host: u.hostname, status: r.status,
        type: r.headers.get('content-type'), length: r.headers.get('content-length'),
        signedAgeSeconds: u.searchParams.has('dis_t') ? Math.round(Date.now() / 1000) - Number(u.searchParams.get('dis_t')) : undefined });
      return r;
    }
  });
  const coldReport = { stage: 'cold-profile-download', saved: cold.manifest.videos.filter(v => v.status === 'saved').length, requests, videos: cold.manifest.videos };
  console.log(JSON.stringify(coldReport));
  await fs.writeFile(path.join(work, 'download-report.json'), JSON.stringify(coldReport, null, 2) + '\n');
  assert.equal(coldReport.saved, 8);
} finally { await context.close(); }
}

const browser = await chromium.launch({ executablePath: resolveEdgeExecutable(), headless: true });
const offline = await browser.newContext({ offline: true });
let remoteRequests = 0;
offline.on('request', r => { if (/^https?:/.test(r.url())) remoteRequests++; });
const results = [];
try {
  const original = JSON.parse(await fs.readFile(path.join(originalDirectory, 'manifest.json'), 'utf8'));
  for (const v of original.videos) {
    if (selectedIndex && v.index !== selectedIndex) continue;
    assert.equal(v.status, 'saved');
    const file = path.resolve(originalDirectory, v.localPath);
    assert.ok(file.startsWith(originalDirectory + path.sep));
    const buffer = await fs.readFile(file);
    assert.equal(buffer.length, v.bytes);
    const freshFile = path.join(cold.directory, v.localPath);
    const freshHash = createHash('sha256').update(await fs.readFile(freshFile)).digest('hex');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const freshVideo = cold.manifest.videos.find(item => item.index === v.index);
    assert.equal(freshVideo.videoId, v.videoId);
    async function playFile(target) {
      const p = await offline.newPage();
      try {
      await p.goto(pathToFileURL(target).href);
      await p.waitForFunction(() => document.querySelector('video')?.readyState >= 2, undefined, { timeout: 10000 });
      const played = await p.locator('video').evaluate(async video => {
        video.muted = true;
        video.playbackRate = 4;
        return await new Promise(async (resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Offline playback did not finish: ' + JSON.stringify({ currentTime: video.currentTime, duration: video.duration, paused: video.paused, readyState: video.readyState, errorCode: video.error?.code, playbackRate: video.playbackRate, frames: video.getVideoPlaybackQuality().totalVideoFrames }))), 45000);
          const fail = () => { clearTimeout(timeout); reject(new Error(`Media error ${video.error?.code}`)); };
          video.addEventListener('error', fail, { once: true });
          video.addEventListener('ended', () => {
            clearTimeout(timeout);
            resolve({ ended: video.ended, duration: video.duration, currentTime: video.currentTime,
              width: video.videoWidth, height: video.videoHeight, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames });
          }, { once: true });
          try { video.currentTime = 0; await video.play(); } catch (error) { clearTimeout(timeout); reject(error); }
        });
      });
      assert.equal(played.ended, true);
      assert.ok(played.duration > 0 && played.decodedFrames > 0);
      return played;
      } finally { await p.close(); }
    }
    const played = await playFile(file);
    const freshPlayed = sha256 === freshHash ? played : await playFile(freshFile);
    assert.ok(Math.abs(played.duration - freshPlayed.duration) < 0.2, 'Normal fallback rendition must preserve the full duration');
    results.push({ index: v.index, localPath: v.localPath, bytes: buffer.length, sha256, ...played,
      coldDownload: { bytes: freshVideo.bytes, sha256: freshHash, sameBytesAsLibrary: sha256 === freshHash, ...freshPlayed } });
    console.log(JSON.stringify({ stage: 'offline-playback', ...results.at(-1) }));
  }
  assert.equal(results.length, selectedIndex ? 1 : 8);
  assert.equal(remoteRequests, 0);
  const report = { verifiedAt: new Date().toISOString(), sourceUrl: articleUrl, originalDirectory,
    coldProfile: !offlineOnly, coldCaptureUsesProductionLifecycle: !offlineOnly, requests, offline: true,
    remoteRequests, playbackRate: 4, results };
  await fs.writeFile(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(work, 'report.json'), verified: results.length,
    totalBytes: results.reduce((sum, v) => sum + v.bytes, 0), remoteRequests }));
} finally { await browser.close(); }
