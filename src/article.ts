export type CaptureStatus = "complete" | "partial" | "empty" | "restricted" | "timeout" | "failed";

export interface ArticleRecord {
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  sourceUrl: string;
  extractedAt: string;
  status: CaptureStatus;
  error?: string;
  sourceHtml?: string;
}
