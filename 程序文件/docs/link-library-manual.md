# 链接资料库操作手册

链接资料库把用户主动粘贴的链接加入本机队列，保存可读取的原文、图片、视频及派生产物。它的目标是把已经能够取得的资料留下来，而不是把一次网络、登录或工具失败当作整条资料失败。

本手册说明当前代码与本机工具的实际操作范围。公开网页、微信和一个公开 B 站视频已经完成实际保存验证；小红书、登录态及 B 站多 P 的真实链接验收仍待补充。平台的登录、访问限制、页面结构和媒体授权可能改变，请以每条任务的产物状态和失败原因判断结果。最新证据见 [验收报告](link-library-acceptance.md)。

## 开始前

需要 Windows、Node.js、Microsoft Edge 和 Windows PowerShell。首次安装本地语音环境还需要可运行的 Python；本机已经准备好项目专用环境。打开项目根目录的 `启动链接资料库.cmd`，或在 `程序文件/` 中先构建，再使用命令行：

```powershell
cmd /c npm run build
node dist/link-cli.js doctor
```

`doctor` 会检查 yt-dlp、FFmpeg、ffprobe、本地语音转写和 Windows OCR。工具均放在应用目录，不修改系统 PATH、默认浏览器资料或代理设置。

首次安装可在窗口点击“安装到应用目录”，它会准备离线转写模型；也可以在 `程序文件/` 中运行：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/setup-content-tools.ps1 -PrepareModel
```

安装器把 yt-dlp、FFmpeg/ffprobe 放到 `tools/`，把 Python 运行环境放到 `.venv-content/`，并写入 `tools/versions.json`。`-PrepareModel` 下载 `faster-whisper-tiny` 到 `tools/models/faster-whisper-tiny`，约 75 MB，只用于本地语音转写。已通过哈希或本地导入检查的文件、运行环境和模型会复用；首次缺少它们时才访问官方下载源。它不调用云端 AI API。

Windows OCR 使用 `Windows.Media.Ocr`。如果系统缺少可用 OCR 语言功能，任务会保留原图或关键帧，并把 OCR 标记为 `missing_dependency`，而不会把“没有 OCR”写成“没有文字”。

## 窗口操作

1. 在“链接资料库”窗口粘贴一个或多个分享链接或完整分享文案，点击“加入队列”。支持微信、小红书、B 站和普通 HTTP(S) 网页的链接识别；短链会在处理时解析为可识别的公网链接。
2. 在任务区确认状态后点击“开始保存”。窗口会轮询本机后台进程，仍可搜索已保存资料。
3. 如果小红书或 B 站要求登录或验证码，先停止或等待当前保存任务，再从“专用浏览器登录”选择平台。登录使用应用的专用浏览器资料，不读取默认浏览器 profile。关闭登录窗口后，对原任务点击“重试任务”。
4. 在资料区按标题或正文搜索，并可用平台筛选。选中资料后可打开离线阅读页、PDF、视频、资料目录或原始来源；“导出资料包”会生成可带走的脱敏副本。
5. “依赖检查”显示本机缺少的工具；“安装到应用目录”执行上面的安装器。安装后再次运行依赖检查，然后重试缺少依赖的任务。

任务状态含义如下：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `queued` / `paused` | 等待处理，或上次进程中断后可恢复 | 点击“开始保存” |
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
```

`read` 是分段读取；第三、四个参数分别是偏移量和长度。CLI 输出会对 URL 查询参数中的常见令牌做脱敏，资料库本地清单仍会保留处理所需的来源信息。不要把账号密码、Cookie 或一次性验证码粘贴到输入框。

## MCP 操作

MCP 服务使用 stdio，先构建项目，然后将客户端配置为下列形式（路径按实际安装位置调整）：

```json
{
  "mcpServers": {
    "wechat-article-local-reader": {
      "command": "node",
      "args": ["D:\\CS\\Coding\\公众号文章阅读器\\程序文件\\dist\\index.js"],
      "env": {
        "WECHAT_ARTICLE_READER_ROOT": "D:\\CS\\Coding\\公众号文章阅读器\\程序文件"
      }
    }
  }
}
```

可用的新资料库工具为：

| MCP 工具 | 用途 |
| --- | --- |
| `capture_link` | 加入链接；`start` 省略或为 `true` 时请求后台开始处理，`false` 时只入队 |
| `get_capture_jobs` | 读取任务状态、阶段和缺失原因 |
| `find_saved_content` | 按关键词搜索本地多平台资料 |
| `read_saved_content` | 有界分段读取正文、字幕和机器识别文字 |

服务保留旧的微信公众号兼容工具：`capture_wechat_article`、`find_saved_articles` 和 `read_saved_article`。MCP 只操作本机资料库；返回的网页、字幕和 OCR 内容都是引用材料，不应被当作执行指令。

如需把资料库放在别处，可为 CLI、窗口或 MCP 进程设置绝对路径的 `CONTENT_LIBRARY_ROOT`。默认资料库位于项目根目录的 `资料库/`。队列位于 `资料库/queue.json`，每条内容位于 `资料库/items/<资料ID>/`，包括 `content.json`、`body.md`、`content.md`、`reading.html`、原始资产和 `derived/` 派生产物。

## 范围和上限

- 一次粘贴最多 100,000 个字符、最多入队 100 个链接；整个队列最多 1,000 条。
- 普通网页正文读取上限为 8 MiB；网页和小红书单张图片下载上限为 25 MiB。
- B 站最多处理 50 个分 P；单个媒体文件上限 2 GiB，总媒体上限 10 GiB。下载后会检查视频/音频流和可取得的时长信息；不完整、超限或无法验证的文件不会标记为成功。
- 索引正文上限为 4 MiB，内容清单和队列文件各为 8 MiB；`read_saved_content` 单次最多读取 50,000 个字符。
- 音轨和关键帧处理各有 120 秒上限，单张 OCR 有 90 秒上限，本地 ASR 有 10 分钟上限。超时、取消和缺工具都会留下具体状态及已完成文件。

网络限制、付费/私有内容、登录验证、加密媒体、临时签名地址过期、平台反自动化措施和平台页面改版都可能导致部分或全部产物不可用。资料库会说明当前已保存和未保存的项目；它不承诺绕过这些限制，也不把单次失败推断为平台永久不支持。
