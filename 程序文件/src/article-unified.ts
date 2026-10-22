import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ArticleRecord } from "./article.js";
import type { ArticleManifest, SaveArticleOptions } from "./article-library.js";
import type { CapturedContent, ContentAsset, ContentManifest } from "./content-types.js";
import { parseContentLinks } from "./content-input.js";
import { saveContent, contentDirectory, containedFile, writableFile, atomicJson, ensureDirectory, fileHash, listManifests } from "./content-library.js";
import { selectReadingPdf } from "./content-reading.js";
import { articleMarkdownBody } from "./markdown.js";
import { resolveUnifiedArticleRoot } from "./article-root.js";

/** A narrow, explicit sibling mapping. No arbitrary redirect or directory links. */
export async function unifiedArticleRoot(root:string):Promise<string|undefined>{
  return resolveUnifiedArticleRoot(root);
}
export async function unifiedArticleRecords(root:string):Promise<Array<{directory:string;manifest:ArticleManifest}>>{
  const target=await unifiedArticleRoot(root);if(!target)return [];
  const result:Array<{directory:string;manifest:ArticleManifest}>=[];
  for(const {directory,manifest:content} of await listManifests(target)){
    if(content.platform!=="wechat")continue;
    try{const article=JSON.parse(await fs.readFile(await containedFile(directory,"manifest.json"),"utf8")) as ArticleManifest;
      if(article.contentId!==content.contentId)continue;
      for(const id of new Set([article.articleId,...(article.articleIds??[])]))if(/^[a-f0-9]{24}$/.test(id))result.push({directory,manifest:{...article,articleId:id}});
    }catch{}
  }return result;
}
type LegacySave=(root:string,record:ArticleRecord,options:SaveArticleOptions)=>Promise<{articleId:string;directory:string;manifest:ArticleManifest}>;
export async function saveUnifiedArticle(root:string,record:ArticleRecord,options:SaveArticleOptions,legacySave:LegacySave){
  const stage=path.join(root,"staging",`wechat-${crypto.randomUUID()}`);await ensureDirectory(stage);
  // Retain the recovery stage until the ordinary verified storage cleaner can prove it redundant.
  const captured=await legacySave(stage,record,options),raw=captured.manifest;
  if(record.sourceHtml!==undefined)await fs.writeFile(await writableFile(captured.directory,"source.html"),record.sourceHtml,"utf8");
  const input=parseContentLinks(raw.sourceUrl)[0];
  const assets:ContentAsset[]=[];
  for(const image of raw.images??[])assets.push({id:`image-${image.index}`,role:"image",status:image.status==="saved"?"saved":"failed",path:image.localPath,sourceUrl:image.sourceUrl,provenance:"original"});
  for(const video of raw.videos??[])assets.push({id:`video-${video.videoId??video.index}`,role:"video",status:video.status==="saved"?"saved":"unavailable",path:video.localPath,reason:video.reason,provenance:"original"});
  assets.push({id:"wechat-source-html",role:"source",status:"saved",path:"source.html",provenance:"original"},{id:"wechat-source-markdown",role:"source",status:"saved",path:raw.markdownFile!,provenance:"original"},{id:"wechat-source-manifest",role:"source",status:"saved",path:"manifest.json",provenance:"original"});
  const content:CapturedContent={platform:"wechat",nativeId:input?.nativeId??raw.articleId,canonicalUrl:input?.canonicalUrl??raw.sourceUrl,sourceUrl:raw.sourceUrl,title:raw.title,author:record.author,publishedAt:record.publishedAt,capturedAt:raw.extractedAt,kind:"article",markdown:articleMarkdownBody(await fs.readFile(await containedFile(captured.directory,raw.markdownFile!),"utf8"),raw),assets,warnings:[],coverage:{legacyArticleId:raw.articleId},storageVersion:2};
  const saved=await saveContent(root,content,captured.directory),directory=await contentDirectory(root,saved.contentId);
  const prior=await fs.readFile(path.join(directory,"manifest.json"),"utf8").then(s=>JSON.parse(s) as ArticleManifest,()=>undefined);
  const asset=(id:string)=>saved.assets.find(a=>a.id===id),pdf=selectReadingPdf(saved.assets);
  const manifest:ArticleManifest={...raw,contentId:saved.contentId,articleIds:[...new Set([...(prior?.articleIds??[]),...(prior?[prior.articleId]:[]),raw.articleId])],markdownFile:saved.markdownFile,htmlFile:asset("wechat-source-html")?.path,
    images:raw.images?.map(i=>({...i,localPath:asset(`image-${i.index}`)?.path,status:asset(`image-${i.index}`)?.status==="saved"?"saved":i.status})),
    videos:raw.videos?.map(v=>({...v,localPath:asset(`video-${v.videoId??v.index}`)?.path})),...(pdf?.path?{pdf:{status:"saved" as const,path:pdf.path}}:{})};
  await atomicJson(await writableFile(directory,"manifest.json"),manifest);
  const declared=new Map(content.assets.filter(a=>a.status==="saved"&&a.path).map(a=>[path.resolve(captured.directory,a.path!),saved.assets.find(b=>b.id===a.id)]));
  const files=await fs.readdir(stage,{recursive:true,withFileTypes:true});let redundant=true;
  for(const entry of files){if(entry.isSymbolicLink()){redundant=false;break;}if(!entry.isFile())continue;const from=path.join(entry.parentPath,entry.name),asset=declared.get(from);if(!asset?.path||await fileHash(from)!==await fileHash(await containedFile(directory,asset.path))){redundant=false;break;}}
  if(redundant&&path.dirname(stage)===path.join(root,"staging")&&!(await fs.lstat(stage)).isSymbolicLink())await fs.rm(stage,{recursive:true,force:true});
  return {articleId:raw.articleId,directory,manifest};
}
export async function syncUnifiedArticleManifest(directory:string,article:ArticleManifest):Promise<void>{
  if(!article.contentId)return;
  const current=JSON.parse(await fs.readFile(await containedFile(directory,"content.json"),"utf8")) as ContentManifest;
  if(current.contentId!==article.contentId||path.basename(path.dirname(directory))!=="items")throw new Error("文章与正式资料身份不一致");
  if(article.pdf?.status==="saved"){
    await containedFile(directory,article.pdf.path);
    const assets=current.assets.filter(a=>a.id!=="reading-pdf");assets.push({id:"reading-pdf",role:"pdf",status:"saved",path:article.pdf.path,provenance:"generated"});
    const saved=await saveContent(path.dirname(path.dirname(directory)),{...current,assets},directory);
    article.pdf={status:"saved",path:saved.assets.find(a=>a.id==="reading-pdf")!.path!};article.markdownFile=saved.markdownFile;
  }
}
/** Keep the previous readable PDF before any regeneration replaces its filename. */
export async function preserveCurrentPdf(directory:string):Promise<void>{
  const current=JSON.parse(await fs.readFile(await containedFile(directory,"content.json"),"utf8")) as ContentManifest;
  if(current.storageVersion!==2&&current.storageVersion!==3)return;
  const pdf=selectReadingPdf(current.assets);if(!pdf?.path||pdf.path.replaceAll("\\","/").startsWith("历史版本/"))return;
  const source=await containedFile(directory,pdf.path),sha=await fileHash(source),bytes=(await fs.stat(source)).size;
  if(!bytes||(pdf.sha256&&pdf.sha256!==sha)||(pdf.bytes&&pdf.bytes!==bytes))throw new Error("当前PDF已在程序外改变，请核对后再生成");
  const relative=`历史版本/阅读/阅读-${sha.slice(0,16)}.pdf`,target=await writableFile(directory,relative);
  if(source!==target){await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL).catch(async error=>{if(error.code!=="EEXIST"||await fileHash(target)!==sha)throw error;});}
  if(!current.assets.some(a=>a.id===`pdf-history-${sha}`)){
    current.assets.push({id:`pdf-history-${sha}`,role:"source",status:"saved",path:relative,capturePath:relative,provenance:"generated",bytes,sha256:sha,label:"历史阅读 PDF"});
    await atomicJson(await writableFile(directory,"content.json"),current);
  }
}
