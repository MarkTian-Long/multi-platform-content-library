# 链接资料库首版验收

日期：2026-09-06。实施分支：`codex/link-library`。本次按用户批准的开发计划，由 Terra 负责平台获取和本地媒体处理、Luna 负责 Windows 窗口，主代理负责资料库/队列/CLI/MCP、集成修复及验收。

首版已经实现，公开网页、微信、公开 B 站单视频有实际保存证据。小红书真实笔记、登录态、多 P 实际链接及当前用户桌面完整点击路径仍待验证，不能称全部平台验收完成。

## 实际样例

| 项目 | 实际结果 | 证据 |
| --- | --- | --- |
| 普通网页 `https://example.com/` | 新 CLI 入队、实际下载、正文检索、阅读页、PDF、导出均通过；离线页面 0 个远程请求 | `logs/link-live-check/report.json`、`offline-reading.png` |
| 微信 `https://mp.weixin.qq.com/s/QYn2OeBXhsO2O7XLwE0lfA` | 取得《GPT-6最佳拍档＝字节Seedance》；4 张图片、6 段视频、5 个音轨、5 份文字稿、96 帧、100 份 OCR、阅读 PDF；2 段视频返回 403，状态为 partial | `logs/link-wechat-live/report.json` |
| B 站 `https://www.bilibili.com/video/BV1NJ411C77L/` | 取得《2019 bilibili live star年度总选盛典宣传片（全片）》；原视频、音轨、封面、简介、弹幕、评论文件、文字稿、21 帧、21 份 OCR 和 PDF 已保存；评论覆盖未知，状态为 partial | `logs/link-bilibili-live/result.json` |
| B 站离线播放 | Edge 实际播放通过，1920×1080；ffprobe/播放器时长均约 82.367833 秒，元数据 82.407 秒；0 个远程请求 | `logs/link-bilibili-live/offline-playback.json`、`offline-video.png` |
| 真实 OCR / 语音处理 | 中文已知文字图片能识别；公开语音样本得到实际转写；有效 VTT 生成平台来源文字稿并跳过 ASR | `tests/enrichment-real-media.test.ts`、`tests/enrichment-real-validation.ps1` |
| 无音轨视频 | 真实 `-an` 小视频经 ffprobe 确认无音轨；音频和语音文字稿显示 unavailable，抽帧与 OCR 正常 | `tests/enrichment-real-media.test.ts` |

微信实测过程中遇到 Windows 对队列文件的短暂占用，初次处理失败；有界原子替换重试修复后恢复到 partial，已保存结果保留。该报告生成时，无音轨视频尚显示音轨/ASR failed；最终代码已通过上表无音轨回归，改为明确中文 unavailable，尚未重新采集此文章覆盖该旧报告。

B 站早期诊断有 HTTP 412。后续本次真实记录同时发现两处实现问题：`--max-downloads 1` 以 101 主动结束，`--paths` 错用等号。已按本机 yt-dlp 帮助改为 `home:` / `temp:` 并移除多余退出限制，之后实际下载和播放通过。旧失败日志不能代表最终结果。

## 自动化与窗口

- 开发前原始 75 个回归测试通过；快照保存在 `logs/baseline-2026-09-06-link-library/`，原测试证据为 `logs/baseline-original-tests.txt`。
- 最后全量回归：**155/155 通过，0 失败、0 跳过**，主代理实际重跑耗时约 11.8 秒。主日志为 `logs/link-library-final-tests.txt`。
- TypeScript 类型检查及构建：最终源码均已通过。
- 新窗口 5 项检查通过，含真实 PowerShell 5.1 控件、真实 `dist/link-cli.js` 临时资料库流程；包括入队、取消、重试、worker、搜索、平台过滤、read 和导出。
- Luna 通过真实 CMD 启动器取得“链接资料库”窗口标题和非零句柄，关闭自有测试进程。证据：`logs/link-window-acceptance/launcher-visible-start.json`。
- 1150×760 和 980×680 的离屏布局截图已审阅，无主要控件重叠；这些是布局证据。
- 主代理使用桌面工具未能看到测试进程启动的窗口，未完成用户桌面点击验收；已请求用户双击新启动器。不能用上述句柄和离屏测试代替该步骤。

MCP 使用 SDK 客户端连接真实 stdio 服务验证 7 个工具，保留旧微信工具；验证新资料分段读取、来源、常见令牌脱敏及旧库输出脱敏。后台 worker 测试实际启动构建产物、确认取得队列锁并消费任务，也覆盖缺构建/提前退出时不谎报已启动。

## 审查修复

独立审查新增 14 个复现用例并闭环：小红书嵌套主体、推荐/头像/评论排除、登录关键词误判；B 站跨 P 时长混用、机器字幕错误来源、重复评论；文件 junction 越界；原生 HTTP 压缩、取消、字节上限、206 实际长度及 IPv6 私网地址。主代理另补网络默认超时、失败资源重试校验、Windows 原子替换、MCP 启动确认与旧工具脱敏。

本机已准备 yt-dlp、FFmpeg/ffprobe、专用 Python/faster-whisper、tiny 模型和 Windows OCR。安装器在已准备环境下实际复用本地文件，未再次下载。版本与来源保存在 `tools/versions.json`，工具、模型、Cookie、资料和日志均被 Git 忽略。

取消回归最终检查真实孙进程 PID 已退出、无关旁路进程仍存活。生产逻辑等待进程树清理完成才返回，清理失败保留诊断；不使用固定延迟的文件标记推断取消成功。

## 尚待验收与边界

| 范围 | 当前证据 | 补齐方式 |
| --- | --- | --- |
| 小红书图集与视频 | 页面结构/状态/图序的固定样例测试通过，尚无用户真实笔记端到端成功证据 | 用户提供完整分享文案；必要时在专用浏览器手动登录，再下载核对图数与视频 |
| 小红书/B 站登录态 | 专用 profile 和 Cookie 落盘/读取契约测试通过；未导入默认浏览器凭据 | 用户在专用浏览器登录后验证实际链接 |
| B 站多 P、各语言平台字幕 | 隔离目录、逐 P 状态/时长/字幕来源回归通过；本轮实测是单 P | 提供真实多 P、有字幕链接，核对每 P 数量、时长和语言 |
| 评论、弹幕完整性 | 真实样例取得文件，无法证明包含平台全部记录 | 以保存时点的可取得范围使用，不标“全部评论” |
| 桌面完整操作 | WinForms/真实后端/启动句柄及布局已验；当前用户桌面点击待验 | 用户启动新窗口后验证粘贴、开始、取消、打开与导出 |

视频默认保留当前访问条件下可取得的最佳格式，不能等同于上传母版。每个视频最多抽样 24 帧，tiny 语音模型和 OCR 结果未经人工校对。付费、私有、DRM、验证码或平台拒绝访问不在绕过范围内。具体数量、文件与处理时间上限见 [操作手册](link-library-manual.md)。

## 复现命令

在 `程序文件/` 目录执行。前三项为维护检查；后三项会访问上述公开样例并保存到 `logs/` 的隔离资料库。

```powershell
cmd /c npm test
cmd /c npm run typecheck
cmd /c npm run build
node tests/link-live-check.mjs
node tests/link-wechat-live.mjs
node --import tsx tests/link-bilibili-live.mjs
node tests/link-offline-media-check.mjs
```

本轮未推送远程、未公开部署。已有未提交微信修复已保留，最终本地提交包含该基线及本次新增功能；基线快照用于区分两部分。
