export type CaptureStatus = "complete" | "partial" | "empty" | "restricted" | "timeout" | "failed";
export interface ArticleImage { index: number; sourceUrl: string; alt?: string; }
export interface ArticleVideo {
  index: number;
  label: string;
  provider: "wechat" | "tencent" | "html5";
  sourceArticleUrl: string;
  videoId?: string;
  sourceKey?: string;
  status: "not_saved" | "saved" | "failed" | "unsupported";
  localPath?: string;
  reason?: string;
  bytes?: number;
}

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
  videos?: ArticleVideo[];
}
