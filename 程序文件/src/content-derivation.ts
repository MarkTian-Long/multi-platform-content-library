import fs from "node:fs/promises";
import crypto from "node:crypto";
import { atomicJson,containedFile,fileHash,writableFile } from "./content-library.js";
import type { ContentAsset,ContentContext } from "./content-types.js";

export interface DerivedFile {id:string;path:string;}
interface Receipt {version:1;sourceId:string;sourceSha256:string;processingFingerprint?:string;files:Array<DerivedFile&{sha256:string}>;}
const samePath=(a:string|undefined,b:string)=>a?.replaceAll("\\","/")===b.replaceAll("\\","/");
export const processingFingerprint=(value:unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Successful manifest entries are evidence; arbitrary nonempty staging files are not. */
export async function trustedDerivedFiles(context:ContentContext,source:ContentAsset,files:DerivedFile[],receiptPath:string):Promise<boolean>{
  if(!source.path||!files.length)return false;
  try{
    const sourceSha256=await fileHash(await containedFile(context.directory,source.path));
    const priorSource=context.existing?.assets.find(a=>a.id===source.id&&a.status==="saved"&&!a.integrityFailed);
    let recorded=true;
    for(const output of files){
      const prior=context.existing?.assets.find(a=>a.id===output.id&&a.status==="saved"&&!a.integrityFailed&&a.sha256&&(samePath(a.capturePath,output.path)||samePath(a.path,output.path)));
      if(!prior||!(prior.derivation?prior.derivation.sourceId===source.id&&prior.derivation.sourceSha256===sourceSha256:priorSource?.sha256===sourceSha256)||prior.sha256!==await fileHash(await containedFile(context.directory,output.path))){recorded=false;break;}
    }
    if(recorded)return true;
    const file=await containedFile(context.directory,receiptPath);if((await fs.stat(file)).size>64*1024)return false;
    const receipt=JSON.parse(await fs.readFile(file,"utf8")) as Receipt;
    if(receipt.version!==1||receipt.sourceId!==source.id||receipt.sourceSha256!==sourceSha256||!Array.isArray(receipt.files)||receipt.files.length!==files.length)return false;
    for(const output of files){const proof=receipt.files.find(f=>f.id===output.id&&samePath(f.path,output.path));if(!proof||proof.sha256!==await fileHash(await containedFile(context.directory,output.path)))return false;}
    return true;
  }catch{return false;}
}

/** Written only after all outputs validate; an interrupted write never creates completion evidence. */
export async function completeDerivedFiles(context:ContentContext,source:ContentAsset,files:DerivedFile[],receiptPath:string,fingerprint?:string,expectedSourceSha256?:string):Promise<NonNullable<ContentAsset["derivation"]>>{
  context.signal?.throwIfAborted();
  const sourceSha256=await fileHash(await containedFile(context.directory,source.path!));
  if(expectedSourceSha256&&sourceSha256!==expectedSourceSha256)throw new Error("处理期间原始素材已变化，未登记为完成");
  const outputs:Receipt["files"]=[];
  for(const output of files){const file=await containedFile(context.directory,output.path);if(!(await fs.stat(file)).size)throw new Error("派生产物为空");outputs.push({...output,sha256:await fileHash(file)});}
  context.signal?.throwIfAborted();
  await atomicJson(await writableFile(context.directory,receiptPath),{version:1,sourceId:source.id,sourceSha256,processingFingerprint:fingerprint,files:outputs} satisfies Receipt);
  return {sourceId:source.id,sourceSha256,processingFingerprint:fingerprint};
}
