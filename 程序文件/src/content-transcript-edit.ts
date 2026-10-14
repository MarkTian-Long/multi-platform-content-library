import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, atomicReplace, containedFile, contentDirectory, fileHash, publicValue, saveContent, writableFile } from "./content-library.js";
import { withContentMaintenance } from "./content-jobs.js";
import type { ContentAsset, ContentManifest } from "./content-types.js";

const MAX_TEXT = 2 * 1024 * 1024;
function validateText(text: unknown): asserts text is string {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text,"utf8") > MAX_TEXT || /[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error("校订稿需为非空文字，最大 2 MiB，不接受二进制控制字节");
}
async function manifestAt(root:string,id:string):Promise<{directory:string;manifest:ContentManifest}> {
  const directory=await contentDirectory(root,id),file=await containedFile(directory,"content.json");
  if((await fs.stat(file)).size>8*1024*1024)throw new Error("资料清单过大");
  const manifest=JSON.parse(await fs.readFile(file,"utf8")) as ContentManifest;
  if(manifest.schemaVersion!==1||manifest.contentId!==id||!Array.isArray(manifest.assets))throw new Error("资料清单无效");
  return {directory,manifest};
}
async function verifiedText(directory:string,asset:ContentAsset):Promise<{text:string;sha256:string}> {
  if(!["transcript","ocr"].includes(asset.role)||asset.status!=="saved"||!asset.path)throw new Error("该文字稿尚未保存");
  const file=await containedFile(directory,asset.path),size=(await fs.stat(file)).size;
  if(size>MAX_TEXT)throw new Error("该文字稿超过校订上限，请打开原文件阅读");
  const sha256=await fileHash(file);
  if(asset.sha256&&asset.sha256!==sha256)throw new Error("文字稿字节已在程序外变化，请先核对原件");
  return {text:await fs.readFile(file,"utf8"),sha256};
}
async function historicalText(directory:string,relative:string|undefined,sha256:string|undefined):Promise<string|undefined>{
  if(!relative||!sha256)return undefined;
  try{const file=await containedFile(directory,relative);if((await fs.stat(file)).size>MAX_TEXT||await fileHash(file)!==sha256)return undefined;return publicValue(await fs.readFile(file,"utf8"));}catch{return undefined;}
}
/** Read one source transcript and its current user edition; the machine source stays immutable. */
export async function readTranscriptEdition(root:string,id:string,sourceAssetId?:string) {
  const {directory,manifest}=await manifestAt(root,id);
  const sources=manifest.assets.filter(a=>["transcript","ocr"].includes(a.role)&&a.status==="saved"&&a.provenance!=="user_edited");
  const source=sourceAssetId?sources.find(a=>a.id===sourceAssetId):sources[0];
  if(!source)throw new Error("没有可校订的文字稿，请先选择“原件+文字稿”处理并完成转写");
  const original=await verifiedText(directory,source),edition=manifest.assets.find(a=>a.id===`edited-${source.id}`&&a.provenance==="user_edited");
  const stale=!!edition&&(edition.status!=="saved"||!!edition.derivation&&edition.derivation.sourceSha256!==original.sha256);
  const current=edition&&!stale?await verifiedText(directory,edition):original;
  const staleText=stale?await historicalText(directory,edition?.capturePath??edition?.path,edition?.sha256):undefined;
  const staleSourceHash=edition?.derivation?.sourceSha256;
  const staleOriginalText=stale&&staleSourceHash?await historicalText(directory,`校订历史/原稿-${staleSourceHash}.md`,staleSourceHash):undefined;
  return {contentId:id,title:manifest.title,sourceAssetId:source.id,sourceRole:source.role,text:publicValue(current.text),originalText:publicValue(original.text),expectedSha256:current.sha256,sourceSha256:original.sha256,edited:!!edition&&!stale,staleEdition:stale,staleText,staleOriginalText,staleReason:stale?"机器/平台原稿已更新；当前编辑器从新原稿开始，旧校订保留供对照和合并":undefined,sources:sources.map(a=>({id:a.id,label:a.label,role:a.role,partId:a.partId,language:a.language}))};
}
/** Literal replacements only: show the preview before a user decides to save. */
export function replaceTranscriptTerms(text:string,terms:Array<{from:string;to:string}>) {
  validateText(text);if(!Array.isArray(terms)||terms.length>100)throw new Error("一次最多替换 100 个术语");
  let result=text,replacements=0;
  for(const term of terms){
    if(!term||typeof term.from!=="string"||!term.from||term.from.length>200||typeof term.to!=="string"||term.to.length>200)throw new Error("术语需为 1 到 200 字的原词和不超过 200 字的替换词");
    let count=0,offset=0;for(;;){const found=result.indexOf(term.from,offset);if(found<0)break;count++;offset=found+term.from.length;}
    const characters=result.length+count*(term.to.length-term.from.length),bytes=Buffer.byteLength(result)+count*(Buffer.byteLength(term.to)-Buffer.byteLength(term.from));
    if(characters>MAX_TEXT||bytes>MAX_TEXT)throw new Error("本轮术语替换会超过 2 MiB 稿件上限，预览未改动");
    if(count){result=result.replaceAll(term.from,()=>term.to);validateText(result);}replacements+=count;
  }
  validateText(result);return {text:result,replacements};
}
export async function saveTranscriptEdition(root:string,id:string,input:{sourceAssetId:string;text:string;expectedSha256:string},deps:{pdf?:(directory:string)=>Promise<string|undefined>}={}) {
  validateText(input.text);if(!/^[a-f0-9]{64}$/.test(input.expectedSha256))throw new Error("缺少当前文字稿校验值，请重新读取后保存");
  return withContentMaintenance(root,async()=>{
    const current=await readTranscriptEdition(root,id,input.sourceAssetId);
    if(current.expectedSha256!==input.expectedSha256)throw new Error("文字稿已被另一个窗口更新，请重新读取；当前草稿可保留后合并");
    const {directory,manifest}=await manifestAt(root,id),source=manifest.assets.find(a=>a.id===input.sourceAssetId)!;
    if(current.text===input.text)return {contentId:id,unchanged:true,sha256:current.expectedSha256};
    const editId=`edited-${source.id}`,prior=manifest.assets.find(a=>a.id===editId),version=crypto.randomUUID(),versionBase=`校订历史/${version}`;
    if(prior&&prior.provenance!=="user_edited")throw new Error("校订标识与已有资产冲突，未覆盖原文件");
    let indexedBytes=Buffer.byteLength(input.text)+64*1024;
    const body=manifest.bodyFile?await fs.readFile(await containedFile(directory,manifest.bodyFile),"utf8"):manifest.markdown;
    indexedBytes+=Buffer.byteLength(body);
    for(const asset of manifest.assets)if(asset.id!==editId&&asset.status==="saved"&&asset.path&&["transcript","ocr"].includes(asset.role))indexedBytes+=(await fs.stat(await containedFile(directory,asset.path))).size;
    if(indexedBytes>4*1024*1024)throw new Error("加入校订稿后超过 4 MiB 搜索正文上限；请缩短稿件，已有稿件保留");
    // One source snapshot per SHA also survives a later ASR model/source rebuild.
    const sourceSnapshot=`校订历史/原稿-${current.sourceSha256}.md`,sourceSnapshotFile=await writableFile(directory,sourceSnapshot);
    if(!await historicalText(directory,sourceSnapshot,current.sourceSha256)){
      const temp=`${sourceSnapshotFile}.${version}.pending`;
      try{await fs.copyFile(await containedFile(directory,source.path!),temp);if(await fileHash(temp)!==current.sourceSha256)throw new Error("原稿快照校验失败");await atomicReplace(temp,sourceSnapshotFile);}finally{await fs.unlink(temp).catch(()=>{});}
    }
    await atomicJson(await writableFile(directory,`${versionBase}.json`),{schemaVersion:1,sourceAssetId:source.id,sourceSha256:current.sourceSha256,sourceSnapshot,baseTextSha256:current.expectedSha256,previousSha256:prior?.sha256??current.expectedSha256,previousPath:prior?.capturePath??sourceSnapshot,createdAt:new Date().toISOString()});
    const relative=`校订历史/.pending-${version}.md`,pending=await writableFile(directory,relative);
    try {
      await fs.writeFile(pending,input.text,"utf8");
      const published=`校订历史/${version}.md`;await atomicReplace(pending,await writableFile(directory,published));
      const edited:ContentAsset={id:editId,role:"transcript",status:"saved",path:published,capturePath:published,provenance:"user_edited",language:source.language,partId:source.partId,label:"用户校订文字稿",derivation:{sourceId:source.id,sourceSha256:current.sourceSha256}};
      const hasPdf=manifest.assets.some(a=>a.role==="pdf"&&a.provenance==="generated"&&a.status==="saved");
      const record={...manifest,assets:[...manifest.assets.filter(a=>a.id!==editId).map(a=>hasPdf&&a.role==="pdf"&&a.provenance==="generated"?{...a,status:"failed" as const,integrityFailed:true,reason:"校订稿已更新，阅读 PDF 正在重新生成"}:a),edited]};
      let saved=await saveContent(root,record,directory),pdfStatus:"unchanged"|"updated"|"stale"="unchanged";
      if(hasPdf){try{const generate=deps.pdf??(await import("./content-service.js")).generateContentPdf;const pdf=await generate(directory);if(!pdf)throw new Error("未生成阅读 PDF");record.assets=record.assets.filter(a=>a.role!=="pdf"||a.provenance!=="generated");record.assets.push({id:"reading-pdf",role:"pdf",status:"saved",path:pdf,provenance:"generated"});saved=await saveContent(root,record,directory);pdfStatus="updated";}catch(error){pdfStatus="stale";for(const asset of record.assets)if(asset.role==="pdf"&&asset.provenance==="generated"){asset.reason=`校订稿已保存；PDF 更新未完成：${publicValue(error instanceof Error?error.message:"请重试生成")}`;}saved=await saveContent(root,record,directory);}}
      const savedEdition=saved.assets.find(a=>a.id===editId)!;
      if(await fileHash(await containedFile(directory,source.path!))!==current.sourceSha256)throw new Error("保存期间原稿变化，请检查资料");
      // The revision keeps exactly one copy of the new text; the readable current edition is its consumer.
      return {contentId:id,path:path.join(directory,savedEdition.path!),sha256:savedEdition.sha256,sourceSha256:current.sourceSha256,previousSha256:current.expectedSha256,version,unchanged:false,previousEdition:!!prior,pdfStatus};
    }finally{await fs.unlink(pending).catch(()=>{});}
  });
}
