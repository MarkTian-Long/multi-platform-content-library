# 平台与格式支持表

更新：2026-10-14 功能与交互升级。当前实现以本表及[升级验收](plans/2026-10-14-library-usability-upgrade.md)为准；下方以前阶段的测试数属于历史证据，不能代替本轮验收。

最新全量665/665，0失败/取消/跳过，类型/构建0，图集独立225/225与组织锁增量17/17分开留证。公开样本为小红书1图+1动态、抖音15静图及30图+30动态，46图片解码、31视频完整解码及断网Edge播放通过；真实重试原件SHA相同，正式/旧资料库712文件全不变，详见[图集验收](reviews/2026-10-14-photo-collections.md)。此前微博593/99、用户样本581/41、YouTube579/43等保持历史身份。当前回执由[总控计划](plans/2026-10-14-library-usability-upgrade.md)末节维护，依赖未变。

| 来源 | 支持的输入链接 / 内容 | 保存的原始内容 | 主要条件和限制 |
| --- | --- | --- | --- |
| 微信公众号 | `mp.weixin.qq.com/s/...`、完整分享文案 | 正文、图片、可取得的文章内视频 | 原视频地址有效且平台允许访问；部分视频可返回 403 |
| 微信视频号 | `weixin.qq.com/sph/...`、`channels.weixin.qq.com` 公开页面 | 描述、已核验 MP4 视频 | sph 分享短链可启用已实测的免登录解析；公开预览页须提供直链；加密媒体不解密 |
| 小红书 | `explore/<笔记ID>`、`discovery/item/<笔记ID>`、`xhslink.com` / `xhslink.cn` 分享短链 | 目标笔记正文、图片、可核验视频；实况照片图片与配套MP4/MOV | 公开页或专用Edge；逐图读取目标笔记imageList内明确H.264动态URL，核对笔记/图片身份并排除推荐/评论/头像。动态已声明却缺地址、受保护或失败时标部分保存；网页版本可能有缩放或水印，不推断作者原片 |
| B 站 | 视频/BV/`b23.tv`；`t.bilibili.com/<ID>`、`bilibili.com/opus/<ID>` 动态/图文 | 视频、音频、封面、可取得字幕、评论和弹幕；动态原文、图片及精确关联 BV 引用 | 视频依赖 yt-dlp/FFmpeg，最多50分P；动态按目标ID核对，视频引用需单独采集关联BV，不冒充已下载；opus原图和历史动态封面均有真实证据 |
| YouTube（单视频，已实测） | 明确单视频 ID 的 watch、youtu.be、shorts、embed | 标题/作者/说明、核验后的 MP4；按需本地 ASR / OCR | 真实CLI原件保存与本地Small转写均completed，完整解码和SHA通过；提供网络设置与专用登录。429共享冷却后有限自动恢复，功能窗口打开时自动续接，验证仍需用户完成。原生字幕/评论、playlist、直播、DRM、HLS/DASH清单未开放 |
| 抖音 | 单视频/单图集作品页、明确modal_id、iesdouyin的video/note/slides分享页、v.douyin.com短链 | 精确作品原文、MP4原视频；静态/实况图集图片及逐图配套MP4/MOV；按需本地ASR/OCR | 单视频HTTP→专用Edge→yt-dlp；图集HTTP→匿名官方slidesinfo→必要时专用Edge，严格核对aweme_id与图片资源uri。逐图保存，顶部BGM不当动态；缺失/受保护/身份冲突标部分保存。主页、合集、直播未开放 |
| 微博 | weibo.com 桌面单帖、m.weibo.cn/status 或 detail、TV 单视频、t.cn 跳转目标帖 | 原文、图片、帖子/TV MP4；实况照片原图及配套MOV/MP4；按需 ASR / OCR | 官方接口和专用Edge；实况动态按配图PID/序号及媒体FID核对，原件字节保留、缺失标部分。长文须展开才标完整，严格BID/MID/FID身份，转发原博/推荐/评论/头像排除；当前实况实测覆盖用户单帖2段MOV |
| 本地文件 | 用户明确选择的 TXT、Markdown、HTML、PDF、DOCX、PNG/JPEG/WebP/BMP、音视频 | 字节一致原件、可检索正文及按需派生 | 文字4MiB；文档/原图32MiB；媒体2GiB。PDF最多200页，DOCX解压64MiB/2048项；扫描PDF保留原件并标缺文字层，加密/宏等拒绝；JPG/JPEG同身份 |
| 普通网页 | 公开 HTTP(S) 页面 | 可读正文和正文中的图片 | 依赖网页结构；通用网页路径没有实现任意网站视频下载 |

快手、直播录制、EPUB和扫描PDF整页OCR未开放。本轮新增 PDF/DOCX/原图导入、处理选择、机器稿独立校订、标签收藏、ZIP、任务历史和可恢复日志归档；窗口、CLI、MCP 使用同一实现。

Edge 补齐后的全量 **463/463**、构建及类型检查通过；覆盖身份、长文、媒体、取消、旧文件保护、专用 profile、访客初始化和浏览器回退。两平台真实公开视频均已在全新、未登录的 Edge 会话中下载，经本机 ffprobe 核验，结果与单元夹具分别留证。出现真实人机验证时仍需通过专用窗口人工完成。

匿名实测：抖音作品 `7691241374158556466` 为 **4,775,833字节**，元数据26.539秒与实际26.538685秒一致，全流程11.738秒；微博原帖 `FBqgOmDxO` 为 **1,810,094字节**，桌面入口全流程3.568秒，移动入口10.212秒，两入口原件SHA一致。本轮样本媒体和临时 profile 已清理，只保留 `logs/social-edge-20261014/` 下脱敏结果；既有两条用户视频和文字稿未改动。时间包含页面加载和核验，仅代表这些样本的本次测量。

编译后的程序还分别完成了隔离库保存：正文/原视频生成正式命名的资料条目，保存后视频SHA与采集原件一致，阅读HTML引用本地视频。该测试未执行ASR/OCR/PDF派生，条目保持partial；不能把原件入库验证计作文字稿已生成。测试库结束后已清理，证据为 `weibo-compiled-library.json` 与 `douyin-compiled-library.json`。

短链经过已校验的作品/帖子地址后再进入登录页时，仍保留目标身份供适配器使用；只有登录页、无目标 ID 的微博短链会要求改用单条帖或 TV 链接，不保存登录页正文。不同目标 ID 的跳转被拒绝。

| 格式 / 产物 | 当前处理范围 |
| --- | --- |
| TXT / Markdown / HTML | 新增 `.txt`、`.md`、`.markdown`、`.html`、`.htm` 本地导入；UTF-8、带 BOM 的 UTF-16LE/BE，GB18030 需显式选择。HTML 只提取静态文字，不执行脚本或加载资源；原件以 `.html.txt` 保留 |
| PDF / DOCX 输入 | 文字层 PDF 按页提取可检索文字，DOCX 提取主文档段落/表格文字；原件字节保留。不承诺版式重建、扫描PDF整页OCR、DOCX嵌入图片、修订/批注全量；加密文档、宏/活动嵌入和损坏包拒绝 |
| PNG / JPEG / WebP / BMP 输入 | 本地原图签名、长度和尺寸校验（最长边32768，最多4000万像素），保留原件；按需执行本机OCR，识别稿可独立校订 |
| Markdown / HTML / PDF 输出 | 正文、机器稿和校订稿生成 `.md`、离线 `.html`；原件模式不额外生成阅读PDF，其他模式按需生成。已有阅读PDF随校订更新；失败保留旧字节但明确标记旧PDF未更新 |
| JPEG / PNG / WebP / GIF / AVIF | 通用正文和笔记图片按服务器提供的原字节保存；多帧GIF有字节一致回归。微信文章AVIF后缀/PDF嵌入、B站动态AVIF签名识别仍有格式边界，详情见动态资源排查 |
| MP4 / WebM / MKV / MOV | B站按可取得格式保存；小红书支持可下载并经ffprobe核验的视频；视频号、抖音和微博普通视频路径核验MP4，小红书/抖音/微博实况另存可核验MOV/MP4。支持这四种本地媒体导入；浏览器播放取决于实际编码，不进行本地转码 |
| M4A / MP3 / WAV / AAC / FLAC / OGG | 新增本地原件导入及纯音频 ASR，不生成重复音轨或视频帧；本地视频提取音轨输出 M4A |
| OPUS | B 站取得的原音轨保留；本地 OGG 容器可以包含 Opus，`.opus` 扩展名本轮未开放 |
| VTT / SRT | 取得的平台字幕可解析为带时间点的 Markdown；机器语音转写输出 SRT、JSON、Markdown |
| ASS / LRC | 可作为原始字幕文件保留；当前不按 VTT/SRT 的时间轴流程解析 |
| JPG / JSON / Markdown | 抽样画面为 JPG（每视频最多 24 帧）；OCR 和语音识别记录为 JSON / Markdown |
| 评论 JSON / 弹幕 XML | 仅保存 B 站本次可取得的记录 |
| 脱敏目录 / ZIP 输出 | 阅读HTML、正文、可导出资产、本地原件和组织元数据；ZIP最多2GiB/4096项，分块写入、逐项CRC/SHA回读验证。内部原始网页快照、机器识别JSON、凭证、历史私有输入及阅读PDF不进入共享包 |

处理选择：`original` 保留原件和基本阅读资料；`transcribe` 在视频/音频上补文字稿，在原图上补OCR文字；`full` 另加视频抽样帧及其OCR。窗口新任务默认transcribe，未显式配置的CLI/MCP和旧任务保持full。“重试任务”沿用旧选项，“补充处理”使用当前选项；已核验产物继续复用。

机器稿与校订稿分开保存，校订采用来源SHA和当前稿SHA检查并发，保留原稿及修订历史。图像字体、噪音与专名会影响识别准确性，OCR实测第二行英文可检索，首行窄字体有误认，真实文字保留在验收记录供校订。HLS/DASH独立媒体清单、DRM、需解密视频、付费与私有内容没有通用下载支持。

微博TV本轮匿名样本为1,126,415字节，OID/FID绑定到原帖，媒体流/时长和完整解码通过。B站opus保存2,351,905字节原图；历史动态保存500,120字节封面和精确BV引用。YouTube较早官方工具134+140成片为633,710字节、19.064秒，应用当时受429/验证；18:06新鲜匿名应用复测得到744,412字节MP4，约30.125秒完成真实下载、合并、完整解码及隔离入库，SHA一致且阅读页存在。两次成片不是同一次输入流快照，不将不同SHA冒称一致；新样本与临时库已清理，仅留脱敏receipt。证据见 [覆盖交接](reviews/2026-10-14-platform-coverage.md)。

YouTube保存的网络选择优先：`proxy`使用本机已有无凭据HTTP(S)代理，`direct`显式直连，`auto`才依次取`CONTENT_YOUTUBE_PROXY`、`HTTPS_PROXY`/`HTTP_PROXY`，没有则直连。元数据、媒体和专用Edge使用同一选择，显式直连不被环境或系统代理重新填入。代理媒体逐跳核验官方域名和公网IP、固定IP CONNECT、保留Host/TLS SNI；TLS连接失败时按[Google DoH JSON规范](https://developers.google.com/speed/public-dns/docs/doh/json)对官方媒体域名作有界安全解析。该DNS请求只含域名，不含视频分享链接、Cookie或认证头；视频号解析服务代理单独配置。YouTube提取与媒体429均立即停止该次自动重试；不会自动完成人机验证或承诺下次访问一定成功。

18:55继续验收已通过真实CLI入队/worker/读取/重试；原件及Small文字稿任务均completed，禁用下载器后补转写7.415秒、原视频SHA不变；同模式重交不启动空worker。隔离样本MD/SRT/JSON三件套已验证并清理。最新版本全量579与当前状态以本页开头及覆盖交接末节为准。

429恢复策略：立即停止该次请求，并在同一queue.json队列事务中保存YouTube共享冷却及自动次数。默认5→15→30分钟，最多自动恢复3次；媒体有效[Retry-After](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After)更长时至少等待服务器指示时间。冷却期间其他平台继续，新增/手动重试/重开程序及历史归档事务不丢失等待约束。连续429超过预算暂停自动恢复；登录/验证码要求直接转人工，参见[yt-dlp官方限流说明](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#http-error-429-too-many-requests-or-402-payment-required)。

功能窗口打开时每5秒检查持久队列，到期以`work --scheduled`只恢复已安排的任务，worker领取时再次核对取消/共享冷却；等待期间释放worker锁。关闭窗口不会留下等待进程，重开窗口重建定时恢复；CLI/MCP返回waitingCount/nextWakeAt，下一次处理仍遵守冷却，不声明无窗口时常驻自动恢复。已保存文件复用和原件完整性边界保留；本地原件复用不被当成平台解除限流的证据。

在“登录与依赖”点击“YouTube网络设置”选择自动/直连/本机代理；选YouTube后“专用浏览器登录”，手动完成平台要求的验证，关闭后回采集任务重试。只保存该专用目录的youtube.com Cookie，不导入默认Edge、Google或其他平台Cookie。CLI在程序目录执行`node dist/link-cli.js youtube-network [auto|direct|proxy 本机HTTP代理地址]`、`node dist/link-cli.js login youtube`。读取/保存设置会保留视频号启用状态、endpoint/proxy与独立凭证作用域。

## 抖音与微博的专用登录

在“登录与依赖”选择抖音或微博，点击“专用浏览器登录”；完成所需的站点登录/人工验证后关闭窗口，再重试原任务。CLI 在 `程序文件/` 执行 `node dist/link-cli.js login douyin` 或 `node dist/link-cli.js login weibo`。源码、界面在重新打开根目录启动器后载入。

会话只来自应用自己的 `.content-profile/douyin` 或 `.content-profile/weibo`，不读取默认浏览器。抖音单视频按HTTP→专用Edge→本机官方yt-dlp，图集按HTTP→匿名官方slidesinfo→必要时专用Edge；slidesinfo不发送Cookie或登录凭证。微博先请求官方帖子/长文/TV接口及正常访客初始化，失败后由Edge加载原帖并读取有限官方JSON。正常访客中间跳转允许完成，导航打断读取时仅有限重试；已经核对的有效主体优先保留。两者均不调用视频号配置的第三方解析站，原始DOM/API正文仅在内存读取。

新媒体先进入本次独立事务，经真实大小、哈希、格式/流和时长核验后原子提交；失败、取消或假MP4不覆盖旧好文件。元数据与媒体时长容差为`max(0.5秒,3%)`。微博图片20MiB、单帖媒体2GiB、最多128图/9视频；抖音单视频2GiB。小红书/抖音图集每次最多128张，图片25MiB、图片与动态共享2GiB，超限明确标部分。签名更新可复用哈希核验后的原件，原图/动态逐项保存checkpoint。最新图集实测见[图集验收](reviews/2026-10-14-photo-collections.md)，历史单视频说明见[抖音交接](reviews/2026-10-14-douyin-adapter.md)、[微博交接](reviews/2026-10-14-weibo-adapter.md)。

## 本地导入与存储

窗口“资料库”页用“导入本地文件”，使用采集任务页当前处理选项。CLI：`node dist/link-cli.js import --processing original "D:\材料\手记.md"`，随后 `work`；GB18030 使用 `import --processing transcribe --encoding gb18030 "D:\材料\旧文本.txt"`。相同格式和字节在改名后复用同一资料，MD/MARKDOWN、JPG/JPEG统一身份。实际导入前后再次核验，已入库原件可支撑外部源文件移动后的派生重试。

编译CLI已在隔离库完成PDF/DOCX/JPEG/PNG实际入队、worker、离线OCR/PDF与全文搜索，4任务均completed，所有源文件及入库原件SHA不变；证据 `logs/usability-20261014/document-cli-live.json`。扫描PDF只保存原件和不可提取说明。窗口新增校订/术语/标签收藏/ZIP/归档恢复均有实际离屏交互，MCP也通过真正子进程验证。

正式库继续放在项目下 `资料库/`，程序/工具/模型放在 `程序文件/`，`文章库/` 保持旧采集器兼容。队列处理结束后只回收已终态且与正式资产 bytes/SHA 完全一致的 staging 副本；未完成、未知、差异、receipt 和备份保留。窗口“登录与依赖”可检查工作副本再回收；CLI `storage` 返回计划，`storage --apply <planId>` 执行前重新校验。

平台选择依据和真实验证边界见 [扩展评审](reviews/2026-10-14-platform-expansion-review.md)；YouTube 的运行条件参见 [yt-dlp 官方 EJS 说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)。现有可用 Node 及官方 yt-dlp 可执行文件无需再引入新的 JavaScript 运行时。完整功能、推荐路径和本轮回收数据见 [功能与存储说明](library-capabilities-storage.md)。

## 视频号解析设置

在窗口“登录与依赖”页可启用或关闭“视频号第三方解析”。应用初始默认关闭；本项目已根据当前聊天中的同意启用，并选用实际下载成功的免费解析站 `v.mtotech.com`。该站只收到主动提交的 sph 分享链接，不读取或发送微信账号 Cookie，也不需要调用者的服务访问凭证。新默认地址不会自动覆盖其他已有自定义配置。

CLI 在 `程序文件/` 执行：

```powershell
node dist/link-cli.js video-parser
node dist/link-cli.js video-parser on
node dist/link-cli.js video-parser off
node dist/link-cli.js video-parser on "https://v.mtotech.com/api/resolve"
node dist/link-cli.js video-parser on "https://你使用的服务/api/fetch_video_profile"
```

如果服务需要经过本机已有代理，可在 `on` 后依次提供服务地址和本机代理地址。应用只让该解析请求经过代理，不改变 Windows 的代理、证书或默认浏览器。

设置保存在被 Git 忽略的 `程序文件/.content-settings.json`。所有解析请求都是 `POST` JSON `{ "url": "视频号分享链接" }`，去除分享链接的查询参数和片段；只请求当前配置的服务，不把同一条链接自动发往多个站点。

- 内置免费服务精确地址为 `https://v.mtotech.com/api/resolve`，严格要求 `ok === true`，仅读取 `data.h264_url` / `h265_url`，优先 H.264，取 `description` 和 `author` 作为原始说明。最长等待 90 秒，不发送认证头。
- 其他自定义服务保留原来的 `data.feedInfo.h264VideoInfo.videoUrl`、`h265VideoInfo.videoUrl` 或 `videoUrl` 协议，最长等待 45 秒。需要服务凭证时按下述本地文件配置。

两种路径都不递归抓取任意 URL；下载只使用选定的单个视频地址，并检查公网地址、2 GiB 上限和实际 MP4 视频流。短时签名地址仅用于本次取得原文件，离线阅读使用保存到本机的文件。

如果拥有该服务的访问凭证，请在本机创建被 Git 忽略的 `程序文件/.content-parser-auth.json`：

```json
{
  "schemaVersion": 1,
  "endpoint": "https://你使用的服务/api/fetch_video_profile",
  "credential": "只在本机填写服务访问凭证"
}
```

凭证只用于与 `endpoint` 完全匹配的服务请求；服务重定向会被拒绝，下载媒体时不携带凭证。不要把真实凭证粘贴进聊天、分享截图或提交 Git。没有可用凭证时，`401` 会明确提示服务授权问题。

接口参考：[当前免费服务页面](https://v.mtotech.com/)、[其公开前端请求与响应契约](https://v.mtotech.com/app.js?v=20260728-gtm-download)。旧自定义协议参考：[解析客户端源码](https://raw.githubusercontent.com/cexll/wx-channels-skill/main/scripts/wx_channels_download.py)、[Worker 鉴权源码](https://raw.githubusercontent.com/ltaoo/wx_channels_download/main/internal/workers/sph/worker.js)；旧 Worker 的匿名示例已无法用作当前免费服务。

## 本次实测

两条用户样本均已保存原视频：小红书 MP4 92,406,705 字节，视频号 MP4 33,039,687 字节。视频号通过正式应用配置取得 H.264 / AAC、720 × 1280、433.903 秒的视频，哈希和完整音视频解码通过，离线阅读页使用本地视频。原视频取得阶段 226 项回归、构建和类型检查通过；本轮转写与优化的集成检查另见验收报告。

2026-10-14 已补齐两条本地语音文字稿，最终使用 [faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) 与 CPU int8 计算，实际运行类型为 int8_float32。小红书为 236 段、2,570 字符，视频号为 248 段、2,591 字符，均从开头覆盖至片尾讲话结束。每条保存 Markdown、SRT、JSON、音轨，并更新综合正文、离线阅读 HTML / PDF；初始 tiny 结果保留供对照。

机器稿未做全文人工逐字校对；抽查已改善 SaaS、Adobe 等词，仍有 Cloudflare / Sierra 等专名错词，低置信分词和字幕对照见本地验证记录。本轮未追加关键帧 / OCR，所以任务仍为 partial；这不表示原视频或语音稿保存失败。最新结果见 [验收报告中的本次补充](link-library-acceptance.md)。单个成功样本不代表所有账号、私有内容、直播或未来失效链接都可下载。

## 下载与重试

- 媒体 GET 最多尝试三次，共享五分钟总期限。短时断线、声明长度截断、408 / 429 / 5xx 等可有限重试；取消、403 / 404、私网、凭证 URL、证书失败、大小超限等不会盲目重试。
- 同一次下载中的部分字节仅在完整长度、强 ETag、未压缩及范围等校验一致时通过 Range / If-Range 恢复；不支持或资源变更时安全从零重新取得。未实现跨进程保留部分下载状态。
- 完整文件按来源地址、路径、大小和 SHA-256 校验后免重复 HTTP 下载。小红书 / 视频号的已保存单视频重试，还会按既有分享身份和原始资产完整性免重新解析短链，不依赖过期的签名地址。
- 已存在且哈希一致的 staging 文件免重复复制；取消后不再开始下一份恢复复制。一次已经开始的系统复制可以先完成。

33 MB 视频号样本的新下载前后为 3.229 / 3.088 秒，单样本不能证明吞吐提升；三次完整文件复用中位数 93 → 3 毫秒、媒体 GET 3 → 0。收到约 4 MiB 时受控中断后，第二次请求在 4.325 秒内取得完整且哈希一致的视频。该 CDN 没有强 ETag，所以这个实测使用从零重试；Range 拼接由故障回归验证。证据为 `logs/download-optimization-20261014/`。

主控用两条真实资产在隔离库核验原视频恢复路径，第二轮没有 HTTP / DNS 请求、没有重复文件复制，内容 ID 和视频哈希保持不变；该检查跳过 ASR 与 PDF 生成，不能把恢复耗时当作整条任务耗时。证据为 `logs/transcription-performance-20261014/cache-check.json`。

本轮最终构建、类型检查、全量 311/311 和差异空白检查通过；源码冻结与检查前后哈希一致。详情见验收报告。界面修改在重新打开应用后载入。

此处 311/311 为前一阶段转写与可靠性集成记录。随后本地导入、YouTube 条件适配和存储生命周期的最终集成为 **372/372**，构建和类型检查退出码 0。120 份源文件检查前后哈希一致；正式库 385 个文件及 queue 未改动。最新范围与回收证据见 [功能与存储说明](library-capabilities-storage.md)。

首阶段条件适配的425项记录保留在 `logs/douyin-weibo-20261014/`，其中匿名 HTTP 返回login_required仅代表当时接口路径。Edge 补齐后的最新统一验收为 **463/463**、构建/类型检查退出码0，130份源码/测试/脚本/依赖文件在检查前后哈希一致；`资料库/` 下595个文件（含队列及既存工作材料）全部不变。独立审查已报问题关闭，无未决 P1/P2。最新证据在 `logs/social-edge-20261014/`，含两平台真实下载和微博移动入口结果；原件与两条现有 Small 文字稿保持不变。
