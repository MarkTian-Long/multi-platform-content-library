# 本地文件导入：实现与集成交接

本轮新模块只复制原件并生成标准 CapturedContent；CLI、窗口、任务队列、正式资料库保存与公共规则由主控集成。它不下载任何外部资源，也不写正式资料库。

## 确定 API

```ts
import { importLocalFile, LOCAL_IMPORT_EXTENSIONS, LocalImportError } from "./content-local-import.js";

const record = await importLocalFile(sourcePath, {
  runtimeRoot,
  directory: stage,
  explicitPath: sourcePath, // 来自用户文件选择器或明确的本地文件操作
  signal,
  onProgress,
  onCheckpoint
});
// 或者以 allowedRoot / allowedRoots 指定预先授权的目录。
// 后续沿用 enrichContent(record, context) 与 saveContent 等已有机制。
```

- `importLocalFile(sourcePath: string, context: LocalImportContext): Promise<ImportedLocalContent>`。
- `LocalImportContext` 扩展既有 ContentContext；授权输入为 `explicitPath` 或 `allowedRoot/allowedRoots`，均不可从不可信网页内容自行推导。
- 其他可选项：`textEncoding: "utf-8" | "gb18030"`、`maxTextBytes`、`maxMediaBytes`。上限只能收窄默认硬上限。
- 返回值是标准 CapturedContent，`platform="local"`；文本为 article，媒体按实际流选择 audio/video。额外 `localSource` 保存文件名、格式、原件字节数、SHA-256、编码、复用标志与媒体流/时长，不持久化来源绝对路径。
- `nativeId=<格式>:<原始字节SHA256>`；canonical/source URL 为 `local://sha256/<格式>/<SHA256>`。现有 contentIdentity 可据此稳定生成内容 ID；相同字节和格式换文件名不会新增一条身份。
- 导入原件路径为 `local-imports/<内容ID>/original.<扩展名>`，可作为 capturePath 输入既有中文命名机制。HTML 原件按 `original.html.txt` 保留完整字节，以文本查看；源文件名仍在 localSource。
- importer 完成后会触发一次 `onCheckpoint`；它本身不运行 ASR/OCR。媒体后续直接交现有 enrichment，原始音频不再生成多余音轨副本。

## 已实现范围

| 类型 | 实现 | 边界 |
| --- | --- | --- |
| TXT | 原件复制、正文、UTF-8/带 BOM UTF-16 | 无 BOM 默认严格 UTF-8；旧中文编码必须明确指定 gb18030 |
| MD / Markdown | 原件复制、保留全文与结构、首个一级标题 | 不自动跟随引用文件或图片 |
| HTML / HTM | 静态文本与基本结构转 Markdown；原始字节保存为 html.txt | 不运行脚本、不加载样式/外部资源；引用图片只留提示并明确警告 |
| MP4/MOV/M4A、MKV/WebM、MP3/WAV/AAC/FLAC/OGG | 原件复制、文件头及 ffprobe 流/时长核验 | 不支持播放列表、伪装媒体、无有效流/时长、缺少 ftyp 的旧 MOV |
| 音视频 ASR/OCR | 接口可直接复用既有 enrichment | 成品验证另记录；不能把“导入原件”写成“转写完成” |
| PDF/DOCX/EPUB | 本轮未实现 | 只列下一阶段建议，接口明确拒绝而不是制造成功 |

## 安全与存储

- 只接受本机绝对普通文件；拒绝 HTTP/file URL、相对路径、UNC/设备路径、文件与祖先的符号链接/junction、越出目录白名单的路径。
- 验证 realpath 和文件身份；源文件保持只读打开，比较 inode/dev、大小、mtime/ctime，并复核复制内容哈希，避免覆盖源或把变化中的文件登记为成功。
- TXT/MD/HTML 默认原件上限 8 MiB；解码后索引上限 4 MiB；音视频默认 2 GiB。空正文、二进制控制字节、脚本专用 HTML、无效媒体会抛 LocalImportError。
- 文件先在自己的 pending 文件中复制/验证；成功后用新副本的内部链接原子登记，不链接用户输入 inode。失败只删除该次自己的 pending 文件，不清理其他目录或历史资料。
- 重复导入先验证既有副本大小与 SHA-256，再复用；损坏副本会报错，不以“非空文件”判定成功，也不静默覆盖。
- ffprobe 使用固定格式与 `file` 协议白名单，禁用 MOV 外部数据引用；不支持网络播放列表。
- HTML 解析仅使用现有 cheerio/turndown。音视频验证复用本地 ffprobe，后续 ASR/OCR 沿用已有工具、模型与完成证据。

## 主控需要集成的位置

1. public union 已有 local/audio，无需本模块再次修改。若 UI 要访问来源字段，可在 CapturedContent 增加可选 `localSource`（类型见本模块）。
2. 本地入口从用户明确选择的路径建立授权，调用 importer；绕过 HTTP 解析/URL 网络校验分支。不要用普通网页提供的路径建立授权。
3. 保持 source/canonical 的本地身份 URI；读取/导出/阅读页不应把 local:// 当外部网页链接。打开原件走已经保存的 source/audio/video 资产路径。
4. saveContent、enrichContent、PDF、中文命名、队列维护锁仍沿用主控已有机制；导入/ASR 期间不要长时间持锁。onCheckpoint 保留真实阶段边界。
5. 纯音频状态只检查音频及转写，不要求视频帧/OCR；原件导入、语音全文、图片文字分别显示。标题和来源文件名应保留 localSource。

## 文档格式后续条件

本轮评估时，项目 `.venv-content` 实测没有 pypdf/pdfplumber/python-docx；Codex 捆绑 Python 有这些工具。这不等于桌面应用已经具备文档导入。下一阶段可选择项目内轻量 PDF 文字层读取、DOCX 只读文本/表格解析，明确扫描 PDF、图片、修订、宏和版式丢失；EPUB 还需 ZIP/XML 大小和引用边界。此次未安装依赖，也未声称这些格式已实现。

## 验证记录

测试与真实本地样本证据保存在 [专用报告](<D:/开发/多平台资料库/程序文件/logs/local-import-20261014/real-samples-report.json>)。

- 定向测试 **12/12** 通过，局部 typecheck 通过；未运行全量 build/测试。
- TXT：21 字符；MD：48 字符，分组来源和 Markdown 完整保留；HTML：70 字符、原件 html.txt 字节一致、脚本未执行、资源未请求。
- WAV：6 秒真实本地语音样本，ASR 生成 en 的 MD/JSON/SRT；只有一条原始音频，没有重复提取音轨、帧或 OCR。含回读/复用验证总计约 1.33 秒，验证缓存复用约 9 ms。
- MP4：6 秒 H.264/AAC 样本，ASR en、6 帧、6 份 OCR 结果（纯色图片明确为无可读文字）；保存 23 条真实资产，回读/复用验证约 7.17 秒，缓存复用约 105 ms。
- 五个样本原文件前后 SHA-256 一致；重复导入身份一致且原件副本复用。所有试验产物只写专用日志，正式资料库只读。
- 已有两条视频及其 Small ASR 三件套、Small model.bin 的前后哈希均一致，证据 `protected-before.json` / `real-samples-report.json`。
- Windows 当前会话不能创建普通文件符号链接；已实际创建并验证目录 junction、链接本身和链接祖先拒绝。文件 symlink 的同一 lstat 防护逻辑在代码中，普通文件 symlink 创建未实测，未切换系统设置。
- 新文件仅 `src/content-local-import.ts`、`tests/content-local-import.test.ts`、本交接文档与自有 logs；不改共享文件、不移动原件、不清理其他目录。

当前为独立模块与本地样本证据；CLI/窗口入口和正式保存由主控接入后另验，未把可调用模块写成已在窗口上线。
