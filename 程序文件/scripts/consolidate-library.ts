import fs from "node:fs/promises";
import path from "node:path";
import {prepareSingleLibrary,publishSingleLibrary,rollbackSingleLibrary} from "../src/single-library-migration.js";
import {generateContentPdf} from "../src/content-service.js";
import {listManifests,findContent,containedFile,fileHash} from "../src/content-library.js";
import {findArticles,readArticle} from "../src/article-library.js";

const project=await fs.realpath(path.resolve(process.argv[2])),backup=await fs.realpath(path.resolve(process.argv[3])),mode=process.argv[4];
const journal=path.join(backup,"单库整理日志.json"),output=path.join(project,"程序文件","logs","single-library");await fs.mkdir(output,{recursive:true});
if(mode==="prepare")console.log(JSON.stringify(await prepareSingleLibrary(project,{backupDirectory:backup,pdf:generateContentPdf,progress:message=>console.log(message)})));
else if(mode==="publish"){await publishSingleLibrary(project,journal);console.log("已发布单库整理");}
else if(mode==="rollback"){await rollbackSingleLibrary(project,journal);console.log("已完成单库整理回退");}
else if(mode==="verify"){
 const log=JSON.parse(await fs.readFile(journal,"utf8")),root=log.status==="prepared"?log.preparedRoot:path.join(project,"资料库");
 const records=await listManifests(root),items=await findContent(root);let checked=0,originals=0;
 for(const {directory,manifest} of records){
  if(manifest.storageVersion!==3)throw new Error("仍有非第三版条目");
  for(const asset of manifest.assets)if(asset.status==="saved"&&asset.path){const file=await containedFile(directory,asset.path);if((await fs.stat(file)).size!==asset.bytes||await fileHash(file)!==asset.sha256)throw new Error("保存文件哈希不符");checked++;if(asset.provenance==="original")originals++;}
  const item=items.find(i=>i.contentId===manifest.contentId);if(!item?.textPath||item.textPath!==await containedFile(directory,manifest.markdownFile))throw new Error("全文入口不对应");
  if(manifest.kind==="article"&&manifest.bodyFile!==manifest.markdownFile)throw new Error("文章仍有两份当前正文");
  if(manifest.kind==="article"&&/^# [^\n]+\nsource: [^\n]+\nstatus: [^\n]+\ncaptured:/m.test(await fs.readFile(item.textPath,"utf8")))throw new Error("全文仍含旧机器包装头");
 }
 const articles=await findArticles(root,"");for(const article of articles)if(!(await readArticle(root,article.articleId)).ok)throw new Error("旧文章ID读取失败");
 if(records.length!==log.entries.length||items.length!==records.length)throw new Error("条目数量不一致");
 const report={status:log.status,items:items.length,assetsVerified:checked,originalAssetsVerified:originals,legacyIdsReadable:articles.length,paths:items.map(i=>({id:i.contentId,directory:i.directory,reading:i.readingPath,text:i.textPath,pdf:i.pdfPath})),finishedAt:new Date().toISOString()};
 await fs.writeFile(path.join(output,log.status==="prepared"?"prepared-verification.json":"final-verification.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({...report,paths:undefined},null,2));
}else throw new Error("mode必须为prepare/publish/rollback/verify");
