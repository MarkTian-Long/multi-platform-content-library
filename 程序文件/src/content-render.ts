import type { ContentAsset, ContentManifest } from "./content-types.js";
import { contentDisplayTitle } from "./content-display.js";

const html=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const local=(value:string)=>value.split(/[\\/]/).map(encodeURIComponent).join("/");
const platforms:Record<string,string>={wechat:"微信公众号",wechat_channels:"微信视频号",xiaohongshu:"小红书",bilibili:"B 站",youtube:"YouTube",douyin:"抖音",weibo:"微博",local:"本地文件",web:"网页"};
const statuses:Record<string,string>={saved:"已保存",completed:"已完成",partial:"部分保存",failed:"未完成",unavailable:"暂未取得",login_required:"需要登录或验证",missing_dependency:"需要安装处理工具",skipped:"未处理"};
const roles:Record<string,string>={image:"图片",video:"视频",audio:"音频",cover:"封面",subtitle:"字幕",transcript:"文字稿",frame:"视频抽样画面",ocr:"图片文字",comments:"评论",danmaku:"弹幕",source:"来源资料",reading:"阅读页",pdf:"PDF"};
const origins:Record<string,string>={original:"原始资料",platform_subtitle:"平台字幕整理",machine_asr:"机器语音识别",machine_ocr:"机器图片识别",sampled_frame:"按时间抽样",generated:"本地生成",user_edited:"用户校订，机器原稿已保留"};

function inline(text:string,files:Set<string>,bodyImages:Set<string>):string {
 const tokens: string[]=[];
 const token=(value:string)=>`\u0000${tokens.push(value)-1}\u0000`;
 // Keep generated markup outside subsequent replacements; all source text is escaped.
 let safe=text.replace(/\u0000/g,"").replace(/`([^`\n]+)`/g,(_,code:string)=>token(`<code>${html(code)}</code>`));
 safe=safe.replace(/(!?)\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,(_,image:string,label:string,url:string)=>{
   let decoded=url;try{decoded=decodeURIComponent(url);}catch{}
   const saved=files.has(decoded.replaceAll("\\","/"));
   if(image){if(saved)bodyImages.add(decoded.replaceAll("\\","/"));return token(saved?`<img loading="lazy" src="${html(local(decoded))}" alt="${html(label)}">`:`<span class="meta">${html(label||"图片")}（未保存到本地）</span>`);}
   const href=saved?local(decoded):/^https?:\/\//i.test(url)?url:undefined;
   return token(href?`<a href="${html(href)}" rel="noreferrer">${html(label)}</a>`:html(label));
 });
 safe=html(safe).replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/\*([^*\n]+)\*/g,"<em>$1</em>");
 return safe.replace(/\u0000(\d+)\u0000/g,(_,index:string)=>tokens[Number(index)]??"");
}

function markdownBody(source:string,files:Set<string>,title:string,bodyImages:Set<string>):string {
 const lines=source.replace(/\r/g,"").split("\n"),blocks:string[]=[];
 for(let i=0;i<lines.length;){
   const line=lines[i];if(!line.trim()){i++;continue;}
   if(/^```/.test(line)){const code:string[]=[];i++;while(i<lines.length&&!/^```/.test(lines[i]))code.push(lines[i++]);i++;blocks.push(`<pre><code>${html(code.join("\n"))}</code></pre>`);continue;}
   const heading=/^(#{1,6})\s+(.+)$/.exec(line);
   if(heading){i++;if(blocks.length===0&&heading[2].trim()===title.trim())continue;const level=Math.min(6,Math.max(2,heading[1].length));blocks.push(`<h${level}>${inline(heading[2],files,bodyImages)}</h${level}>`);continue;}
   if(/^\s*(?:[-*+] |\d+\. )/.test(line)){const ordered=/^\s*\d+\. /.test(line),items:string[]=[];while(i<lines.length&&/^\s*(?:[-*+] |\d+\. )/.test(lines[i]))items.push(`<li>${inline(lines[i++].replace(/^\s*(?:[-*+] |\d+\. )/,""),files,bodyImages)}</li>`);const tag=ordered?"ol":"ul";blocks.push(`<${tag}>${items.join("")}</${tag}>`);continue;}
   if(/^>\s?/.test(line)){const quote:string[]=[];while(i<lines.length&&/^>\s?/.test(lines[i]))quote.push(lines[i++].replace(/^>\s?/,""));blocks.push(`<blockquote>${inline(quote.join("\n"),files,bodyImages)}</blockquote>`);continue;}
   const paragraph:string[]=[];while(i<lines.length&&lines[i].trim()&&!/^(?:#{1,6}\s|```|>\s)/.test(lines[i]))paragraph.push(lines[i++]);blocks.push(`<p class="body">${inline(paragraph.join("\n"),files,bodyImages)}</p>`);
 }return blocks.join("\n");
}

function coverageNotes(item:ContentManifest):string[] {
 const labels:Record<string,string>={body:"正文",media:"媒体",photos:"图集原图",livePhotos:"实况照片动态",subtitles:"平台字幕",comments:"评论",danmaku:"弹幕",parts:"视频分段",metadata:"标题与简介"};
 return Object.entries(item.coverage??{}).filter(([key])=>key!=="legacyArticleId").map(([key,value])=>{
   const prefix=key.split(":")[0];
   if(prefix==="part"&&key.endsWith(":duration")&&/unknown|mismatch/.test(value))return "部分视频的时长尚未核实，请核对原视频";
   if(/[\u4e00-\u9fff]/.test(value))return value;
   const label=labels[prefix];if(!label)return "";
   if(/unknown|unavailable|not_attempted|failed|cancelled/.test(value))return `${label}：${/unknown/.test(value)?"覆盖范围尚未确认":/cancelled/.test(value)?"本次处理已取消":"本次未取得"}`;
   if(/login_required/.test(value))return `${label}：需要在专用浏览器完成登录或验证`;
   if(/saved/.test(value))return `${label}：已保存本次可取得的内容`;
   return "";
 }).filter(Boolean);
}

function assetBlock(asset:ContentAsset,files:Set<string>,bodyImages:Set<string>):string {
 const href=asset.path&&files.has(asset.path)?local(asset.path):"";
 const caption=`${roles[asset.role]||asset.role}${asset.label?` · ${asset.label}`:""}`;
 const quality=asset.quality, container=/\.(heic|heif)$/i.exec(asset.path||"")?.[1].toUpperCase();
 const dimensions=quality?.width&&quality.height?`${quality.width} × ${quality.height}`:"";
 const watermark=quality?quality.watermark==="none"?"平台标记无水印":quality.watermark==="present"?"来源版本带水印":"水印状态未确认":"";
 const version=quality?.rendition==="original"?"原对象文件":quality?.rendition==="preview"?"网页预览，原图另存":quality?"平台提供版本":"";
 const resolution=quality?.resolution==="smaller_than_source"?"小于来源声明尺寸":quality?.resolution==="matches_source"?"达到来源声明尺寸":"";
 const result=[statuses[asset.status]||asset.status,origins[asset.provenance??""],container,dimensions,version,watermark,resolution,asset.reason].filter(Boolean).join(" · ");
 const media=asset.status==="saved"&&href?(["image","cover","frame"].includes(asset.role)?container?`<a href="${html(href)}">打开 ${html(container)} 原文件</a><p class="meta">原文件未转码；可使用支持该格式的图片软件打开。</p>`:`<a href="${html(href)}"><img loading="lazy" src="${html(href)}" alt="${html(caption)}"></a>`:asset.role==="video"?`<video controls preload="metadata" src="${html(href)}"></video>`:asset.role==="audio"?`<audio controls preload="none" src="${html(href)}"></audio>`:`<a href="${html(href)}">打开${html(roles[asset.role]||"文件")}</a>`):"";
 const originalMedia=["video","audio"].includes(asset.role)&&(!asset.provenance||asset.provenance==="original");
 const printable=asset.status==="saved"&&!asset.integrityFailed&&href&&((["image","cover","frame"].includes(asset.role)&&!bodyImages.has(asset.path!.replaceAll("\\","/")))||originalMedia);
 const printLink=printable&&originalMedia?`<p class="print-only">${html(roles[asset.role])}已单独保存：<a href="${html(href)}">${html(asset.path!)}</a></p>`:"";
 return `<section class="asset${printable?"":" print-suppressed"}"><h3>${html(caption)}</h3><p class="meta">${html(result)}</p>${media}${printLink}</section>`;
}

/** The caller supplies an already redacted manifest and Markdown. No remote assets are loaded. */
export function renderReadingPage(item:ContentManifest,markdown:string):string {
  const displayTitle=contentDisplayTitle(item.title);
 const files=new Set(item.assets.filter(a=>a.status==="saved"&&a.path&&!a.path.split(/[\\/]/).includes("..")).map(a=>a.path!));
 const original=item.platform==="local"?item.assets.find(asset=>asset.provenance==="original"&&asset.path&&files.has(asset.path)):undefined;
 const sourceLink=original?.path?`<p><a href="${html(local(original.path))}">打开保存的原文件</a></p>`:/^https?:\/\//i.test(item.canonicalUrl)?`<p><a href="${html(item.canonicalUrl)}" rel="noreferrer">查看原始来源</a></p>`:"<p class=\"meta\">来源：本地文件</p>";
 const notes=[...new Set(coverageNotes(item))];
 const date=new Date(item.capturedAt);const captured=Number.isNaN(date.getTime())?item.capturedAt:date.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
 const bodyImages=new Set<string>(),body=markdownBody(markdown,files,item.title,bodyImages);
 const parts=item.parts?.length?`<h2>视频分段</h2><ul>${item.parts.map(p=>`<li>${html(p.title)} · ${html(statuses[p.status]||p.status)}${p.reason?` · ${html(p.reason)}`:""}</li>`).join("")}</ul>`:"";
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(displayTitle)}</title><style>body{font:17px/1.8 'Microsoft YaHei',sans-serif;color:#253630;background:#f4f5f0;margin:0}main{max-width:880px;margin:auto;padding:40px 28px;background:white;min-height:90vh}h1{font-size:32px;line-height:1.45;margin:12px 0 20px}h2{font-size:24px;margin-top:32px}h3{font-size:18px;margin:0}.meta{color:#607068;font-size:14px}.badge{display:inline-block;background:#edf2ed;border-radius:6px;padding:2px 10px;font-size:14px}.body,blockquote{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#176c62;text-underline-offset:3px}img,video{display:block;max-width:100%;max-height:720px;margin:12px 0}audio{width:100%}.asset{border-top:1px solid #ddd;margin-top:20px;padding:16px 0}.warning{background:#fff4d9;padding:14px;border-radius:6px}blockquote{border-left:3px solid #aac6b8;margin-left:0;padding-left:18px;color:#4b5e54}pre{background:#f5f6f3;padding:16px;overflow:auto}code{font:14px/1.7 Consolas,monospace}.notes{font-size:15px;color:#5d675f}.print-only{display:none}@media(max-width:640px){main{padding:22px 18px}h1{font-size:26px}}@media print{body{background:white}main{padding:0;min-height:0;max-width:none}video,audio,.screen-only,.print-suppressed{display:none!important}.print-only{display:block}.asset{break-inside:avoid}h1,h2,h3{break-after:avoid}img{max-height:650px}}</style></head><body><main><span class="badge">${html(statuses[item.status]||item.status)}</span><h1>${html(displayTitle)}</h1><p class="meta">${html([platforms[item.platform]||item.platform,item.author,`保存于 ${captured}`].filter(Boolean).join(" · "))}</p>${sourceLink}${item.warnings.length?`<div class="warning">${item.warnings.map(html).join("<br>")}</div>`:""}${body}${parts}${item.assets.length?`<h2 class="screen-only">文件与处理结果</h2>${item.assets.map(a=>assetBlock(a,files,bodyImages)).join("")}`:""}${notes.length?`<h2>采集说明</h2><ul class="notes">${notes.map(note=>`<li>${html(note)}</li>`).join("")}</ul>`:""}</main></body></html>`;
}
