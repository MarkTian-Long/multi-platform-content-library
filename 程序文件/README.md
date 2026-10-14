# 程序与开发说明

用户入口在项目根[README](../README.md)。代码、脚本、测试和开发文档集中在本目录，正式资料放在根目录`资料库/`，旧微信资料放在`文章库/`。完整结构见[目录规范](docs/directory-conventions.md)。

## 安装与验证

需要Windows、Edge、PowerShell 5.1、Node.js 22.13.0及以上。在本目录执行：

```powershell
cmd /c npm ci
cmd /c npm run typecheck
cmd /c npm run build
cmd /c npm test
node dist/link-cli.js doctor
```

`dist/`是本机生成的运行文件，首次安装必须构建再打开根目录启动器。依赖按`package-lock.json`使用`npm ci`安装；窗口脚本更新后重开窗口，已有MCP服务重启后加载新编译代码。

## 本地工具

窗口“登录与依赖”可以准备FFmpeg、ffprobe、yt-dlp和专用Python环境，也可执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-content-tools.ps1 -PrepareModel
```

脚本按固定来源和哈希核验工具，`-PrepareModel`准备tiny离线转写模型。已有兼容模型可用`CONTENT_ASR_MODEL`指定绝对路径。工具、模型和`.venv-content/`留在本机，语音处理不上传音频；新clone不会预装本次验收使用的Small模型。

## 命令与配置

```powershell
node dist/link-cli.js enqueue --processing transcribe "视频或文章链接"
node dist/link-cli.js work
node dist/link-cli.js jobs
node dist/link-cli.js youtube-network auto
```

处理模式为`original`、`transcribe`、`full`。`work --scheduled`只恢复到期且已安排自动恢复的YouTube限流任务；CLI单轮返回恢复时间，窗口打开时定时续接，无窗口时不常驻等待。完整命令见[操作手册](docs/link-library-manual.md)，17个MCP接口见[配置说明](docs/mcp-setup.md)。

`CONTENT_LIBRARY_ROOT`可指定正式资料库绝对路径，`WECHAT_ARTICLE_READER_ROOT`指向本程序目录。Cookie只来自专用账号目录；`.content-settings.json`、`.content-parser-auth.json`、环境文件和账号目录受Git忽略规则保护，不复制进源码或文档。

## 恢复与清理

在项目根执行`powershell.exe -NoProfile -ExecutionPolicy Bypass -File 程序文件/scripts/backup-source.ps1`，生成排除资料/凭证/依赖/日志的源码ZIP并逐文件回读核验。正式资料、机器原稿/校订历史、任务/日志恢复记录和独有验收夹具保留；只清理已确认不活动、可重建或与正式文件哈希相同的工作副本。实际记录见[工作区清理](docs/workspace-cleanup.md)。
