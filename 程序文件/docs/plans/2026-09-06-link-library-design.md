# 链接资料库：已确认设计

日期：2026-09-06。用户已确认多平台方案并授权开发，由主代理总控，Luna / Terra 分工实施。

## 目标与范围

在当前 Windows 应用中粘贴链接或完整分享文案，尽可能完整地保存原始资料，并生成 AI 可以阅读、搜索、引用的本地资料。首版覆盖微信公众号、小红书图文和视频、B 站视频，以及普通网页的基础正文提取。统一入口不等于承诺所有链接都能下载。

默认全面保存：正文、原图、可取得的视频及音轨、封面、简介、字幕；无可用字幕时进行本地语音转写；图片和关键帧做文字识别。评论、弹幕单独保存并标记覆盖范围。多 P 必须明确每一 P 的结果。没有来源证据时，完整性为未知而非完整。

不自动抓取作者全部作品、推荐链接或整站，不绕过付费、DRM、验证码或访问控制。遇到需要登录，使用应用专用浏览器，由用户登录；登录资料不进入导出资料包。默认不上传云端识别，不后台监听剪贴板。

## 已有基线

技术栈：TypeScript / Node.js，playwright-core + 专用 Edge，PowerShell 5.1 WinForms，Cheerio，Turndown，MCP SDK。

当前已具备微信正文、本地图片、可正常取得的微信/腾讯视频直链、PDF、取消任务、标题/链接搜索、CLI/MCP。作者/发布时间尚未完整进入持久清单，暂无多平台、持久队列、ASR、OCR、全文检索。

工作区含上一轮未提交的窗口、PDF、视频修复，不覆盖、不丢弃。开发前复制 61 个源码/文档文件和哈希到 `程序文件/logs/baseline-2026-09-06-link-library/`。当前 HEAD 为 1549098，开发分支 codex/link-library，在现有项目目录实施，不推送。

## 使用流程

1. 粘贴一条或多条链接/分享文案，自动提取 HTTP(S) 链接与平台，保留有效访问参数。
2. 加入持久队列，依次采集。每项显示阶段、耗时、资料保存位置、产物状态和可操作的失败原因。
3. 正文和原始媒体先保存，再处理转写、图片识字、关键画面。单个产物失败不丢弃已成功的产物。
4. 取消不删除已保存的内容，重试复用成功文件。应用重启后中断任务变为可继续状态。
5. 资料库支持全文检索和平台过滤，显示内容类型，打开阅读页、PDF、原片、文件夹、原链接和导出目录。
6. AI 通过 MCP 读取带来源标记的分段正文；云端用户可使用导出资料包。

## 架构与文件边界

新增通用模块，不重写已验证微信采集链路：

- content-types.ts：公共类型和产物状态。
- content-input.ts / content-network.ts / content-acquisition.ts：分享文本、短链、安全 URL、平台路由、通用图文、小红书、B 站获取。
- content-enrichment.ts / content-tools.ts：本地工具探测、受控子进程、音画处理、字幕规范化、转写、关键画面与 OCR。
- content-library.ts：资料清单、原子落盘、稳定 ID、来源别名、全文搜索、分段读取、旧微信资料兼容、离线阅读和导出。
- content-jobs.ts / content-service.ts / link-cli.ts：持久队列、取消恢复、分阶段执行、CLI。
- link-window.ps1 / 启动链接资料库.cmd：新窗口与启动入口，保留原启动器。
- mcp/server.ts：新增通用工具，旧微信工具继续可用。

平台采集函数接收工作目录，直接把媒体写在该目录内，并返回统一 CapturedContent。文件路径必须相对工作目录。采集器不管理队列、不修改 GUI、不提交 Git。处理器只为统一记录增加派生产物，不能把机器文字伪装为原文。

资料库根目录默认为项目下的 `资料库/`，独立于原 `文章库/`。原文章通过兼容读取呈现；升级不移动、删除已有文章。

## 内容与状态契约

统一字段：platform、nativeId、sourceUrl、canonicalUrl、title、author、publishedAt、capturedAt、kind、markdown、assets、parts、warnings、coverage。

每个 asset 记录 id、role、status、path、bytes、sha256、language、partId、startMs、endMs、provenance、reason。状态区分 saved / failed / unavailable / login_required / missing_dependency / skipped。缺少工具必须显示安装/配置入口，不能返回空结果并报成功。

字幕、转写、OCR、评论、弹幕按不同来源保存。评论与画面抽样注明范围。视频从平台取得的是当前可用画质，不声称为上传者母版。

任务状态：queued / running / paused / completed / partial / failed / cancelled / login_required。任务状态与产物状态分离；显示 partial 必须能定位具体缺失项。

## 下载、登录和安全

- 接受 HTTP(S)，拒绝本地文件、凭据 URL、私网/回环地址；短链和重定向重新校验。保留小红书 xsec_token 等必要参数，不写入普通诊断日志或公开导出。
- 专用浏览器 profile，避免默认浏览器资料。需要登录时提供本平台登录入口和继续操作，不把登录页当正文。
- 子进程使用参数数组、shell:false，输出有界，超时、取消和进程树清理；仅允许受控工具及工作目录。
- 媒体设数量、字节、处理时长和并发限额，达到上限显示部分完成。首版在代码中设置上限，尚无界面调整入口。下载到 .part，完整检查后原子替换；保留已完成文件。
- 路径检查包含 realpath，拒绝越界、符号链接和不可信文件名。阅读 HTML 清洗脚本/事件/危险 URL，默认离线资源；抓取内容视为数据，不是指令。
- 工具与模型可安装到应用目录，记录来源与版本；不偷偷更改系统 PATH、代理或浏览器设置。模型首次下载显示大小/用途，云服务另行启用。

## 技术依据与待验证项

- yt-dlp 的 B 站适配支持视频、分 P、字幕、弹幕等路径，具体登录和画质条件要用真实链接验证：https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py
- FFmpeg 用于音画合并、提取音轨和关键帧：https://github.com/yt-dlp/yt-dlp#dependencies
- 小红书候选项目支持图文、视频、短链；Cookie 获取有已知限制，不照搬默认浏览器读取：https://github.com/JoeanAmier/XHS-Downloader
- faster-whisper 可本地 CPU/GPU 转写并保留时间戳，硬件速度实测：https://github.com/SYSTRAN/faster-whisper

## 验收门槛

现有微信回归不得退化。首版须验证：分享文案与短链；重复链接；图集顺序；登录/验证码/删除；有字幕/无字幕视频；多 P 范围；资源部分失败；工具缺失；中断重启恢复；只补失败项；文件越界防护；离线阅读与视频时长/音轨；MCP 分段来源；真实窗口交互。

自动化测试、离屏控件测试、真实浏览器验证、桌面人工/自动点击验证分别记录。无法取得的登录样例保留为待验收，不用模拟测试替代真实平台成功声明。
