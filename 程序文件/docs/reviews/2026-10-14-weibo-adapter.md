# 微博单条适配器交接（2026-10-14）

当前版本已补专用 Edge 自动获取路径，见本页最后“专用 Edge 补齐”一节。下列17项定向验收、425项总验收及纯 HTTP 匿名受限结果属于补齐前的历史证据，不能代表当前 Edge 路由的真实可用性。

本次独占修改为 `src/content-weibo.ts`、`tests/content-weibo.test.ts` 和本报告；隔离证据位于 `logs/douyin-weibo-20261014/weibo/`。共用身份解析、路由、类型、登录入口、UI 和总验收由主控负责。本子任务没有写正式资料库，没有修改前序转录、本地导入、ASR 模型或其他平台模块。

导出接口是 `acquireWeibo(input: ContentInput, context: ContentContext, deps?: WeiboDeps): Promise<CapturedContent>`。`WeiboDeps` 兼容主控的 `AcquisitionDeps`，复用 `runTool`、`probeMedia`；附加接口和下载注入仅用于定向验证与预算控制。

## 身份和内容范围

- 复用 `content-social-reference.ts` 的精确 MID/BID 分块换算与 FID 解析。普通单帖保持 BID 身份及 `https://m.weibo.cn/status/BID` 规范地址；TV 保持 `video:FID` 身份，回查原帖后仍只选择输入 FID 的视频。
- 原帖声明的 `id`、`idstr`、`id_str`、`mid`、`bid`、`mblogid` 必须全部有效且一致。不会从 cards、评论、推荐列表寻找近似帖子，也不下载头像、转发原博图片或原博视频。
- 正文保留原帖的 `text_raw` 或安全转换 HTML。长文先取绑定原帖的内嵌全文，再取官方 longtext/extend。扩展响应未声明身份时依当前官方请求绑定；声明了任一身份字段时必须全部归一有效且等于原帖。失败时保留片段，正文覆盖明确标为不完整。
- 图片取原帖 `pic_ids/pic_infos`、`pics` 和自身混合附件；声明图片数量但缺失地址时保留缺失记录。原视频取自身 `page_info/media_info` 或混合视频附件，优先 progressive playback MP4。私网、带账号密码、分段清单和加密媒体不登记为保存成功。

## 下载、登录和保存边界

所有媒体字节经过共享 `savePublicAsset`。每次尝试使用当前条目下 `.weibo-downloads/UUID` 独立事务，先核对非空字节、预算、哈希和图片文件头；视频还须通过本地视频流、有效时长核验。默认 ffprobe 显式使用 `-f mov -enable_drefs 0 -use_absolute_path 0`，并保留 `file,pipe` 协议白名单，防止伪装成 MP4 的清单或外部数据引用被自动探测。元数据与实测时长差须不超过 `max(0.5秒, 3%)`。通过后使用共享原子替换；失败和取消不会把新文件覆盖到旧文件上，也不依赖后续 manifest 合并来补救。临时事务目录在解析绝对路径并确认归属后清理。

每张图片上限20MiB，视频及成功留存媒体总预算默认最多2GiB，可由 deps 下调；一帖最多128张图片、9个视频，每个视频最多尝试2个 progressive 地址。API 正文8MiB、索引正文4MiB、一次调用5分钟；超限或失败保留明确状态与已完成的检查点。

请求使用微博官方接口及正常匿名访客初始化，JSONP 只用固定回调格式提取 JSON，不执行脚本。有效 JSON 优先解析，正常原文包含“验证码/安全验证”不会误判为挑战页。专用登录只读取项目 `.content-profile/weibo/cookies.txt` 的微博域 Cookie；正常访客 Cookie 只保存在调用内存中。不读取默认浏览器、不使用第三方解析、不绕过验证码。

官方接口字段和正常访客序列参考 [yt-dlp 的 Weibo 提取器源码](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/weibo.py)。本机实际响应另确认了 `window.gen_callback && gen_callback({...});` 前缀，记录只包含结构、键名和状态，没有访客标识或凭证。

## 本次验证和当前限制

定向测试17/17通过，包含精确单帖、MID别名、身份冲突、长文失败与矛盾扩展、合法正文中的挑战词、实际 JSONP 前缀、图片和视频核验、强制MP4解析器、2秒视频只得到0.1秒时拒绝、失败图片/视频保留旧好文件、TV选中输入FID、转发隔离、登录状态和取消检查点。严格 TypeScript 定向检查通过；没有运行全套测试或构建。

实际 ffprobe 使用相同参数读前序隔离样本 `logs/local-import-20261014/source-samples/本地视频.mp4`，返回视频流和6秒时长，前后 SHA-256 均为 `258623451dabda35b096693a6dff37d21073305c29c40357f6e20bb0b13ee00f`。同一次验证中，隔离目录伪装为 `.mp4` 的 M3U8 载荷被拒绝，退出码1；未引入新的大型样本。

真实样本为 `https://m.weibo.cn/status/FBqgOmDxO`，限定90秒、视频20MiB、成功留存总计25MiB，目录为 `logs/douyin-weibo-20261014/weibo/real-post-FBqgOmDxO/`。本机没有微博专用 Cookie 文件。2026-10-14 14:14（上海时间）官方普通接口和正常访客初始化均返回HTTP200，但重试桌面接口仍跳转 `passport.weibo.com`，移动接口跳转 `visitor.passport.weibo.cn`。结果为资产 `login_required`、整条 `failed`、正文0字、原媒体0件。没有宣称已成功抓取此微博的真实原文、图片或视频；专用登录后真实内容的验收尚未完成。

证据文件：`tests.txt`、`typecheck.txt`、`regressions-red.txt`、`visitor-red.txt`、`mp4-probe-red.txt`、`mp4-tool-report.json`、`visitor-shape.json`、`real-sample-report.json`。测试中媒体夹具明确为注入样本，不作为真实平台下载证明。

模块已冻结，交由主控统一集成验收；除主控提出具体修正外，不再修改共用文件或继续真实平台写入。

## 主控最终集成

独立冻结复核发现 host-only Cookie 作用域扩大（W3）；主控接手并修复 Netscape TRUE/FALSE、响应 Domain 是否声明、路径边界及未声明 Path 的请求目录默认值。新增 `content-social-cookie-scope.test.ts` 4项使用合成会话验证微博两种 Cookie 来源和路径、抖音现有正确范围。独立原复现复核通过，已报问题全部关闭。

最终全量425/425、构建/类型检查退出码0，129份源文件哈希在检查前后不变，385份正式文件与queue不变。原17/17是模块首次交接证据，最终以主控 `logs/douyin-weibo-20261014/` 下的检查记录为准。一次可能读取项目专用 Cookie 的复测命令被自动审批拒绝，未执行；主控改用新建空运行根和单独的本地探测器，批准后的纯匿名复测仍为login_required，正文0、已存媒体0，报告不含凭证或签名。

## 专用 Edge 补齐（2026-10-14）

用户提出“和小红书一样用edge不行吗”后，本模块接入总控维护的 `content-social-browser.ts`。新增 `WeiboDeps.captureBrowser?: typeof captureSocialBrowser` 注入；正式默认调用共享 helper，使用项目 `.content-profile/weibo` 专用 Edge 持久会话，加载输入的精确 UID/BID 或 TV FID 页面。测试默认注入快照，因此本子任务没有打开真实 Edge profile，真实样本由总控串行。

普通帖子先尝试两个官方 HTTP show 地址；接口失败或返回不匹配身份时，自动请求 Edge 页面观察到的官方 JSON 和同站 fetch。每次帖子回退提供4个有限官方 GET（桌面/移动 show、longtext/extend），没有 Cookie、Authorization 或显式 Referer header。TV 回退先提供1个官方 component POST，仅 Content-Type 与输入 FID 表单，再依据 MID 绑定回查原帖；已观察到的同帖 JSON 可直接复用。每次调用最多使用 component 和 post 两个 Edge 阶段，同一阶段不会重复打开 profile。

浏览器结果只读取允许的官方 show/longtext/component 响应，按请求地址的 BID/MID/FID 和响应身份双重校验，复用原有顶层原帖解析。错误页面、其他帖子、其他 TV FID、推荐或无关接口均不可作为目标数据。不会从无绑定证据的 HTML 抽取正文或媒体。TV 响应声明多个 FID 字段时须全部等于输入 FID；原帖和长文声明的多个身份字段仍须全部归一一致。

完整、已核对的目标 JSON 不因随后出现验证页面而被丢弃；没有可核对目标数据时，`gated=true` 才登记 `login_required`，正常可读空结果登记 `unavailable`。长文仍可通过已绑定的浏览器 longtext 或完整 show 补齐；失败保留原帖片段，验证页保留需登录状态。浏览器 `text_raw` 原样保留，包括字面尖括号和段落换行，不再二次转成 HTML。原媒体继续经过共享下载、独立事务、真实 MP4 探测和原子替换；无效回退不能覆盖旧好文件。取消在打开 Edge 前、返回快照后和下载提交前均检查。

当前微博定向测试30/30通过，严格 TypeScript 定向检查通过。新增13项覆盖 HTTP失败后浏览器成功、同帖原图与转发隔离、错误页面/接口/帖子/TV身份、验证码与可读空结果、长文补齐与冲突身份、无效视频回退保留旧文件、验证页面保留已核对数据、原始正文保真、HTTP已成功时不打开浏览器、两个取消时点及脱敏错误诊断。仅执行本模块测试和定向 noEmit 检查；没有生成 dist、运行全套、提交、写正式资料库或队列。

早期 helper 证据 `logs/social-edge-20261014/weibo-browser.json` 使用全新匿名运行根，但链接 `https://weibo.com/1866405545/FBqgOmDxO` 的作者 UID 错误；该帖准确 UID 为 `5926682210`。早期页面初始出现目标 show JSON、`gated=false`，不能证明错误作者路径可稳定加载。首次集成下载报告 `logs/social-edge-20261014/weibo-download.json` 返回 helper 读取失败、无视频；相关失败证据保留，错误 UID 后续导致网页空化或昵称不存在，不能据此归因为平台会话限制。本模块保留 helper 脱敏错误信息及状态，便于核对失败阶段。

总控随后反馈定位到正常访客初始化触发自动重载，与官方接口读取发生导航竞争，具体错误为 `Execution context was destroyed`；已在共享 helper 加入至多两次读取及有界 DOMContentLoaded 等待并保留已观察响应。另外，正常 `visitor.passport` 中间跳转被过早判为就绪验证页，已从等待判定移除，只有最终停留才分类为 gated。以上属于共享浏览器层，微博请求白名单不需修改；本模块继续透传脱敏错误阶段与准确状态。

当前真实下载证据已更新为 `logs/social-edge-20261014/weibo-download-bootstrap-fixed.json`：2026-10-14 15:13:32（上海时间），全新匿名运行根使用准确链接 `https://weibo.com/5926682210/FBqgOmDxO`，通过专用 Edge 获取官方原帖 JSON、完整正文和1份已核验原视频，无警告。总耗时3568毫秒（不是视频时长），原视频1810094字节，SHA-256为 `17f407a0e005d2ab73b276e5d5e1d8345f89fecab7f9e521648f252738575aca`。总控确认经过真实 ffprobe 视频流和时长核验，并清理临时样本；正式资料库未写入。本模块读取了该证据的覆盖、媒体状态、字节数及哈希，与总控回报一致。

冻结时源码 SHA-256：`src/content-weibo.ts` = `5fb083179215ae663008888fc6e97e1384daeb7c059be8e19de8f21ff7a23adf`；`tests/content-weibo.test.ts` = `ba268c4053e10f97b79fec5b9d6fd4e6ac411d263beb06a9fa7c44a8b43bead0`。本次只更新实测交接事实，30项已通过测试及源码保持冻结，没有追加功能或重新运行全套。

本次只修改 `src/content-weibo.ts`、`tests/content-weibo.test.ts` 和本报告，保留总控此前的 Cookie host-only/includeSubdomains 与路径范围修复及历史交接记录。当前源码已重新冻结，微博本轮准确链接的真实下载已通过，总控继续完成统一验收。
