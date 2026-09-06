import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {contentRoot,runtimeDirectory} from '../dist/content-service.js';
import {migrateReadableLibrary} from '../dist/content-migration.js';
import {listManifests,containedFile,fileHash,findContent,readContent} from '../dist/content-library.js';
import {resolveEdgeExecutable,isPathWithin} from '../dist/url-policy.js';

const root=contentRoot(),runtime=runtimeDirectory(),logs=path.join(runtime,'logs','readable-names-acceptance');
await fs.mkdir(logs,{recursive:true});
const before=await listManifests(root),original=new Map();
for(const {directory,manifest} of before)for(const asset of manifest.assets)if(asset.status==='saved'&&asset.path&&asset.role!=='pdf'){
 original.set(`${manifest.contentId}:${asset.id}`,await fileHash(await containedFile(directory,asset.path)));
}
const queueBefore=await fs.readFile(path.join(root,'queue.json')).catch(()=>undefined);
const migration=await migrateReadableLibrary(root);assert.equal(migration.failed.length,0,JSON.stringify(migration.failed));
const after=await listManifests(root);assert.equal(after.length,before.length);
const browser=await chromium.launch({executablePath:resolveEdgeExecutable(),headless:true});const checks=[];
try{
 for(const {directory,manifest} of after){
   assert.match(path.basename(directory),new RegExp(manifest.platform==='bilibili'?'B站':'微信|网页|小红书'));
   assert.equal(manifest.namingVersion,1);
   const assets=[];
   for(const asset of manifest.assets)if(asset.status==='saved'&&asset.path){
     const file=await containedFile(directory,asset.path),hash=await fileHash(file);
     if(original.has(`${manifest.contentId}:${asset.id}`))assert.equal(hash,original.get(`${manifest.contentId}:${asset.id}`));
     assets.push({role:asset.role,path:asset.path,bytes:(await fs.stat(file)).size});
   }
   const read=await readContent(root,manifest.contentId);assert.equal(read.ok,true);assert.equal((await findContent(root,manifest.title)).some(x=>x.contentId===manifest.contentId),true);
   const page=await browser.newPage({viewport:{width:1200,height:850}}),requests=[];
   await page.route(/^https?:\/\//,route=>{requests.push(route.request().url());return route.abort();});
   await page.goto(pathToFileURL(await containedFile(directory,manifest.readingFile)).href,{waitUntil:'load'});
   await page.evaluate(()=>document.querySelectorAll('img').forEach(img=>img.loading='eager'));
   await page.waitForFunction(()=>Array.from(document.images).every(img=>img.complete&&img.naturalWidth>0));
   const localLinks=await page.locator('[src],a[href]').evaluateAll(elements=>elements.map(el=>el.src||el.href).filter(url=>url?.startsWith('file:')));
   for(const url of localLinks){const filename=fileURLToPath(url);assert.ok(isPathWithin(directory,filename));assert.ok((await fs.stat(filename)).isFile());}
   let videoPlayed=false;
   if(await page.locator('video').count()){
     await page.locator('video').first().evaluate(async video=>{video.muted=true;await video.play();});
     await page.waitForFunction(()=>document.querySelector('video').currentTime>0,{},{timeout:15000});
     await page.locator('video').first().evaluate(video=>video.pause());videoPlayed=true;
   }
   assert.equal(requests.length,0);await page.screenshot({path:path.join(logs,`${manifest.contentId}.png`)});
   checks.push({contentId:manifest.contentId,title:manifest.title,directory,assets,localLinks:localLinks.length,videoPlayed,remoteRequests:requests.length});await page.close();
 }
}finally{await browser.close();}
if(queueBefore)assert.deepEqual(await fs.readFile(path.join(root,'queue.json')),queueBefore);
const second=await migrateReadableLibrary(root);assert.equal(second.migrated,0);assert.equal(second.failed.length,0);
const report={ok:true,migration,checks,queueUnchanged:true,secondRunNoOp:true,timestamp:new Date().toISOString()};
await fs.writeFile(path.join(logs,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({ok:true,migrated:migration.migrated,items:checks.map(item=>({title:item.title,directory:item.directory,assets:item.assets.length,videoPlayed:item.videoPlayed,remoteRequests:item.remoteRequests})),report:path.join(logs,'report.json')}));
