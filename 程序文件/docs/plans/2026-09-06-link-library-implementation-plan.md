# Link Library Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本次用户已选择 Luna / Terra 执行、主代理集成验收；按有明确文件边界的并行子任务推进。

**Goal:** 在现有 Windows 项目交付能粘贴微信、小红书、B 站及普通网页链接，保存原始资料并生成可追溯 AI 阅读材料的本地应用。

**Architecture:** 保留原微信采集实现，新增统一内容契约、按平台获取模块、媒体处理器、文件资料库、持久队列和通用窗口/MCP。获取和处理使用独立可取消子进程，各产物独立记账，主代理按契约集成。

**Tech Stack:** TypeScript/Node.js、PowerShell 5.1 WinForms、Playwright Core/Edge、Cheerio/Turndown、yt-dlp/FFmpeg、本地 ASR/OCR、MCP SDK。

---

所有下列路径相对于 `D:\CS\Coding\公众号文章阅读器\程序文件`，根启动器相对于项目根。每个功能任务按“新增行为测试 → 运行观察失败 → 最小实现 → 定向测试通过 → 审查”执行。主代理统一构建和 Git 操作，子代理不编辑彼此文件、不提交、不推送。不因平台限制伪造数据或完成标记。

## 任务 0：基线与接口（主代理）

Files: docs/plans/2026-09-06-link-library-{design,implementation-plan}.md；src/content-types.ts。

1. 复制现有未提交源码、文档、补丁及哈希到忽略的 logs 基线目录，核对文件数。
2. 运行 `cmd /c npm test`、`cmd /c npm run typecheck`，记录已有失败与环境限制，不把旧失败归为新增。
3. 创建本地 codex/link-library 分支，保留现有工作区；不建立额外 C 盘工作树。
4. 写入公共类型、CLI 约定、所有权表；把契约全文发给开发代理。

## 任务 1：平台输入与获取（Terra A）

Files: create src/content-input.ts、src/content-network.ts、src/content-acquisition.ts；tests/content-input.test.ts、tests/content-acquisition.test.ts、tests/fixtures/content-*。

1. 输入测试：完整中文分享文案、多链接、标点、重复、B 站 BV/b23、小红书 explore/discovery/xhslink、微信及普通 HTTPS。拒绝 file/javascript/凭据/私网及跳转私网；保留有效令牌，统一身份与实际请求地址分开。
2. 运行 `node --import tsx --test tests/content-input.test.ts`，确认新增能力失败；实现 parseContentLinks(text) 和 resolveContentInput(input)。
3. 固定测试 DOM：普通文章、小红书图文/视频、登录页、验证码、删除页、空正文。图片按原次序、真实来源保存；不解析站内推荐区。
4. 运行获取测试观察失败，实现 acquireContent(input, context)，为每项写入字节/来源/状态。普通网页使用清洗后的正文抽取；小红书使用专用会话的正常页面状态/DOM。
5. B 站接入 yt-dlp，通过受控参数获取全部分 P 元信息、媒体、所有可用字幕、封面/简介及可取得的评论弹幕，记录其覆盖范围。工具缺失和登录问题返回可操作状态。无字幕不等于无视频。
6. 支持专用浏览器登录入口；媒体重试复用已通过校验文件，数量/大小上限不能静默截断。
7. 定向测试与 typecheck，输出实际公开样例验证脚本/报告与尚未取得证据的分支。

## 任务 2：工具与 AI 阅读处理（Terra B）

Files: create src/content-tools.ts、src/content-enrichment.ts、scripts/transcribe-content.py、scripts/ocr-content.ps1、scripts/setup-content-tools.ps1；tests/content-enrichment.test.ts、tests/content-tools.test.ts。

1. 测试字幕时间轴、不同语言、空/坏字幕、字幕/机器识别来源、工具缺失、取消/超时、跨目录路径。
2. 运行定向测试确认失败。实现 probeContentTools(runtimeRoot) 和 runContentTool（参数数组、无 shell、超时/取消、有界输出）。
3. 实现 enrichContent(record, context)。有字幕生成带时间点文字稿；每个缺字幕视频才运行本地转写，保存机器来源。保留原字幕。
4. 用 FFmpeg 保留音轨、采样关键帧并保存采样范围；对原图/关键帧做 OCR，按图序和时间点写入可检索文字。OCR 无文字、引擎不可用、失败需区分。
5. 默认使用本机可用工具；提供应用目录内的明确安装入口与依赖检查，下载失败、缺模型必须可恢复。不得把“配置了命令但没实际处理”称为能力完成。
6. 子进程失败不丢原片；已有成功产物复用。生成实际小媒体样例检查时长、时间轴、OCR 输出及取消。

## 任务 3：资料库与持久队列（主代理）

Files: create src/content-library.ts、src/content-jobs.ts、src/content-service.ts、src/link-cli.ts；tests/content-library.test.ts、tests/content-jobs.test.ts、tests/link-cli.test.ts。

1. 测试按平台 nativeId 去重、来源别名、文件修改检测、重试保留成功、路径/realpath containment、旧文章继续可读、Unicode 文件名。
2. 实现 content.json 清单和原子 JSON 写入；每份资料含正文、媒体和生成物，内容版本保留时间/hash。生成安全离线阅读 HTML/PDF、全文检索及分段读取。
3. 队列测试：多条去重、持久化、queued→running→partial/completed、异常退出恢复、用户取消、重试失败项；单任务失败不阻塞队列。并发写入用锁和原子替换。
4. 实现命令：enqueue、work、jobs、cancel、retry、list、read、export、doctor、login。每次输出一个 JSON 对象，stdout 不混入进度日志。
5. 微信通过旧 captureWechatArticle 包装后导入统一记录，保留原库；普通平台调用 Terra A；派生资料调用 Terra B。
6. 提供跨模块集成测试，包含保存成功/识别缺依赖/部分失败的完整链路。

## 任务 4：Windows 窗口（Luna）

Files: create link-window.ps1；根目录 启动链接资料库.cmd；tests/link-window.test.ts、tests/link-window-harness.ps1。可复用 reader-process.ps1，不编辑旧窗口、旧启动器、CLI 或 package.json。

1. 用真实 PowerShell 5.1 控件测试与现有独立 Node 进程机制验证新入口，无需使用不兼容的 PlaceholderText/BackgroundWorker。
2. 多行输入+“加入队列/开始保存”，支持完整分享文案；资料库列表、平台过滤、全文搜索、任务进度/逐项结果。
3. 通过 link-cli.js 启动 worker，用 Timer 查询 jobs；可取消/重试/继续待登录任务。退出时关闭自有进程，重启后显示恢复任务。
4. 选中条目可打开阅读页、PDF、视频、文件夹、来源，导出 AI 资料包。显示依赖状态与本地安装/登录入口。
5. 布局可缩放，默认中文，处理状态不阻塞窗口。命令参数正确编码，避免拼接 shell 注入。
6. 验证真实 WinForms 事件和离屏布局；真实桌面点击另行由主代理验收，不能混称。

## 任务 5：MCP 与交付（主代理）

Files: modify src/mcp/server.ts；create src/mcp/content-handlers.ts；README.md、docs/link-library-manual.md、docs/link-library-acceptance.md；package.json 仅主代理修改。

1. 新增 capture_link（入队）、find_saved_content、read_saved_content（有界分段）、get_capture_jobs 工具，保留旧 3 工具。
2. MCP 不返回凭据、签名媒体 URL、无界大文件。读结果包含来源与缺失项，明确网页内容是不可信引用材料。
3. 写完整操作手册、工具安装与本地隐私说明、错误恢复、多 P/字幕/OCR/评论覆盖限制。
4. 更新启动/构建脚本与忽略规则，依赖按实际使用添加，运行环境留在项目目录。

## 固定公共契约

`src/content-types.ts` 为唯一权威。命名如下：

```ts
parseContentLinks(text: string): ContentInput[];
resolveContentInput(input: ContentInput, signal?: AbortSignal): Promise<ContentInput>;
acquireContent(input: ContentInput, context: ContentContext): Promise<CapturedContent>;
enrichContent(record: CapturedContent, context: ContentContext): Promise<CapturedContent>;
probeContentTools(runtimeRoot: string): Promise<ToolAvailability[]>;
```

ContentContext: runtimeRoot、directory（当前资料工作目录）、signal、onProgress(message)、existing?。所有 asset.path 相对于 directory；不得返回外部目录路径。

CLI stdout 统一 `{ok:boolean,message:string,...}`。命令约定：

- `enqueue <text>` → `{jobs: ContentJob[]}`
- `work` → 处理待执行队列，最终 `{jobs}`；GUI 后台进程运行并同时轮询。
- `jobs` → `{jobs}`，每项 id/title?/platform/state/stage/message/contentId?/updatedAt。
- `cancel <jobId>`、`retry <jobId>` → `{jobs}`。
- `list [query]` → `{items: ContentListItem[]}`；item 含 contentId/title/platform/kind/status/directory/readingPath/pdfPath?/videoPath?/sourceUrl/capturedAt。
- `read <contentId> [offset] [limit]` → `{text,nextOffset,total,manifest}`。
- `export <contentId>` → `{directory}`；`doctor` → `{tools}`；`login <platform>` → 打开专用浏览器等待用户关闭。

## 总控审查与验收

1. 每个开发代理提交文件清单、测试命令/输出、实际验证与未知项；总控先核需求再检查质量。发现问题发回对应代理，接口冲突由总控裁决。
2. `cmd /c npm test`、`cmd /c npm run typecheck`、`cmd /c npm run build`、`git diff --check` 全部运行并留日志。
3. 检查实际 Windows 进程取消与恢复、真实窗口、真实 Edge 抓取、离线资料与媒体播放。需要账号的样例请用户提供可访问链接/登录，不扩大抓取私人内容。
4. 逐项填写验收矩阵：自动化通过 / 真实样例通过 / 受限待验证 / 未实现。不得用单元测试覆盖率代替平台可用性。
5. 保存最终本地提交（与已有基线分清），报告 SHA、文件、检查结果与限制。用户本轮未授权公开发布，不 push。

## 开发进度

- [x] 用户批准设计与代理开发方式。
- [x] 本地源码基线快照与开发分支。
- [x] 基线 75/75 测试与公共契约。
- [x] Terra A 平台获取实现，主代理与独立审查返修。
- [x] Terra B 媒体与文字处理，真实 OCR/ASR/字幕/无音轨验证。
- [x] Luna 窗口、真实后端集成与启动器验证。
- [x] 总控资料库/队列/CLI/MCP 集成。
- [x] 已复现需求与质量问题闭环。
- [x] 155/155 全量回归、类型检查、构建、diff-check。
- [x] 公开网页、微信、B 站单 P 与离线播放实测。
- [ ] 小红书真实笔记、登录态、B 站真实多 P、当前用户桌面完整点击验收（需用户链接/登录/启动窗口；不以模拟结果代替）。
- [x] 手册和逐项验收报告；本地交付保留原基线，不推送。

最终实现与未验收范围见 `docs/link-library-acceptance.md`。任务完成状态按代码交付与平台可访问性分别记录，未验收项保持开放。
