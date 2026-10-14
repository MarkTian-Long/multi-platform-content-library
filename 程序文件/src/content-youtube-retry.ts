export interface YoutubeCooldown { until:string; failures:number; paused:boolean; }
export const YOUTUBE_AUTOMATIC_RETRIES = 3;
const waits=[5,15,30].map(minutes=>minutes*60000);

export function retryTimestamp(value:unknown):number|undefined {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))return undefined;
  const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value?time:undefined;
}
/** RFC Retry-After accepts delay-seconds or an HTTP date; malformed headers use the default backoff. */
export function youtubeRetryAfter(value:string|null,now=Date.now()):string|undefined {
  if(!value||value.length>128)return undefined;
  const text=value.trim();
  const timestamp=/^\d+$/.test(text)?now+Number(text)*1000:/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)?Date.parse(text):NaN;
  if(!Number.isFinite(timestamp)||timestamp<=now||timestamp>253402300799999)return undefined;
  return new Date(timestamp).toISOString();
}
export function nextYoutubeCooldown(previous:YoutubeCooldown|undefined,retryAfter:string|undefined,now:number):YoutubeCooldown {
  const failures=Math.min(YOUTUBE_AUTOMATIC_RETRIES+1,(previous?.failures??0)+1);
  const until=Math.max(now+waits[Math.min(failures-1,waits.length-1)],retryTimestamp(previous?.until)??0,retryTimestamp(retryAfter)??0);
  return {until:new Date(until).toISOString(),failures,paused:failures>YOUTUBE_AUTOMATIC_RETRIES};
}
