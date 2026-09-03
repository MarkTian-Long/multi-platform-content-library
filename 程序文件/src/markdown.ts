import type { ArticleRecord } from "./article.js";

export function renderArticleMarkdown(article: ArticleRecord): string {
  const lines = [`# ${article.title}`, `source: ${article.sourceUrl}`, `status: ${article.status}`, `captured: ${article.extractedAt}`, "", article.markdown];
  return lines.join("\n").trimEnd() + "\n";
}
