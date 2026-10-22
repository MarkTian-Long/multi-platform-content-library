import * as cheerio from "cheerio";
import type { ContentManifest } from "./content-types.js";

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const localPath=(value:string)=>value.split(/[\\/]/).map(encodeURIComponent).join("/");
const isLocal=(value:string)=>!!value&&!/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(value)&&!value.split(/[\\/]/).includes("..")&&!/[\x00-\x1f]/.test(value);
const allowedTags=new Set("section div p span a img h1 h2 h3 h4 h5 h6 strong b em i u s del ins small big mark sub sup br hr pre code blockquote ul ol li table thead tbody tfoot tr th td caption colgroup col dl dt dd ruby rt rp figure figcaption center font".split(" "));
const allowedStyle=/^(?:color|background(?:-color|-image)?|font(?:-family|-size|-weight|-style|-variant)?|line-height|letter-spacing|word-spacing|text-(?:align|indent|decoration|transform|shadow)|white-space|word-break|overflow-wrap|vertical-align|display|box-sizing|box-shadow|(?:-webkit-)?box-decoration-break|opacity|width|min-width|max-width|height|min-height|max-height|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color|radius))?|border-(?:collapse|spacing)|table-layout|list-style(?:-type|-position)?|overflow(?:-[xy])?|object-fit|object-position|aspect-ratio|break-(?:before|after|inside)|page-break-(?:before|after|inside)|orphans|widows|float|clear)$/i;

/** Preserve inert typography/layout, never CSS capable of fetching resources or executing code. */
function safeStyle(source:string):string{
 return source.split(";").flatMap(declaration=>{
  const colon=declaration.indexOf(":");if(colon<1)return[];
  const property=declaration.slice(0,colon).trim().toLowerCase(),value=declaration.slice(colon+1).trim();
  if(!allowedStyle.test(property)||!value||/[\\<>@]|\/\*|(?:url|expression|image-set|cross-fade|paint|var)\s*\(|(?:https?|file|data|javascript)\s*:/i.test(value))return[];
  return[`${property}:${value}`];
 }).join(";");
}

/** Rebuild only the captured article body; the original snapshot is never executed or modified. */
export function renderWechatReadingPage(sourceHtml:string,item:ContentManifest,sanitizeUrl:(value:string)=>string):string|undefined{
 const $=cheerio.load(sourceHtml),content=$("#js_content").first();if(!content.length)return undefined;
 const author=$("#js_name").first().text().trim()||item.author||"",published=$("#publish_time").first().text().trim()||item.publishedAt||"";
 const files=item.assets.filter(a=>a.status==="saved"&&!a.integrityFailed&&a.path&&isLocal(a.path));
 const images=files.filter(a=>a.role==="image"||a.role==="cover"),usedImages=new Set<string>();
 content.find("script,style,link,iframe,object,embed,form,input,button,textarea,select,noscript,svg,canvas,template,base,meta").remove();
 content.find("video,mp-video,audio,source").remove();
 content.find("img").each((index,node)=>{
  const element=$(node),sources=["data-src","data-original","data-actualsrc","src"].map(key=>element.attr(key));
  const asset=images.find(a=>a.sourceUrl&&sources.includes(a.sourceUrl))??images.find(a=>!a.sourceUrl&&a.id===`image-${index+1}`);
  const style=element.attr("data-original-style")??element.attr("style")??"",alt=element.attr("alt")||"图片";
  for(const attribute of Object.keys(node.attribs))element.removeAttr(attribute);
  if(asset?.path){element.attr({src:localPath(asset.path),alt,style:safeStyle(style),loading:"eager",decoding:"sync"});usedImages.add(asset.path);}
  else element.replaceWith($("<span class=\"missing-image\"></span>").text(`${alt}（未保存到本地）`));
 });
 content.find("*").each((_,node)=>{
  if(!("attribs" in node))return;const element=$(node),tag=node.tagName.toLowerCase();
  if(!allowedTags.has(tag)){element.replaceWith(element.contents());return;}
  for(const attribute of Object.keys(node.attribs)){
   const lower=attribute.toLowerCase(),value=element.attr(attribute)??"";
   if(lower==="style"){const style=safeStyle(value);if(style)element.attr("style",style);else element.removeAttr(attribute);continue;}
   if(tag==="a"&&lower==="href"){
    try{const parsed=new URL(value,item.canonicalUrl);if(!["https:","http:"].includes(parsed.protocol))throw new Error();element.attr("href",sanitizeUrl(parsed.href));element.attr("rel","noreferrer noopener");}catch{element.removeAttr(attribute);}continue;
   }
   if(tag==="img"&&["src","alt","loading","decoding"].includes(lower))continue;
   if(["colspan","rowspan","span","start","value","width","height"].includes(lower)&&/^\d{1,4}%?$/.test(value))continue;
   if(["align","valign","dir","lang"].includes(lower)&&/^[a-zA-Z-]{1,16}$/.test(value))continue;
   element.removeAttr(attribute);
  }
 });
 for(const attribute of Object.keys(content.attr()??{}))content.removeAttr(attribute);
 content.attr("id","js_content");
 // Old image records can contain images outside the captured body; keep them accessible without repeating the article.
 const attachments=files.filter(a=>(["video","audio","transcript","ocr"].includes(a.role)||(["image","cover"].includes(a.role)&&!usedImages.has(a.path!))));
 const links=attachments.map(a=>`<li><a href="${escapeHtml(localPath(a.path!))}">${escapeHtml(a.label||a.path!)}</a>${a.role==="video"?`<video controls preload="none" src="${escapeHtml(localPath(a.path!))}"></video>`:a.role==="audio"?`<audio controls preload="none" src="${escapeHtml(localPath(a.path!))}"></audio>`:""}</li>`).join("");
 const sourceLink=/^https?:\/\//i.test(item.canonicalUrl)?`<a href="${escapeHtml(sanitizeUrl(item.canonicalUrl))}" rel="noreferrer noopener">查看公众号原文</a>`:"";
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(item.title)}</title><style>
body{margin:0;background:#f5f5f5;color:#333;font:16px/1.8 -apple-system,BlinkMacSystemFont,'Microsoft YaHei',sans-serif}main{max-width:677px;margin:0 auto;padding:32px 24px;background:#fff;overflow-wrap:break-word}header h1{font-size:24px;line-height:1.45;margin:0 0 12px}header .byline{font-size:14px;color:#777;margin:0 0 24px}#js_content{font-size:16px;line-height:1.8;overflow-wrap:break-word}#js_content img{max-width:100%!important;height:auto!important;vertical-align:middle}#js_content table{max-width:100%}#js_content pre{white-space:pre-wrap;overflow-wrap:anywhere}footer,details{margin-top:24px;font-size:13px;color:#777}details li{margin:8px 0}video,audio{display:block;max-width:100%}.warning,.missing-image{color:#8a4b12}.warning{padding:12px;background:#fff7e9}a{color:inherit}header h1,h2,h3,h4{break-after:avoid}p{orphans:2;widows:2}@media(max-width:600px){main{padding:24px 16px}}@media print{body{background:#fff}main{padding:0;max-width:677px}details,footer{display:none!important}#js_content img{max-height:250mm;object-fit:contain;break-inside:avoid}#js_content{overflow:visible}#js_content a{text-decoration:none}}
</style></head><body><main><header><h1>${escapeHtml(item.title)}</h1>${author||published?`<p class="byline">${escapeHtml([author,published].filter(Boolean).join(" · "))}</p>`:""}</header>${item.warnings.length?`<aside class="warning">${item.warnings.map(escapeHtml).join("<br>")}</aside>`:""}${$.html(content)}${links?`<details><summary>本地附件与识别稿</summary><ul>${links}</ul></details>`:""}<footer>${sourceLink}</footer></main></body></html>`;
}
