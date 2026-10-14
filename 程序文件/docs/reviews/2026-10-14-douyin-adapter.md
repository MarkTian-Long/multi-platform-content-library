# 抖音单条作品适配交接

2026-10-14，Asia/Shanghai。导出 `acquireDouyin(input:ContentInput, context:ContentContext, deps:DouyinDeps):Promise<CapturedContent>`，位于 `src/content-douyin.ts`。`runTool`、`ytDlpPath`、`probeMedia` 与当前 AcquisitionDeps 兼容；额外 `maxVideoBytes` / `maxDurationSeconds` 可在隔离样本验证中收紧预算。未修改 acquisition、types、service、CLI、UI、content-input、content-network 或 YouTube 模块，路由与专用登录入口由主控集成。

## 范围与行为

通过主控的纯 `douyinWorkReference` 校验 URL 和数字作品 ID。识别与短链解析仍归主控；模块实际读取 helper 得到的单条作品 canonical URL。没有主页、合集、直播、推荐区抓取；modal_id 若代表一条明确作品，转到该作品路径读取，不读取主页。

优先解析作品页中 RENDER_DATA 的 `aweme.detail` / `aweme_detail` / `awemeDetail` 和 `_ROUTER_DATA.loaderData` 的明确 video/note 页面 `videoInfoRes.item_list`。脚本仅作有边界的 JSON 解析，不执行 JS；只接受字符串 aweme_id 精确匹配目标的对象，排除其他推荐作品，多个不一致主体拒绝。当前公开样本未提供可访问的作品数据，所以这些页面结构的覆盖来自可控夹具，未当成真实页面成功验收。

没有可用结构数据时，对同一 canonical 视频 URL 调用官方 yt-dlp metadata-only。限制 `^Douyin$` extractor、禁用环境配置/插件/远程组件/playlist/format 探测，不让 yt-dlp 下载媒体，不保存带签名地址的原始 info JSON。必须匹配目标 id、Douyin extractor 与可选 webpage_url，拒绝 playlist、live、DRM、音频主体和分段流。公开视频源 URL保持服务器提供的值，不重写水印、授权或签名参数。

原始作品说明原样保留为 markdown；metadata 标题独立保留，description 缺失时正文保持空并将 body coverage 标为 unavailable，不以标题补造原始说明。标题只按现有约定缩短，作者和发布时刻来自匹配作品对象。视频经现有 savePublicAsset 下载，沿用公网 DNS / 私网拒绝 / 重定向 / 长度 / 大小 / 原子写入 / 取消 / 有限重试。默认 2 GiB 上限，45 秒作品页、60 秒 metadata、30 秒 probe、十分钟采集总期限；独立事务文件完成视频流和有限正时长核验、时长差 `max(0.5秒,原时长×3%)`、长度及 SHA-256 后才原子替换为 `video/001.mp4`，`provenance=original`。不强制音轨存在，允许原本无声的视频；衍生产物继续由现有 enrichment 明确标记。

失败/取消仅清理本调用创建的事务目录，不删除或先覆盖旧好文件。专用 session 只读取 `.content-profile/douyin/cookies.txt`，要求普通小文件及无符号祖先；作品页 Cookie 做域、子域、路径、过期及控制字符过滤，媒体不附带 Cookie。登录/验证码页面返回 login_required，要求人工完成；不会创建账号、导入默认浏览器 Cookie、生成挑战签名或请求第三方解析服务。

图文边界明确：若 note URL 或匹配主体带 images，则仅保留能核验身份的原说明，`kind=gallery`，图片记 unavailable。当前不是图文图片下载器，不能作为视频 saved。封面、字幕、评论、合集与直播均未采集。

## 上游与真实验证

今日网络核验的 [官方 DouyinIE](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py) 仍通过 web detail API 取得 aweme_detail，无有效数据时保留新鲜 Cookie 失败路径；这不等于必须账号登录，也不能推断匿名必然成功。当前本机 yt-dlp 为主控已核验的 2026.08.19。实现没有复制上游其他平台的验证挑战求解。

只选择官方测试列表中一个作品 ID `6961737553342991651`，上游标注 19 秒。在 `logs/douyin-weibo-20261014/douyin/sample` 隔离验证，媒体预算 32 MiB、时长预算 30 秒、采集期限 90 秒；没有换用其他样本或解析服务。实际结果 **login_required，媒体字节 0，hash / duration 未取得**。没有真实原视频保存成功的声明。结果见 `real-result.json`，输出仅 id/status/bytes/hash/duration；未打印 Cookie 或签名 URL。当前没有需保留或清理的大媒体文件。

## 定向检查与交接

初始 11 项有 9 项按缺失行为失败，见 `red-tests.log`；另复现并修复了把作品说明里的“验证码”误当验证页的问题，见 `captcha-text-red.log`。独立审查提出的两个 P2 在 `review-red.log` 均已复现：精确作品数据优先于普通登录/验证词判断；metadata 标题不替代缺失的原始说明。修复后先单独核验身份优先回归，再运行全部 **15 / 15 本文件定向测试**，类型检查退出码 0。只有缺少精确目标状态才采用文本验证判断；独立 captcha 元素仍保守停止。真实受限样本证据保持，没有为了通过检查重取样本。

最新定向用例覆盖精确作品与推荐隔离、身份不符、验证停止、官方 metadata-only 参数、fresh-cookie状态、Cookie 域/路径/过期隔离、私网、探测缺流/时长不符、大小预算、取消、图文边界、伪造主机与专用 profile 符号链接、正文途中取消及旧文件保护。源码、测试和本文的最终 SHA-256 在 `verification.json`，本交付后冻结，由主控完成全量验收。

格式收口：默认 ffprobe 保留 `file,pipe` 并显式添加 `-f mov -enable_drefs 0 -use_absolute_path 0`，仅按 MOV/MP4 容器处理，禁止外部 track 和绝对 data reference。本机 demuxer 帮助已核对两个选项。真实本地回归先复现了 auto-probe 将声明为 MP4 的 concat 播放列表读成其引用的两秒素材并错误 saved；限定格式后拒绝该载荷，普通两秒 MP4 仍正常通过。只使用前一任务已生成的本地微型素材，没有增加平台样本或网络流量。最终 **17 / 17 定向测试通过、0 skipped，类型检查退出码 0**，最新源码及证据重新冻结。

运行本文件：

```powershell
node --import tsx --test --test-reporter=tap tests/content-douyin.test.ts
cmd /c node_modules\.bin\tsc.cmd --noEmit
```

上述 HTTP/yt-dlp 阶段的计数和类型检查结果在本日志目录的 `verification.json`；该记录不覆盖后续 Edge 补充。未运行全套或 build、未提交、未写正式资料库。主控告知已接好 router、专用登录、显示/UI/MCP；本任务没有改公共接入文件，交由主控全量验收。该阶段仅验证受限状态，后续匿名真实成功证据见文末。

## 专用 Edge 获取补充

根据用户“和小红书一样用 Edge”的最新要求，已在本模块接入总控的 `captureSocialBrowser`，`DouyinDeps.captureBrowser?:typeof captureSocialBrowser` 用于测试注入。获取顺序为 **HTTP → 专用 Edge → yt-dlp 最后兜底**。HTTP 已有完整、身份一致的原视频信息时不启动浏览器；HTTP 受限、命令行不可取、或已知视频缺直链时自动读取持久的 `.content-profile/douyin`。本模块没有创建或控制共享 helper，也没有并发打开真实 profile。

Edge 接收一个有限的官方 detail GET：`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=<目标ID>`，只设置 Accept，不传 Cookie、Authorization、Referer；浏览器使用自己的目标页会话。解析渲染后的既有结构状态和官方 `aweme_detail` JSON，必须精确匹配字符串作品 ID；非成功 status_code、外站、feed、不同请求 ID、其他页面作品均拒绝。通用 meta/title 和 DOM/video URL 不能提供身份依据。

已取得且精确核验的主体优先于粗略 gated 信号，既有说明、作者等不被后续空字段覆盖。没有主体且 gated=true 才表达明确会话/验证状态；可访问但空结果不冒充登录失败，返回 unavailable。取消后不进行命令行或媒体请求。媒体仍走原来的公网事务下载、MOV/MP4限定的 ffprobe、时长/哈希核验和原子替换，空结果、错误主体、验证或取消不会覆盖旧好文件。

本轮仅改本模块、对应测试和本文；原先日志中的 17/17 冻结记录是上一阶段的历史证据，不覆盖成当前浏览器版本。Edge 注入回归先观察到 4 个缺失行为失败，再实现回退，并覆盖错误身份/外站/推荐、空结果、验证、已知说明保留、已可用主体优先、HTTP快路径和取消。最后一次本文件定向结果 **27/27、0 skipped，tsc --noEmit 退出码0**；没有由本模块启动真实 Edge 或追加平台样本流量。真实 profile 与样本由主控串行操作。

总控匿名专用 Edge 对近期人民日报作品 `7691241374158556466` 获得 status_code=0、精确 aweme_id 和 video 对象，获取层证据位于 `logs/social-edge-20261014/douyin-recent-browser.json`。随后主控串行运行本模块，已实际下载并验证原视频，下载层证据为 `logs/social-edge-20261014/douyin-download.json`，本次交接已只读核对：

- 原视频 saved，**4,775,833 字节**。
- SHA-256：`406e29ea3e8f2c03be3b244be34273607e61de20f1b017404040a08f19dc23ad`。
- 元数据时长 **26.539 秒**，实际 ffprobe 时长 **26.538685 秒**，匹配。
- 精确目标原说明 saved，无警告；总耗时 **11.738 秒**。

该证据来自全新的匿名运行根，不能外推所有账号、私有内容或未来链接。主控已清理样本媒体和匿名 profile，正式资料库未写入。浏览器加载、JSON 获取、下载与探测分别记录；原先旧样本的 login_required / 0 字节记录继续保留为历史受限证据。

按主控收口指示，源码与测试已停止修改，后续 Cookie 共享测试及全量验收归主控。当前冻结指纹：

- `src/content-douyin.ts`：`78764022fbc75e9cbe6e54b40f9a7b719f69183723e7db29cf87bfa29d3fe480`。
- `tests/content-douyin.test.ts`：`ab05156815e6bfde63c585c0a2e629c8ce51b9de7b37a9c72c745df3a7e96de5`。
