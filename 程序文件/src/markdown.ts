import type { ArticleRecord } from "./article.js";

export function renderArticleMarkdown(article: ArticleRecord): string {
  const lines = [`# ${article.title}`, `source: ${article.sourceUrl}`, `status: ${article.status}`, `captured: ${article.extractedAt}`, "", article.markdown];
  return lines.join("\n").trimEnd() + "\n";
}

/** Remove only our exact legacy wrapper; the captured Markdown remains available in the raw evidence. */
export function articleMarkdownBody(markdown:string,article:Pick<ArticleRecord,"title"|"sourceUrl"|"extractedAt">):string{
  const lines=markdown.replace(/\r\n/g,"\n").split("\n");
  // Some legacy retries updated the generated Markdown before updating extractedAt in the index.
  const captured=/^captured: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z)$/.exec(lines[3]??"");
  const machineTimestamp=lines[3]===`captured: ${article.extractedAt}`||!!captured&&!Number.isNaN(Date.parse(captured[1]));
  if(lines[0]===`# ${article.title}`&&lines[1]===`source: ${article.sourceUrl}`&&/^status: (?:complete|partial|empty)$/.test(lines[2]??"")&&machineTimestamp&&lines[4]==="")return lines.slice(5).join("\n").trimEnd();
  return markdown;
}
