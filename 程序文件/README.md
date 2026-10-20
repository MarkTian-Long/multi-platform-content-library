# 程序与开发说明

当前存储树及恢复说明见[存储目录说明](docs/storage-layout.md)，746项回归与真实资料核验见[存储验收](docs/reviews/2026-10-16-storage-unification.md)。

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

`dist/`和根目录`多平台资料库.exe`是本机生成的运行文件，首次安装必须构建再打开EXE入口。Windows构建使用系统.NET Framework C#编译器，由`scripts/build-windows-launcher.mjs`编译`launcher/ContentLibraryLauncher.cs`，不需要额外安装.NET SDK；缺少编译器时构建明确报错。启动器使用GUI子系统和CreateNoWindow启动现有PowerShell/WinForms界面，EXE与程序目录配套使用，继续依赖Node.js及Windows PowerShell。依赖按`package-lock.json`使用`npm ci`安装；窗口脚本更新后重开窗口，已有MCP服务重启后加载新编译代码。

2026-10-14小红书实况照片及抖音静态/实况图集保留独立图片和配套动态，按原照片序号命名。画质优化新增同资源原对象、JPEG/WebP/HEIC/HEIF格式保留、HEIC网页预览及候选水印/尺寸/码率选择；实测尺寸和水印依据落清单并显示在阅读页，签名重试及防降级保持字节核验。选择`original`只保存原件；当前725/725、类型/构建0，独立218/218与原反例4/4分别留证，范围见[画质与水印验收](docs/reviews/2026-10-14-original-media-quality.md)。初次图集665/665、独立225及历史阶段计数保留各自身份。

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

## Windows窗口回归的收尾

原生入口与关闭控制台后的生命周期回归使用独占临时目录、离屏窗口和私有CLI。验证时依次确认无控制台、UI响应、正常关闭以及测试进程退出；保留全部行为断言。Windows下目录清理使用`await fs.promises.rm`和有界重试，并核对目标确实位于本次logs临时根内，避免同步删除阻塞测试收尾。不得清理用户窗口或其他会话进程。

2026-10-20发布前复验曾连续复现原生窗口测试在`rmSync`清理阶段报EPERM；切换到上述现有异步清理方式后，相关四项回归通过。仅修测试收尾，不改应用窗口行为。下次修改启动方式、后台进程或窗口关闭流程时复用这些测试；完整证据和当前待办见[本轮收口](docs/reviews/2026-10-16-storage-unification.md#2026-10-20-发布复核与沉淀)。
