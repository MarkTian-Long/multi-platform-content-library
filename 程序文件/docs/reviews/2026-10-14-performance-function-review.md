# 多平台资料库：性能与功能独立评审

日期：2026-10-14。项目：`D:\开发\多平台资料库`。初次只读评审范围是提交链接、队列、恢复、保存、搜索、离线阅读与本地工具调用。初次评审输出限定在本报告和 `程序文件/logs/overall-review-20261014/`，未运行全量测试或构建，没有安装、操作账号、提交或推送。

**用户随后要求直接修复；下文 R1—R9 和测量是修复前的评审基线，当前修复结果及新鲜验证见末节“直接修复回填”。**

## 结论与优先级前三项

优先修复保存结果的可靠性，再削减不必要的本地工作。当前 14 条资料的直接搜索仅测得 17 ms，尚无依据把现用资料库判断为“整体很慢”；较明确的性能浪费在重试恢复、工具探测和窗口轮询。检查点已有哈希缓存，实测没有每次重新复制或完整读取大视频。

| 顺序 | 问题及证据类别 | 用户影响 | 建议改法与收益 | 修复代价估计 | 建议验收 |
| --- | --- | --- | --- | --- | --- |
| 1 / P1 | **搜索触发的旧库导入没有取得 worker 锁**；隔离竞态已复现较新正文被旧版覆盖 | 后台保存时正常搜索就可能参与写入，造成正文和标题回退 | 将列表查询与导入分离；导入使用既有 worker/维护互斥，并在锁内重新判断身份是否已有。避免较新结果被覆盖 | 小至中：服务边界和竞态回归 | 同身份、导入先读旧快照、worker 后保存的受控竞态中，新正文和标题保持不变；worker 忙时搜索仍返回已有资料 |
| 2 / P2 | **重试恢复无条件复制所有已存文件，复制循环不响应取消**；在更新后的 service 上再次复现 | 点击取消后继续复制后续大文件；重试有磁盘写入与空间负担 | 恢复循环检查取消；目标已有且校验一致时跳过复制；后续再制定 staging 回收规则 | 中：涉及恢复与文件生命周期 | 首份复制期间取消后，不再开始第二、三份复制；已验证 staging 文件的复制字节为 0；成功文件仍可读 |
| 3 / P2 | **派生文件的复用只检查非空，不检查完成证据或来源指纹**；伪造的非空 OCR Markdown 被标为 saved | 崩溃留下的截断文字，或对应旧媒体的文字，可能进入正文、搜索和导出 | 用完整状态、来源资产哈希和处理配置确定复用；派生文件原子完成后再登记成功 | 中：应由本地媒体处理负责人一并评估 | 无完成记录、截断文件、来源哈希改变时不复用为 saved；来源相同且完整的派生文件无需重跑 |

“小/中”是代码范围估计，未经实施排期。P1 表示存在可复现的数据正确性风险；P2 表示明确功能/效率问题或应补齐的生命周期机制，不代表当前已发生正式资料损坏。

## 证据范围和当前基线

- 当前正式资料清单 14 条，清单合计 448,341 字节；队列 12 条：completed 7、partial 3、failed 1、cancelled 1。本评审不输出队列输入、设置或凭证内容。
- `items/` 实际文件合计 934,609,886 字节（891.31 MiB）；`staging/` 为 863,539,860 字节（823.54 MiB）。后者是清理评估范围，不等于可以直接删除的垃圾；可能包含未完成或恢复所需文件。
- 当前视频号免费解析成功以 [formal-result.json](../../logs/wechat-channels-20261014/formal-result.json) 为依据：33,039,687 字节，H.264/AAC，720×1280，433.903 秒，完整音视频解码退出码 0。旧 Worker 的 401 不列为当前阻塞。
- [既有全量测试日志](../../logs/wechat-channels-20261014/full-tests.log)记录 226/226 通过。这是主控此前验收的证据，本评审没有重跑；其后并行代码继续变化，不能用这份日志证明新增变更全部通过。
- 主控在评审期间回传已修复“已存原视频仍依赖解析服务”和“小红书失效短链改变内容身份”，并报告 service/input 18 项定向通过。本评审已看到 `reusableOriginalVideo`、保存身份优先及哈希验证实现，这两项不再列为待修缺陷；该组测试没有在本评审重跑。取消循环问题在这次更新后的 service 上仍定向复现。
- 基础计数、I/O 及耗时见 [diagnostics.json](../../logs/overall-review-20261014/diagnostics.json)。其运行前后六个主要源码哈希一致；service 后续发生上述并行变更。更新后取消复核的源码哈希单独保存在 [retry-cancel-current.json](../../logs/overall-review-20261014/retry-cancel-current.json)。

所有耗时都是本机有界诊断单次测量或明确列出的三次测量，没有冷缓存控制，不是吞吐量 SLA，也没有据此推导 CPU 百分比。合成素材不代表真实媒体识别质量。默认执行沙箱的 Node `realpath` 对项目根也返回 EPERM；实际诊断在限定授权后执行，这一环境现象未被计为应用缺陷。

## 已确认的问题

### R1 / P1：列表查询中的导入会越过 worker 互斥，覆盖刚保存的新内容

定位：[content-service.ts:54](../../src/content-service.ts#L54) 的 `importLegacyArticles`、[content-service.ts:67](../../src/content-service.ts#L67) 的 `listSavedContent`；既有互斥见 [content-jobs.ts:9](../../src/content-jobs.ts#L9)。

列表每次调用先读取现存清单快照，再逐条复制/保存旧微信文章，没有使用 `withContentMaintenance` 或其他 worker 锁。是否已有同身份资料只按导入开始时的 `knownIds` 判断。若 worker 在快照之后保存了同身份资料，导入仍会调用 `saveContent`，旧正文可覆盖刚写入的新正文。

最低充分复现：在独占隔离目录写入本进程有效的 worker 锁；让导入在读旧文章时等待；以正式 `parseContentLinks` 得到相同 nativeId 的 worker 记录保存 `WORKER_NEW_VALUE`；再放行导入。结果标题由“worker 新内容”变回“旧内容”，正文变成 `LEGACY_OLD_VALUE`，锁始终存在。证据：[concurrent-import.json](../../logs/overall-review-20261014/concurrent-import.json)。这证明可触发的实现缺陷，没有证据表明正式资料库已经发生了这次覆盖。

修复时不宜简单让所有搜索等待长达数分钟的下载/ASR。建议搜索只读已有索引；兼容导入另行受现有互斥保护，worker 忙时延后，且在锁内再次读取当前身份集合。保留“后台保存时仍能搜索”的用户流程。

### R2 / P2：重试恢复继续复制已存资产，取消只在复制结束后的阶段被检查

定位：[content-service.ts:32](../../src/content-service.ts#L32) 的 `copyAsset`，`processContentJob` 中的 `restorePaths` / `existing.assets` 恢复循环（本次收尾快照在 90—94 行）。

恢复会验证正式文件后，将其复制回任务 staging。即使相同 staging 文件已经存在且内容一致，也没有跳过复制；循环未检查 AbortSignal，`copyFile` 本身也未传递取消能力。新加的函数入口取消检查解决的是开始前取消，不能解决复制期间取消。

实测：三份资产，第一份复制时触发取消，另外两份仍被复制，之后 acquire 收到的 signal 已经 aborted。最初样本为每份 4 MiB；更新后定向复核改用每份 1 MiB，仍是 3 次恢复复制，最终才抛 AbortError。证据：[retry-cancel-current.json](../../logs/overall-review-20261014/retry-cancel-current.json)。因此可以确认取消边界有缺口；没有用合成样本声称 92 MB 或 2 GiB 实际需要等待多少秒。

建议先做低风险两步：每份文件开始前及复制完成后检查取消；已存在的 staging 文件按大小/哈希核对后一致则复用。一次正在进行的系统复制可以先完成，但不能在取消后开始后续资产。若单文件复制也必须可中断，再采用有临时文件和原子替换的可取消流。

相邻的空间问题：服务在任务完成后没有 staging 回收流程，当前 staging 已达 823.54 MiB。建议单独设计保留期/手动清理入口：只回收能与正式文件核验一致的已完成副本，保留未完成片段和失败诊断。不要为了腾空间删除整条任务目录。

### R3 / P2：OCR/ASR 复用缺少“这份结果确已完成、对应当前来源”的检查

定位：[content-enrichment.ts:70](../../src/content-enrichment.ts#L70) 的 `presentFile`；[content-enrichment.ts:225](../../src/content-enrichment.ts#L225) 的 ASR Markdown 快捷复用；[content-enrichment.ts:252](../../src/content-enrichment.ts#L252) 的 OCR Markdown 快捷复用。写派生文字的 [content-enrichment.ts:102](../../src/content-enrichment.ts#L102) 直接写目标文件。

`presentFile` 确认路径在目录内且文件非空，但不核对已保存清单、来源文件哈希、JSON 结构或处理是否完成。路径检查有价值，但不足以证明文字稿完整、对应当前图像/视频。

最低充分复现：在隔离 staging 中按实际 safeId 规则预放一份非空 `TRUNCATED_UNVERIFIED_STAGING_TEXT` OCR Markdown，不放 OCR JSON，也没有可信派生资产记录；使用合成无效图片调用 `enrichContent`。函数没有实际 OCR 就把这份 Markdown 登记为 `status: saved`。证据：[offline-and-reuse.json](../../logs/overall-review-20261014/offline-and-reuse.json) 的 `ocrReuse`。

这是复用判定的直接复现。崩溃期间留下截断文件、来源文件替换后复用旧文字，是由实现推导的实际触发方式，本评审未在正式任务上制造崩溃或替换文件。ASR 有同样的非空复用条件，但本次没有运行真实 ASR 去复现损坏语音稿。

建议派生文件先写临时路径，完整验证后原子发布，再登记完成；复用记录至少关联 source asset ID + sha256、产物哈希、引擎/模型及影响结果的配置。完整且来源相同的结果继续快速复用，不因修复而每次重跑识别。

### R4 / P2：无媒体正文也启动全套本地工具探测；doctor 的“可用”没有覆盖模型就绪

定位：[content-enrichment.ts:271](../../src/content-enrichment.ts#L271)、[content-tools.ts:132](../../src/content-tools.ts#L132)、[ocr-content.ps1:12](../../scripts/ocr-content.ps1#L12)，以及 `transcribe-content.py` 的 `--probe` 分支。

纯正文、无图无视频的样本仍调用 yt-dlp、FFmpeg、ffprobe、Python ASR 和 PowerShell OCR 探测。全套探测测得 1,654.73 ms；纯正文 enrichment 为 1,675.68 ms，产物数为 0。此处足以确认无效工作，不需要把“ASR 很慢”作为解释。建议无待处理资产直接返回；按实际资产角色探测所需工具，worker 内按工具路径/文件变化缓存探测结果。

另一个已复现的功能差距：仅把当前进程 `CONTENT_ASR_MODEL` 指向不存在的隔离路径时，doctor 的 ASR 仍是 available，而同一 helper 的正式运行参数立即以退出码 3 报缺模型。见 `offline-and-reuse.json` 的 `modelProbe`。本机现用模型存在，这不是当前任务缺模型的报告。建议区分“运行时已安装”和“配置的模型就绪”；OCR probe 也应确认可创建语言引擎，而不只加载类型。

验收：无图无视频不启动上述五个工具；纯图不探测 yt-dlp/ASR；缺模型或 OCR 语言时 doctor 的对应状态不显示全部就绪；设置或安装发生变化后缓存失效。

### R5 / P2：窗口每约 700 ms 启动完整 Node CLI 查询状态，启动成本接近轮询间隔

定位：[link-window.ps1:502](../../link-window.ps1#L502) 的 `Start-LinkPoll`、[link-window.ps1:769](../../link-window.ps1#L769)；[link-cli.ts:3](../../src/link-cli.ts#L3) 顶层导入完整服务/采集链。

在空隔离队列上运行真实 `dist/link-cli.js jobs` 三次，完整进程耗时分别 472.15、506.90、492.31 ms，输出仅 56 字节。窗口活跃 worker 期间约每 700 ms 启动一次，且查询过程会影响 `busy` 控件状态。已确认的是频繁进程创建及其响应延迟；没有测量长任务期间的 CPU/能耗，不能给出 CPU 节省百分比。

建议先拆出轻量的状态读取入口，减少 jobs/cancel 等控制命令加载浏览器和采集模块；或在既有 worker 内提供状态通道。再根据用户可接受的反馈延迟决定 1—2 秒轮询或变化通知，暂不必为此建立新的后台常驻服务。

验收：保存长任务时采样进程启动次数、取消提交延迟及窗口可交互时间；查询结果与队列一致，取消仍能在约定窗口内生效。先测量再选择较大的进程架构改造。

### R6 / P2（增长后）：列表重复扫描清单；读取 100 字符仍可能读入十几 MB 元数据

定位：[content-service.ts:55](../../src/content-service.ts#L55)、[content-service.ts:67](../../src/content-service.ts#L67)、[content-library.ts:26](../../src/content-library.ts#L26)、[content-library.ts:148](../../src/content-library.ts#L148)、[content-library.ts:165](../../src/content-library.ts#L165)。

清单中包含全文。`listSavedContent` 的导入检查先扫描一次新库，`findContent` 再扫描一次；旧库还有另外的读取。`contentDirectory` 对可读目录名也逐个解析清单找 ID，`readContent` 再完整读入正文后才切片。分段输出的字符上限并未约束这些内部读取量。

合成样本每条正文约 64 KiB、空旧库、不匹配检索词；读取选择目录遍历末尾 ID：

| 条数 | UI 使用的 list API 耗时 | 清单 readFile 次数 | read 输出字符 | read 总读取字节 | read 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 | 25.33 ms | 20 | 100 | 791,725 | 17.22 ms |
| 100 | 227.72 ms | 200 | 100 | 6,733,531 | 124.42 ms |
| 200 | 645.54 ms | 400 | 100 | 13,335,831 | 241.33 ms |

当前正式库的直接 `findContent` 只需 17.36 ms，读 14 份清单、448,341 字节。因此这项有明确增长证据，但不应抢在当前正确性修复之前做大型搜索系统重构。

建议先建立可重建的 `contentId -> directory` 映射和轻量列表索引，正文检索另按 contentHash 更新。索引写入仍受保存互斥保护，打开资产时保留现有路径边界校验。一个小型原子 JSON 索引是否足够，应先用实际增长规模判断，不预设必须上数据库。

验收：继续使用 10/100/200 条样本；直接 read 的清单读取次数与库总条数脱钩；索引损坏能重建；可读文件夹重命名、旧 ID 路径和文件越界保护继续有效。

### R7 / P2（生命周期）：1000 条上限统计全部历史，重复提交终态链接仍声称已入队

定位：[content-jobs.ts:30](../../src/content-jobs.ts#L30)、[link-cli.ts:16](../../src/link-cli.ts#L16)。

两个不同结论：

1. **已确认限制，缺少产品出口**：1000 条 completed 历史也使新链接无法入队；CLI/窗口没有历史归档/移除命令。隔离样本准确返回“任务列表达到1000条上限”，原记录保留。当前仅 12 条，不是今天的阻塞。建议活动队列与历史记录分开限额，并提供保留资料、归档任务的操作。
2. **已确认反馈不匹配**：先取消链接，再重复 enqueue，队列仍只有一条 cancelled/attempts 0 的记录，CLI 却固定返回“链接已加入队列”。窗口的“保存链接”随后可能启动一个没有可消费任务的 worker。应返回 added/existing/needs_retry 等真实结果；已有失败/取消任务要能聚焦并清楚引导重试，已完成任务应直接提示已有资料。

验收：取消后重贴链接时，要么明确进入该任务的重试，要么准确提示需重试；不得显示已入队却仍无可运行项。归档 1000 条历史不删除资料，也不破坏旧 contentId/read/export。

### R8 / P2：耗时包括排队/隔天等待；派生阶段缺少细分进度

定位：[link-window.ps1:560](../../link-window.ps1#L560)、[content-types.ts](../../src/content-types.ts) 的 ContentJob；`content-enrichment.ts` 中没有 onProgress 调用。

窗口以 `createdAt` 到 `updatedAt/现在` 计算“耗时”，重试没有本轮开始时间。链接昨天入队、今天才处理时，显示值不能表示这次处理时间。服务进入派生后只有“生成阅读资料”，音轨、ASR、24 张帧及 OCR 逐项处理时没有阶段反馈。用户难以区分模型加载、识别运行和无进展。

建议持久化每次 attempt 的 startedAt/finishedAt，分别展示排队时间和本轮处理时间；按真实阶段报告“提取音轨/ASR/OCR 7/24/PDF”，不知道总时长就显示不定进度，不编造百分比。新下载进度由已有下载优化对话负责，本报告不扩大其文件写入范围。

验收：昨天入队的今日任务、隔天重试、暂停恢复三种时间均正确；取消/失败后不再增长；阶段和分子/分母来自真实完成项。

### R9 / P3：视频号把描述前 240 字符作为大标题，严重挤占阅读页/PDF

定位：[content-wechat-channels.ts:33](../../src/content-wechat-channels.ts#L33)、[content-wechat-channels.ts:94](../../src/content-wechat-channels.ts#L94)、[content-render.ts:68](../../src/content-render.ts#L68)。

正式视频号样本 title 恰为 240 字符、正文 495 字符。解析服务无独立标题时，程序直接把说明截成标题；HTML/PDF 又以 32 px h1 全量呈现。实际 PDF 首页的大标题占据大半页，正文随后重复相同说明。证据：[PDF 首页截图](../../logs/overall-review-20261014/pdf-6d892e62-page-1.png)。

建议保留完整原始说明和原始标题字段，展示标题使用首句或较短的可编辑标题，并在 HTML/PDF 使用同一展示规则。该改动可以独立完成，不需要重新下载视频或生成 ASR。

验收：本样本、无标点长说明、中文/英文标题均可读；完整说明仍可搜索和分段读取；contentId、原视频哈希和来源保持稳定。

## 检查点：已验证的反例与后续优化边界

定位：[content-library.ts:71](../../src/content-library.ts#L71)、[content-library.ts:99](../../src/content-library.ts#L99)、[content-enrichment.ts:91](../../src/content-enrichment.ts#L91)。

在 8 MiB 假视频上初次保存后，逐项添加 24 份约 1,950 字节的 OCR 文件并调用真实 saveContent：

- 初次只复制一次 8 MiB 视频；后面 24 个检查点总复制 46,800 字节，都是新增文字文件，**没有重复复制原视频**。
- 哈希缓存有效：后续检查点中原视频目标只增加一次 8 MiB 哈希读取，不能把源码里多次 fileHash 调用等同于每次重读视频。
- 24 次合计 1,525.8 ms，写入 2,735,817 字节；lstat 17,256 次、stat 4,284 次、realpath 2,880 次。第 1/12/24 个检查点分别约 29/62/120 ms。

因此“检查点重复复制大文件”假设不成立；**全量路径校验、正文拼接、HTML 和版本快照的累计成本**有实测证据。真实长 OCR 文本和多 P 的时间占比尚待分阶段测量，不应从这个 8 MiB 合成样本直接外推 GB 视频耗时。

建议在 R1—R4 后考虑：逐项耐久记录资产变化，阅读 HTML/综合正文按阶段或短间隔合并更新。任何合并都必须保留现有“取消/崩溃后已完成资产可恢复”的保证。当前媒体哈希复用应保留。

## 离线阅读和支持表核对

实际用新建、无账号的 Edge profile 设为 offline，并拦截 HTTP(S)，打开两条正式资料的本地阅读页。两条视频均真实播放约 0.7 秒、readyState 4、720×1280、无媒体错误；小红书本地 WebP 解码成功；两页 HTTP(S) 请求均为 0、pageerror 均为 0。见 [offline-and-reuse.json](../../logs/overall-review-20261014/offline-and-reuse.json) 和同目录 `offline-*.png`。这是短时播放验证，没有再次执行全段解码或验证任意跳转位置；视频号全段解码沿用正式结果证据。

两份视频在 0.5/120/300 秒的画面一致，完整原始说明都讨论同一期 SaaS 主题，属于符合跨平台发布同一内容的现象；未将这一点误列为解析失败，也没有据此自动合并或删除资料。见 [media-identity.json](../../logs/overall-review-20261014/media-identity.json)。

两份已有 PDF 可用本地解析器打开，共 3 页/2 页；全部页能提取文字，全部 5 页已用 bundled PDFium 渲染并目视核对。小红书图片正常，未见缺字或主要内容裁切；视频号长标题问题见 R9。PDF 是静态阅读输出，隐藏播放器符合当前契约。证据：[pdf-check.json](../../logs/overall-review-20261014/pdf-check.json)、`pdf-*.png`。

[平台支持表](../platform-support.md)与[当前验收报告:94](../link-library-acceptance.md#L94)已区分实现路径与真实样本。视频号当前成功、普通网页不含通用视频下载、PDF 不是通用导入、导出不是 ZIP，以及图集/登录态/多 P 等待扩验的表述一致。本评审未发现需要把这些支持声明改成“所有链接已验收”的依据。

尚待测量/补验，不作为已确认缺陷：

- `generateContentPdf` 把 lazy 图片改为 eager 后立即打印，没有显式等待全部 `decode()`；本次 PDF 图片正常，因此“可能偶发漏图”仍只是待构造延迟资源场景验证的假设。可加有界 decode 等待，并用本地慢解码/延迟图片验证。
- 未在真实长队列上测量 polling 的 CPU、内存峰值、磁盘繁忙占比；也未测量真实多 P 的检查点与 OCR 子进程启动占比。
- 没有重新操作小红书图集、登录态、B 站多 P、ASS/LRC 转写或桌面完整鼠标路径；已有文档对这些边界的限制应保留。
- 安装器取消路径只停止直接 PowerShell 进程，是否遗留 pip/模型下载子进程需另做隔离进程树验证；本次没有运行安装器，不列为实测故障。

## 主控可采用的本轮范围

建议 R1 纳入必要修复。R2 的文件边界取消检查、R3 的派生完成/来源校验，以及 R4 无媒体跳过探测适合作为本轮小范围可靠性/效率补齐，由现有模块负责人协调；不要直接删正式 staging，也不要覆盖正在进行的 ASR 或下载改动。

R5 先用轻量状态入口做对比测量，R6/R7 按资料增长与日常使用安排，R8/R9 可独立作为流程与阅读体验改进。索引、持久 worker、全局去重和数据库化都不应仅凭本报告的局部测量一起引入。

## 可复现诊断及使用限制

以下命令均在 `D:\开发\多平台资料库\程序文件` 执行，只写本评审专属 logs 目录；需要已有 Node/tsx、现有工具与 Edge。不执行全量测试或 build，不提交新链接到平台。`diagnose.mjs` 会读取正式库的脱敏计数，直接调用只读 findContent；它不会在正式库调用带导入副作用的 listSavedContent。

```powershell
node --import tsx logs/overall-review-20261014/diagnose.mjs
node --import tsx logs/overall-review-20261014/concurrent-import-check.mjs
node --import tsx logs/overall-review-20261014/retry-cancel-check.mjs
node --import tsx logs/overall-review-20261014/offline-and-reuse.mjs
```

脚本会在专属目录内新建合成 fixture；旧 fixture 无需保留，JSON、截图及脚本足以重跑。PDF 检查脚本 `check-pdf.py` 使用本机已加载的 bundled Python/pypdf/PDFium，不要求安装系统工具。原视频与正式资料均不改写。

初次评审收尾的 [source-snapshot.json](../../logs/overall-review-20261014/source-snapshot.json)记录路径、源码哈希及关键定位行。并行变更后应按函数名和该快照重新定位，不能把旧行号或旧全量日志当成新实现的验收。以上保留为独立评审基线，后续修复状态如下。

## 直接修复回填

本对话收到用户“你可以针对发现问题，直接修复吗”后，已在当前项目修改源码。主控主动完成分工与 ASR 文件交接；未向其他对话发送消息，未改正式资料库、正式 queue 或系统配置，未提交/推送。主控原有的原视频复用、身份稳定、恢复复制和下载网络改动均保留；本对话未修改 ASR Python helper。

| 项目 | 已落地修复 | 剩余边界 |
| --- | --- | --- |
| R1 | 旧库导入使用既有 worker 互斥；忙时跳过导入，列表继续可读 | 不新增常驻服务 |
| R2 | 保留主控匹配文件跳过复制、循环取消检查；独立验证中首份取消不开始后续，已匹配文件复制字节为 0 | 不承诺单文件中途截停；不自动清理正式 staging |
| R3 | 来源 SHA、成功清单或完整完成记录共同验证；新产物先验证再原子完成；来源变化后保存合并不复活旧稿 | 未在正式库重跑媒体或迁移数据 |
| R4 | 无媒体不探测；按实际素材探测工具子集；30 秒短缓存、文件/配置变化失效、doctor 强制新检查；缺模型/OCR 语言引擎不能报可用 | doctor 检查文件和运行时，不证明模型已实际加载 |
| R5 | 控制命令动态加载所需模块，轻量 runtime 独立 | 仍按现有窗口轮询；未引入 daemon |
| R6 | 优先查找可读目录的短 ID 提示，但仍校验完整 contentId；26 份清单的单项读取回归不超过 3 份 | 全文查询和大正文分段读取仍可继续优化，未引入持久索引 |
| R7 | 重复取消/失败/partial/需登录任务重新排队，沿用 ID 且更新新签名链接；完成重复返回 existing，CLI/MCP/窗口不启动空 worker | 1000 条历史上限与归档入口未改 |
| R8 | 每轮排队/执行/结束时间准确记录并显示；终态耗时冻结；提取/OCR 报真实项数，ASR 报不定进度 | 未做完整鼠标路径验收 |
| R9 | 列表与阅读 HTML/PDF 共用较短展示标题；保留原 title、完整说明与身份 | 正式阅读页/PDF 未重新生成 |

R3 的 ASR 复用核验 JSON/SRT/Markdown 三件套的段数、内容、语言与时间轴，拒绝非空标题文件、截断/不一致文件、来源变化和残缺输出组。产物记录实际处理配置指纹；环境没有明确指定模型时不把现有 small 降为默认 tiny。显式设置 `CONTENT_ASR_MODEL` 时请求处理，即使模型目录名相同；旧记录只有模型名，无法证明权重相同。本轮未绑定权重指纹，因此同一个显式路径也会请求处理。机器 ASR 字幕不再被重试流程当成平台字幕。

当前验证：

- 12 个受影响测试文件 **93/93 通过**、无跳过，含本轮 30 个新增用例，以及 ASR/媒体处理已有 10 个 enrichment 回归，其中涵盖 helper 行为。日志：[repair-targeted-tests.txt](../../logs/overall-review-20261014/repair-targeted-tests.txt)。
- 类型检查退出码 0，受版本管理的本轮文件 `git diff --check` 通过。日志：[repair-typecheck.txt](../../logs/overall-review-20261014/repair-typecheck.txt)。
- 两份真实 small 三件套与原视频只读复制到隔离 stage，在完全没有 ASR helper/模型的运行时成功复用三份 saved 产物；模型仍为 faster-whisper-small、语言均为 zh、JSON 字节不变、来源 SHA 一致。隔离副本已清理，没有实际 ASR 重算或正式库写入。证据：[formal-asr-reuse.json](../../logs/overall-review-20261014/formal-asr-reuse.json)。
- 同 tsx 加载器的源码启动对照中位 570.92 → 99.75 ms；OCR fresh 203.68 ms、缓存 0.29 ms。证据：[repair-performance.json](../../logs/overall-review-20261014/repair-performance.json)。这些不是构建后的端到端窗口性能数据，未据此声称 CPU/磁盘占用降低多少。

源码定向修复现已完成并再次冻结，主控可立即做统一构建、类型检查和全量集成验证；本对话未构建、未运行全量测试。显式同名模型目录回归先失败再通过。精确源码清单与冻结哈希：[repair-handoff.json](../../logs/overall-review-20261014/repair-handoff.json)；计划与剩余产品边界：[2026-10-14-review-repairs.md](../plans/2026-10-14-review-repairs.md)。历史归档、自动 staging 回收、持久全文索引、检查点批量合并保持后续建议，不能把本轮定向通过当成这些机制已经存在的证据。
