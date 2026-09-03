export type CaptureStatus = "complete" | "partial" | "empty" | "restricted" | "timeout" | "failed";
export interface ArticleImage { index: number; sourceUrl: string; alt?: string; }

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
  images?: ArticleImage[];
}
