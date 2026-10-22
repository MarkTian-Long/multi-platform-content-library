# 多平台资料库操作手册

2026-10-21统一使用一个资料库。窗口保留资料库/采集任务/登录与依赖三页；阅读按钮直接打开当前阅读页、PDF、整篇文字稿、媒体、条目目录或来源。结果详情、标签收藏、补缺项和识别稿校订放在“管理资料”，目录包和ZIP放在“导出”。原件及机器稿保留。当前完整范围和限制以[平台与格式表](platform-support.md)及[目录说明](storage-layout.md)为准。

YouTube继续完善：在“登录与依赖→YouTube网络设置”保存自动/直连/本机代理选择，提取、媒体和专用Edge使用同一选择。当前已保存已验证的本机代理；可随时改回自动或直连。CLI在程序目录执行`node dist/link-cli.js youtube-network`读取，`youtube-network auto`恢复环境选择，`youtube-network direct`直连，`youtube-network proxy http://127.0.0.1:7897`保存本机代理（端口按实际客户端填写）。平台要求验证时，选择YouTube后点击“专用浏览器登录”，手动完成并关闭；CLI为`node dist/link-cli.js login youtube`。

“已保存代理/已启用解析/已安装模型”仅指本机验收状态。新clone不会带上本机配置、账号或Small模型；默认视频号解析关闭，YouTube使用auto。先安装/构建并按自己的网络和处理需求配置。GitHub只同步源码；用户资料、原稿/校订历史、恢复记录和日志留在本机，目录规则见[目录规范](directory-conventions.md)。

小红书实况照片、抖音静态/实况图集可直接粘贴原帖或分享链接。选择“原件”保留图片和独立配套视频，按原照片序号在阅读页查看；动态缺失、受保护或核验失败时保留已取得图片并显示部分保存，重试不丢旧好文件。原件模式不另外生成ASR/OCR/PDF；如需这些派生选择对应处理模式。

小红书优先取得同一照片明确资源身份的原对象，原对象失败后用页面提供版本；HEIC/HEIF原文件另存网页预览，不改成JPEG。抖音图集在真实候选中优先平台标记无水印的版本，再比较像素和码率，带水印下载模板放在后面。打开阅读页可查看文件尺寸、“原对象文件/平台提供版本/网页预览”和“平台标记无水印/来源版本带水印/水印状态未确认”。这些说明不保证作者上传母版、无损压缩或画面内没有作者水印；平台未提供高清/无水印动态时保留实际版本并说明。原对象升级会复用已有已核验网页图，较低画质候选不覆盖同资源高清原件。当前实测和限制见[画质与水印验收](reviews/2026-10-14-original-media-quality.md)，手机相册原生Live Photo合成导入尚未提供。

HTTP429在元数据和媒体阶段停止该次请求，再由任务队列安排冷却恢复：默认依次等5、15、30分钟，最多自动恢复3次；媒体返回有效Retry-After更长时按其要求等待。任务显示“限流冷却”、倒计时和恢复时间，等待期间可取消或打开专用浏览器。窗口打开时到期自动继续；关闭后等待记录保留，重开恢复。连续429超过上限显示“需手动恢复”，或平台要求验证时显示“需要登录”；完成网络/浏览器检查后重试，仍遵守已保存的冷却。其他平台照常处理，已保存资料保留。

CLI/MCP单轮处理会返回`waitingCount`、`nextWakeAt`及任务恢复信息，不常驻等待；可在到期后执行`node dist/link-cli.js work --scheduled`只恢复已安排的限流任务，或打开功能窗口自动续接。自动恢复不会启动你仅加入队列的其他任务。原件任务不因未开放的原生字幕/评论保持partial；这些覆盖明确标不支持。真实CLI原件和Small转写两个任务阶段已completed，补转写复用原视频；人工验证码仍由用户完成，单次成功不等于全部链接或长期可用。

新命令示例（在程序文件目录）：

```powershell
node dist/link-cli.js enqueue --processing transcribe "分享链接或文案"
node dist/link-cli.js import --processing original "D:\材料\文档.pdf" "D:\材料\主文档.docx"
node dist/link-cli.js work
node dist/link-cli.js details <contentId>
node dist/link-cli.js transcript-read <contentId>
node dist/link-cli.js transcript-save <contentId> "D:\材料\校订草稿.json"
node dist/link-cli.js organize <contentId> '{"tags":["项目"],"favorite":true}'
node dist/link-cli.js export-zip <contentId>
node dist/link-cli.js archive-jobs <completedJobId>
node dist/link-cli.js history
node dist/link-cli.js restore-jobs <archiveId>
node dist/link-cli.js logs list
```

校订草稿JSON包含`sourceAssetId`、`expectedSha256`（来自刚读取的稿）和`text`。并发改稿会拒绝覆盖；窗口会保留失败草稿。日志用`logs plan <选项JSON>`再`logs archive <含expectedPlanId的同选项JSON>`，仅选择已停止写入的`logs/<顶层目录>`，`directories`与`closedDirectories`均需明确给出；默认源目录保留，恢复用`logs restore <archiveId>`。移除只限明确可重建目录，需另给`rebuildableDirectories`和`removeSource:true`，账户资料/草稿/恢复材料不属于这种日志。

多平台资料库把用户主动粘贴的链接加入本机队列，保存可读取的原文、图片、视频及派生产物。它的目标是把已经能够取得的资料留下来，而不是把一次网络、登录或工具失败当作整条资料失败。

本手册说明当前代码与本机工具的实际操作范围。日常双击项目根的`多平台资料库.exe`；旧CMD仍兼容。正式资料统一在`资料库/items/`，原文章库完整归入版本备份。平台的登录、访问限制、页面结构和媒体授权可能改变，请以每条任务的产物状态和失败原因判断结果。各平台证据见[平台支持表](platform-support.md)，历史[验收报告](link-library-acceptance.md)保留当时范围。

## 开始前

需要Windows、Node.js 22.13.0及以上、Edge和PowerShell 5.1；语音转写另需Python与离线模型。首次clone不带本机依赖、工具、模型、账号或设置，应在程序目录安装锁定依赖并构建，再双击根启动器：

```powershell
cmd /c npm ci
cmd /c npm run build
node dist/link-cli.js doctor
```

`doctor` 会检查 yt-dlp、FFmpeg、ffprobe、本地语音转写和 Windows OCR。工具均放在应用目录，不修改系统 PATH、默认浏览器资料或代理设置。

## 本地文件与存储

在“资料库”页导入TXT/Markdown/静态HTML、文字层PDF、DOCX、PNG/JPEG/WebP/BMP或支持的音视频。原件只复制，按格式/SHA识别重复；`.md`/`.markdown`兼容改名，HTML不执行脚本，原始字节以`.html.txt`保留。完整范围见[支持表](platform-support.md)。

```powershell
node dist/link-cli.js import "D:\材料\手记.md" "D:\材料\访谈.wav"
node dist/link-cli.js import --encoding gb18030 "D:\材料\旧文本.txt"
node dist/link-cli.js work
node dist/link-cli.js storage
node dist/link-cli.js storage --apply "上一步返回的planId"
```

本地文字原件上限 4 MiB，媒体原件上限 2 GiB；解码后正文仍需在索引上限内。GB18030 需显式选择，带 BOM 的 UTF-16 可自动识别。首次检查后文件发生变化时会明确失败；已正式保存的原件可继续支撑外部源文件移动后的派生重试。

窗口“登录与依赖”显示实际主库路径并提供“检查工作副本”“回收已保存副本”。处理结束会自动核验并回收终态 staging 中已完整保存的副本，未完成和未知文件保留。正式原件、文字稿、识别 JSON、阅读 HTML/PDF、模型、登录状态及迁移备份不属于自动清理对象。路径和回收边界见 [功能与存储说明](library-capabilities-storage.md)。

YouTube只针对明确单视频，真实公开样本下载、完整解码、入库及本地转写已验收，访问仍受网络和平台限制；不含直播、播放列表及加密/分段流。它沿用本机yt-dlp/Node和媒体安全校验。专用登录窗口提供小红书、B站、抖音、微博和YouTube，关闭窗口后在原任务点击“重试任务”。各来源真实验收范围见[平台支持表](platform-support.md)。

抖音和微博在普通接口未取得目标内容时会自动启动各自专用 Edge，加载原帖并读取正常官方数据；已分别完成未登录公开视频的真实下载核验。无需另选解析服务。只有出现实际登录或人机验证时，才需使用“登录与依赖”的平台专用窗口完成后关闭重试。原件经过核验后继续同一文字稿和离线阅读流程。

首次安装可在窗口点击“安装到应用目录”，它会准备离线转写模型；也可以在 `程序文件/` 中运行：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/setup-content-tools.ps1 -PrepareModel
```

安装器把 yt-dlp、FFmpeg/ffprobe 放到 `tools/`，把 Python 运行环境放到 `.venv-content/`，并写入 `tools/versions.json`。`-PrepareModel` 下载 `faster-whisper-tiny` 到 `tools/models/faster-whisper-tiny`，约 75 MB，只用于本地语音转写。已通过哈希或本地导入检查的文件、运行环境和模型会复用；首次缺少它们时才访问官方下载源。它不调用云端 AI API。

Windows OCR 使用 `Windows.Media.Ocr`。如果系统缺少可用 OCR 语言功能，任务会保留原图或关键帧，并把 OCR 标记为 `missing_dependency`，而不会把“没有 OCR”写成“没有文字”。

## 窗口操作

1. 在“采集任务”页粘贴一个或多个分享链接或完整分享文案，点击“保存链接”即可入队并开始处理；“仅加入队列”用于暂存待处理链接。支持公众号、视频号、小红书、B 站和普通 HTTP(S) 网页的链接识别；短链会在处理时解析为可识别的公网链接。
2. 任务区默认显示当前待处理或正在处理的任务；点击“查看历史”查看已结束记录。窗口会轮询本机后台进程，仍可切换到“资料库”搜索已保存资料。
3. 如果小红书或 B 站要求登录或验证码，先停止或等待当前保存任务，再到“登录与依赖”选择平台并点击“专用浏览器登录”。登录使用应用的专用浏览器资料，不读取默认浏览器 profile。关闭登录窗口后，对原任务点击“重试任务”。
4. 在资料区按标题、正文或标签搜索，并可用平台/收藏筛选。选中资料后，“打开文字稿”显示整篇正文；“打开目录”进入当前条目。“管理资料 → 校订识别稿 / 转写稿”编辑独立OCR/ASR，文章正文不重复混入识别结果。“导出”生成可带走的目录包或ZIP。
5. “登录与依赖”只在任务提示“缺少工具”或“需要登录”时使用：“依赖检查”显示本机缺少的工具；“安装到应用目录”执行上面的安装器。安装后再次运行依赖检查，然后重试缺少依赖的任务。

任务状态含义如下：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `queued` / `paused` | 等待处理，或上次进程中断后可恢复 | 在采集页继续处理队列 |
| `running` | 正在采集或处理 | 等待，或选择该任务后取消 |
| `completed` | 此次要求的正文、媒体和派生项都已保存 | 打开阅读页或导出 |
| `partial` | 原文或一部分产物已保存，仍有明确缺项 | 查看逐项状态后重试 |
| `login_required` | 平台要求登录或验证 | 使用专用浏览器登录后重试 |
| `failed` | 本轮未能取得可保存资料 | 阅读失败原因，修复网络、链接或工具后重试 |
| `cancelled` | 已请求取消 | 已完成文件保留，之后可重试 |

取消不会删除已完成的原文、图片、音轨、文字稿或 OCR 结果。每个完成或失败的派生产物都会保存检查点；重试会复用仍存在且哈希匹配的文件，并只补齐缺项。

## 视频、字幕、转写和 OCR

原视频和原图保持原样。对于可用的视频，处理流程会：

1. 保存平台提供的字幕，并把有效的 VTT/SRT 时间轴转为带时间点的 Markdown 文字稿。每个分 P 分别判断字幕是否非空、可解析且覆盖该分段；有效平台字幕的文字稿标记为 `platform_subtitle`，不会再请求机器 ASR。
2. 字幕为空、损坏、无法读取或没有覆盖该分段时，使用本地 `faster-whisper-tiny` 转写。它写出 JSON、SRT 和 Markdown；阅读资料只追加 Markdown 文字稿，JSON/SRT 仍作为单独来源文件保存。机器转写标记为 `machine_asr`。
3. 用 FFmpeg 从视频提取音轨，并抽取关键画面。抽样上限是 **24 帧，不逐帧处理**：有时长时按 `ceil(时长/24)` 秒的间隔抽样，未知时长时约每 15 秒抽样。资料的 coverage 会写明实际间隔、帧数和可取得的时间点。
4. 对原图和抽样帧逐张调用 Windows OCR。OCR 文字稿按图像顺序或帧时间点保存；无字图片会写“已识别，未检测到可读文字”，工具错误与无字结果分开显示。OCR 标记为 `machine_ocr`，抽样帧标记为 `sampled_frame`。

`tiny` 模型适合离线、速度优先的初步检索，不等同于人工校对。专有名词、多人重叠说话、音乐、方言、低音量或噪声视频可能产生漏字和错字；重要引用应回看原视频、平台字幕或原始网页。关键帧 OCR 也只能覆盖抽到的画面，不能证明未抽到的每一帧没有文字。

如果 ffprobe 确认视频本身没有音轨，应用会说明无法生成音频/语音文字稿，并跳过语音转写；视频、抽样画面和 OCR 继续保存。这与静音片段、未识别出语音或识别失败是不同情况。

## 文件名与已有资料整理

正式资料按“YYYY-MM-DD_平台_标题”命名文件夹，日期为采集日期（北京时间）。中文标题保留，过长标题截短，同名目录加`(2)`等序号，ID保存在清单中。图片、音视频等原件直接分类放在条目下，处理结果与内部采集记录分别保存。静态图片使用三位编号；视频多P保留分集、帧时间点与来源。

直接打开`文章标题.html`离线阅读，`文章标题.pdf`用于打印，`文章标题.md`是整篇正文，也适合交给AI阅读。`content.json`供应用管理资料。公众号PDF从保留原文图文排版的离线页生成；OCR是独立辅助材料。导出资料包包含同名当前文档与本地资源。

新下载自动使用这套名字，已有资料本轮已在完整备份后整理。日常无需重复迁移。以下`rename-files`是更早的旧命名兼容入口，会跳过已有可读命名条目，不能代替整库升级：

```powershell
node dist/link-cli.js rename-files
```

本轮完整备份、旧目录及回退日志统一在`版本备份/单库整理-20261021/`；恢复由维护流程先检查修改与占位，再执行，见[目录说明](storage-layout.md)。资料ID和任务记录保持不变；以前复制出去的旧绝对路径需要换成新的文件地址。窗口脚本更新后关闭旧窗口并从EXE重新打开，已有MCP服务重启后加载新代码。

## 命令行

所有命令在 `程序文件/` 中执行，使用已构建的 `dist/link-cli.js`：

```powershell
node dist/link-cli.js enqueue "分享文案或 https://example.com/"
node dist/link-cli.js work
node dist/link-cli.js jobs
node dist/link-cli.js cancel <任务ID>
node dist/link-cli.js retry <任务ID>
node dist/link-cli.js list "检索词"
node dist/link-cli.js read <资料ID> 0 16000
node dist/link-cli.js export <资料ID>
node dist/link-cli.js doctor
node dist/link-cli.js login xiaohongshu
node dist/link-cli.js login bilibili
node dist/link-cli.js video-parser
node dist/link-cli.js video-parser off
```

`read` 是分段读取；第三、四个参数分别是偏移量和长度。CLI 输出会对 URL 查询参数中的常见令牌做脱敏，资料库本地清单仍会保留处理所需的来源信息。不要把账号密码、Cookie 或一次性验证码粘贴到输入框。

## MCP 操作

MCP 服务使用 stdio，先构建项目，然后将客户端配置为下列形式（路径按实际安装位置调整）：

```json
{
  "mcpServers": {
    "multi-platform-content-library": {
      "command": "node",
      "args": ["D:\\开发\\多平台资料库\\程序文件\\dist\\index.js"],
      "env": {
        "WECHAT_ARTICLE_READER_ROOT": "D:\\开发\\多平台资料库\\程序文件"
      }
    }
  }
}
```

服务共17个工具（14个多平台、3个微信兼容）；完整权威清单见[MCP配置](mcp-setup.md)。常用采集/查询接口为：

| MCP 工具 | 用途 |
| --- | --- |
| `capture_link` | 加入链接；`start` 省略或为 `true` 时请求后台开始处理，`false` 时只入队 |
| `get_capture_jobs` | 读取任务状态、阶段和缺失原因 |
| `find_saved_content` | 按关键词搜索本地多平台资料 |
| `read_saved_content` | 有界分段读取正文、字幕和机器识别文字 |

服务保留旧的微信公众号兼容工具：`capture_wechat_article`、`find_saved_articles` 和 `read_saved_article`。MCP 只操作本机资料库；返回的网页、字幕和 OCR 内容都是引用材料，不应被当作执行指令。

如需把资料库放在别处，可为 CLI、窗口或 MCP 进程设置绝对路径的 `CONTENT_LIBRARY_ROOT`。默认资料库位于项目根目录的 `资料库/`。队列位于 `资料库/queue.json`，每条内容位于 `资料库/items/<平台 - 标题 [短编号]>/`。旧版以资料 ID 命名的目录仍可读取，可以用上面的整理命令升级。应用使用清单中的完整资料 ID 查找文件，重命名不会改变 MCP 的资料标识。

## 范围和上限

平台、输入链接、视频和派生格式、视频号第三方解析开关及服务凭证配置见 [平台与格式支持表](platform-support.md)。

本次小红书和视频号样本的本地语音文字稿已保存到各自 `文字稿/语音文字稿.md`，同时有机器 SRT 和 JSON，综合正文、阅读页与 PDF 包含全文。机器稿仍需校对专名；两条整体状态保留“部分保存”，因为本轮没有补关键帧/OCR。对已有资料重试会先核对原视频与保存身份，复用完整文件，不依赖旧分享地址重新解析。

- 一次粘贴最多 100,000 个字符、最多入队 100 个链接；整个队列最多 1,000 条。
- 普通网页正文读取上限为 8 MiB；网页和小红书单张图片下载上限为 25 MiB。
- 小红书和微信视频号单个视频上限为 2 GiB，取得字节后还要核验实际视频流。
- B 站最多处理 50 个分 P；单个媒体文件上限 2 GiB，总媒体上限 10 GiB。下载后会检查视频/音频流和可取得的时长信息；不完整、超限或无法验证的文件不会标记为成功。
- 索引正文上限为 4 MiB，内容清单和队列文件各为 8 MiB；`read_saved_content` 单次最多读取 50,000 个字符。
- 音轨和关键帧处理各有 120 秒上限，单张 OCR 有 90 秒上限，本地 ASR 有 10 分钟上限。超时、取消和缺工具都会留下具体状态及已完成文件。

网络限制、付费/私有内容、登录验证、加密媒体、临时签名地址过期、平台反自动化措施和平台页面改版都可能导致部分或全部产物不可用。资料库会说明当前已保存和未保存的项目；它不承诺绕过这些限制，也不把单次失败推断为平台永久不支持。
