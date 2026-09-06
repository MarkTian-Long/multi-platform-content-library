import * as cheerio from "cheerio";
import TurndownService from "turndown";
import type { ArticleRecord } from "./article.js";
import { attachArticleVideoCandidates, extractArticleVideos } from "./article-videos.js";

export function extractRenderedArticle(html: string, sourceUrl: string, extractedAt = new Date()): ArticleRecord {
  const $ = cheerio.load(html);
  const title = $("#activity-name").first().text().trim() || $("title").first().text().trim() || "未命名文章";
  const author = $("#js_name").first().text().trim() || undefined;
  const publishedAt = $("#publish_time").first().text().trim() || undefined;
  const content = $("#js_content").first();
  const timestamp = extractedAt.toISOString();
  if (!content.length) return { title, author, publishedAt, markdown: "", sourceUrl, extractedAt: timestamp, status: "empty" };

  const { videos, candidates } = extractArticleVideos($, content, sourceUrl);
  content.find("script, style, iframe, form, svg, canvas, noscript").remove();
  content.find("*").each((_, node) => {
    const element = node as unknown as { attribs?: Record<string, string> };
    for (const attribute of Object.keys(element.attribs ?? {})) {
      if (attribute.toLowerCase().startsWith("on")) delete element.attribs?.[attribute];
    }
  });
  content.find("a").each((_, node) => {
    const href = $(node).attr("href") ?? "";
    try {
      const parsed = new URL(href, sourceUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") $(node).replaceWith($(node).text());
      else $(node).attr("href", parsed.toString());
    } catch {
      $(node).replaceWith($(node).text());
    }
  });
  const images = content.find("img").toArray().flatMap((node, offset) => {
    const source = ["data-src", "data-original", "data-actualsrc", "src"].map((key) => $(node).attr(key) ?? "").find((value) => /^https?:\/\//i.test(value));
    if (!source) return [];
    $(node).attr("src", source).removeAttr("data-src").removeAttr("data-original").removeAttr("data-actualsrc");
    return [{ index: offset + 1, sourceUrl: source, alt: $(node).attr("alt")?.trim() || undefined }];
  });
  const service = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  const markdown = service.turndown(content.html() ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const article: ArticleRecord = { title, author, publishedAt, markdown, sourceUrl, extractedAt: timestamp, status: markdown ? (title === "未命名文章" ? "partial" : "complete") : "empty", images, videos };
  attachArticleVideoCandidates(article, candidates);
  return article;
}
