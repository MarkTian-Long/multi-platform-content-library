/** Shared link-library contract. Asset paths are relative to ContentContext.directory. */
export type ContentPlatform = "wechat" | "wechat_channels" | "xiaohongshu" | "bilibili" | "youtube" | "douyin" | "weibo" | "local" | "web";
export type ContentKind = "article" | "gallery" | "video" | "audio";
export type AssetRole = "image" | "video" | "audio" | "cover" | "subtitle" | "transcript" | "frame" | "ocr" | "comments" | "danmaku" | "source" | "reading" | "pdf";
export type AssetStatus = "saved" | "failed" | "unavailable" | "login_required" | "missing_dependency" | "skipped";
export type ProcessingMode = "original" | "transcribe" | "full";
export interface ContentProgress { phase: string; completed?: number; total?: number; unit?: string; }
export interface ContentInput {
  url: string; platform: ContentPlatform; canonicalUrl: string; nativeId?: string;
  /** Private queue input from an explicitly selected file; never copied into a manifest. */
  localPath?: string; localFileName?: string; localTextEncoding?: "utf-8" | "gb18030";
  processing?: ProcessingMode;
}
export interface ContentAsset {
  id: string; role: AssetRole; status: AssetStatus; path?: string; label?: string;
  /** Stable relative path used by acquisition/enrichment; path is the readable saved name. */
  capturePath?: string;
  sourceUrl?: string; bytes?: number; sha256?: string; mime?: string; reason?: string;
  provenance?: "original" | "platform_subtitle" | "machine_asr" | "machine_ocr" | "sampled_frame" | "generated" | "user_edited";
  language?: string; partId?: string; startMs?: number; endMs?: number;
  derivation?: {sourceId:string;sourceSha256:string;processingFingerprint?:string};
  integrityFailed?: boolean;
  quality?: {
    width?: number; height?: number; expectedWidth?: number; expectedHeight?: number;
    source: "provided" | "platform_object";
    rendition: "original" | "playback" | "download" | "preview" | "unknown";
    watermark: "none" | "present" | "unknown";
    evidence?: "platform_flag" | "known_stream_type" | "known_template";
    resolution: "matches_source" | "smaller_than_source" | "unconfirmed";
    resourceId: string;
  };
}
export interface ContentPart { id: string; title: string; status: "saved" | "partial" | "failed" | "unavailable"; durationSeconds?: number; reason?: string; }
export interface CapturedContent {
  platform: ContentPlatform; nativeId?: string; sourceUrl: string; canonicalUrl: string;
  title: string; author?: string; publishedAt?: string; capturedAt: string;
  kind: ContentKind; markdown: string; assets: ContentAsset[]; parts?: ContentPart[];
  warnings: string[]; coverage?: Record<string, string>;
  processingMode?: ProcessingMode;
  /** Opt-in storage layout; IDs and capture paths remain unchanged. */
  storageVersion?: 2 | 3;
}
export interface ContentContext {
  runtimeRoot: string; directory: string; signal?: AbortSignal;
  libraryRoot?: string;
  processing?: ProcessingMode;
  onProgress?: (message: string, progress?: ContentProgress) => void; existing?: CapturedContent;
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
  displayTitle?: string;
  status: ContentStatus; directory: string; readingPath: string; pdfPath?: string;
  videoPath?: string; audioPath?: string; originalPath?: string; sourceUrl: string; capturedAt: string;
  textPath?: string; transcriptPath?: string; tags?: string[]; favorite?: boolean;
}
export type JobState = "queued" | "running" | "paused" | "waiting" | "rate_limited" | "completed" | "partial" | "failed" | "cancelled" | "login_required";
export interface ContentJob {
  id: string; input: ContentInput; platform: ContentPlatform; title?: string; state: JobState;
  stage: string; message: string; contentId?: string; createdAt: string; updatedAt: string;
  attempts: number; cancelRequested?: boolean;
  queuedAt?: string; startedAt?: string; finishedAt?: string;
  progress?: ContentProgress;
  retry?: { kind:"youtube_rate_limit"; notBefore:string; attempts:number; automatic:boolean };
}
/** Transient handler signals are consumed under the queue mutex, never persisted as job fields. */
export interface ContentJobResult extends Partial<ContentJob> {
  youtubeRateLimit?: { retryAfter?:string };
  youtubeAccessRestored?: boolean;
}
