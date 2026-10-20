import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {chromium} from "playwright-core";
import {resolveEdgeExecutable} from "../src/url-policy.js";
import {listManifests,findContent,readContent,containedFile,fileHash} from "../src/content-library.js";
import {exportContentZip,extractContentZip} from "../src/content-organization.js";
const project=path.resolve(process.argv[2]),root=path.join(project,"资料库"),output=path.join(project,"程序文件","logs","storage-acceptance");await fs.mkdir(output,{recursive:true});
const manifests=await listManifests(root),items=await findContent(root);let assets=0,pdfs=0,localImages=0;const failures:string[]=[],external:string[]=[];
for(const {directory,manifest:m} of manifests){if(!(await readContent(root,m.contentId)).ok)failures.push(`read:${m.contentId}`);for(const asset of m.assets)if(asset.status==="saved"&&asset.path){const file=await containedFile(directory,asset.path);if((await fs.stat(file)).size!==asset.bytes||await fileHash(file)!==asset.sha256)failures.push(`hash:${m.contentId}:${asset.id}`);assets++;}for(const item of items.filter(i=>i.contentId===m.contentId&&i.pdfPath)){const bytes=await fs.readFile(item.pdfPath!);if(bytes.subarray(0,5).toString()!=="%PDF-")failures.push(`pdf:${m.contentId}`);pdfs++;}}
const browser=await chromium.launch({executablePath:resolveEdgeExecutable(),headless:true});
try{const page=await browser.newPage();await page.route(/^https?:\/\//,async route=>{external.push(route.request().url().split("?")[0]);await route.abort();});
async function inspect(file:string){await page.goto(pathToFileURL(file).href,{waitUntil:"load"});await page.evaluate(()=>document.querySelectorAll("img").forEach(i=>i.loading="eager"));await page.waitForFunction(()=>Array.from(document.querySelectorAll("img")).every(i=>i.complete),{},{timeout:10000});const images=await page.locator("img").evaluateAll(nodes=>nodes.map(i=>({src:(i as HTMLImageElement).src,good:(i as HTMLImageElement).naturalWidth>0})));localImages+=images.filter(i=>i.good).length;for(const image of images)if(!image.good)failures.push(`image:${image.src}`);}
for(const item of items)await inspect(item.readingPath);
const sample=items.find(i=>i.platform==="wechat"&&i.kind==="article")??items.find(i=>i.kind==="article")??items[0];if(!sample)throw new Error("资料库没有可核验条目");await inspect(sample.readingPath);await page.screenshot({path:path.join(output,"整理后阅读页.png"),fullPage:false});
const zip=await exportContentZip(root,sample.contentId),extracted=path.join(output,"ZIP解压核验");await extractContentZip(zip,extracted);await inspect(path.join(extracted,"阅读.html"));const exported=JSON.parse(await fs.readFile(path.join(extracted,"content.json"),"utf8"));for(const a of exported.assets)if(a.status==="saved"&&a.path)await containedFile(extracted,a.path);
const exportsRoot=await fs.realpath(path.join(root,"exports"));if(path.dirname(await fs.realpath(zip.path))!==exportsRoot)throw new Error("核验ZIP路径异常");await fs.unlink(zip.path);if(path.dirname(await fs.realpath(extracted))!==await fs.realpath(output))throw new Error("核验解压路径异常");await fs.rm(extracted,{recursive:true,force:true});
}catch(error){failures.push(String(error));}finally{await browser.close();}
const report={items:items.length,assetsVerified:assets,pdfsChecked:pdfs,localImagesLoaded:localImages,externalRequests:external,failures,finishedAt:new Date().toISOString()};await fs.writeFile(path.join(output,"核验报告.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));if(failures.length||external.length)process.exitCode=1;
