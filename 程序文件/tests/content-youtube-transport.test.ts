import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {configuredYoutubeProxy,validateYoutubeProxy,youtubeMediaTransport,youtubeDohAddress} from "../src/content-youtube-transport.js";
import {savePublicAsset,fetchedPublicUrl} from "../src/content-network.js";
test("only existing local proxies without credentials are accepted and explicit scope wins",()=>{
  assert.equal(configuredYoutubeProxy({}),undefined);assert.equal(configuredYoutubeProxy({CONTENT_YOUTUBE_PROXY:"http://127.0.0.1:7890",HTTPS_PROXY:"http://localhost:9999"}),"http://127.0.0.1:7890/");for(const value of ["socks5://127.0.0.1:7890","http://remote.example:8080","http://u:p@localhost:7890","http://127.0.0.1:7890/private","http://127.0.0.1"])assert.throws(()=>validateYoutubeProxy(value));
});
test("redirects are validated, scoped to official hosts, strip auth and retain final source identity",async t=>{
  t.mock.method(dns,"lookup",async()=>[{address:"93.184.216.34",family:4}]);const visited:Array<{url:string;headers:Headers}>=[];
  const transport=youtubeMediaTransport("http://127.0.0.1:7890",{hop:async(url,init)=>{visited.push({url:url.toString(),headers:new Headers(init.headers)});return visited.length===1?new Response(null,{status:302,headers:{location:"https://cdn.googlevideo.com/movie"}}):new Response("video bytes",{headers:{"content-type":"video/mp4"}});}});
  const response=await transport("https://www.youtube.com/media",{headers:{cookie:"private",authorization:"Bearer private"}});assert.equal(await response.text(),"video bytes");assert.equal(visited[1].headers.has("cookie"),false);assert.equal(visited[1].headers.has("authorization"),false);assert.equal(fetchedPublicUrl(response),"https://cdn.googlevideo.com/movie");
  const unsafe=youtubeMediaTransport("http://localhost:7890",{hop:async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1/private"}})});await assert.rejects(unsafe("https://www.youtube.com/media"),/私网/);
  await assert.rejects(transport("https://evil.example/video"),/官方媒体域名/);
});
test("custom transport keeps downloader streaming limits and cancellation",async t=>{
  t.mock.method(dns,"lookup",async()=>[{address:"93.184.216.34",family:4}]);const directory=await fs.mkdtemp(path.join(os.tmpdir(),"youtube-proxy-limit-"));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const transport=youtubeMediaTransport("http://localhost:7890",{hop:async()=>new Response("video-bytes-too-large",{headers:{"content-type":"video/mp4","content-length":"21"}})});
  const asset=await savePublicAsset("https://cdn.googlevideo.com/movie",directory,"movie","video",undefined,4,undefined,transport);assert.notEqual(asset.status,"saved");assert.match(asset.reason??"",/上限/);assert.deepEqual(await fs.readdir(directory),[]);
  const controller=new AbortController();controller.abort();const cancelled=await savePublicAsset("https://cdn.googlevideo.com/movie",directory,"movie","video",controller.signal,100,undefined,transport);assert.notEqual(cancelled.status,"saved");assert.deepEqual(await fs.readdir(directory),[]);
});
test("secure DNS replies bind the exact official hostname and reject private, truncated or mixed answers",()=>{
  const response={Status:0,TC:false,Question:[{name:"cdn.googlevideo.com.",type:1}],Answer:[{type:1,data:"142.250.191.46"}]};assert.deepEqual(youtubeDohAddress("cdn.googlevideo.com",response),{address:"142.250.191.46",family:4});
  for(const bad of [{...response,TC:true},{...response,Status:2},{...response,Question:[{name:"evil.example.",type:1}]},{...response,Answer:[{type:1,data:"127.0.0.1"}]},{...response,Answer:[...response.Answer,{type:1,data:"10.0.0.1"}]},{...response,Answer:[{type:1,data:"malformed"}]}])assert.throws(()=>youtubeDohAddress("cdn.googlevideo.com",bad));assert.throws(()=>youtubeDohAddress("evil.example",response));
});
