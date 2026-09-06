/** Shared link-library contract. Asset paths are relative to ContentContext.directory. */
export type ContentPlatform = "wechat" | "xiaohongshu" | "bilibili" | "web";
export type ContentKind = "article" | "gallery" | "video";
export type AssetRole = "image" | "video" | "audio" | "cover" | "subtitle" | "transcript" | "frame" | "ocr" | "comments" | "danmaku" | "source" | "reading" | "pdf";
export type AssetStatus = "saved" | "failed" | "unavailable" | "login_required" | "missing_dependency" | "skipped";
export interface ContentInput { url: string; platform: ContentPlatform; canonicalUrl: string; nativeId?: string; }
export interface ContentAsset {
  id: string; role: AssetRole; status: AssetStatus; path?: string; label?: string;
  /** Stable relative path used by acquisition/enrichment; path is the readable saved name. */
  capturePath?: string;
  sourceUrl?: string; bytes?: number; sha256?: string; mime?: string; reason?: string;
  provenance?: "original" | "platform_subtitle" | "machine_asr" | "machine_ocr" | "sampled_frame" | "generated";
  language?: string; partId?: string; startMs?: number; endMs?: number;
}
export interface ContentPart { id: string; title: string; status: "saved" | "partial" | "failed" | "unavailable"; durationSeconds?: number; reason?: string; }
export interface CapturedContent {
  platform: ContentPlatform; nativeId?: string; sourceUrl: string; canonicalUrl: string;
  title: string; author?: string; publishedAt?: string; capturedAt: string;
  kind: ContentKind; markdown: string; assets: ContentAsset[]; parts?: ContentPart[];
  warnings: string[]; coverage?: Record<string, string>;
}
export interface ContentContext {
  runtimeRoot: string; directory: string; signal?: AbortSignal;
  onProgress?: (message: string) => void; existing?: CapturedContent;
  /** Await after each durable asset so cancellation/crashes retain a readable checkpoint. */
  onCheckpoint?: (record: CapturedContent) => Promise<void>;
}
export interface ToolAvailability { id: string; name: string; available: boolean; path?: string; version?: string; reason?: string; }
export type ContentStatus = "completed" | "partial" | "failed";
export interface ContentManifest extends CapturedContent {
  schemaVersion: 1; contentId: string; status: ContentStatus; aliases: string[];
  updatedAt: string; contentHash: string; markdownFile: string; readingFile: string;
  bodyFile?: string;
  namingVersion?: 1;
}
export interface ContentListItem {
  contentId: string; title: string; platform: ContentPlatform; kind: ContentKind;
  status: ContentStatus; directory: string; readingPath: string; pdfPath?: string;
  videoPath?: string; sourceUrl: string; capturedAt: string;
}
export type JobState = "queued" | "running" | "paused" | "completed" | "partial" | "failed" | "cancelled" | "login_required";
export interface ContentJob {
  id: string; input: ContentInput; platform: ContentPlatform; title?: string; state: JobState;
  stage: string; message: string; contentId?: string; createdAt: string; updatedAt: string;
  attempts: number; cancelRequested?: boolean;
}
