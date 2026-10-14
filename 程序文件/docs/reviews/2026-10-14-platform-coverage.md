# 平台覆盖交接：YouTube、微博 TV、B 站动态

本轮已完成 B 站动态/opus 的精确身份适配、微博 TV 真实采集验证，以及 YouTube 的同配置代理接入。两模块定向回归 **47/47**，当前源码 `tsc --noEmit` 退出码 **0**。18:06总控续验补齐YouTube真实应用媒体下载、合并、完整解码及隔离入库，见末节；下面早期TLS/429失败表保留其发生时状态，不代替最新结论。

## 真实结果

| 场景 | 已核验结果 | 证据与边界 |
| --- | --- | --- |
| 微博 TV `1034:633c288cc043d0ca7808030f1157da64` | 官方组件 OID 与输入 FID 一致；MID `4189191225395228` 绑定原帖 `FBqgOmDxO`；取得原帖正文与 1,126,415 字节原视频，实测 53.173991 秒，完整 FFmpeg 解码退出码 0 | `logs/platform-coverage-20261014/weibo-tv-live.json`、`weibo-tv-decode.json`。使用本轮独立空运行目录下的专用 Edge，会话没有导入既有用户 Cookie；未修改 `content-weibo.ts` |
| 历史失败 B 站动态 `1243630122984013862` | 官方 API 返回精确动态 ID、`DYNAMIC_TYPE_AV`，原视频 BVID 为 `BV1XNtJ6UEmm`；保存 500,120 字节原封面，字节、MIME、SHA-256 核验通过 | `dynamic-adapter-live-1243630122984013862-final.json`。这条动态自身没有文字正文，视频卡片简介是截断预览，未充作全文；返回准确原视频引用，长视频需按视频链接独立采集；历史失败队列没有在本会话重写 |
| 新版 opus `1167341221710921800` | 官方动态与 opus detail 均匹配同一 ID；保存原作者文字与 2,351,905 字节原图，SHA-256 核验通过 | `dynamic-adapter-live-1167341221710921800-final.json`。使用原生 `MODULE_TYPE_CONTENT` 段落与原图结构；预约等交互卡片明确排除，头像、推荐、评论未纳入 |
| YouTube 官方 yt-dlp 网络路径 `jNQXAC9IVRw` | 同一已有代理真实取得 `134+140` 两条流并合并；输出 633,710 字节、19.063583 秒，同时具有视频与音轨，完整解码退出码 0 | `youtube-official-live.json`。这是官方工具独立网络验证，尚不能代替应用流程结果 |
| YouTube 资料库流程（早期失败记录） | 初次准确元数据读取成功，但直连 CDN 超时；接入固定公网 IP 代理后，媒体 TLS 连接断开。总控补受控 DoH 后的一次有界尝试在元数据阶段收到 HTTP 429 / 机器人验证，返回 `login_required` | `youtube-live.json`、`youtube-app-live.json`、`proxy-dns-evidence.json`、`youtube-app-final-live.json`。此早期阶段尚未完成真实应用下载/合并/隔离入库；18:06续验已通过，见末节和`youtube-status-followup.json` |

当前系统把已核验样本的 Googlevideo 域名解析为 `108.160.162.102`。这是当前 DNS 观察；其与 TLS 失败之间的关联需要网络层验证，不能只凭地址断言根因。后续有有效元数据或平台不再要求验证时，才可继续同一受控应用路径验证，不循环请求、不导入默认浏览器 Cookie。

总控 DoH 修订后的同域名根路径 HEAD 取得 HTTP 404，证明此次 TLS 传输能够完成；没有请求签名视频 URL 或取得媒体字节，不能证明完整应用下载已通过。证据：`doh-head-live.json`。

三份成功取得的微博/动态记录已调用真实 `saveContent` 保存到本轮隔离库，再读回正文、阅读文件与媒体哈希。结果为微博 `partial`、视频动态 `partial`、图文动态 `completed`；这些状态保留原覆盖范围，未把未采集评论或未保存原视频改成完成。证据：`isolated-save-readback.json`。样本目录的当前保留/清理状态以 `cleanup.json` 为准。

真实媒体 SHA-256：

- 微博 TV：`e69ecdaef96d71dcc8b8bee467a432088090da906a310502e62f0e442d5f7d02`
- 动态原封面：`12f8ecfc835e2797f4d86a708af36c447c87afe2c435d9b6be3c78d671204775`
- opus 原图：`7045721b4fc6adba473fa92abdc8db2a8b98f59d7bfd70d400cc911b2c33172b`
- YouTube 官方工具成片：`71b5cb268beebc4075b4264e5c717e02d8e2c844b71e3c906ee4f95b55cee3ed`

## 接入契约

`src/content-bilibili-dynamic.ts` 导出：

- `bilibiliDynamicReference(value)`：接受 `t.bilibili.com/<数字ID>` 与 `bilibili.com/opus/<数字ID>`，返回 `{ nativeId: "dynamic:<ID>", dynamicId: "<ID>", canonicalUrl: "https://t.bilibili.com/<ID>" }`。不与视频 BV/AV 身份碰撞；拒绝动态列表、主页、伪造域名、凭据、非标准端口和多余路径。
- `acquireBilibiliDynamic(input, context, deps?)`：接收平台 `bilibili` 与上述精确身份。已解析的 `b23.tv` 分享允许以 `canonicalUrl` 采集，同时保留原 `sourceUrl`；明确原链接与 canonical/nativeId 冲突则拒绝，外站不能仅靠一个 canonical 值冒充目标。
- `captureBilibiliDynamicBrowser`：供同模块回退与定向诊断使用，每次创建空临时 Edge profile，结束清理本次 profile；只请求两个精确官方 detail 接口。没有默认浏览器 Cookie 导入、登录账号操作或第三方解析器。

动态使用官方 `x/polymer/web-dynamic/v1/detail`，图文使用官方 `x/polymer/web-dynamic/v1/opus/detail`。本机真实接口存在 `-352` 风控，空 Edge 的站点自身访客初始化后，未签名的精确读取取得目标数据。只接受同 ID、可见的官方 item；转发只保留发布者自己的正文，不展开 `orig`，推荐及其他 ID 不能供给原文或媒体。图文未知段落、缺失的已知文本字段、全文缺失均保留部分/未知覆盖；专栏卡片与视频简介不冒充全文。

原图每张上限 20 MiB、数量 64、原图合计 100 MiB，正文/API 上限 4 MiB。原封面单独上限 20 MiB。媒体先放本次独有事务目录，核对实际字节、SHA-256、图片头/MIME 后再原子替换；失败、取消不覆盖已有成功文件。已保存原图逐项 checkpoint，取消后保留完成项。

YouTube 在 `src/content-ytdlp-platform.ts` 使用总控单写的 `configuredYoutubeProxy()` 与 `youtubeMediaTransport(proxy)`：`CONTENT_YOUTUBE_PROXY` 优先，否则已有 `HTTPS_PROXY`/`HTTP_PROXY`，仅无凭据本机 HTTP(S) 代理；元数据明确传同一个 `--proxy`，媒体仍经过共享 `savePublicAsset` 的字节、重试、断点、取消与完整性检查。本轮没有修改共享网络/代理模块。FFmpeg 合并与 ffprobe 使用本地 MOV demuxer，禁用外部 dref 和绝对路径引用。

当前本机 Node 24.14.0 与已有官方 yt-dlp 可读取该公开视频元数据；官方文档要求 Node 至少 22，官方独立可执行包自带 EJS。未启用远程 EJS 下载或任意插件。[yt-dlp EJS 官方说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)。机器人验证及账号受限等边界以当次实际平台结果为准。[YouTube 提取器官方说明](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube)。

## 验证与写入范围

`tests/content-bilibili-dynamic.test.ts` 26 项、`tests/content-ytdlp-platform.test.ts` 21 项。覆盖身份冲突、短链 canonical、转发隔离、私网媒体、完整性错误、既有文件保护、缺失图文节点、预算与取消、代理配置一致、受限元数据、双流合并和时长错误。RED 及最终 GREEN 日志在 `logs/platform-coverage-20261014/`；最终 47 项结果见 `targeted-final.log`，类型检查见 `typecheck.json`。

本会话独占修改：动态模块、新增动态测试、YouTube 模块及其测试、本评审和上述专属日志。未修改正式资料库、队列、账户、`content-input.ts`、`content-acquisition.ts`、共享类型、共享浏览器、CLI/UI、包依赖或 dist；未创建 worktree、提交、推送或归档会话。总控已接入分类与 acquisition，最终共享回归、正式资料 595 文件基线比较、窗口与 CLI/MCP 验收由总控完成；此处不代替它们。

输入为当前项目源码、历史失败队列的脱敏读取、上述真实官方响应与总体计划 `docs/plans/2026-10-14-library-usability-upgrade.md`。已读当前 Harness 偏好、本机说明、任务路由和证据分层视角；路由文件 SHA-256 与派发值 `F0E1B13E89A184D15D7A83B1404F418420F8B708A2886CB2BB589365FD0F4B48` 一致。继承当前会话模型，未覆盖模型或派发新 Agent；运行时内部实际型号与 token 节省没有独立观察，未据此作收益声明。

冻结文件身份及证据状态见 `logs/platform-coverage-20261014/verification.json`。之后如总控变更共享传输或接入，需要它验证新增主张，不能用这份定向结果自动证明完整应用支持。

## 总控续验：真实应用媒体路径已通过（18:06）

用户询问当前YouTube能力与能否继续推进，总控按systematic-debugging核对历史官方工具路径、应用元数据/媒体传输路径及[官方429处理说明](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#http-error-429-too-many-requests-or-402-payment-required)，随后执行一次45秒总期限的匿名复测。使用现有本机代理与已冻结编译程序，单次元数据提取，关闭该提取的失败重试；不读默认或应用既有浏览器Cookie，不复用过期签名缓存，不增加插件或更换网络线路。

`jNQXAC9IVRw`本次元数据退出0，未出现429/机器人验证；两条音视频流经应用共享下载器保存并本地合并，ffprobe核验通过。最终MP4 **744,412字节**、SHA-256 **a521d584e2ad7a8afb39899fe2a9cbdeecbda46c6599a69f15453c72283b60f9**，完整FFmpeg解码退出0。真实saveContent保存到本次独有隔离库后，原视频SHA与采集原件一致，离线阅读文件存在；全流程**30,125ms**。这是新的提取与成片，字节/SHA不与较早633,710字节官方工具成片混记。

本次没有执行ASR、OCR或平台字幕/评论采集，隔离清单仍为`partial`，不将媒体保存成功写成所有派生内容完成。应用下载/合并/完整解码/隔离入库的真实尾项已通过；当前支持仍限定公开视频单视频、HTTP(S) MP4/M4A流及可访问网络，单次成功不保证其他链接或长期稳定。此次没有反例证明唯一根因，因此不将恢复单独归因于DoH、等待时间或某个网络选项。

临时原件、匿名运行目录和隔离库逐级核对绝对路径/链接归属后全部移除，只留一次性复测脚本及脱敏receipt `logs/platform-coverage-20261014/youtube-status-followup.json`；没有增加正式资料条目。复测后146份源码/脚本/测试/依赖SHA仍匹配最终561项验收版本，正式595文件大小/SHA全不变。无产品源码变更，不重复全量测试；最新支持表、README、功能说明和主计划已回写真实结果。

## 继续完善与真实队列验收（18:55—19:00）

用户随后明确要求继续验证完善。本节为当前版本，上节18:06不改源码与partial只表示当时事实。六个新增反例已从旧实现失败转为通过：YouTube专用登录、网络选择持久化及兼容/非法值保护、元数据/媒体429重复重试、原件任务被未开放评论误标partial。元数据retries/extractor-retries归零，完整stderr的429判断优先于登录文字；媒体429取消响应体后终止该次自动重试，其他平台3次/Range/ETag保留。auto/direct/proxy设置贯通元数据、媒体及专用Edge，直连显式禁止代理回填；只导出专用目录youtube.com域Cookie，默认浏览器、Google/其他平台及视频号凭证不参与。

真实编译CLI在新匿名运行根保存本机代理、清除代理环境，执行youtube-network→enqueue(original)→work→retry(transcribe)→work→read→同模式重复enqueue，全部退出0。原件/文字稿两阶段均completed；视频744,412字节、SHA为`a521d584e2ad7a8afb39899fe2a9cbdeecbda46c6599a69f15453c72283b60f9`，完整解码0。转写阶段使用现有Small离线模型，同时将下载器替为不可执行的隔离哨兵，仍生成Markdown468字节、SRT303字节、JSON6658字节，原视频SHA不变；读取697字符，重交readyCount0/existingCount1。原件worker30,770ms、补转写7,415ms、全流程39,088ms；只表示本样本。哨兵只证明未重新调用下载器，不将其当成进程网络抓包。`youtube-queue-live.json`保留，所有临时样本、识别结果、运行根和隔离库已清理。

失败记录`youtube-improvement-red.log`为27项21过/6失败。新增范围独立只读复核32/32、无未决P1/P2、12源码/脚本/测试SHA不变；命令`node.exe --import tsx --test tests/content-youtube-workflow.test.ts tests/content-ytdlp-platform.test.ts tests/content-youtube-transport.test.ts`，2870.282ms。真实隐藏WinForms有8项设置校验/保存/最小尺寸断言，真实账号登录和人工验证码未执行。

最终全量568/568、0失败/取消/跳过，18,104.982ms，类型/构建退出0。148源码/脚本/测试/依赖前后SHA相同，正式595文件大小/SHA不变。本次统一及独立证据由`youtube-improvement-verification.json`承接，不覆盖早期47项owner冻结证明。已把当前可用本机代理保存为项目YouTube选择，视频号设置不变；原选择及恢复方法见`youtube-network-recovery.json`。系统代理、真实账户未操作，音频未上传；长期平台稳定仍未知。

## 429持久冷却与窗口自动恢复（19:32—19:38）

这是当前最新版本；上节568/148保留其历史身份。用户明确要求补上自动冷却：队列共享5/15/30分钟退避、有效媒体Retry-After的更长等待、最多3次自动恢复、超限或验证时人工继续。完整queue文档在统一事务保存；冷却期间其他平台继续、worker释放锁，取消/重试/新输入/重启/任务历史写入保留时间约束。窗口每5秒先刷新持久状态再唤醒单次`work --scheduled`，只领取已安排的automatic waiting，不启动仅入队的新任务；CLI/MCP给恢复时间，无窗口不常驻等待。

初始服务缺调度意图及独立审查发现的异常终态取消竞态分别有实测RED，后者旧代码在精确交错后错误写为failed；修复后队列事务内取消胜出。限定独立复验43/43、15文件SHA不变，P2已关闭，范围内无未决P1/P2；最终全量579/579、0失败/取消/跳过，19,049.217ms，类型/构建0、150源码前后SHA相同、正式595文件全不变。隐藏窗口夹具涵盖等待装载、倒计时/恢复时间、取消和先读队列、到期单次恢复及不启动仅入队任务。

真实新编译CLI从人工种入的“已到期429”等待记录续接（该初始429不是真实平台响应），使用无Cookie的匿名隔离运行根、既有本机代理且清除代理环境。实际`work --scheduled`完成一次公开视频下载/合并/入库，33,692ms、completed，744,412字节MP4、SHA`a521d584e2ad7a8afb39899fe2a9cbdeecbda46c6599a69f15453c72283b60f9`，完整解码0、阅读页存在、共享预算清除。临时样本/目录已检查归属及无链接后清理，不新增正式资料。真实账号验证/自动解除平台429/长期稳定未被证明；最终证据以`youtube-retry-verification.json`承接。
