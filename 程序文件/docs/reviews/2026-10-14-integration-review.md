# 最终集成只读审查

时间：2026-10-14 12:58（Asia/Shanghai）。初次结论：**有 3 项已隔离复现的 P2 集成问题。** 主控随后已复现并修复，见下方收尾记录；原始审查证据保留。未发现需要扩大到数据库、重新迁移目录或重跑正式 ASR 的依据。

## 主控修复与最终结果

I1 保留本地 `source + original` 原件的导出，字节一致；其他内部来源快照仍按原策略过滤。I2 扩展本地 article 的核验复用，原件/格式身份一致后从正式库恢复，外部文件移走与 staging 回收后仍能继续生成 PDF。I3 在本地诊断边界转换文件系统错误，并对所选父路径做针对性保护；不改写原始正文。

`library-expansion-integration.test.ts` 的 8 个用例包含三个失败再通过的场景：原件导出、移源/回收后的派生重试、缺失/权限诊断在公开任务/清单/导出中的路径隐藏。相关库/服务/渲染合计 37 项通过；随后主控全量 372/372、构建和类型检查通过。真实本地文字的队列/PDF/自动回收烟雾验收也完成。没有重跑两条正式视频的 ASR，正式库与 queue 哈希不变。

范围为 `content-local-queue.ts`、service/library/enrichment/CLI/types/render、`link-window.ps1` 和 `setup-content-tools.ps1` 的本轮新增接入。local-import/ytdlp 仅参照公开接口契约，未改写其代码；本对话只新增本报告。没有 build、全量测试、正式库写入、账号操作或依赖安装。

## 已复现问题

### I1 / P2：本地文字、HTML 的原始文件被导出包遗漏

定位：[content-library.ts:192](../../src/content-library.ts#L192)。

新的本地文字/HTML 导入把原件登记为 `role:"source", provenance:"original", status:"saved"`。现有导出过滤所有 `source` 资产，因而连这类原件一起移除；导出目录只有整理后的正文/阅读材料，没有字节一致的原始 HTML/TXT 文件。

隔离样例导入一份 HTML，正式清单中原件已成功保存，调用真实 `exportContent` 后原件数由 **1 变 0**。这不是仅丢失内部诊断 JSON：静态化后的正文不能还原原始 HTML 字节。

建议让导出判断同时考虑 provenance，保留已核验的本地原始 source 资产；继续按现有策略处理内部来源快照。回归应断言原始 TXT/HTML 在导出包中存在、bytes/SHA 与正式原件一致。

### I2 / P2：本地文字原文件移动后，已有正式副本不能支撑派生重试

定位：[content-service.ts:81](../../src/content-service.ts#L81)、[content-service.ts:122](../../src/content-service.ts#L122)。

`reusableOriginalVideo` 仅接受 video/audio。即使本地 article 的原件和正文已在正式库核验保存、恢复流程也已按 capturePath 复制回来，重试仍调用 `importLocalFile(input.localPath)` 打开最初的外部路径。

复现：导入 HTML，注入一次 PDF 失败使任务 partial；通过真实存储 API 回收 1 个已覆盖的 staging 原件；移动用户选择的外部 HTML，再重试该任务。结果任务 **failed**，正式原件仍然存在且可读，PDF 重试未能继续。原目录移动或用户在独立入库后归档源文件，就会触发该问题。

建议让本地 article 在身份和原件 bytes/SHA 校验通过时复用正式原件/已存正文，再尝试缺失派生项；保持首次入库和显式新版本的源变化检查。回归应覆盖“首次已保存原件、派生失败、回收 staging、外部原件移动、重试仍能调用派生处理”。

### I3 / P2：原始绝对路径通过文件系统错误持久化到清单和导出

定位：[content-service.ts:138](../../src/content-service.ts#L138)、[content-service.ts:139](../../src/content-service.ts#L139)、[content-library.ts:24](../../src/content-library.ts#L24)。

成功路径已隐藏队列 `localPath`，但错误路径把 Node 的原始 `error.message` 交给 `publicValue`。该过滤器隐藏结构化 localPath 和 URL 凭证，没有移除诊断字符串里的绝对源路径。I2 的 ENOENT 因而被写进 `warnings` 和 pipeline-error，随后进入实际导出的 content.json。

隔离复现中，模拟私有选择目录出现在公开任务消息、正式清单 warnings 和导出文件，三项检测均为 **true**。报告只记录布尔结果，没有打印真实个人路径、原文或凭证。

建议在本地输入的诊断边界把文件系统错误转换成安全的错误码/说明或仅含文件名的消息，然后持久化；不要通过改写用户正文来清除路径。回归需覆盖缺失/无权限等输入错误，确认公共消息、清单和导出均不包含原始父目录。

## 隔离复现证据

全部使用 `$TEMP/integration-review-*` 合成目录，HTML 仅包含本次固定示例文字。`enrich` 替换为原样返回，PDF 第一次固定抛错，第二次固定返回；没有浏览器、下载或实际 ASR。唯一的回收调用针对该合成库，结束前验证临时目录边界并清理。

```json
{
  "firstState": "partial",
  "formalOriginalSaved": true,
  "exportedOriginalCount": 0,
  "stagingCopiesReclaimed": 1,
  "retryAfterOriginalMoved": "failed",
  "formalOriginalStillReadable": true,
  "privateDirectoryInPublicJobMessage": true,
  "privateDirectoryPersistedInManifest": true,
  "privateDirectoryInExport": true
}
```

复现调用顺序：`enqueueLocalFiles` → `runJobs(processContentJob, 假 PDF 失败)` → `exportContent` → `inspectContentStorage/reclaimContentStaging` → 移动合成外部源文件 → `retryJob/runJobs(processContentJob)` → 检查正式原件、warnings 和第二次 export。导入器本身完成成功存档；缺陷在根集成的导出过滤、重试选择与错误输出边界。

## 已通过或已收敛的检查

- 审查最初看到 `.opus`/`.ogg` 允许表错位；并行更新后，queue 已复用 `LOCAL_IMPORT_EXTENSIONS`，窗口也已对齐。当前隔离结果为 `.opus` 在入队时拒绝、导入器也以 UNSUPPORTED_FORMAT 拒绝，`.ogg` 允许入队；不再列为当前缺陷。这只核对格式入口，没有借此声称真实 Ogg 媒体已解码。
- 当前本地身份包含规范化 format 和 SHA，md/markdown、html/htm 归一；已有新增集成回归验证重命名去重、不同格式身份、隐藏私有 queue 路径，以及入队后源字节变化时拒绝保存。
- 本地音频直接进入 ASR，不重复提取音轨或关键帧；音频完成状态仍要求真实 saved transcript。
- 存储 CLI apply 后 fresh inspect，窗口按返回的 planId/剩余字节更新回收按钮；维护 hook 位于 runJobs 释放锁之后。模块继续逐文件核验，不根据同名或旧计划直接递归删除。
- 窗口本地“打开原件”使用正式 originalPath，音频按钮使用 audioPath；阅读页链接指向已保存原件，没有把外部选择路径当作来源链接。此处为源码检查，未执行完整鼠标路径。
- 依赖安装新分支先核验现用 FFmpeg/ffprobe SHA，完整时跳过 ZIP；解压仅提取需要的已校验二进制并保留许可证；faster-whisper 已可 import 时复用环境。未实际运行安装器或访问网络，没有把静态检查当成安装验收。

## 定向验证与版本边界

实际运行 `tests/library-expansion-integration.test.ts`、`tests/content-service.test.ts`、`tests/content-render.test.ts`：**18/18 通过**。包括储存 CLI 旧计划拒绝/回收后剩余候选、音频接入、旧 capturePath 恢复、原视频复用、损坏原件重新采集、取消/跳过重复复制、本地去重及源变化检查。这些既有用例没有覆盖上面三个复现场景，不能以通过数否定具体失败证据。

复现与收尾核对的关键源码 SHA-256 相同：

| 文件 | SHA-256 |
| --- | --- |
| `src/content-service.ts` | `f7acfb120dc196b4cf788a327cd8ae86f5366b37bc70eccfe80d47b7ea37eaac` |
| `src/content-library.ts` | `e32b1b7e4f80fad653da65fc1c7a49ba7308c5a2bf56db8d0dadd4768913e78c` |
| `src/content-local-queue.ts` | `6c33f76c5e4ff2a01c8c6800f030bfde6b052cbaf10c6d834b6e6d433ac27c7b` |

主控已报告正式回收和 385 个正式文件 SHA/queue 不变；本审查没有重新执行该回收或将合成恢复场景当成正式媒体重跑。其他对话继续修改源码后，按函数和哈希重新定位以上反馈，再进行总控最终构建/全量验收。
