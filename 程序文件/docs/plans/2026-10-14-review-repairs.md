# 整体评审问题修复

用户于本对话明确要求直接修复已发现的问题。当前项目中修复，不建 worktree、不提交或推送；本轮未改写正式资料库、正式 queue 或系统配置，也没有重跑实际 ASR。

## 完成条件与分工

确认缺陷先写行为回归并观察失败，再做修复；主控已经完成的修复独立验证，不虚构失败记录。保留主控的原视频/身份复用和恢复复制、ASR 对话的 CPU/时间轴/质量改动、下载对话的网络边界与有界重试。

主控已主动完成文件交接，不再需要用户确认，也未向其他对话发送消息。本对话负责源码修复和定向验证；主控负责最后冻结、构建及全量集成验证。以下源码已完成本轮定向验证，可进入主控最终集成阶段。

## 修复结果

| 问题 | 当前结果 | 验证及剩余边界 |
| --- | --- | --- |
| R1 搜索中的旧库导入越过互斥 | 导入取得既有 worker 锁，忙时立即延后；搜索继续读取已有库 | 运行中 worker 与列表导入竞态回归通过 |
| R2 恢复重复复制和取消 | 主控实现匹配文件跳过、复制循环取消检查；本对话保留并独立验证 | 两项回归通过；单文件复制中途截停、自动 staging 回收未实施 |
| R3 非空派生文件被误当成功 | 原素材 SHA 与成功清单/完整完成记录共同确定复用；新输出先验证再原子替换；来源变化与残缺输出不能恢复成 saved | OCR、音轨、抽帧、ASR 接入；ASR 核验 JSON/SRT/Markdown 三件套内容与时间轴；真实 small 三件套隔离复用通过 |
| R4 多余探测和不准确的可用声明 | 纯文本跳过工具探测，图片只探测 OCR，视频只探测所需工具；短期缓存支持配置/文件变化失效及强制检查 | 缺离线模型不报 ASR 可用；OCR 探测实际语言引擎；doctor 不代表模型实际加载成功 |
| R5 控制命令启动成本 | 独立轻量 runtime 入口，CLI 按命令动态加载媒体模块 | 同 tsx 加载器对照中位 570.92 → 99.75 ms；这是源码对照测量，不是已发布版本性能承诺 |
| R6 单条读取扫描 | 可读目录中的短 ID 只作为搜索顺序提示，仍核验清单完整身份 | 26 份清单的读取降到不超过 3 份；兼容旧目录。全文搜索仍按清单扫描，未引入数据库 |
| R7 重复任务反馈 | 取消/失败/partial/需登录任务重用原 ID 入队；重试更新新提交的实际访问链接；完成任务返回 existing，不启动空 worker | CLI、MCP、WinForms 回归通过；1000 条历史上限及归档入口未改 |
| R8 时间和进度 | 保存每轮 queuedAt/startedAt/finishedAt；显示本轮等待/执行时间，终态耗时冻结；提取/OCR 使用真实项数，ASR 不编造百分比 | WinForms 隔离脚本 5 个断言通过；未声称完成完整鼠标路径验收 |
| R9 过长标题 | 列表、阅读 HTML/PDF 共用较短展示标题，原 title/正文/身份保留 | 长描述行为回归通过；未改写正式 HTML/PDF |

R3 同时阻止保存合并把来源已经变化的旧 OCR/ASR 重新标为成功。合法旧 schema 结果根据原素材与产物哈希兼容；环境未明确指定模型时保留现有 small。显式设置 `CONTENT_ASR_MODEL` 时请求处理，即使目录 basename 相同：旧记录只证明模型名，不能证明同一套权重；本轮没有增加模型权重指纹，所以同一个显式路径也不承诺缓存复用。记录实际模型、引擎、计算配置的处理指纹，不把默认 tiny 写成已有结果的模型。

## 新鲜验证证据

- 12 个明确列出的受影响测试文件，**93/93 通过**，零跳过；其中本轮新增 30 个用例。`logs/overall-review-20261014/repair-targeted-tests.txt`。
- `npm run typecheck` 退出码 0。`logs/overall-review-20261014/repair-typecheck.txt`。
- 本轮修改的受版本管理文件 `git diff --check` 通过；只有仓库现存 LF/CRLF 转换提示。
- 两份正式 small 结果只读复制到本评审隔离目录，隔离运行时没有 ASR helper/模型：均复用 3 份 saved 产物、语言 zh、来源 SHA 与原视频相符；转写 JSON 字节不变、模型仍为 faster-whisper-small。副本已清理。`logs/overall-review-20261014/formal-asr-reuse.json`。
- ASR/媒体处理已有 10 项 enrichment 回归包含在 93 项内，其中涵盖 CPU、hotwords、置信度、空结果和时长边界；没有修改其 Python helper。
- 工具缓存的 OCR 探测对照 203.68 → 0.29 ms，源码哈希前后一致。`logs/overall-review-20261014/repair-performance.json`。未测真实长队列 CPU，也未从源码启动耗时推导正式窗口帧率。

原始回归记录：首次 8 项为 2 通过/6 失败；其后来源、三件套、缺模型、目录查找、新签名链接及残缺完成组均先复现失败再修复。主控原已修复的 R2 两项从独立验证起就通过。

## 交接文件

源码：`src/content-jobs.ts`、`src/content-service.ts`、`src/content-library.ts`、`src/content-tools.ts`、`src/content-types.ts`、`src/content-render.ts`、`src/link-cli.ts`、`src/mcp/content-handlers.ts`、`src/content-enrichment.ts`、`scripts/ocr-content.ps1`、`link-window.ps1`。

新增模块：`src/content-runtime.ts`、`src/content-display.ts`、`src/content-derivation.ts`、`src/content-asr-bundle.ts`。

新增测试：`tests/content-review-repairs.test.ts`、`tests/content-review-asr.test.ts`、`tests/content-derivation.test.ts`、`tests/link-review-repairs.test.ts`。

报告：`docs/reviews/2026-10-14-performance-function-review.md` 末节已回填修复状态。精确交接清单与源码哈希见 `logs/overall-review-20261014/repair-handoff.json`。

## 留给后续产品工作的建议

持久全文索引、历史归档、自动 staging 回收和检查点批量合并尚未实施。这些涉及新的生命周期/兼容规则；当前小规模搜索基线没有证明需要立刻数据库化。保留文件、可恢复状态与既有 1000 条上限，不通过自动删除掩盖容量问题。

显式同名模型目录的新增回归先失败再通过，未指定模型时 small 缓存仍通过。源码已再次冻结，主控可立即统一 build/typecheck/全量；冻结哈希在交接 JSON 中。

本对话未构建、未运行全量测试；主控最终集成检查仍是独立完成条件，不能用本轮 93 项定向通过代替。
