import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {atomicJson,containedFile,writableFile,exportContent,contentDirectory,publicValue} from './content-library.js';
import {withContentMaintenance} from './content-jobs.js';
import type {ContentListItem} from './content-types.js';

export interface ContentOrganization {tags:string[];favorite:boolean;updatedAt?:string;}
export type OrganizedContentListItem=ContentListItem & ContentOrganization;
export interface OrganizationFilter {tag?:string;favoritesOnly?:boolean;query?:string;}
export interface ZipOptions {signal?:AbortSignal;maxTotalBytes?:number;compressSmallFiles?:boolean;files?:string[];}
export interface VerifiedZipEntry {path:string;bytes:number;compressedBytes:number;sha256:string;crc32:number;method:0|8;dataOffset:number;}
export interface VerifiedZip {path:string;bytes:number;sha256:string;entries:VerifiedZipEntry[];}
const idPattern=/^[a-f0-9]{24}$/;
const DEFAULT_MAX=2*1024*1024*1024, SMALL=1024*1024;
const empty=():ContentOrganization=>({tags:[],favorite:false});
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}};

/** Cross-process lock, with token ownership on release and no lock-file link following. */
export async function withOrganizationLock<T>(root:string,name:string,operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!/^[a-z-]{1,40}$/.test(name))throw new Error('组织锁名称无效');
  const file=await writableFile(root,`.organization/${name}.lock`),token=crypto.randomUUID(),deadline=Date.now()+8000;
  for(;;){signal?.throwIfAborted();try{const handle=await fs.open(file,'wx');try{await handle.writeFile(JSON.stringify({pid:process.pid,token}));}finally{await handle.close();}break;}catch(e){
    if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
    let safe:string,stat:Awaited<ReturnType<typeof fs.stat>>;
    try{safe=await containedFile(root,`.organization/${name}.lock`);stat=await fs.stat(safe);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      if(Date.now()>=deadline)throw new Error('组织管理正忙，请稍后重试');continue;
    }
    if(Date.now()-stat.mtimeMs>2000){let owner:{pid?:number}={};try{owner=JSON.parse(await fs.readFile(safe,'utf8'));}catch{}
      if(!owner.pid||!alive(owner.pid)){await fs.unlink(safe).catch(()=>{});continue;}}
    if(Date.now()>=deadline)throw new Error('组织管理正忙，请稍后重试');await new Promise(r=>setTimeout(r,25));
  }}
  try{return await operation();}finally{try{const safe=await containedFile(root,`.organization/${name}.lock`),owner=JSON.parse(await fs.readFile(safe,'utf8'));if(owner.token===token)await fs.unlink(safe);}catch{}}
}
function tags(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>20||value.some(v=>typeof v!=='string'))throw new Error('标签最多20个，每个必须是文本');
  const result:string[]=[];for(const v of value){const text=(v as string).trim().normalize('NFC');if(!text||Array.from(text).length>40||/[\x00-\x1f\x7f]/.test(text))throw new Error('标签须为1至40个可见字符');if(!result.includes(text))result.push(text);}return result;
}
async function organizationData(root:string):Promise<Record<string,ContentOrganization>>{
  let file:string;try{file=await containedFile(root,'.organization/items.json');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {};throw e;}
  if((await fs.stat(file)).size>16*1024*1024)throw new Error('组织元数据超过上限');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  if(data.version!==1||!data.items||typeof data.items!=='object'||Array.isArray(data.items)||Object.keys(data.items).length>10000)throw new Error('组织元数据损坏，已保留原文件');
  const result:Record<string,ContentOrganization>={};for(const [id,value]of Object.entries(data.items) as Array<[string,ContentOrganization]>){if(!idPattern.test(id)||!value||typeof value.favorite!=='boolean'||value.updatedAt!==undefined&&(typeof value.updatedAt!=='string'||value.updatedAt.length>40||!Number.isFinite(Date.parse(value.updatedAt))))throw new Error('组织元数据损坏，已保留原文件');result[id]={tags:tags(value.tags),favorite:value.favorite,...(value.updatedAt?{updatedAt:value.updatedAt}:{})};}
  return result;
}
export async function getContentOrganization(root:string,contentId:string):Promise<ContentOrganization>{if(!idPattern.test(contentId))throw new Error('资料标识无效');return structuredClone((await organizationData(root))[contentId]??empty());}
export async function setContentOrganization(root:string,contentId:string,patch:{tags?:string[];favorite?:boolean}):Promise<ContentOrganization>{
  if(!idPattern.test(contentId)||!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!['tags','favorite'].includes(k))||patch.favorite!==undefined&&typeof patch.favorite!=='boolean')throw new Error('组织更新无效');
  const nextTags=patch.tags===undefined?undefined:tags(patch.tags);
  return withOrganizationLock(root,'items',async()=>{
    const file=await containedFile(await contentDirectory(root,contentId),'content.json');if((await fs.stat(file)).size>8*1024*1024||JSON.parse(await fs.readFile(file,'utf8')).contentId!==contentId)throw new Error('资料不存在');
    const items=await organizationData(root),previous=items[contentId]??empty();
    if(!items[contentId]&&Object.keys(items).length>=10000)throw new Error('组织条目超过上限');
    const value={tags:nextTags??previous.tags,favorite:patch.favorite??previous.favorite,updatedAt:new Date().toISOString()};items[contentId]=value;
    await atomicJson(await writableFile(root,'.organization/items.json'),{version:1,items});return structuredClone(value);
  });
}
export async function decorateContentItems(root:string,items:ContentListItem[],filter:OrganizationFilter={}):Promise<OrganizedContentListItem[]>{
  const data=await organizationData(root),needle=filter.query?.trim().toLocaleLowerCase();
  return items.map(item=>({...item,...structuredClone(data[item.contentId]??empty())})).filter(item=>(!filter.tag||item.tags.includes(filter.tag))&&(!filter.favoritesOnly||item.favorite)&&(!needle||`${item.title} ${item.displayTitle??''} ${item.sourceUrl} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(needle)));
}
export function archiveRelativePath(value:string):string{
  if(typeof value!=='string'||!value||value.length>2048||path.isAbsolute(value)||path.win32.isAbsolute(value)||/[<>:"|?*\x00-\x1f]/.test(value))throw new Error('归档路径无效');
  const parts=value.replaceAll('\\','/').split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw new Error('归档路径无效');return parts.join('/');
}
export async function archiveTree(root:string,signal?:AbortSignal):Promise<string[]>{
  // writableFile checks every directory ancestor without accepting junctions.
  const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('归档根目录无效');await writableFile(root,'.archive-validation');const result:string[]=[];
  async function visit(relative:string){for(const entry of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){signal?.throwIfAborted();const key=archiveRelativePath(relative?`${relative}/${entry.name}`:entry.name);if(entry.isSymbolicLink())throw new Error('归档拒绝符号链接');if(entry.isDirectory())await visit(key);else if(entry.isFile()){await containedFile(root,key);result.push(key);if(result.length>4096)throw new Error('归档文件超过4096项');}else throw new Error('归档只接受普通文件');}}
  await visit('');return result;
}
const table=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[i]=c>>>0;}
const crcUpdate=(crc:number,bytes:Buffer)=>{for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return crc>>>0;};
export async function archiveFileHash(file:string,signal?:AbortSignal):Promise<string>{const h=crypto.createHash('sha256');for await(const chunk of createReadStream(file,{signal,highWaterMark:65536}))h.update(chunk);return h.digest('hex');}
async function* entryChunks(zip:string,entry:VerifiedZipEntry,signal?:AbortSignal):AsyncGenerator<Buffer>{
  if(entry.method===8){if(entry.bytes>SMALL||entry.compressedBytes>SMALL+65536)throw new Error('归档压缩块超过上限');const chunks:Buffer[]=[];if(entry.compressedBytes)for await(const c of createReadStream(zip,{start:entry.dataOffset,end:entry.dataOffset+entry.compressedBytes-1,signal}))chunks.push(Buffer.from(c));yield inflateRawSync(Buffer.concat(chunks),{maxOutputLength:Math.max(1,entry.bytes+1)});}
  else if(entry.method===0){if(entry.bytes!==entry.compressedBytes)throw new Error('归档存储长度无效');if(entry.bytes)for await(const c of createReadStream(zip,{start:entry.dataOffset,end:entry.dataOffset+entry.bytes-1,signal,highWaterMark:65536}))yield Buffer.from(c);}
  else throw new Error('归档压缩格式无效');
}
function validateEntries(entries:VerifiedZipEntry[],zipBytes:number,maximum=DEFAULT_MAX):void{
  if(!Array.isArray(entries)||entries.length>4096)throw new Error('归档条目数量无效');let total=0,end=0;const names=new Set<string>();
  for(const e of entries){const name=archiveRelativePath(e.path),key=name.toLowerCase();if(names.has(key)||![e.bytes,e.compressedBytes,e.dataOffset,e.crc32].every(Number.isSafeInteger)||e.bytes<0||e.compressedBytes<0||e.dataOffset<30||e.crc32<0||e.crc32>0xffffffff||e.dataOffset<end||e.dataOffset+e.compressedBytes>zipBytes||!/^[a-f0-9]{64}$/.test(e.sha256))throw new Error('归档条目或边界无效');names.add(key);total+=e.bytes;end=e.dataOffset+e.compressedBytes;if(total>maximum)throw new Error('归档总大小超过上限');}
}
/** Verify payload bytes after closing the ZIP. No unverified archive can authorize removal. */
export async function verifyContentZip(zip:string,entries:VerifiedZipEntry[],signal?:AbortSignal):Promise<void>{
  const file=await containedFile(path.dirname(zip),path.basename(zip));validateEntries(entries,(await fs.stat(file)).size);
  for(const e of entries){signal?.throwIfAborted();let length=0,crc=0xffffffff;const h=crypto.createHash('sha256');for await(const b of entryChunks(file,e,signal)){length+=b.length;if(length>e.bytes)throw new Error('归档解压长度不符');h.update(b);crc=crcUpdate(crc,b);}if(length!==e.bytes||h.digest('hex')!==e.sha256||((crc^0xffffffff)>>>0)!==e.crc32)throw new Error('归档内容哈希不一致');}
}
/** ZIP32 STORE for large files; optionally DEFLATE only bounded small files. */
export async function writeVerifiedZip(root:string,destination:string,options:ZipOptions={}):Promise<VerifiedZip>{
  const maximum=options.maxTotalBytes??DEFAULT_MAX;if(!Number.isSafeInteger(maximum)||maximum<=0||maximum>DEFAULT_MAX)throw new Error('ZIP预算无效');
  const files=(options.files??await archiveTree(root,options.signal)).map(archiveRelativePath);if(files.length>4096||new Set(files.map(v=>v.toLowerCase())).size!==files.length)throw new Error('ZIP条目数量或重名无效');
  let planned=0;for(const relative of files){planned+=(await fs.stat(await containedFile(root,relative))).size;if(planned>maximum)throw new Error('ZIP总大小超过上限');}
  const final=await writableFile(path.dirname(destination),path.basename(destination));if(await fs.lstat(final).then(()=>true,()=>false))throw new Error('归档目标已存在');
  const temp=`${final}.${crypto.randomUUID()}.tmp`,handle=await fs.open(temp,'wx'),entries:VerifiedZipEntry[]=[],central:Buffer[]=[];let position=0,total=0,closed=false;
  const write=async(buffer:Buffer)=>{let start=0;while(start<buffer.length){options.signal?.throwIfAborted();const {bytesWritten}=await handle.write(buffer,start,buffer.length-start);if(!bytesWritten)throw new Error('ZIP写入中断');start+=bytesWritten;position+=bytesWritten;if(position>0xffffffff)throw new Error('ZIP32大小超过上限');}};
  try{
    for(const relative of files){options.signal?.throwIfAborted();const source=await containedFile(root,relative),before=await fs.stat(source),name=Buffer.from(relative,'utf8'),method:0|8=options.compressSmallFiles&&before.size<=SMALL?8:0,offset=position;
      const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0808,6);header.writeUInt16LE(method,8);header.writeUInt16LE(33,12);header.writeUInt16LE(name.length,26);await write(header);await write(name);const dataOffset=position;
      let bytes=0,crc=0xffffffff;const h=crypto.createHash('sha256');
      if(method===8){const hSource=await fs.open(source,'r');let b:Buffer;try{const data=Buffer.alloc(Math.min(SMALL+1,before.size+1));let length=0;while(length<data.length){options.signal?.throwIfAborted();const read=await hSource.read(data,length,data.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}if(length>SMALL)throw new Error('归档文件读取中发生变化');b=data.subarray(0,length);}finally{await hSource.close();}bytes=b.length;crc=crcUpdate(crc,b);h.update(b);await write(deflateRawSync(b));}
      else for await(const chunk of createReadStream(source,{signal:options.signal,highWaterMark:65536})){const b=Buffer.from(chunk);bytes+=b.length;if(total+bytes>maximum)throw new Error('ZIP总大小超过上限');h.update(b);crc=crcUpdate(crc,b);await write(b);}
      const after=await fs.stat(await containedFile(root,relative));if(before.size!==bytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('归档源文件发生变化');total+=bytes;if(total>maximum)throw new Error('ZIP总大小超过上限');
      const compressedBytes=position-dataOffset,crc32=(crc^0xffffffff)>>>0,entry={path:relative,bytes,compressedBytes,sha256:h.digest('hex'),crc32,method,dataOffset};entries.push(entry);
      const descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc32,4);descriptor.writeUInt32LE(compressedBytes,8);descriptor.writeUInt32LE(bytes,12);await write(descriptor);
      const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0808,8);c.writeUInt16LE(method,10);c.writeUInt16LE(33,14);c.writeUInt32LE(crc32,16);c.writeUInt32LE(compressedBytes,20);c.writeUInt32LE(bytes,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);
    }
    const centralOffset=position;for(const b of central)await write(b);const footer=Buffer.alloc(22);footer.writeUInt32LE(0x06054b50);footer.writeUInt16LE(entries.length,8);footer.writeUInt16LE(entries.length,10);footer.writeUInt32LE(position-centralOffset,12);footer.writeUInt32LE(centralOffset,16);await write(footer);await handle.sync();await handle.close();closed=true;
    await verifyContentZip(temp,entries,options.signal);
    for(const e of entries)if(await archiveFileHash(await containedFile(root,e.path),options.signal)!==e.sha256)throw new Error('ZIP核验后源文件发生变化');
    const sha256=await archiveFileHash(temp,options.signal);options.signal?.throwIfAborted();await fs.link(temp,final);await fs.unlink(temp);return {path:final,bytes:position,sha256,entries};
  }finally{if(!closed)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
}
export async function extractContentZip(zip:VerifiedZip,destination:string,signal?:AbortSignal):Promise<void>{
  if(await archiveFileHash(zip.path,signal)!==zip.sha256)throw new Error('ZIP整体哈希不一致');await verifyContentZip(zip.path,zip.entries,signal);
  for(const e of zip.entries){const file=await writableFile(destination,archiveRelativePath(e.path)),handle=await fs.open(file,'wx');try{for await(const b of entryChunks(zip.path,e,signal)){let start=0;while(start<b.length){const {bytesWritten}=await handle.write(b,start,b.length-start);if(!bytesWritten)throw new Error('归档恢复写入中断');start+=bytesWritten;}}await handle.sync();}finally{await handle.close();}if(await archiveFileHash(file,signal)!==e.sha256)throw new Error('恢复文件哈希不一致');}
}
export async function exportContentZip(root:string,contentId:string,options:Pick<ZipOptions,'signal'|'maxTotalBytes'>={}):Promise<VerifiedZip>{
  if(!idPattern.test(contentId))throw new Error('资料标识无效');
  return withContentMaintenance(root,async()=>{options.signal?.throwIfAborted();const maximum=options.maxTotalBytes??DEFAULT_MAX;if(!Number.isSafeInteger(maximum)||maximum<=0||maximum>DEFAULT_MAX)throw new Error('ZIP预算无效');
    const directory=await contentDirectory(root,contentId),manifestFile=await containedFile(directory,'content.json');if((await fs.stat(manifestFile)).size>8*1024*1024)throw new Error('资料清单超过上限');const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));if(manifest.contentId!==contentId||!Array.isArray(manifest.assets))throw new Error('资料清单无效');
    const files=new Set<string>(['content.json',manifest.markdownFile,manifest.readingFile]);for(const asset of manifest.assets)if(asset.status==='saved'&&asset.path&&!['reading','pdf'].includes(asset.role)&&(asset.role!=='source'||manifest.platform==='local'&&asset.provenance==='original'))files.add(asset.path);
    let bytes=0;for(const relative of files){options.signal?.throwIfAborted();bytes+=(await fs.stat(await containedFile(directory,relative))).size;if(bytes>maximum)throw new Error('ZIP总大小超过上限');}if(files.size>4096)throw new Error('ZIP文件超过4096项');
    const organization=await getContentOrganization(root,contentId),result=await exportContent(root,contentId);try{await atomicJson(await writableFile(result.directory,'organization.json'),publicValue({version:1,contentId,...organization}));return await writeVerifiedZip(result.directory,`${result.directory}.zip`,options);}finally{
    const real=await fs.realpath(result.directory),exports=await fs.realpath(path.join(root,'exports'));if(path.dirname(real)!==exports)throw new Error('导出快照归属异常');await fs.rm(real,{recursive:true,force:true});
  }});
}
