import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { upgradeStorage,rollbackStorageUpgrade,storageInventory } from "../src/content-storage-upgrade.js";
import { listManifests,findContent,containedFile,fileHash } from "../src/content-library.js";
import { readArticle,findArticles } from "../src/article-library.js";
import { generateContentPdf } from "../src/content-service.js";
const project=path.resolve(process.argv[2]??""),mode=process.argv[3]??"rehearse";
if(!process.argv[2]||!["rehearse","apply","rollback"].includes(mode))throw new Error("usage: project rehearse|apply");
if(mode==="rollback"){if(!process.argv[4])throw new Error("缺少回退日志");await rollbackStorageUpgrade(project,path.resolve(process.argv[4]));console.log("回退完成");process.exit(0);}
if(mode==="apply"){
 const folder=path.join(project,"版本备份","存储优化-20261016-084810"),meta=JSON.parse(await fs.readFile(path.join(folder,"备份核验.json"),"utf8"));
 if(meta.verified!==true||path.resolve(meta.manifest.root)!==await fs.realpath(project)||(await fs.stat(path.join(folder,"迁移前完整备份.zip"))).size!==meta.archiveBytes)throw new Error("缺少本项目已核验的完整备份，拒绝正式整理");
}
const root=path.join(project,"资料库"),legacy=path.join(project,"文章库");
const before=await listManifests(root),originals=before.flatMap(item=>item.manifest.assets.filter(a=>a.provenance==="original"&&a.status==="saved"&&a.path).map(a=>({contentId:item.manifest.contentId,id:a.id,sha256:a.sha256})));
const baseline=mode==="rehearse"?await storageInventory(root):undefined;
const backup=mode==="rehearse"?path.join(project,`演练回退-${Date.now()}`):path.join(project,"版本备份","存储优化-20261016-084810","工作回退");
const result=await upgradeStorage(project,{backupDirectory:backup,pdf:generateContentPdf,progress:message=>console.log(message)});
if(result.items===0){console.log("资料库已经整理，无需再次迁移；原核验记录保持不变。");process.exit(0);}
const after=await listManifests(root),items=await findContent(root);if(after.length!==before.length||items.length!==before.length)throw new Error("条目数量变化");
let verified=0;for(const original of originals){const item=after.find(i=>i.manifest.contentId===original.contentId),asset=item?.manifest.assets.find(a=>a.id===original.id);if(!item||!asset?.path||await fileHash(await containedFile(item.directory,asset.path))!==original.sha256)throw new Error("原件校验失败");verified++;}
const articles=await findArticles(legacy,"");for(const article of articles)if(!(await readArticle(legacy,article.articleId)).ok)throw new Error("旧文章ID读取失败");
if(mode==="rehearse"){
 const old=await import(pathToFileURL(path.join(project,"程序文件","dist","content-library.js")).href);const oldItems=await old.findContent(root);if(oldItems.length!==items.length)throw new Error("旧缓存读取条目失败");for(const item of oldItems){const fresh=items.find(i=>i.contentId===item.contentId);if(item.pdfPath!==fresh?.pdfPath)throw new Error("旧缓存PDF入口不一致");}
 await rollbackStorageUpgrade(project,result.journal);await rollbackStorageUpgrade(project,result.journal);
 if(JSON.stringify(await storageInventory(root))!==JSON.stringify(baseline))throw new Error("回退后文件清单不一致");
}
const report={...result,mode,originalAssetHashesVerified:verified,contentIds:after.map(i=>i.manifest.contentId),legacyIds:articles.map(a=>a.articleId),itemsVisible:items.length,oldReaderChecked:mode==="rehearse",rollbackChecked:mode==="rehearse",finishedAt:new Date().toISOString()};
await fs.writeFile(path.join(backup,"核验报告.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
