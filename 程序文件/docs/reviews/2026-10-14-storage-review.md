# 存储生命周期盘点与安全回收

范围：当前项目 `D:\开发\多平台资料库`。正式资料仍在 `资料库/`，程序、依赖和本机浏览器配置仍在 `程序文件/`，兼容文章区保留 `文章库/`，不重复迁移。当前对话只做只读盘点、新模块和隔离测试，不删除实际数据。

源码已冻结，详见同目录 `2026-10-14-storage-handoff.json`。本轮存储专项 17/17、关联定向 45/45 通过，类型检查通过；没有 build 或全量测试。

## 集成 API（已稳定）

```ts
inspectContentStorage(root: string, options?: { signal?: AbortSignal }): Promise<ContentStoragePlan>
reclaimContentStaging(root: string, options: {
  jobIds: string[];
  expectedPlanId?: string;
  signal?: AbortSignal;
}): Promise<ContentStorageCleanupResult>
```

`ContentStoragePlan` 包含 `version/planId/generatedAt/workerActive/jobIds/entries` 及 `totalBytes/reclaimableBytes/reclaimableFiles/retainedFiles`。`jobIds` 仅包含有候选文件的任务；保留字节为 `totalBytes - reclaimableBytes`。每个 entry 包含 `jobId/state/contentId`、文件级 decision/reason 和字节。输出只含本地相对路径与状态，不含输入 URL、原文、配置或凭证。

```ts
const plan = await inspectContentStorage(root);
if (plan.jobIds.length && !plan.workerActive && !plan.reason) {
  const result = await reclaimContentStaging(root, {
    jobIds: plan.jobIds, expectedPlanId: plan.planId,
  });
  // result.plan 是执行前复核计划；窗口应 fresh inspect 更新剩余候选。
}
```

dry-run 不创建锁、不恢复 queue 状态、不写资料库。有 active worker 时不列可执行候选。apply 默认必须明确选择 jobIds；取得既有 worker/maintenance 互斥后全量重扫，再比较 expectedPlanId；每次 unlink 前重新核验 queue、清单、来源和目标的真实 bytes/SHA。只逐文件删除被正式 saved 资产完整覆盖的 staging 文件，不递归删除目录；残留未知文件会使目录继续保留。

终态为 completed/partial/failed/cancelled/login_required；queued/running/paused、没有匹配 queue 的目录、缺 contentId/正式清单均保留。一个终态目录中未保存、不匹配、未知、partial/pending、receipt、版本和迁移备份、符号链接均保留；其他已经完整覆盖的普通文件可单独成为候选。用正式资产 `capturePath ?? path` 对应 staging，绝不按文件名跨目录猜测。

成功任务的回收 hook 建议放在 runJobs 已写终态、释放 worker 锁之后；调用同一个 inspect/apply，由它重新取得维护锁。不要在 processContentJob 内嵌套维护锁。重试仍可用正式清单中的 path/capturePath 恢复；receipt 留在 staging，不破坏来源与处理证据。

`ContentStorageCleanupResult` 返回 `ok/reason/reclaimedBytes/reclaimedFiles/removedJobIds/plan`。中途遇到取消或变化，已经安全回收的计数仍保留，其他文件不再继续处理；`ok:false` 不能解读成从未发生回收。`worker_active` 是库忙；`plan_changed` 表示须重新预览；`queue_changed/manifest_changed/maintenance_changed/file_changed` 表示停止剩余项；`revalidation_or_delete_failed` 表示复核或文件系统操作未完成。调用前已取消时可抛出 AbortError，维护锁通过 finally 释放。

## 取数时点与分类

以下时间均为北京时间（Asia/Shanghai），由 JSON 原始 UTC 时间换算：

- **2026-10-14 11:21:21**：本对话首次只读盘点，程序目录 3,557,906,542 B；对应 `inventory-initial.json`。
- **2026-10-14 11:27:32**：总控回收日志重副本后的再次盘点，程序目录 2,145,215,172 B；对应 `inventory.json`。并行对话会新增小日志，不用前后总量之差冒充精确执行回收字节。
- **2026-10-14 11:27:35**：正式 staging 回收前 dry-run，worker 不活跃；对应 `dry-run.json`。本对话只读核验，耗时约 2.08 s。
- **staging 回收后的取数**：本对话尚未执行或观测；由总控正式 apply 后 fresh inspect，并在总报告记录时间和实际回收数。下表是回收前快照，不能作为清理后的占用。

| 路径/类别 | 取数字节 B | 处理判断 |
| --- | ---: | --- |
| `资料库/items` | 942,332,757 | 正式主版本，385 文件，完整保留 |
| items 内 `versions`（已包含在上一行） | 3,513,914 | 78 个历史清单，保留，不重复计总量 |
| `资料库/staging` | 863,539,860 | 339 文件；仅候选资产副本可文件级回收 |
| `资料库/.命名备份` | 22,628,963 | 78 文件，迁移恢复资料，保留 |
| `资料库/.平台识别备份` | 69,245 | 11 文件，保留 |
| `文章库` | 171,452,677 | 103 文件，兼容入口仍可使用；不因已导入新库就删除 |
| `程序文件/tools` | 1,220,902,498 | 工具和模型；本轮不自动回收 |
| `tools/models`（已包含在 tools） | 564,423,178 | small 486,214,385 B；tiny 78,208,793 B，均保留 |
| `程序文件/.venv-content` | 283,593,007 | Python ASR 运行依赖，保留 |
| `程序文件/node_modules` | 83,489,823 | 程序依赖，保留 |
| `.wechat-reader-profile` | 177,582,892 | 只统计元数据，不读取内容或凭证，保留 |
| `.content-profile` | 41,456,138 | 同上，保留 |
| `程序文件/logs` | 336,874,183 | 总控日志副本回收后的快照；剩余内容仅报告，不由本对话删除 |

资料库总计 1,828,580,178 B，兼容文章库 171,452,677 B，程序目录 2,145,215,172 B。根目录的 Git 和少量入口文件未并入这三个目录之和。所有扫描限定当前项目，lstat 递归但不跟随链接，未读取 profiles 文件内容。

## staging 候选与保留

dry-run 的 `planId` 为 `4211566db2ef68f17fe918528db706e49b4348754935c1df85a846df710c659f`。**219 文件、799,633,498 B** 在 11 个终态任务中被正式清单的完整 bytes/SHA 覆盖；保留 **120 文件、63,906,362 B**。这是可执行前的候选数，实际执行仍重新扫描，不信任旧计划内的路径或大小。

| 任务状态 | staging 字节 B | 候选字节 B | 候选文件 |
| --- | ---: | ---: | ---: |
| completed，7 个目录 | 151,451,869 | 151,417,007 | 162 |
| partial，3 个目录 | 55,216,987 | 52,583,363 | 51 |
| cancelled，1 个目录 | 623,682,280 | 595,602,448 | 5 |
| failed，1 个目录 | 30,680 | 30,680 | 1 |
| 无 queue 归属的 legacy 导入，2 个目录 | 33,158,044 | 0 | 0 |

completed/partial 合计 **204,000,370 B**，适合自动 hook 的状态选择；cancelled/failed 的已验证副本由总控在本轮手动选择。模块允许全部终态，但每份未保存或未知的失败中间文件仍保留。

保留原因：97 个未登记文件，3 个 bytes/SHA 不匹配文件，1 个恢复/来源证据文件，以及无任务归属目录中的 19 个文件。它们没有凭文件名被当成垃圾。原文、视频、ASR Markdown/SRT/JSON、OCR、阅读 HTML/PDF、receipt、历史清单、命名/迁移备份均按正式资产与恢复语义判断，不能跨目录按同名删除。

回收后的重试不需要重新下载才能恢复已保存资产：正式清单保留 `asset.path` 和 `asset.capturePath`，既有 service 恢复流程可从正式文件复制回原 capture 路径。隔离测试已实际按该映射恢复并核对每份 SHA；正式库的内容和清单不由此模块改写。

## 日志与安装材料：仅报告候选

总控已通知其单独回收 107 个日志媒体副本，精确执行记录在 `logs/library-storage-20261014/diagnostic-reclaimed.json`；本对话未重复执行。再次盘点 logs 为 336,874,183 B，较大的剩余目录包括 `link-wechat-live` 53,513,459 B、`transcription-20261014` 51,774,056 B，以及多组约 25–28 MB 的 `video-live-verification-*` / `video-cold-diagnostic-*`。它们混合诊断、浏览器测试状态和证据，不能直接按目录名或尺寸认定全部无用。

`tools/ffmpeg-package` 为 321,521,840 B，下载 ZIP 为 111,253,802 B。解包目录中两个 exe 与现用 `tools/ffmpeg.exe`、`tools/ffprobe.exe` 已只读核对 bytes/SHA 完全相同，合计 205,508,608 B；整个解包目录还含许可证、其他二进制和文档，不能把两份 exe 的相同外推到整包。它们是后续安装缓存评估候选，本轮保持原位。安装脚本 `scripts/setup-content-tools.ps1` 当前会校验/下载 ZIP；删除缓存前应先由总控检查安装、许可材料和恢复策略。

模型、专用 profile、兼容文章库和版本备份不属于本轮可自动清理的中间材料。目录保持既有职责，可避免为了节省空间再产生一轮完整迁移副本。

## 验证与交接

- `tests/content-storage.test.ts`：17/17 通过；首次实现前 7 项中 6 项明确失败，证明缺失候选/回收行为。之后新增“未知空目录仍保留”回归先失败再修复；一个新增任务选择夹具错误已纠正，不计作应用缺陷。
- 存储、任务锁、正式清单、派生来源证据四个明确测试文件：**45/45 通过，无跳过**。日志 `logs/storage-review-20261014/targeted-tests.txt`。
- 新鲜 `npm run typecheck` 退出码 0；日志 `logs/storage-review-20261014/typecheck.txt`。源码/测试无行尾空白；Git 只提示现有 LF/CRLF 转换。
- 覆盖真实 bytes/SHA、capturePath、独立任务选择、非终态、损坏队列、worker 忙、计划变化、并发重试、取消释放锁、符号链接/Windows junction、正式副本损坏、receipt/备份/未知文件和空目录保留。
- 仅新增 `src/content-storage.ts`、`tests/content-storage.test.ts`、本报告和自有日志脚本；service/jobs/library/CLI/UI/types 的集成由总控负责。本对话没有 build、全量测试、正式删除、提交、推送或消息回传操作。

源码冻结时间 **2026-10-14 12:35:36 +08:00**。模块 SHA-256：`1914907358f34f5657ed76fe7267fd84a71b5da02d52774e2a7b39e677fef0d5`。精确 API、测试、所有候选 jobIds、源码/测试哈希和取数时间均在 `docs/reviews/2026-10-14-storage-handoff.json`；总控可据此统一验收和执行。
