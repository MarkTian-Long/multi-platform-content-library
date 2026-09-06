import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
const directory=path.resolve('logs/link-bilibili-live/library/items/1badb59adb6ff613492c7394');
const output=path.resolve('logs/link-bilibili-live');
const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:820}});let externalRequests=0;
 await page.route(/^https?:\/\//,route=>{externalRequests++;return route.abort();});
 await page.goto(pathToFileURL(path.join(directory,'reading.html')).href,{waitUntil:'load'});
 const video=page.locator('video').first();await video.scrollIntoViewIfNeeded();
 const playback=await video.evaluate(async element=>{element.muted=true;try{await element.play();await new Promise(resolve=>setTimeout(resolve,1500));element.pause();return {ok:element.currentTime>0,duration:element.duration,currentTime:element.currentTime,width:element.videoWidth,height:element.videoHeight};}catch(error){return {ok:false,reason:error.message,code:element.error?.code};}});
 await video.scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'offline-video.png')});
 const result={checkedAt:new Date().toISOString(),externalRequests,playback};await fs.writeFile(path.join(output,'offline-playback.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 if(externalRequests||!playback.ok)process.exitCode=1;
}finally{await browser.close();}
