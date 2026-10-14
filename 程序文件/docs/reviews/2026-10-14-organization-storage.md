# 资料组织与可恢复归档交接

日期：2026-10-14。当前状态：**总控接入、全量561项验收及UR1–UR5限定独立复核均已完成，无范围内未决P1/P2。** 前段50/52项模块冻结和UR反例保留为历史证据，最新代码身份、复核与实际清理见末节；模块会话未归档真实资料、日志和队列。已读当前 Harness、偏好、本机说明、总控计划及 task-routing 方法，方法 SHA-256 为 F0E1B13E89A184D15D7A83B1404F418420F8B708A2886CB2BB589365FD0F4B48。继承当前模型，不创建 worktree/子会话，不提交或推送。

## 先行 API 契约

`root` 为现有 contentRoot，`projectRoot` 为包含 `logs` 的程序目录；库元数据和原始 content.json 分开。总控单写共享 types/library/service/CLI/MCP/UI，以下文件由本会话单写。

- `content-organization.ts`：`getContentOrganization(root, contentId)`；`setContentOrganization(root, contentId, {tags?, favorite?})`；`decorateContentItems(root, items, {tag?, favoritesOnly?, query?})` 返回原列表字段加 tags/favorite，筛选按 AND。标签最多20个、单个40字符，收藏为boolean；按 contentId 写 `.organization/items.json`，独立串行锁与原子写入，不改原清单。
- `exportContentZip(root, contentId, {signal?, maxTotalBytes?})` 返回 `{path, bytes, sha256, entries}`；复用现有 `exportContent` 脱敏导出目录，ZIP 不扫描原资料树，附加独立脱敏 `organization.json` 以携带标签/收藏。ZIP32 上限默认2GiB、最多4096文件，媒体64KiB分块读取，写后逐项复读 ZIP 与源文件 SHA-256 验证；临时公共导出快照核对归属后清理。
- `content-history.ts`：`archiveContentJobs(root, jobIds)`、`listArchivedContentJobs(root)`、`restoreArchivedContentJobs(root, archiveIds)`。返回项含 archiveId/jobId/state/title/platform/contentId/archivedAt/inQueue；原始私有输入只留内部历史记录以供恢复，不返回原始输入。历史以 jobId+快照hash 标识版本，可重复归档/恢复，无覆盖新任务。archive先持久化再队列移除；restore保留历史、队列同ID不覆盖，容量预检1000。
- `content-jobs.ts` 追加 `withContentQueueTransaction(root, operation)`，复用当前 queue.lock/rawJobs/atomicJson，供历史操作串行。按总控明确补充：`retryJob(root,id,processing?)` 在锁内更新可选模式、所有queueRetry清除旧progress；enqueue已completed且本次显式模式不同才重试，同模式不重跑，省略模式沿用旧模式。其他worker/队列行为保留，processing/progress在历史快照中原样保留。
- `content-log-archive.ts`：`planContentLogArchive(projectRoot, options)`、`archiveContentLogs(projectRoot, options & {expectedPlanId, removeSource?})`、`listContentLogArchives(projectRoot)`、`restoreContentLogArchive(projectRoot, archiveId)`。options 含 directories/closedDirectories/activeDirectories?/rebuildableDirectories?/signal；只接受 `logs/<封闭历史顶层目录>`。closedDirectories 是总控确认停写的清单，activeDirectories优先拒绝；链接、活动/恢复/源码/工具/浏览器/凭证材料拒绝。默认ZIP核验后保留原目录；仅 removeSource=true 且已明确可重建的选中目录才核验后移除。归档ZIP与清单保留于 `.log-archives`，可核验恢复，既有目标不同则拒绝覆盖。

对应新 tests 与本文独占；不改 package.json/dist。旧文章库不迁移、不删除，本模块只提供当前资料库组织和封闭历史日志治理。

## 验证记录

首批契约测试已先因模块不存在失败；实现后13项通过。扩充恢复/隐私/并发用例后31项通过（组织9 + 历史9 + 日志7 + 既有队列6），0失败/跳过，四模块入口严格noEmit通过。修复了总控发现的空数组string/never推断，未由总控改独占文件。仍在做最后受影响路径复核，冻结后补最终哈希；本会话没有执行真实归档、全量测试或build。

最终定向：`node --import tsx --test tests/content-organization.test.ts tests/content-history.test.ts tests/content-log-archive.test.ts tests/content-jobs.test.ts tests/content-storage.test.ts`，**50/50、0失败、0跳过、退出码0**（组织9、历史10、日志8、原队列6、原存储17）。四模块入口使用ES2022/NodeNext/strict/skipLibCheck的noEmit检查，退出码0；指定路径git diff --check退出码0，仅现有Git LF/CRLF提示。未运行项目全量或生成dist。

证据涵盖：并发标签/收藏不丢更新、原清单字节不改、组织字段不能覆盖原列表路径；ZIP隐藏签名/令牌/原始body/未知原快照、附脱敏organization.json、6MiB视频禁止readFile整读，Python标准zipfile成功读取中文路径与CRC；取消/超预算/越界/链接不发布ZIP，损坏ZIP与路径攻击不越界恢复。任务历史的队列提交故障保留pending快照，重试幂等；损坏记录不改队列；私有localPath及处理模式仅内部恢复，list只返摘要；1000容量、不同重试版本和并发retry不丢任务。日志默认留源、计划变化拒绝、移除失败仍可用ZIP恢复、相同计划复用归档；链接、活动、恢复、源码、浏览器、凭证、嵌套档案、raw HTML等不进入归档。17项既有存储维护锁回归保持通过。

## 冻结文件

| 文件 | SHA-256 |
| --- | --- |
| src/content-organization.ts | 7dd6f59dd0fce15c73a66b9d2cf11f1a5a17d816fec14fc132472d6c3bf56a84 |
| src/content-history.ts | 3bfc65c3e1ed7779c7de62a8b6ad11dcdd4811c4cc6ffefba9376c2a77a7a65a |
| src/content-log-archive.ts | 31bae7e5ee1a96c86d57f2c7b11cedac29d6b8078f5d3e44a43a5e6e42bd3112 |
| src/content-jobs.ts | 80b9e6ef0e74c55074033616e385f21739946a5ee406b54bce6eae4036a4bb60 |
| tests/content-organization.test.ts | 3f9bd6ea2f54751240d372ec34d9cc65e83801cdc0baf25e28dbdf1804c5537a |
| tests/content-history.test.ts | 0033ee4a1589e988a8e91816bb94bf5fc73b63d8a7ef2280a7a29c24a4c2d93d |
| tests/content-log-archive.test.ts | 9a1e1807e8e7ed4d70d89c4036aa119a3129d18763b83f0683ca6c0d4294eeb7 |

ZIP基础格式按[PKWARE官方APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)核对STORE/DEFLATE、UTF-8标志、data descriptor与CRC32；只支持本模块有界ZIP32，未新增依赖，不承诺任意外来ZIP格式。ZIP导出需取得现有worker维护锁，活动采集时沿用忙提示。封闭日志清单必须由总控确认停写，不因日期或路径名字自动认定封闭；默认不删源，removeSource明确且rebuildable清单含每个目录才移除。旧文章库留原位置兼容，不搬删。

数据位置：库内`.organization/items.json`、`history/*.json`；程序目录`.organization/log-archive.lock`、`.log-archives/{id}.zip/.json`。history含私有恢复输入，日志归档属于内部恢复材料，源码版本打包/共享应排除这些运行目录；共享ignore规则由总控维护。本会话无真实归档写入、无账户/profile操作、无提交推送；等待总控最终三入口验收和正式595文件基线比较，未把本模块测试当全项目验收。

## 总控新增功能独立只读复核

总控随后指定处理模式/进度、校订稿、服务和三个入口及窗口脚本复核，并请求匿名cold/live profile来源的只读诊断。本节将仅追加具体P1/P2或无阻塞结论，保留范围与版本；不改总控文件，不构建或重复全量，不对真实日志/profile作删除或归档。

### UR1/P2：字符串false被当成日志源移除授权（已关闭）

同构临时夹具经真实 `runLinkCli(['logs','archive',JSON.stringify(options)], {root:临时根,runtimeRoot:临时根})` 调用，JSON中removeSource为字符串`"false"`，其他闭合/可重建清单与planId正常。修复前实际返回ok=true、removedDirectories含logs/closed-run，源目录已不存在。源码快照：CLI 2b9ae679…，content-log-archive 31bae7e5…；运行前后SHA一致，临时根已核对归属后清理。入口只校验字段名，模块if(options.removeSource)会将任何真值当授权。

本会话在自有日志模块追加严格boolean验证，并仅在 `removeSource===true` 执行移除；非法值在取锁/ZIP写入之前拒绝。新增回归含字符串false/true、数字、对象和null，修复前已失败；不改总控CLI/MCP文件。草稿保护按总控另行明确要求加入drafts/编辑草稿/校订草稿等目录；实际UI的UUID.json公开草稿夹具在修复前确为eligible=true，已补对应拒绝用例。最终绿灯/新冻结哈希见后续复核记录。

日志模块再次独立10/10、0失败/跳过、noEmit退出码0。重新冻结：`src/content-log-archive.ts` **0c002eaa6b104efef77e00fb5afa1515a70a9b61e557d5807a54c1ebafcc6064**，`tests/content-log-archive.test.ts` **c8281ba905cd90459d90b0c6eee6015c3f0796950382a0d7a645de6665fc37fc**；其他六份冻结源码/测试哈希保持。草稿回归以实际UUID文件名验证，避免pending名字被其他规则拒绝而产生假覆盖。本次追加2项，最后专属与受影响定向合计52项分不同运行通过，不把历史50与日志10累加成60项独立测试。

### UR2/P2：术语替换缺少工作集大小约束（已关闭，原反例保留）

定位：`src/content-transcript-edit.ts:41-42`，SHA-256 **98dd0284953085fd267e93f068bb5b068d169d4d304e8debe0fbb42d46c69cee**；`link-library-dialogs.ps1:68` 也在分配完整替换字符串后才更新编辑器，没有相应预算预检。CLI `transcript-replace`可调用核心函数。

独立只读复现只用16,384个ASCII字符：先将x替换为200个x，再将200个x替换回x，正常返回16KiB，但中间字符串为**3,276,800字节，已超过2MiB**；SHA前后不变。validateText仅在全部替换完成后执行，中间扩张没有界限。合法2MiB输入一次可扩张到约400MiB，连续100次扩张可耗尽进程；没有执行该大载荷。GUI长替换词同样可能在预览时分配巨大字符串，威胁未保存草稿。

建议在每轮split/join或Text.Replace之前计算匹配数及UTF-8结果大小/字符工作集，超2MiB或约定工作集预算即明确拒绝；术语字段类型/长度校验也在分配前完成。预检失败不改编辑器当前稿，不改变literal替换与Ctrl+Z行为。本会话只记录反例，不修改总控文件。

### UR3/P2：MCP无效start类型会入队并尝试启动（已关闭，原反例保留）

定位：`src/mcp/server.ts:36`，capture_link只检查text为string，随后将 `args.start!==false` 传入handler；import_content_files同样如此。工具声明的boolean inputSchema不会由手写CallToolRequestSchema处理器自动执行对应工具的字段校验，当前SDK客户端只缓存输出schema校验。

独立以SDK Client + InMemoryTransport连接真实createServer，运行根/库根均为新建 `organization-mcp-review-` 临时根，调用capture_link参数 `{text:'https://example.com/invalid-start-review',start:'false'}`：返回isError=false、ok=false、queued=true、workerStarted=false、提示缺少编译程序；**queue.json已经有1个任务**。临时根故意没有dist/link-cli.js，因此启动入口在spawn前拒绝，没有实际worker/网络/浏览器/账户操作；客户端/服务器已关闭，临时根和环境变量已恢复。

预期异常字段应在队列写入/启动之前返回参数错误。建议对start/encoding/processing和其他新工具字段作显式运行时校验，不用truthy或`!==false`隐式解释无效类型；至少capture/import的非boolean start需拒绝。复核时保留合法start:false的仅入队正控制，以及非法类型时queue不变的反例。本会话未修改总控MCP/handler文件。

### UR4/P2：原机器稿重建后，保留的失效校订稿堵住新校订（已关闭，原反例保留）

定位：`src/content-transcript-edit.ts` 的readTranscriptEdition，edition查找未区分saved/failed，随后verifiedText强制status=saved。合法素材/ASR/OCR重建会由content-library的derivation校验将旧user_edited版本标为failed并保留字节；但新的机器原稿仍saved，这时应允许用户查看新原稿并开始/合并新校订。

独立临时夹具：saveContent保存机器原稿A；saveTranscriptEdition保存用户校订A；同contentId/sourceAssetId用saveContent提交已核验的机器原稿B；再readTranscriptEdition(id,'asr')。实际机器稿status=saved，旧edited-asr为failed，reason为原始素材变化；**读取整个校订入口抛“该文字稿尚未保存”**。夹具无ASR/OCR/PDF/浏览器调用，原文件保留，无修改总控源码；临时根已验证归属后清理。

建议仍保留旧校订历史，在旧版因源SHA变化失效且新source可核验时返回新机器稿与明确stale提示，或允许用户选择另起/合并校订。不要把失效版静默当作当前成功，也不要删除用户版本。新增“源重建后可再次校订、旧版本字节/hash仍可恢复”回归。本会话不修改总控模块。

### UR5/P2：ZIP能自校验，但非文字原件与导出清单不一致（已关闭，原反例保留）

按总控要求仅做该项最小只读复现，不修改共享library或扩大检查。定位：`src/content-organization.ts` 的exportContentZip预检只计文件大小；现有 `src/content-library.ts` 的exportContent对非文字资产copyFile，manifest仍保留原bytes/SHA。

独立 `organization-export-review-` 临时库：saveContent保存4字节GOOD为original video；写入清单后，在库内同一路径改为4字节FAKE；exportContentZip正常成功，再用extractContentZip读回包内content.json。实际metadataStatus=saved，原/导出metadataSHA均为 **278f14e96cc67489e5c0d6cebec8a2718fb158ec656fd41fed7ecd031cd472b2**，ZIP视频条目/实际FAKE的SHA为 **a152d9568d84788386ed06560799f7b0f2220051af3399d2aa78862c556eabcb**；sameBytes=true、hashMatches=false。纯合成字节，无真实下载/probe/原件写入，临时根已核对归属后清理。

ZIP层已经正确验证“源副本→ZIP条目”的自洽；它不证明副本匹配原清单。建议共享exportContent在创建输出之前核对原saved资产的已知bytes/SHA，复制后再次对照并拒绝源变更，保持原清单与外部变化文件原样以供用户核查；不能通过简单改清单SHA把变化后的字节冒称已核验原件。文字脱敏派生须明确沿用现有重新计算导出bytes/SHA的逻辑。新增同长度篡改负例、原件未变正例和文字脱敏后metadata匹配正例。

### cold/live profile只读诊断（2026-10-14，本次未清理）

已定位来源：`tests/video-network-diagnostic.mjs:11` 的--cold分支、`tests/video-live-verification.mjs:16`新建logs下mkdtemp根，再将此根交openEdgePage；`src/browser/edge.ts:10`使用该根下`.wechat-reader-profile`，没有复制默认profile。但该函数headless=false，历史窗口可被用户交互，**不能从新根或目录名称证明后续始终匿名、没有账户会话**；本次没有读取Cookies/Login Data/Preferences等内容。

旧目录皆为2026-09-06遗留：cold azUA8P/iRafJv/rKFoU9；live 2NfJac/fQbTvL/lGlRUY/n0is5S，共7份profile，**2,522文件、179,450,024字节（约171.1MiB）**。live HT8kjY只有报告无profile。live目录中的library有原始验证资料，部分目录没有顶层report，不能把整个cold/live根认作可删缓存。公开report/download-report保留原位置，不读出签名/Cookie字段。

活动检查：默认沙箱CIM不可用；只读授权后的Win32_Process检查结果EdgeProcessCount=0、UnknownCommandLines=0、项目logs匹配profile为0。该结论仅属于检查时刻，操作前需重新确认。

安全清理建议仅针对已确认停止使用的7份测试profile内：Default/Cache、Default/Code Cache、Default/GPUCache、Default/DawnGraphiteCache、Default/DawnWebGPUCache、GrShaderCache、ShaderCache。只统计元数据，共**1,473文件、137,218,583字节（约130.9MiB）**；属于可由浏览器再生成的缓存，不保证重建旧响应字节。保留Cookies、Login Data、Local State、Bookmarks、Preferences、Service Worker/CacheStorage、全部report及library/验证媒体；不建议按当前证据删除整个profile或整个测试目录。若根会最终执行，仅在无占用、realpath仍为上述明确logs子树并保护恢复材料后按精确缓存目录处理。本会话只诊断建议，未删除、打包或移动真实目录。

该诊断还发现旧`.wechat-reader-profile`名字与空保护目录需要在日志策略层明确拒绝；已补对所有目录的只读策略预检及实际名称反例，重新冻结哈希/日志11项复核在下面记录，日志ZIP不能携带此类profile，即使调用者声称可重建。

## 总控最终闭环与独立复验

本节由总控接管单写，保留上文发现时版本与反例，不将旧哈希当作当前冻结身份。最终独立只读复核由总控内部审查代理`/root/final_regression_review`限定在UR1–UR5完成；没有新增问题搜寻、代码或正式资料写入。结论：五项均可关闭，范围内无未决P1/P2。指定三份现有定向测试**27/27通过、0失败/跳过、退出0，约8.49秒**，6份源码及3份测试SHA在该复验前后一致；具体命令与回执保存在`logs/usability-20261014/verification.json`。

| 项目 | 当前修复与独立复验结果 |
| --- | --- |
| UR1 | 非boolean的removeSource在锁和ZIP写入前拒绝，只有严格true可移除；UUID草稿、空恢复目录及旧profile目录受保护，日志11项回归通过。 |
| UR2 | 每轮替换分配前计算字符和UTF-8工作集预算；16KiB→200倍→缩回反例在中间扩张时被拒绝，GUI同样先检；正常literal替换通过。 |
| UR3 | MCP使用工具schema在handler前校验类型/枚举/数量，handler另作副作用前检查；真实子进程非法start/processing/encoding返回isError且queue字节不变，合法start:false仅入队。 |
| UR4 | 新机器稿可正常读取/另起校订，旧失效校订与旧机器稿明确标记并可查看；按来源SHA保存原稿快照，A→用户A→机器B→用户B回归验证旧版本字节仍可恢复。 |
| UR5 | 实际原件bytes/SHA先与原清单核对，拷贝后二次检查来源与目标；文字脱敏重算导出SHA。同长度篡改被拒绝且不遗留导出包，原件保持原样。 |

限定复验核对的当前源码SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| src/content-log-archive.ts | c5fe8fc4ce1ad90a116cde1e7b2d2066420b773b07d905e4c0a6e529d27decf7 |
| src/content-transcript-edit.ts | 1d9cd11c3685d7731ac5490b0f177ae8a27e90c6d81e54dc5be13cd967f26213 |
| src/content-library.ts | ddf491de2ebe04afb5274b996158a9cd5d509c92d905b92b668b12576f53337c |
| src/mcp/server.ts | a62b648a2301bcce46f4f510251aa3070a7561fe8e75e794754bd7c7890f4e1d |
| src/mcp/content-validation.ts | 4903be97ebc1c73c320e5377f258c7399f746821eab43437f2b13ee62d144702 |
| src/mcp/content-handlers.ts | dca1e2abe8dc04cac21c375d4c25cd5e36db7f0bdf3883afd18b7df9e14a057c |

总控最终类型检查、构建、全量测试退出0，**561/561、0失败/跳过**；146源码/脚本/测试/依赖文件检查前后SHA不变，`资料库/`595文件大小/SHA全部不变。实际缓存清理由总控在重新验证绝对路径、链接及占用后执行，仅上文7份旧测试profile内明确的可重建缓存，回收**1,473文件、137,218,583字节**；1,049非缓存文件元数据未变。账户、报告、原始媒体、Service Worker和恢复材料保留。清理结果见`logs/usability-20261014/legacy-cache-cleanup.json`；不将本会话原先的只读建议写成其执行结果。

交接范围已由项目[升级计划](../plans/2026-10-14-library-usability-upgrade.md)承接，协作会话可按用户授权归档。归档只是结束该协作范围；当时YouTube的HTTP429/平台验证记录保留。总控18:06新续验已补齐真实应用媒体下载与隔离入库，见平台覆盖交接末节和最新支持表；未发生的字幕/ASR/OCR、其他链接或长期稳定仍不作成功声明。
