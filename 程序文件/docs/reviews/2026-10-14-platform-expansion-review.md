# 平台扩展评审与 YouTube 单视频候选

2026-10-14，Asia/Shanghai。首选 YouTube 单视频，代码与定向验证已完成；没有用户提供的 YouTube 样本，本次未提交真实视频链接、未下载平台视频，不能声称已经完成真实 YouTube 下载验收。抖音、快手和微博仅完成官方资料及源码评审。

## 四个平台的证据与取舍

| 平台 | 当前官方依据 | 可实现范围与条件 | 预计维护成本 / 本次取舍 |
| --- | --- | --- | --- |
| YouTube | 官方有专用 extractor；现有 yt-dlp 可沿用 | 明确 ID 的单个普通视频；网络可达、格式可取；EJS 与支持的 JS runtime 是关键依赖，部分请求还受登录、机器人验证或 PO Token 限制 | 中等：维护 yt-dlp/EJS 版本、格式和账号条件；先实现受控单视频候选 |
| 抖音 | 官方支持列表包含 Douyin，`tiktok.py` 中有 `DouyinIE` | 当前源码在 web detail API 无有效详情时要求新鲜 Cookie，未完成其验证挑战 Cookie 生成；不能据此推断需要账号登录或必然匿名可用 | 高：短链、Cookie 有效期和平台验证需要专门样本及登录流程；本次不扩展 |
| 快手 | 本次官方支持列表没有 Kuaishou；预期 `extractor/kuaishou.py` 返回 404；本机 extractor 列表也未出现 Kuaishou | 未找到可直接复用的官方专门 extractor；通用 extractor 或第三方插件的存在不能当成本项目支持 | 高且未知：需要额外工具/适配和真实链接证据；本次不扩展、不调用第三方解析 |
| 微博 | 官方有 Weibo/WeiboVideo/WeiboUser，`weibo.py` 存在访客 Cookie 初始化及视频格式提取 | 公开视频可能经站点访客流程取得；账号限制、帖子/视频/合集身份及元数据仍需样本验证 | 中至高：范围和访客接口需要额外边界测试；本次不扩展 |

维护成本是结合源码失败路径和本项目已有能力作出的工程判断，不是平台成功率实测。[官方支持列表](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)、[YouTube 官方说明](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube)、[EJS 设置](https://github.com/yt-dlp/yt-dlp/wiki/EJS)、[Douyin 源码](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py)、[微博源码](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/weibo.py)。

官方文本与源码通过网络读取并保存于 `logs/platform-expansion-20261014/`，哈希与 HTTP 状态在 `upstream-sources.json`。GitHub commits API 返回 403，因此没有声称冻结到已核验的上游 commit；保留的是本次读取文件的 SHA-256。对缺失快手 extractor 的判断同时使用支持列表、本机 extractor 列表和文件 404，未将单独一次 404 作为充分证据。

## 已实现的模块与链接识别

入口为 `acquireYoutube(input, context, deps): Promise<CapturedContent>`，位于 `src/content-ytdlp-platform.ts`。`YoutubePlatformDeps` 的 `ytDlpPath`、`runTool(command,args,context)`、`probeMedia(file,context)` 与 acquisition 的现有形状兼容；另可提供 `ffmpegPath` / `ffprobePath`，缺省沿用应用 tools / PATH / 已有 CONTENT_* 位置。

`content-input.ts` 导出 `youtubeVideoReference`，识别明确 11 字符视频 ID 的 watch、youtu.be、shorts、embed 及 youtube-nocookie embed。支持常见 www / m / music 主机，保持原访问 URL，将身份统一为 `https://www.youtube.com/watch?v=<ID>` 并去除分享、时间、playlist 和 index 查询。相同视频跨入口去重，ID 大小写保留；旧 web 任务在 resolve 时重识别，无需额外请求已具有明确 ID 的 youtu.be 页面。

纯 playlist、频道、搜索、live 路径、错误或重复 v、额外路径、非标准端口及伪造主机仍归普通网页，不进入视频适配器。现有 B 站/小红书/微信的短链及签名访问 URL 行为保持，新增私网短链回归继续通过。没有泛化为“所有 yt-dlp 站点”。

yt-dlp 仅提取所选单视频的 JSON 元数据：忽略环境配置、插件、搜索与 playlist，禁用 remote components 与 format 探测，显式使用本进程 Node。校验 Youtube extractor、视频 ID、可选页面身份、非 playlist / 非正在直播 / 非尚未处理视频及正的有限时长。未保存原始 info JSON，也不把签名媒体 URL放入最终 asset 或日志。

只选择 HTTP(S) 非 DRM、非 fragments 的 MP4/M4A。可直接保存完整音视频 MP4；需要提高分离流质量且 FFmpeg 可用时，视频及音轨分别经过现有 `savePublicAsset`，共享 2 GiB 源流字节预算，在本地以 stream copy 合并。FFmpeg/ffprobe 的输入协议限定 `file,pipe`；HLS/DASH、DRM 和 WebM 不在该候选范围。下载复用原生公网/DNS/重定向/大小/取消/有限重试检查。

合并或直接下载后的文件必须有视频和音频、正的可读时长、时长差不超过 `max(0.5秒, 元数据时长×3%)`，并核对大小及 SHA-256，才原子替换为 `media/<ID>.mp4`。每次调用拥有独立临时事务目录，失败/取消只清理自己的临时目录，原有完整文件不被删除或提前覆盖。采集总期限十分钟，工具与下载接收同一取消 signal。

默认匿名。只允许已有 `runtimeRoot/.content-profile/youtube/cookies.txt`，要求普通非符号小文件且祖先目录无符号链接，不读取默认浏览器，不创建账号、不启用 PO Token 服务或第三方解析。该 Cookie 路径只用于平台元数据提取；媒体下载不附带 Cookie。登录/验证失败用明确状态返回，不照搬工具提出的默认浏览器 Cookie 导入指令。

## 当前验证层级

本机已有 yt-dlp **2026.08.19**、Node **24.14.0**，帮助输出确认本次所需命令选项存在，extractor 列表包含 youtube、Douyin、Weibo，见 `local-capabilities.json`。EJS 的上游要求已核验，但无视频的 extractor 列表探测没有输出运行时组件细节，`ejs-capabilities.json` 留存空证据；没有据此声称已完成真实挑战求解。

初始 23 项输入/模块用例中 7 项按未实现行为失败，见 `red-tests.log`。另复现短视频 2 秒元数据 / 0.2 秒实际文件被宽松时长容差接受的问题，修复后最新 **32 / 32 定向检查通过**，类型检查 `tsc --noEmit` 退出码 0。涵盖平台身份、去重、短链安全、私网/凭证、playlist、live、DRM、分段流、登录、专用 profile 符号链接、限额、截断重试、取消、元数据失败、缺流、时长和旧文件保护；见 `green-tests.log`、`short-duration-red.log`、`typecheck.log`。

另使用两秒、128×72 的本地生成 H.264/AAC 文件，模拟平台元数据及 HTTP 边界，实际运行当前 FFmpeg 合并和 ffprobe，最终 MP4 20,971 字节、时长 2 秒，整段解码退出码 0。记录为 `offline-merge-result.json`。这是本地工具链真实验证，网络字节为零，不是真实 YouTube 平台视频验收。

## 主控集成与真实限制

公共类型中 youtube 和渲染名称已由主控准备。主控在 `acquireContent` 对 youtube 分支调用该入口，继续接现有 enrichment、保存与 checkpoint；CLI、UI、平台支持文档及完整回归由主控集成。本对话未修改 acquisition/types/service/CLI/UI/docs-support，也未修改已完成的 content-network.ts、正式资料、queue 或 dist。

收尾已只读观察到主控的 `acquireContent` YouTube 分支导入和调用；平台支持表的更新及整个应用的完整验收仍由主控负责。

真实验证仍需用户授权的单视频样本：平台元数据可取、CDN 下载、合并/媒体核验、保存及阅读分别确认。部分格式需额外请求头、PO Token、登录或平台验证时，本候选可能返回 unavailable / login_required；不会自行建立账户、获取新密钥、导入浏览器 Cookie 或转向多个解析服务。专用 YouTube 登录 UI 的创建/导出、封面、字幕、评论及 webm 等格式不在本次模块交付。

媒体逐跳经过安全下载；yt-dlp 内部元数据请求本身仍属于既有本机工具的网络能力，canonical URL和 extractor 限定减少任意输入风险，不应描述成进程级网络沙箱。上层完整文件复用沿用主控的既有缓存核验，临时流仅在本次调用内保留。local 输入应由主控的本地导入路由处理，`resolveContentInput` 继续坚持 HTTP(S) 公网短链职责。

复核命令：

```powershell
node --import tsx --test --test-reporter=tap tests/content-input.test.ts tests/content-ytdlp-platform.test.ts
node --import tsx logs/platform-expansion-20261014/local-check.mts
node --import tsx logs/platform-expansion-20261014/offline-merge-check.mts
cmd /c node_modules\.bin\tsc.cmd --noEmit
```

无 build、全量测试、Git 操作或系统配置修改；未进行真实平台视频下载。

共享 checkout 核对：当前 `content-network.ts` 相对第一轮网络交付增加了把 `TimeoutError` 识别为瞬时网络错误的两行调整，见 `logs/platform-expansion-20261014/network-followup.patch`。本次平台任务没有改写该文件，保留这份后续工作；上述定向检查使用当前版本。机器汇总分别记录旧快照和当前哈希，没有把不同阶段误记为哈希未变。
