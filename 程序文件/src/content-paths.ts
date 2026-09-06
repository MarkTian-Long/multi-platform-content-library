const escapeRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const encodePath=(value:string)=>value.replaceAll("\\","/").split("/").map(part=>encodeURIComponent(part).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
const isLocal=(value:string)=>!!value&&!/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(value)&&!/[\x00-\x1f]/.test(value);
const attr=(value:string)=>value.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("'","&#39;");

/** Rewrite complete local link targets, never prose or remote URLs. Mapping may be reversed for retries. */
export function rewriteLocalAssetLinks(text:string,mapping:ReadonlyMap<string,string>,options:{allowRemoteSources?:boolean}={}):string{
 let marker="\u0000local-rename-";while(text.includes(marker))marker+="x";
 const replacements:string[]=[];
 const token=(value:string)=>`${marker}${replacements.push(value)-1}\u0000`;
 const pairs=[...mapping].filter(([from,to])=>(isLocal(from)||(options.allowRemoteSources&&/^https?:\/\//i.test(from)))&&isLocal(to)&&from!==to);
 const chunks=text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
 for(let index=0;index<chunks.length;index+=2){
   let chunk=chunks[index];
   for(const [from,to] of pairs){
     const normalized=from.replaceAll("\\","/");
     const variants=new Set([from,normalized,encodePath(from),normalized.split("/").map(encodeURIComponent).join("/"),encodeURI(normalized)]);
     for(const variant of [...variants].sort((a,b)=>b.length-a.length)){
       const exact=escapeRegex(variant),replacement=()=>token(encodePath(to));
       chunk=chunk.replace(new RegExp(`(!?\\[[^\\]\\r\\n]*\\]\\(\\s*<?)${exact}(>?\\s*(?:["'][^\\r\\n]*?["']\\s*)?\\))`,"g"),(_match,start,end)=>start+replacement()+end);
       chunk=chunk.replace(new RegExp(`^(\\s{0,3}\\[[^\\]\\r\\n]+\\]:\\s*<?)${exact}(>?\\s*(?:["'][^\\r\\n]*?["'])?\\s*)$`,"gm"),(_match,start,end)=>start+replacement()+end);
       for(const htmlVariant of new Set([variant,attr(variant)])){
         chunk=chunk.replace(new RegExp(`(<[a-zA-Z][^>]*?\\b(?:src|href)\\s*=\\s*["'])${escapeRegex(htmlVariant)}(["'])`,"g"),(_match,start,end)=>start+replacement()+end);
       }
     }
   }
   chunks[index]=chunk;
 }
 return chunks.join("").replace(new RegExp(`${escapeRegex(marker)}(\\d+)\u0000`,"g"),(_match,index)=>replacements[Number(index)]);
}
