/** Display only; source title, identity and indexed text stay intact. */
export function contentDisplayTitle(value:string):string{
  const title=value.replace(/\s+/g," ").trim(),characters=Array.from(title);
  if(characters.length<=60)return title;
  const sentence=/^(.+?[。！？!?])/.exec(title)?.[1];
  if(sentence&&Array.from(sentence).length<=60)return sentence;
  return characters.slice(0,59).join("").trimEnd()+"…";
}
