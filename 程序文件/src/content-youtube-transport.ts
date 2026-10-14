import { request,ProxyAgent } from "undici";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { fetchPublic,resolvePublicHost,privateAddress,type PublicNetworkHop } from "./content-network.js";

/** Existing local HTTP proxy only. This does not activate a service or reuse parser credentials. */
export function validateYoutubeProxy(value:string):string {
  let url:URL;try{url=new URL(value);}catch{throw new Error("YouTube 代理地址无效");}
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=="/"||!["127.0.0.1","[::1]","localhost"].includes(url.hostname)||!url.port)throw new Error("YouTube 只接受本机已有、无凭据的 HTTP(S) 代理地址");
  return url.toString();
}
export function configuredYoutubeProxy(env:NodeJS.ProcessEnv=process.env):string|undefined {
  const value=env.CONTENT_YOUTUBE_PROXY?.trim()||env.HTTPS_PROXY?.trim()||env.HTTP_PROXY?.trim();return value?validateYoutubeProxy(value):undefined;
}
/** One saved choice is shared by metadata, media and the app's dedicated login browser. */
export async function configuredYoutubeNetwork(runtimeRoot:string,env:NodeJS.ProcessEnv=process.env):Promise<{mode:"auto"|"direct"|"proxy";proxyUrl?:string}> {
  const {readContentSettings}=await import("./content-settings.js");
  const setting=(await readContentSettings(runtimeRoot)).youtubeNetwork??{mode:"auto" as const};
  const proxyUrl=setting.mode==="direct"?undefined:setting.mode==="proxy"?validateYoutubeProxy(setting.proxyUrl!):configuredYoutubeProxy(env);
  return {mode:setting.mode,...(proxyUrl?{proxyUrl}:{})};
}
const youtubeHost=(host:string)=>["googlevideo.com","youtube.com","youtu.be","ytimg.com"].some(domain=>host===domain||host.endsWith(`.${domain}`));
type Address={address:string;family:number};
/** A bounded, certificate-verified DNS reply must match the exact official query and contain only public IPv4 answers. */
export function youtubeDohAddress(host:string,data:unknown):Address {
  if(!youtubeHost(host)||!data||typeof data!=="object")throw new Error("YouTube 安全域名解析返回无效");
  const reply=data as {Status?:number;TC?:boolean;Question?:Array<{name?:string;type?:number}>;Answer?:Array<{type?:number;data?:string}>};
  if(reply.Status!==0||reply.TC||reply.Question?.length!==1||reply.Question[0].type!==1||reply.Question[0].name?.replace(/\.$/,"").toLowerCase()!==host.toLowerCase()||!Array.isArray(reply.Answer)||reply.Answer.length>64)throw new Error("YouTube 安全域名解析没有匹配目标");
  const answers=reply.Answer.filter(a=>a.type===1).map(a=>a.data);
  if(!answers.length||answers.some(address=>typeof address!=="string"||isIP(address)!==4||privateAddress(address)))throw new Error("YouTube 安全域名解析返回私网或无效地址");
  return {address:answers[0]!,family:4};
}
async function dohAddress(proxy:string,host:string,signal?:AbortSignal):Promise<Address> {
  const deadline=AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]),dispatcher=new ProxyAgent({uri:proxy,requestTls:{servername:"dns.google"},headersTimeout:10000,bodyTimeout:10000});
  const endpoint=new URL("https://8.8.8.8/resolve");endpoint.searchParams.set("name",host);endpoint.searchParams.set("type","A");endpoint.searchParams.set("edns_client_subnet","0.0.0.0/0");
  try {
    const result=await request(endpoint,{dispatcher,signal:deadline,method:"GET",headers:{host:"dns.google",accept:"application/dns-json"}});
    if(result.statusCode!==200){result.body.destroy();throw new Error("YouTube 安全域名解析暂不可用");}
    let size=0;const chunks:Buffer[]=[];for await(const chunk of result.body){size+=chunk.length;if(size>65536){result.body.destroy();throw new Error("安全域名解析响应过大");}chunks.push(Buffer.from(chunk));}
    return youtubeDohAddress(host,JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }finally{await dispatcher.destroy().catch(()=>{});}
}
function tlsConnectionError(error:unknown):boolean {
  for(let depth=0;error&&typeof error==="object"&&depth<4;depth++){const e=error as {code?:string;message?:string;cause?:unknown};if(/TLS|certificate|secure TLS/i.test(e.message??"")||["ECONNRESET","UND_ERR_CONNECT_TIMEOUT","CERT_HAS_EXPIRED","ERR_TLS_CERT_ALTNAME_INVALID","UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(e.code??""))return true;error=e.cause;}
  return false;
}
async function proxyHop(proxy:string,url:URL,init:RequestInit,signal:AbortSignal|undefined,cache:Map<string,{value:Address;until:number}>):Promise<Response> {
  const hit=cache.get(url.hostname),resolved=hit&&hit.until>Date.now()?hit.value:await resolvePublicHost(url.hostname,signal);
  try{return await proxyRequest(proxy,url,init,signal,resolved);}catch(error){
    if(signal?.aborted||url.protocol!=="https:"||!tlsConnectionError(error))throw error;
    const address=await dohAddress(proxy,url.hostname,signal);cache.set(url.hostname,{value:address,until:Date.now()+120000});
    return proxyRequest(proxy,url,init,signal,address);
  }
}
async function proxyRequest(proxy:string,url:URL,init:RequestInit,signal:AbortSignal|undefined,resolved:Address):Promise<Response> {
  const method=(init.method??"GET").toUpperCase();if(!["GET","HEAD"].includes(method)||init.body!=null)throw new Error("YouTube 媒体代理只处理读取请求");
  const target=new URL(url);
  target.hostname=resolved.family===6?`[${resolved.address}]`:resolved.address;
  const headers=new Headers(init.headers);headers.set("host",url.host);
  for(const name of ["cookie","authorization","proxy-authorization"])headers.delete(name);
  // CONNECT uses the validated public IP. Host and TLS SNI retain the original CDN domain.
  const dispatcher=new ProxyAgent({uri:proxy,requestTls:{servername:url.hostname},headersTimeout:20000,bodyTimeout:30000});
  try {
    const result=await request(target,{method:method as "GET"|"HEAD",headers:Object.fromEntries(headers.entries()),signal:signal??init.signal,dispatcher});
    const outgoing=new Headers();for(const [key,value] of Object.entries(result.headers))if(value!==undefined)outgoing.set(key,Array.isArray(value)?value.join(", "):value);
    if(method==="HEAD"||[204,205,304].includes(result.statusCode)){await result.body.dump();await dispatcher.close();return new Response(null,{status:result.statusCode,headers:outgoing});}
    const reader=(Readable.toWeb(result.body) as ReadableStream<Uint8Array>).getReader();let settled=false;
    const close=async()=>{if(!settled){settled=true;await dispatcher.close();}};
    const body=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){controller.close();await close();}else controller.enqueue(next.value);}catch(error){controller.error(error);await dispatcher.destroy().catch(()=>{});}},async cancel(reason){await reader.cancel(reason).catch(()=>{});await close();}});
    return new Response(body,{status:result.statusCode,headers:outgoing});
  }catch(error){await dispatcher.destroy().catch(()=>{});throw error;}
}
/** The shared redirect loop still checks every hop, strips cross-origin auth, and records final URLs. */
export function youtubeMediaTransport(proxyUrl:string,options:{hop?:PublicNetworkHop}={}):typeof fetchPublic {
  const proxy=validateYoutubeProxy(proxyUrl),cache=new Map<string,{value:Address;until:number}>();
  return (value,init={},signal)=>fetchPublic(value,init,signal,async(url,requestInit,requestSignal)=>{
    if(!youtubeHost(url.hostname.toLowerCase()))throw new Error("YouTube 媒体代理只访问 YouTube 官方媒体域名");
    return (options.hop??((u,i,s)=>proxyHop(proxy,u,i,s,cache)))(url,requestInit,requestSignal);
  });
}
