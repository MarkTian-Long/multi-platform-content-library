import fs from "node:fs/promises";
import { containedFile } from "./content-library.js";
import { processingFingerprint } from "./content-derivation.js";
import type { ContentContext } from "./content-types.js";

export interface AsrCue {startMs:number;endMs:number;text:string;}
export interface AsrBundle {language?:string;model?:string;fingerprint:string;data:Record<string,unknown>;}
export interface AsrPaths {md:string;json:string;srt:string;}
const normalize=(text:string)=>text.replace(/\s+/g," ").trim();
function stamp(ms:number):string{const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000);return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(ms%1000).padStart(3,"0")}`;}

/** Check all formats against JSON evidence; a nonempty header is never a transcript. */
export async function readAsrBundle(context:ContentContext,paths:AsrPaths,parseSubtitle:(text:string)=>AsrCue[]):Promise<AsrBundle|undefined>{
  try{
    const read=async(relative:string)=>{const file=await containedFile(context.directory,relative),s=await fs.stat(file);if(!s.size||s.size>8*1024*1024)throw new Error("ASR 文件无效或超过上限");return fs.readFile(file,"utf8");};
    const [md,json,srt]=await Promise.all([read(paths.md),read(paths.json),read(paths.srt)]);
    const data:Record<string,unknown>=JSON.parse(json);if(!data||Array.isArray(data)||!Array.isArray(data.segments)||!data.segments.length)return undefined;
    const segments=data.segments as AsrCue[],cues=parseSubtitle(srt);if(cues.length!==segments.length||(md.match(/^-\s+\[/gm)?.length??0)!==segments.length)return undefined;
    let end=0,position=0;const canonical=md.replace(/[–—]/g,"-");
    for(let i=0;i<segments.length;i++){
      const s=segments[i],cue=cues[i];if(!s||!Number.isSafeInteger(s.startMs)||!Number.isSafeInteger(s.endMs)||s.startMs<end||s.endMs<=s.startMs||typeof s.text!=="string"||!s.text.trim())return undefined;
      if(typeof data.durationMs==="number"&&(!Number.isFinite(data.durationMs)||s.endMs>data.durationMs))return undefined;
      if(s.startMs!==cue.startMs||s.endMs!==cue.endMs||normalize(s.text)!==normalize(cue.text))return undefined;
      const expected=`- [${stamp(s.startMs)} - ${stamp(s.endMs)}] ${s.text}`.replace(/[–—]/g,"-");const found=canonical.indexOf(expected,position);if(found<0)return undefined;position=found+expected.length;end=s.endMs;
    }
    const language=typeof data.language==="string"?data.language:undefined,mdLanguage=/语言[：:]\s*([^\r\n]+)/.exec(md)?.[1]?.trim();if(language&&mdLanguage&&language!==mdLanguage)return undefined;
    const fingerprint=processingFingerprint({engine:data.engine,engineVersion:data.engineVersion,model:data.model,device:data.device,computeType:data.computeType,requestedLanguage:data.requestedLanguage,requestedComputeType:data.requestedComputeType,hotwords:data.hotwords});
    return {language,model:typeof data.model==="string"?data.model:undefined,fingerprint,data};
  }catch{return undefined;}
}
