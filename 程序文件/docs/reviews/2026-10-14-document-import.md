# 文档与原图导入交接（2026-10-14）

已完成文字层 PDF、常见 DOCX 主文档和 PNG/JPEG/WebP/BMP 原图导入。原有 `importLocalFile` 调用契约保持，`content-service.ts` 的既有本地获取/捕获入口继续调用它；本次没有修改共享服务、UI、CLI/MCP 或类型。源码、测试和包依赖在本页记录的版本冻结，由总控统一构建、验收及安排归档。

开工已读取 current.md、其短协作偏好、本机说明和 task-routing.md；委派方法 SHA-256 为 `f0e1b13e89a184d15d7a83b1404f418420f8b708a2886cb2bb589365fd0f4b48`，与派发输入一致。保持本项目目录与当前模型设置，没有新建 worktree、提交、推送或访问账号。本次单写范围为 `src/content-local-import.ts`、新增 `src/content-document-import.ts`、两份专属测试、package.json/package-lock.json 和本报告。复用样本与测试暂存只在项目独立日志目录。

## 队列与调用者接口

`LOCAL_IMPORT_EXTENSIONS` 新增 `.pdf .docx .png .jpg .jpeg .webp .bmp`；保留 `.txt .md .markdown .html .htm .mp4 .mov .m4a .webm .mkv .mp3 .wav .aac .flac .ogg`。

新增两项共享纯函数，供入队预检与实际导入使用：

```ts
localImportFormat(fileNameOrExtension: string): LocalImportFormat | undefined
localImportByteLimit(fileNameOrExtension: string, limits?: {
  maxTextBytes?: number; maxMediaBytes?: number;
  maxDocumentBytes?: number; maxImageBytes?: number;
}): number
```

| 类型 | 标准 format / nativeId 前缀 | 应用硬字节上限 |
|---|---|---|
| TXT / MD / HTML | txt / markdown / html | 8MiB，调用者可下调；总控队列与服务使用4MiB |
| PDF / DOCX | pdf / docx | 32MiB |
| PNG / JPG与JPEG / WebP / BMP | png / jpeg / webp / bmp | 32MiB |
| 原有音视频 | 既有格式名 | 2GiB |

nativeId 为 `<标准format>:<原件SHA-256>`，规范来源为 `local://sha256/<format>/<SHA-256>`。JPG/JPEG 共用 jpeg 身份，MD/MARKDOWN 共用 markdown 身份；名称变化不会制造新原件。导入再次检查授权路径、真实文件、字节上限与原件状态，不信任队列预检替代实际核验。

`LocalImportContext` 增加 maxDocumentBytes、maxImageBytes、documentLimits，仅允许下调默认上限。localSource 增加 document（文字层页数/是否可检索/主文档覆盖）及 image（格式/尺寸/MIME）元数据。原件资产仍为 original；文档为 source，图片为 image，供总控现有离线 OCR 处理。

## 行为与限制

- PDF 使用项目 PDF.js 的 text stream。保留页号和文字层内容；最多200页、索引文字4MiB，不截断后宣称全文。没有文字的扫描/空白 PDF 保存原件及明确的状态说明，searchable=false、body=unavailable；部分页面没有文字时记录实际页数并保留警告。这里的 complete 指各页文字层有结果，不等于图像、公式或全部视觉内容已 OCR；版面阅读顺序也不作还原保证。加密 PDF 不提供密码，要求用户先自行解密。
- DOCX 用有界 ZIP + 严格 XML，不运行 Office 或 HTML 转换。要求标准主文档路径、唯一的本地包关系及正确内容类型；支持 UTF-8、BOM UTF-16 XML，保留中文、实体字面文字、段落、制表符和表格文字，跳过删除修订。索引范围明确为主文档；页眉页脚、脚注、图形/替代嵌入保留在原件，未展开部分有提示。空正文只保存原件与不可检索说明。旧 DOC、DOCM、其他 OPC 主文档布局不在本轮范围。
- ZIP 最多2048条、总展开64MiB，XML/关系单条8MiB、其他单条16MiB；膨胀比最多100，微小条目允许至1KiB。声明和实际展开字节都检查，每条核对 CRC；拒绝加密、越界/重复/链接条目、宏、ActiveX/OLE 活动嵌入。DTD、外部实体、超过128层的 XML 被拒绝；外部关系只作提示，不访问文件或网络。
- 解析在可终止 Node worker 中运行，默认30秒，可降低；取消、超时和线程失败不登记成功。V8 old generation 限制192MiB、young generation 32MiB；读取块后另检查 ArrayBuffers 128MiB。它们是线程解析防护，不是整个进程 RSS 硬限制。PDF 只传原始字节，关闭 XFA、脚本求值、系统字体、WASM/自动远程读取；字体/CMap 如需读取，只允许项目依赖自带目录中的安全名称。
- 原图最多32768边长、4000万像素。扩展名须与字节签名和尺寸解析类型一致，检查 PNG/JPEG 尾部、WebP/BMP 长度结构；不支持 SVG 或其他引用型图像。这里是元信息/结构检查，未对压缩像素做完整解码；OCR 属于后续离线处理，导入不伪造文字稿。原图没有上传。

原文件只读，沿用目录白名单或 exact explicitPath、祖先及文件符号链接拒绝、打开/复制/登记前的状态检查。新副本经过独立复制和两次源哈希核对，以新副本 inode 原子登记，不链接输入 inode。新文档/原图在解析后再核验快照大小与哈希，防止解析期间副本被修改；坏旧快照拒绝复用，失败的 pending 副本清理。既有大型音视频不增加额外整文件复读。

## 项目依赖与官方资料

新增并精确锁定 `pdfjs-dist 6.4.299`、`yauzl 3.4.0`、`saxes 6.0.0`、`image-size 2.0.4`；开发类型 `@types/yauzl 3.4.0`。仅安装在项目，没有以 Codex bundled 库作为应用运行时。PDF.js 要求 Node >=22.13，当前已验证 Node 24.14.0；其可选 canvas 依赖也随项目安装。

选型核对了 [PDF.js 当前 API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)、[yauzl 的懒读取及大小核验](https://github.com/thejoshwolfe/yauzl)、[saxes 的严格 XML 与 DTD行为](https://github.com/lddubeau/saxes)、[image-size 的字节元信息接口](https://github.com/image-size/image-size)。DOCX 采用严格 XML 的正文范围，不将格式转换器生成的 HTML 当原文。

交接时生产 npm audit 未列出上述4个新运行时依赖的告警，原有共享依赖有6项（SDK、undici、fast-uri、hono、ip-address、proxy-addr，含1项critical）。随后总控按兼容范围修复并恢复完整开发依赖，完整npm audit退出0、当前已知告警0，SDK1.32.1/undici7.30.0；本页末尾包锁SHA属于原交接时刻，新锁身份由[统一升级验收](../plans/2026-10-14-library-usability-upgrade.md)承接。审计0不等于整体无漏洞证明。

## 验证与可复用样本

本模块最终35/35定向测试通过，严格 noEmit 类型检查退出码0。包括真实字节 PDF 英文/嵌入中文映射、扫描与混合页面、DOCX 中文/表格/BOM UTF-16、空/损坏/声明加密/CRC错误/膨胀/目录越界/外部关系/DTD/宏、四种原图、别名同身份、时间与输入保护、取消/超时以及解析后快照篡改。原12项文本/音视频导入回归保持通过。较小展开预算仅限制文档内容，不能把解析器本身的内存算作 ZIP 数据。Windows 无文件 symlink 权限时仍测试了真实目录 junction 与链接祖先拒绝。

执行命令（从程序文件目录）：

```powershell
node --import tsx --test tests/content-document-import.test.ts tests/content-local-import.test.ts
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --types node src/content-document-import.ts src/content-local-import.ts src/types.d.ts tests/content-document-import.test.ts tests/content-local-import.test.ts
node --import tsx tests/content-document-import.test.ts --write-fixtures
```

第三条只生成7份样本，不注册单元测试。冻结版位置：`logs/usability-20261014/document-fixtures-v1/`。包含文字层 PDF（657字节）、扫描 PDF（605）、标准 OPC DOCX（1207）、带文字的900×200 PNG（9100）、2×2 JPEG（221）、WebP（44）、BMP（70）。PNG 实际文字为 `OCR TEST LOCAL IMAGE 2026` 与 `Document import sample`，可用于离线 OCR；后三种小图没有正文。生成器不覆盖不同哈希的既有样本。

总控真实 receipt：依赖修复后编译CLI重新对冻结v1 PDF/DOCX/JPEG/PNG执行import/work/list，4任务均completed、原件SHA不变，OCR/PDF和搜索可用，见`logs/usability-20261014/document-cli-live.json`。PNG第二行正确、首行窄字体有机器误认，机器稿与校订入口保留。当前DOCX1207字节，SHA `7ce67792cb571e965042d2aefb10f9368ffdae6dfaa9c6876892fc4a2ec9a25a`。前版1053字节的真实receipt另留`document-cli-before-v1.json`，SHA `5f65f5ae93f6ac5a8a8a9d81f75d84ecb79ec3e642ca7f7039d2fe9b47521640`；两次输入身份分开保留。

按 `logs/usability-20261014/formal-before.json` 逐项复核595份正式资料的大小及 SHA-256，595份全相同。子任务没有运行全套或构建 dist，没有写正式资料库、队列或账号；总控进行后续统一验收。

## 冻结 SHA-256

| 文件 | SHA-256 |
|---|---|
| src/content-local-import.ts | 9bf7fe67d6e52515a1643946dc73c639068af0f0eb12885b9cd21b88364e9b10 |
| src/content-document-import.ts | dd39a0821b318da5b310c55c3050e49d7815779e865447278da416cf41d246d3 |
| tests/content-document-import.test.ts | 47c415866c61126f52251bf6820853fa377dffabdebe780c3f81524fa675714c |
| tests/content-local-import.test.ts | 14b776c24b12e12e3e0f5a169b883b161b3aa5981cfaf9146b63b9f8df6b1d03 |
| package.json | 1b6880b092b1ac1447e8b1ea42ef7cd910b03634b66cf5cccf7e34c0f81d2dac |
| package-lock.json | 6157a3ac947da5066ea282a269cf99fe3481044773e2a704e36437cef6ab4363 |

达到本子任务完成条件后停止扩展，源码、测试和依赖已冻结；不自行归档聊天。
