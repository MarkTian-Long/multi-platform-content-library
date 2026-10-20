import fs from "node:fs/promises";
import path from "node:path";
import { withContentMaintenance } from "../src/content-jobs.js";
import {storageInventory} from "../src/content-storage-upgrade.js";
import {fileHash,ensureDirectory,atomicJson} from "../src/content-library.js";
const project=path.resolve(process.argv[2]),root=path.join(project,"资料库"),backup=path.join(project,"版本备份","存储优化-20261016-084810");
const metadata=JSON.parse(await fs.readFile(path.join(backup,"备份核验.json"),"utf8"));
const baseline=new Map<string,{bytes:number;sha256:string}>(metadata.manifest.files.map((f:any)=>[f.path,f]));
const report:any={moved:[],removed:[],retained:["完整备份ZIP","工作回退/原目录","工作回退/兼容原文件","旧客户端隔离图片","未知staging"],createdAt:new Date().toISOString()};
function target(relative:string){const absolute=path.resolve(project,relative);if(!absolute.startsWith(project+path.sep))throw new Error("收尾目标越界");return absolute;}
await withContentMaintenance(root,async()=>{
 for(const name of [".命名备份",".平台识别备份"]){const source=target(`资料库/${name}`);if(!await fs.stat(source).then(s=>s.isDirectory(),()=>false))continue;const files=await storageInventory(source);for(const file of files){const previous=baseline.get(`资料库/${name}/${file.path}`);if(!previous||file.bytes!==previous.bytes||file.sha256!==previous.sha256)throw new Error("早期备份与已核验完整ZIP不一致");if(file.path.endsWith("迁移记录.json")){const journal=JSON.parse(await fs.readFile(path.join(source,file.path),"utf8"));if(!["completed","rolled_back"].includes(journal.state))throw new Error("发现尚未完成的早期迁移");}}
 const destination=target(`版本备份/存储优化-20261016-084810/早期迁移备份/${name}`);await ensureDirectory(path.dirname(destination));if(await fs.lstat(destination).then(()=>true,()=>false))throw new Error("早期备份目标已存在");await fs.rename(source,destination);report.moved.push({from:path.relative(project,source),to:path.relative(project,destination),files:files.length});}
 for(const name of [".命名整理","exports"]){const directory=target(`资料库/${name}`);if(await fs.stat(directory).then(s=>s.isDirectory(),()=>false)&&!(await fs.readdir(directory)).length){await fs.rmdir(directory);report.removed.push({path:path.relative(project,directory),empty:true});}}
});
const rehearsal=target("程序文件/logs/storage-rehearsal"),rehearsalDirs=(await fs.readdir(rehearsal,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name.startsWith("演练回退-"));let proof=false;
for(const entry of rehearsalDirs){const candidate=path.join(rehearsal,entry.name,"核验报告.json");try{const value=JSON.parse(await fs.readFile(candidate,"utf8"));if(value.rollbackChecked&&value.oldReaderChecked&&value.items===17){await fs.copyFile(candidate,path.join(backup,"演练核验.json"));proof=true;break;}}catch{}}
if(!proof)throw new Error("缺少成功演练证据，保留临时目录");
// Only directories created for this exact run are removed; all trees are checked for links first.
for(const relative of ["程序文件/logs/storage-rehearsal","版本备份/存储优化-20261016-084810/工作回退/准备区"]){const directory=target(relative);const inventory=await storageInventory(directory);if((await fs.lstat(directory)).isSymbolicLink())throw new Error("收尾目录不允许链接");await fs.rm(directory,{recursive:true,force:true});report.removed.push({path:relative,files:inventory.length,bytes:inventory.reduce((n,f)=>n+f.bytes,0)});}
await atomicJson(path.join(backup,"收尾记录.json"),report);console.log(JSON.stringify(report,null,2));
