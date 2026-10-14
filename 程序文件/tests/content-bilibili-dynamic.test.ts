import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {promises as dns} from 'node:dns';
import {acquireBilibiliDynamic,bilibiliDynamicReference,type BilibiliDynamicDeps} from '../src/content-bilibili-dynamic.js';
import {fileHash} from '../src/content-library.js';
import type {ContentContext,ContentInput} from '../src/content-types.js';

const id='1243630122984013862',other='1243630122984013863';
const input:ContentInput={platform:'bilibili',url:`https://t.bilibili.com/${id}?spm_id_from=tracking`,canonicalUrl:`https://t.bilibili.com/${id}`,nativeId:`dynamic:${id}`};
const api=(opus=false)=>`https://api.bilibili.com/x/polymer/web-dynamic/v1/${opus?'opus/':''}detail?id=${id}`;
const picture='https://i0.hdslb.com/bfs/new_dyn/original.png';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGd8AAAAASUVORK5CYII=','base64');
const item=(changes:any={})=>({id_str:id,type:'DYNAMIC_TYPE_WORD',visible:true,modules:{module_author:{name:'原作者',pub_ts:1788393602,face:'https://i0.hdslb.com/avatar.png'},module_dynamic:{desc:{text:'原动态正文\n保留第二行'},major:null}},...changes});
const envelope=(value:any)=>({code:0,data:{item:value}});
const opus=(paragraphs:any[],modules:any[]=[])=>envelope({id_str:id,type:0,modules:[{module_type:'MODULE_TYPE_AUTHOR',module_author:{name:'图文作者',pub_ts:'1788393602'}},{module_type:'MODULE_TYPE_CONTENT',module_content:{paragraphs}},...modules]});
const text=(words:string)=>({para_type:1,text:{nodes:[{type:'TEXT_NODE_TYPE_WORD',word:{words}}]}});

async function context(t:TestContext):Promise<ContentContext>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bilibili-dynamic-'));
  t.after(async()=>{const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('bilibili-dynamic-'))throw new Error('unexpected fixture root');await fs.rm(resolved,{recursive:true,force:true})});
  t.mock.method(dns,'lookup',async()=>[{address:'93.184.216.34',family:4}]);
  return {directory,runtimeRoot:path.join(directory,'runtime')};
}
function deps(raw:any=item(),options:Partial<BilibiliDynamicDeps>={}):BilibiliDynamicDeps{
  return {requestJson:async url=>url===api()?envelope(raw):{code:0,data:{item:null,fallback:{id}}},captureBrowser:async()=>({finalUrl:input.canonicalUrl,gated:false,responses:[]}),saveAsset:async(url,directory,stem,role)=>{
    const relative=`${stem}.png`;await fs.mkdir(path.dirname(path.join(directory,relative)),{recursive:true});await fs.writeFile(path.join(directory,relative),png);
    return {id:stem,role,status:'saved',path:relative,bytes:png.length,sha256:await fileHash(path.join(directory,relative)),mime:'image/png',sourceUrl:url};
  },...options};
}

test('dynamic/opus aliases share a prefixed exact identity',()=>{
  for(const url of [`https://t.bilibili.com/${id}?spm_id_from=1`,`https://www.bilibili.com/opus/${id}/`,`http://bilibili.com/opus/${id}`])assert.deepEqual(bilibiliDynamicReference(url),{nativeId:`dynamic:${id}`,dynamicId:id,canonicalUrl:`https://t.bilibili.com/${id}`});
});
test('feeds, malformed paths, spoofed hosts, credentials and ports have no dynamic identity',()=>{
  for(const value of ['https://t.bilibili.com','https://t.bilibili.com/0','https://t.bilibili.com/00123',`https://t.bilibili.com/${id}/extra`,`https://t.bilibili.com.evil.test/${id}`,`https://user:pass@t.bilibili.com/${id}`,`https://t.bilibili.com:8443/${id}`,`https://www.bilibili.com/video/${id}`,`https://space.bilibili.com/${id}/dynamic`,`https://t.bilibili.com/%31${id.slice(1)}`])assert.equal(bilibiliDynamicReference(value),undefined,value);
});
test('exact text skips Edge, avatars, comments and recommendations',async t=>{
  const ctx=await context(t);let browser=0,media=0;const raw=item({orig:item({id_str:other}),recommendations:[item({id_str:other})]});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{captureBrowser:async()=>{browser++;throw new Error('unexpected')},saveAsset:async()=>{media++;throw new Error('unexpected')}}));
  assert.equal(record.markdown,'原动态正文\n保留第二行');assert.equal(record.author,'原作者');assert.equal(record.nativeId,`dynamic:${id}`);assert.match(record.coverage!.body,/saved/);assert.equal(browser,0);assert.equal(media,0);
});
test('input identity conflicts stop before any official request',async t=>{
  const ctx=await context(t);let requests=0;
  const record=await acquireBilibiliDynamic({...input,nativeId:'BV1XNtJ6UEmm'},ctx,deps(item(),{requestJson:async()=>{requests++;return envelope(item())}}));
  assert.equal(requests,0);assert.equal(record.markdown,'');assert(record.assets.some(a=>a.status==='unavailable'));
});
test('raw and canonical dynamic ID conflicts stop before requests',async t=>{
  const ctx=await context(t);let requests=0;
  const record=await acquireBilibiliDynamic({...input,canonicalUrl:`https://t.bilibili.com/${other}`},ctx,deps(item(),{requestJson:async()=>{requests++;return envelope(item())}}));
  assert.equal(requests,0);assert.equal(record.markdown,'');
});
test('resolved b23 share uses exact canonical identity while preserving source URL',async t=>{
  const ctx=await context(t);const url='https://b23.tv/PublicShare';
  const record=await acquireBilibiliDynamic({...input,url},ctx,deps());assert.equal(record.sourceUrl,url);assert.equal(record.nativeId,`dynamic:${id}`);assert.equal(record.markdown,'原动态正文\n保留第二行');
});
test('an unrelated source cannot claim a target solely through canonicalUrl',async t=>{
  const ctx=await context(t);let requests=0;
  const record=await acquireBilibiliDynamic({...input,url:'https://evil.test/post'},ctx,deps(item(),{requestJson:async()=>{requests++;return envelope(item())}}));assert.equal(requests,0);assert.equal(record.markdown,'');
});
test('risk-control HTTP fallback accepts only exact official Edge responses',async t=>{
  const ctx=await context(t);let requests:string[]=[];
  const record=await acquireBilibiliDynamic(input,ctx,deps(item(),{requestJson:async()=>({code:-352,message:'-352'}),captureBrowser:async(_,__,urls)=>{requests=urls;return {finalUrl:input.canonicalUrl,gated:true,responses:[{url:api(),data:envelope(item())}]}}}));
  assert.equal(record.markdown,'原动态正文\n保留第二行');assert.match(record.coverage!.acquisition,/Edge/);assert.deepEqual(requests,[api(),api(true)]);assert.equal(record.warnings.length,0);
});
test('wrong Edge endpoint/query/item cannot supply a target',async t=>{
  const ctx=await context(t);
  for(const response of [{url:`https://evil.test/detail?id=${id}`,data:envelope(item())},{url:api().replace(id,other),data:envelope(item())},{url:api()+`&id=${id}`,data:envelope(item())},{url:api(),data:envelope(item({id_str:other}))},{url:api().replace('/detail','/feed/all'),data:envelope(item())}]){
    const record=await acquireBilibiliDynamic(input,ctx,deps(item(),{requestJson:async()=>({code:-352}),captureBrowser:async()=>({finalUrl:input.canonicalUrl,gated:false,responses:[response]})}));
    assert.equal(record.markdown,'');assert(!record.assets.some(a=>a.status==='saved'));
  }
});
test('wrong final Edge page cannot supply even matching JSON',async t=>{
  const ctx=await context(t);
  const record=await acquireBilibiliDynamic(input,ctx,deps(item(),{requestJson:async()=>({code:-352}),captureBrowser:async()=>({finalUrl:`https://t.bilibili.com/${other}`,gated:false,responses:[{url:api(),data:envelope(item())}]})}));
  assert.equal(record.markdown,'');assert.match(record.warnings.join(' '),/身份/);
});
test('gated empty Edge result remains login_required',async t=>{
  const ctx=await context(t);
  const record=await acquireBilibiliDynamic(input,ctx,deps(item(),{requestJson:async()=>({code:-352}),captureBrowser:async()=>({finalUrl:input.canonicalUrl,gated:true,responses:[]})}));
  assert.equal(record.markdown,'');assert(record.assets.some(a=>a.status==='login_required'));
});
test('forward stores its own words and does not download original author media',async t=>{
  const ctx=await context(t);let downloads=0;
  const raw=item({type:'DYNAMIC_TYPE_FORWARD',orig:item({id_str:other,type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:{text:'被转发的正文'},major:{type:'MAJOR_TYPE_DRAW',draw:{items:[{src:picture}]}}}}})});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{saveAsset:async()=>{downloads++;throw new Error('unexpected')}}));
  assert.equal(record.markdown,'原动态正文\n保留第二行');assert.equal(downloads,0);assert.match(record.coverage!.forward,/excluded/);
});
test('forward with no own body never borrows orig content',async t=>{
  const ctx=await context(t);const raw=item({type:'DYNAMIC_TYPE_FORWARD',modules:{module_dynamic:{desc:null}},orig:item()});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw));assert.equal(record.markdown,'');assert.match(record.coverage!.body,/unavailable/);
});
test('native opus paragraphs supply full text when dynamic preview has none',async t=>{
  const ctx=await context(t);const raw=item({type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:null,major:{type:'MAJOR_TYPE_DRAW',draw:{items:[{src:picture}]}}}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{requestJson:async url=>url===api()?envelope(raw):opus([text('原图文第一段'),text('完整第二段')])}));
  assert.match(record.markdown,/原图文第一段\n\n完整第二段/);assert.equal(record.author,'图文作者');const asset=record.assets.find(a=>a.role==='image')!;assert.equal(asset.status,'saved');assert.equal(asset.bytes,png.length);assert.equal(asset.sha256,await fileHash(path.join(ctx.directory,asset.path!)));assert.match(record.coverage!.body,/saved/);
});
test('opus top album and inline paragraphs share de-duplicated original pictures',async t=>{
  const ctx=await context(t);const raw=item({type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:null,major:{type:'MAJOR_TYPE_OPUS',opus:{summary:{text:'预览'},pics:[{url:picture}]}}}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{requestJson:async url=>url===api()?envelope(raw):opus([text('全文'),{para_type:2,pic:{pics:[{url:picture}]}}],[{module_type:'MODULE_TYPE_TOP',module_top:{display:{album:{pics:[{url:picture}]}}}}])}));
  assert.equal(record.assets.filter(a=>a.role==='image'&&a.status==='saved').length,1);assert(!record.markdown.includes('预览'));
});
test('wrong opus ID cannot replace dynamic body with other full text',async t=>{
  const ctx=await context(t);const raw=item({modules:{module_dynamic:{desc:{text:'本条短文'},major:{type:'MAJOR_TYPE_OPUS',opus:{summary:{text:'短预览'}}}}}});
  const wrong=opus([text('其他动态全文')]);wrong.data.item.id_str=other;
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{requestJson:async url=>url===api()?envelope(raw):wrong}));
  assert.equal(record.markdown,'本条短文');assert.match(record.coverage!.body,/partial|unknown/);
});
test('unknown opus paragraph content marks partial coverage',async t=>{
  const ctx=await context(t);const raw=item({type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:null}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{requestJson:async url=>url===api()?envelope(raw):opus([text('已识别文字'),{para_type:999,unexpected:{text:'未识别段'}}])}));
  assert.match(record.markdown,/已识别文字/);assert.match(record.coverage!.body,/partial|unknown/);assert(record.warnings.length);
});
test('malformed known opus text nodes do not receive complete-body coverage',async t=>{
  const ctx=await context(t);const raw=item({type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:null}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{requestJson:async url=>url===api()?envelope(raw):opus([text('可读取的文字'),{para_type:1,text:{nodes:[{type:'TEXT_NODE_TYPE_WORD',word:{words:42}}]}}])}));
  assert.match(record.markdown,/可读取的文字/);assert.match(record.coverage!.body,/partial|unknown/);
});
test('cancellation after a durable original image retains that asset and its checkpoint',async t=>{
  const ctx=await context(t),controller=new AbortController();const raw=item({type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:{text:'文字'},major:{type:'MAJOR_TYPE_DRAW',draw:{items:[{src:picture},{src:picture.replace('original','second')}]}}}}});
  let saves=0,checkpoints=0;const fixture=deps(raw),save=fixture.saveAsset!;
  fixture.saveAsset=async(...args)=>{saves++;return save(...args)};
  const record=await acquireBilibiliDynamic(input,{...ctx,signal:controller.signal,onCheckpoint:async value=>{if(value.assets.some(a=>a.role==='image'&&a.status==='saved')){checkpoints++;controller.abort()}}},fixture);
  assert.equal(saves,1);assert(checkpoints);const image=record.assets.find(a=>a.role==='image'&&a.status==='saved')!;assert.equal(await fileHash(path.join(ctx.directory,image.path!)),image.sha256);assert.match(record.coverage!.media,/cancelled/);assert.deepEqual(await fs.readdir(path.join(ctx.directory,'.bilibili-dynamic-downloads')),[]);
});
test('original video is an exact reference and truncated archive desc is not body',async t=>{
  const ctx=await context(t);const bvid='BV1XNtJ6UEmm';const raw=item({type:'DYNAMIC_TYPE_AV',modules:{module_dynamic:{desc:null,major:{type:'MAJOR_TYPE_ARCHIVE',archive:{bvid,title:'原视频标题',desc:'截断的原视频简介',jump_url:`//www.bilibili.com/video/${bvid}/`}}}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw));assert.equal(record.kind,'video');assert.match(record.markdown,new RegExp(bvid));assert(!record.markdown.includes('截断的原视频简介'));assert.match(record.coverage!.body,/unavailable/);assert(record.assets.some(a=>a.role==='video'&&a.status==='unavailable'));assert.match(record.coverage!.videoReference,/BV1XNtJ6UEmm/);
});
test('conflicting archive jump URL is not a video reference',async t=>{
  const ctx=await context(t);const raw=item({type:'DYNAMIC_TYPE_AV',modules:{module_dynamic:{desc:null,major:{type:'MAJOR_TYPE_ARCHIVE',archive:{bvid:'BV1XNtJ6UEmm',title:'原视频',jump_url:'https://www.bilibili.com/video/BV1NJ411C77L/'}}}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw));assert(!record.markdown.includes('BV1'));assert.match(record.coverage!.videoReference,/unavailable/);
});
test('hidden or deleted items are not accepted as original content',async t=>{
  const ctx=await context(t);
  for(const raw of [item({visible:false}),item({type:'DYNAMIC_TYPE_NONE'}),item({id_str:Number(id)})]){const record=await acquireBilibiliDynamic(input,ctx,deps(raw));assert.equal(record.markdown,'');assert(!record.assets.some(a=>a.status==='saved'))}
});
test('private image target is never passed to a downloader',async t=>{
  const ctx=await context(t);let saves=0;const raw=item({type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:{text:'文字'},major:{type:'MAJOR_TYPE_DRAW',draw:{items:[{src:'http://127.0.0.1/private.png'}]}}}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{saveAsset:async()=>{saves++;throw new Error('unexpected')}}));assert.equal(saves,0);assert(!record.assets.some(a=>a.status==='saved'));assert.match(record.coverage!.images,/unavailable|partial|unknown/);
});
test('bad image integrity preserves a previous good destination',async t=>{
  const ctx=await context(t);await fs.mkdir(path.join(ctx.directory,'images'));await fs.writeFile(path.join(ctx.directory,'images/001.png'),'old-good');
  const raw=item({type:'DYNAMIC_TYPE_DRAW',modules:{module_dynamic:{desc:{text:'文字'},major:{type:'MAJOR_TYPE_DRAW',draw:{items:[{src:picture}]}}}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw,{saveAsset:async(_,directory,stem,role)=>{await fs.writeFile(path.join(directory,`${stem}.png`),png);return {id:stem,role,status:'saved',path:`${stem}.png`,bytes:png.length,sha256:'0'.repeat(64),mime:'image/png'}}}));
  assert.equal(await fs.readFile(path.join(ctx.directory,'images/001.png'),'utf8'),'old-good');assert(record.assets.some(a=>a.status==='failed'));assert.deepEqual(await fs.readdir(path.join(ctx.directory,'.bilibili-dynamic-downloads')),[]);
});
test('pre-cancelled call creates no browser or asset',async t=>{
  const ctx=await context(t);const controller=new AbortController();controller.abort();let requests=0;
  const record=await acquireBilibiliDynamic(input,{...ctx,signal:controller.signal},deps(item(),{requestJson:async()=>{requests++;return envelope(item())}}));assert.equal(requests,0);assert.equal(record.markdown,'');assert.match(record.coverage!.media,/cancelled/);
});
test('body exceeding budget is not truncated and passed off as complete',async t=>{
  const ctx=await context(t);const raw=item({modules:{module_dynamic:{desc:{text:'字'.repeat(1400000)}}}});
  const record=await acquireBilibiliDynamic(input,ctx,deps(raw));assert.equal(record.markdown,'');assert.match(record.warnings.join(' '),/上限/);
});
