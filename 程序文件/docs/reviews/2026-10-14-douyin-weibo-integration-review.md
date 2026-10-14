# 抖音、微博接入前置审查

日期：2026-10-14（Asia/Shanghai）。当前阶段：**新增 Edge 冻结版独立审查完成，无未决 P1/P2：公共 helper 13/13、抖音24/24、微博30/30定向通过；跨平台旧 Cookie 用例 T1/P2 经总控修复后独立4/4通过，已关闭。前次 HTTP 版 C1、D1/D2、W1/W2/W3 已全部关闭。** 本次独立定向与主控真实下载证据分别记录，交主控继续统一验收。下文保留历史反例和快照，最终结论见末节。

当前权威契约来自总控及 `src/content-social-reference.ts`：微博帖子 **nativeId=bid、canonical=m.weibo.cn/status/bid**；TV 独立使用 **video:FID**，核验其查询所得目标帖子及目标媒体。初步讨论中的 decimal mid 主键方案已由该集成决定取代，后续按此审查。

范围：核对官方 yt-dlp `DouyinIE`、`WeiboIE/WeiboVideoIE`，以及现有 input/types/router/login/network/service/storage 的接口。只查官方源码和本项目源码、执行纯函数/标识计算；没有访问真实帖子、抓推荐页、导入默认 Cookie、调用第三方解析、写正式库、修改代码、build 或全量测试。唯一新增文件为本报告。

## nativeId 和 URL：供实现者立即采用

| 输入类别 | nativeId | canonicalUrl 与处理 |
| --- | --- | --- |
| 抖音明确单视频 | **aweme_id 的数字字符串**，不经 Number | `https://www.douyin.com/video/<id>`；元数据 id 必须一致 |
| `v.douyin.com/<token>` | 解析前不使用 token 作作品 ID | 暂存短链身份；受控跳转后识别单作品，再更新当前 job.input，按真实作品 ID 保存 |
| 其他抖音分享形态 | 只有明确作品标识才建立作品身份 | 如支持 `iesdouyin.com/share/video/<id>` 或明确单一 modal_id，可转到相同单视频规范 URL；须有 URL 夹具，不能把用户主页、合集、直播当单作品 |
| 抖音 note/图集 | 不冒充已支持的 video | 若本轮不支持则明确 unavailable；支持时按该作品自身 ID、真实 gallery 类型保存，不能用背景音乐/封面证明已取得原视频 |
| 微博帖子数字 mid | **把 decimal mid 转成 bid** | 固定 `https://m.weibo.cn/status/<bid>`；m/status、m/detail 与桌面同一帖子合并到此处 |
| 桌面 `weibo.com/<uid>/<bid>` | **bid，保留大小写并验证往返** | uid 是作者位置，不能代替帖子 ID；返回数据的 mid/id_str 和 mblogid 归一到相同 bid 再核验 |
| 微博 TV / `fid=1034:…` | **`video:<FID>`** | `https://weibo.com/tv/show/<FID>`；另绑定查询所得目标帖和目标媒体，不将 oid 尾数当帖子 mid，不自动合并 TV 和引用它的任意帖子 |
| `t.cn` 等短链 | 解析后再判定对象 | 它可能指向站外网页；解析前不能宣称是微博帖子。已明确属于抖音/微博的入口若落到登录页、主页或其他对象，应明确限制，不能静默拿落地页当原帖 |

官方 DouyinIE 接受单视频数字 ID；本机安装脚本固定的 yt-dlp 为 `2026.08.19`，已核对该标签及 master 相关代码。[官方 DouyinIE](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/tiktok.py#L1288-L1422)

官方 WeiboIE 同时处理桌面 bid 和移动端帖子入口，其结果 id 与 display_id 分离；TV 提取器另外查询帖子 mid。其测试中的 `1034:4797699866951785` 对应帖子 **4797700463137878**，尾部数字并不等于帖子 ID。[官方 Weibo 提取器及测试](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/weibo.py#L126-L280)

### bid 转 mid 的实现建议与实际验证

纯函数约定：按 bid 从右向左每 **4 位 base62** 转成一组十进制，除最左组外补足 **7 位**再拼接；反向按十进制每 7 位转为 4 位 base62。字符表为 `0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ`。整体 ID 保持字符串；BigInt 可用，单组明确小于等于 9,999,999 时用 Number 也安全。不小写化 bid，不把整串当普通 base62 整数。

这是应用侧的归一建议，**不是声称 yt-dlp 内部使用此算法**；官方代码通过元数据接口识别帖子。本次只计算其公开测试夹具，以下三组 decode 和 encode 往返全部一致，没有请求这些帖子：

| bid | decimal mid | 计算与往返 |
| --- | --- | --- |
| `N4xlMvjhI` | `4910815147462302` | 一致 |
| `FBqgOmDxO` | `4189191225395228` | 一致 |
| `LEZDodaiW` | `4797700463137878` | 一致 |

URL/API 语义明确为 decimal mid 时，按字符分组转换为规范 bid。全数字但语义不明的短 bid、超长/非法字符、转换不合法或返回身份不一致时，保持待解析或拒绝；不要把整体 ID 用 Number 舍入。JSON 中 id 为不安全数字时，也不能先 String(number) 再当作精确标识；优先可信的字符串 id_str/mid 与 bid 对照。当前 helper 已做长度与往返校验，最终核验以其支持范围为准。

## 已证实的契约陷阱

### C1：微博文章只有 coverage 不完整标记（总控已修复）

定位：`src/content-library.ts` 的 `contentStatus`。纯函数合成 article：正文是摘要、assets 空、warnings 空，`coverage.body = "unavailable: long body not fetched"`，实际返回 **completed**；加一条明确 warning 或 failed source 资产后返回 **partial**。

上述是修复前的可复现证据。总控随后为新两平台加入 body coverage 检查；本次用同一 article/明确 unavailable body 纯函数夹具复核，结果已为 **partial**。真实未就绪资产仍需准确登记，不能把摘要字段写成 saved 来绕过完整性判断。

### C2：不能把 yt-dlp 的微博视频元数据当完整帖子的唯一来源

官方 WeiboIE 会将混合媒体结果变成列表、跳过 pic 项；视频描述取 text_raw，未见独立的长文展开分支。因此它可作为视频来源，不能独自证明纯图文、完整长正文和所有混合媒体均已覆盖。[官方相关实现](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/weibo.py#L98-L200)

实现时保持用户所提交的根帖作者/时间/正文，post 的 meta.id/mid/mblogid 均归一到请求 bid。`retweeted_status` 单独标为引用关系；不能用被转发帖、media object_id 或列表子项 id 覆盖 post nativeId。TV 则保留 video:FID，另核验映射目标帖和实际媒体。纯文本、图文、单视频、混合媒体按真实结构分类，原文只出现“展开/摘要”的场景须保留不完整状态。

## 根集成需要保持的具体边界

| 层 | 当前可核验的契约与接入要求 |
| --- | --- |
| input/types | 总控已增加平台联合及纯 helper `content-social-reference.ts`，input 已接入。适配器共同使用该逻辑，避免普通 parse 引入采集模块循环。只有被批准支持的单帖/单作品路径建立 nativeId，用户名、uid、列表/搜索/直播不充当作品身份。 |
| 短链/路由 | `resolveContentInput` 已列入 v.douyin.com/t.cn，createInput 已接入纯 helper，acquireContent 已动态路由到两个适配器。`fetchPublic` 逐跳检查公网目标并丢弃跨 origin 凭证；应用还必须检查最终**对象类型和目标 ID**。已知但不支持的站内类型不能靠 acquireWeb 把登录/推荐文字保存为原内容。 |
| service/去重 | `contentIdentity` 使用 platform + nativeId，队列按同样键去重。短链第一次解析后把真实作品/帖子身份写回 job.input；TV 保留 video:FID，另记录并核验所映射帖子/媒体。重新保存同对象保持 contentId。不能因为别名字符串相同或下游视频 id 相同，就复用另一帖子原件。允许暂时存在两个短链任务，但不能生成两个不同身份的同一作品主版本。 |
| 恢复 | 总控已扩展新平台复用允许表，并要求微博正文覆盖已核验。冻结后按实际视频/图文/文章范围核验：已保存且原件 SHA 一致的任务，应能从正式 path/capturePath 补派生项，不重新依赖过期短链。新记录身份未确认、来源变化或原件不匹配时不可走缓存。 |
| 正文 | 直接保存经过身份校验的目标正文；长正文的明确展开信号与仅有摘要要区分。正文完整性未证明时写 warning/缺失状态；不能以 title、视频 description、登录提示、推荐内容或转发子对象替换完整根帖正文。标题可缩短显示，完整文字留正文。 |
| 媒体/探测 | 可复用已有 yt-dlp 元数据受限调用模式，但字节继续通过 publicHttpUrl/savePublicAsset 等现有下载边界。元数据 id/extractor/type/entries 必须验证；只支持单视频时，不从不明 playlist 盲取第一项。退出非零、超时、取消、输出截断、空/无效文件或 ffprobe 未验证均不能登记 saved。无音轨的真实视频应如实登记音轨 unavailable，不虚构 ASR。 |
| 存储 | 正式清单继续使用稳定 assetId、capturePath、真实 bytes/SHA 和来源/处理证据，耐久检查点后才报告取得。重试保留已验证内容；新媒体不匹配时不得把旧派生稿恢复 saved。staging 清理仍由既有维护锁和正式覆盖验证处理，不新增按扩展名/目录名删除。 |

以上是针对当前接口的接入条件，不是把所有可能的平台故障列为阻塞。最终只对冻结代码实际违背这些条件且可复现的项目提出修复要求。

## Cookie 与调用边界

- 总控已接入新平台登录类型、CLI/UI 和专用 Cookie 保存。后续核验其使用应用内独立 `.content-profile/douyin`、`.content-profile/weibo`，仅在用户调用入口后操作；会话/验证限制须明确，不借用其他站点或默认浏览器状态。
- yt-dlp 保持 ignore-config/no-config-locations/no-plugin-dirs、显式 extractor、无搜索/主页/推荐遍历；Cookie 只能来自相同平台的应用专用安全文件，检查祖先/普通文件/大小，拒绝默认 cookies-from-browser、默认 profile 和跨平台 jar。媒体下载不要把站点 Cookie 无条件带给任意 CDN 域名。
- 元数据 HTTP 请求也受总期限、取消、响应上限和明确站点/API 控制；ffprobe/ffmpeg 只探测本地文件、限制协议。yt-dlp 的外部进程请求不会自动继承 fetchPublic 的 DNS/重定向策略；复用现有“有限元数据、媒体字节受控下载”的模式，不能因引入提取器而放宽媒体目标地址。
- 官方 DouyinIE 缺少 detail 时可能给出需要新鲜站点 Cookie 的错误；它不等于所有网络故障都证明必须登录。应区分 missing_dependency、login_required、unavailable 和 failed，200 空 JSON/验证页面也不能 saved。[官方错误分支](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/tiktok.py#L1411-L1422)
- 原始 Cookie、授权头、签名媒体 URL 不写进正文、coverage、公共 CLI 或日志。已有 publicValue 对结构化字段的过滤，不等于任意写到 source JSON 文件里的原始元数据也会被过滤；只持久化所需安全字段，内部下载参数留在短暂上下文。

## 冻结后的最小差异验收

等待总控给出实现冻结后，仅针对新增差异检查以下有界夹具，不测试随机真实页面或大量抓取：

1. 两平台规范长链、短链落到正确单对象、登录/主页/站外落地、不安全重定向；原 ID 与提取器返回另一个 ID 时拒绝混存。
2. 上述三组 bid/mid、大小写区分、全数字歧义、TV oid 不等于 mid；移动端和桌面同帖去重；转发根/子帖、图文/多视频子项身份不混。
3. 纯文字、图文、单视频、转发、长正文请求失败：正文、图片与视频各自状态准确，摘要不 completed。
4. 专用 Cookie 可用/缺失/链接文件/跨平台文件、元数据含 Cookie/签名 sentinel：不读取默认 profile，不在持久结果泄露。
5. 非零退出、空/截断 JSON、错误 extractor/type/entries、媒体伪文件、探测缺失/失败/取消：保留原因且无假 saved；合法原件恢复后仍不破坏来源证据与 staging 回收。

本阶段实际验证只有官方源码查阅、三组 bid/mid 纯计算和 contentStatus 的三个纯函数分支；没有测试冻结实现或真实平台可用性。后续差异审查结论将追加在本文件，保持唯一记录。

## 抖音已成型模块只读审查：2 项 P2

总控允许在最终冻结前先审查已成型的 `content-douyin.ts`。以下复现期间源码 SHA-256 前后一致：`037ee8dc7d9da108d025ce397d7189fa209345015cc34a722b65fd32eda5b806`。没有修改代码或新增测试文件；所有 HTTP/DNS/yt-dlp/探测均由临时夹具替代，无真实页面或账户访问。

### D1 / P2：正文和标题关键词误伤合法作品（最终冻结版已修复）

定位：[content-douyin.ts:176](../../src/content-douyin.ts#L176)、[content-douyin.ts:177](../../src/content-douyin.ts#L177)。

代码对整个可见正文的“安全验证/滑块验证码”和整个 title 的“登录/verify/captcha”等词直接判 login_required，然后才解析带精确 aweme_id 的目标状态。

两个普通作品夹具均带合法、ID 匹配且有完整说明/媒体地址的 RENDER_DATA：其一正文仅是“本期讲解滑块验证码和安全验证原理”，其二 title 仅是“登录页交互设计 - 抖音”。两者实际都只请求页面一次、没有进入媒体下载或元数据 fallback、markdown 为空、login_required=true。正常作品在安全/开发话题中使用这些词，即被阻断。

现有“legitimate work description mentioning captcha”用例把词放在会被移除的 script JSON 里，没有覆盖可见正文和正常标题，所以仍通过。

建议结合精确目标作品数据与真正验证页/表单/跳转证据作判断，避免将任意正常标题/正文中的话题词单独当作验证墙。保留无目标数据的实际验证码页面拦截；回归同时覆盖合法可见正文、合法标题、真正验证码页。

### D2 / P2：description 缺失时用 title 冒充完整原说明（最终冻结版已修复）

定位：[content-douyin.ts:140](../../src/content-douyin.ts#L140)、[content-douyin.ts:182](../../src/content-douyin.ts#L182)。

元数据 fallback 的 description 缺失分支取 info.title；后续直接写 markdown 并标记 `saved: exact-work original description`。这使可能截短的标题被当成原文完整保存，绕过新 body 完整性检查。

隔离元数据含正确作品 id、Douyin extractor、title、19 秒时长及媒体格式，但**完全没有 description**。实际结果：视频 saved=true，markdown=`TRUNCATED_TITLE_ONLY`，body coverage 为 saved。媒体可用不能证明完整原说明可用。

建议 title 仅用于显示标题，正文只使用实际取得的完整 description/精确作品 desc；缺失时正文及 body 完整性状态如实保留，已验证的视频仍可保存。回归应断言缺失/null description 时不把 title 写成原文、body 不标 saved。

### 本轮有界验证

实际独立运行抖音五个既有定向用例：身份错配、受限元数据 fallback、专用域 Cookie 不外发到媒体、预算/预先取消、现有验证码描述场景，**5/5 通过**。另外在 probeMedia 返回前触发取消，结果无 saved 资产且原因正确为取消。C1 的明确 unavailable body 夹具已返回 partial。

这些通过的边界没有覆盖 D1/D2 的具体输入；两个 D1 变体和一个 D2 变体已由实际 acquireDouyin 路径复现。没有因静态猜测追加 Cookie、身份或取消阻塞项，也没有将模拟探测算作真实视频验证。

## 微博已落盘模块只读审查

本轮三组夹具执行前后源码 SHA-256 一致：`6edd7c4e867781c7be3b053de115c93394560f453af477cf63eb1998bc1f4dd4`。全部使用专属临时目录和 requestJson/fetch 注入；没有真实请求或实际 Cookie。控制组普通目标正文返回原文、没有 login_required，contentStatus=completed。

### W1 / P2：对整个 JSON 响应做验证码关键词检测（冻结版已修复）

定位：[content-weibo.ts:171](../../src/content-weibo.ts#L171)。

officialRequester 在 JSON.parse / exactPost 身份核验之前，对 result.text 整串匹配“验证码/安全验证”。因此目标帖 text_raw 只要包含这些正常话题词，也被当作验证页。

同一合法 mblogid/idstr、同一 HTTP 200 JSON 结构：text_raw 为“完整普通正文”时单次请求成功；改成“本期讨论验证码的安全设计”时两次接口尝试均被拒绝，markdown 为空且出现 login_required。不是推荐内容，也没有验证表单或错误响应。

建议先区分并解析合法 API JSON，结合接口错误/登录跳转/实际 HTML 验证页证据分类；不将正文值中的词语当作验证墙。回归需走真实 officialRequester（deps.fetch 注入），仅使用 requestJson 注入会跳过此分支。

### W2 / P2：长文提供矛盾身份时，undefined 被当成无身份而放行（冻结版已修复）

定位：[content-weibo.ts:232](../../src/content-weibo.ts#L232)。

长文校验仅在 postBid(data) 有值且不匹配时拒绝。postBid 在“完全没提供身份”和“提供了无效/互相矛盾的身份”两种情况都返回 undefined；后者因此绕过校验。

复现：目标根帖身份正确且标 isLongText；长文响应 data.mblogid 为请求 bid、data.idstr 却为另一个官方夹具 mid，longTextContent 为固定错误标记。实际错误长文被写入 markdown，coverage.body=`saved: full post text`，contentStatus=completed。根帖 exactPost 对相同矛盾会拒绝，但长文分支未保持该约束。

建议区分“没有身份字段”和“身份字段存在但无效/不一致”。存在字段时必须全部归一一致且匹配目标；已知不可信长文保留摘要/不完整状态。总控已明确要求此修复，本报告记录当前复现而不重复扩大方案。

### 总控已安排的其余核验

总控已要求收紧短视频时长容差至 0.5s/3%，并要求探测失败不覆盖 stage 旧好文件、通过独立 transaction 再原子提交；本次没有把这些待处理项另写成未经执行的新发现。D1/D2 已由总控交抖音实现者修复。新模块尚未冻结，待冻结信号后复核修复和关键差异，再给最终结论；本阶段不能因五项既有抖音用例通过或 C1 已修就认定整体验收完成。

阶段收尾已看到抖音源码更新为 `6ec75b307530554a294ae8b992946d07adae190751ef76ba292acb24eca29ea3`；D1/D2 上述失败证据对应旧 037ee8… 快照，尚未把更新后的实现判为通过或仍失败。微博复现版本仍为 6edd7c…，新增回归已出现，等待实现者完成并冻结后统一复核。

## 微博第一次冻结版复核

总控明确给出冻结信号后，本次审查源码为 `ed246f822652461f8197853e0a195dbd84cfee12e180b519d9034feabbf4692f`，测试文件为 `fa62b33acb6d7c0a0fb0bfe983760a02dca86978f0071a8aa6ff4d7082c05b18`。独立运行 `tests/content-weibo.test.ts`：**17/17 通过**，复现夹具前后源码哈希相同。

- W1 原“正文含验证码”夹具：保留完整正常正文，login_required=false，状态 completed；已修复。
- W2 原矛盾 mblogid/idstr 长文夹具：错误正文没有接受，保留摘要，body=unknown，状态 partial；已修复。`boundText` 已区分没有声明身份和声明身份无效/冲突。
- 已核对独立 `.weibo-downloads/<UUID>` transaction：下载与探测在独立目录完成，校验及取消检查后再 atomicReplace；坏图片、2 秒截断视频的原有好文件保留用例通过。时长容差已为 0.5s/3%。
- 默认 ffprobe 已强制 mov，file/pipe 协议及外部引用禁用用例通过。总控另外提供实际 2 秒 H264/AAC / 伪装 playlist smoke 证据；本审查没有重新生成或把 mock 探测当作真实平台媒体取得。
- TV video:FID 和指定媒体、转发原博排除、正常访客 JSONP 仅按数据解析、取消保留已完成检查点等定向用例通过。

### W3 / P2：host-only Cookie 被扩展到子域（重新冻结版已修复）

定位：[content-weibo.ts:139](../../src/content-weibo.ts#L139)、[content-weibo.ts:150](../../src/content-weibo.ts#L150)、[content-weibo.ts:157](../../src/content-weibo.ts#L157)。读取时忽略 Netscape 第 2 列 TRUE/FALSE，保存 Cookie 没有 hostOnly 信息；匹配统一接受 hostname.endsWith(domain)，Set-Cookie 未声明 Domain 的 host-only 语义也未保留。

只使用专属临时 `.content-profile/weibo/cookies.txt`，放一条**有效且未过期的合成** `weibo.com / FALSE / Path=/ / Secure` Cookie。假响应把根 API 引向合法 passport.weibo.com 访客流程；在完全没有第三方或真实账户的情况下，实际请求记录为：

| 请求 host | 携带该 host-only Cookie |
| --- | --- |
| weibo.com 初次 API | true，符合作用域 |
| passport.weibo.com genvisitor | **true，应为 false** |
| passport.weibo.com visitor | **true，应为 false** |
| weibo.com 重试 API | true，符合作用域 |

该 Cookie 的 FALSE 标志不包含子域；同属微博的子域也不能自动继承 host-only Cookie。[官方 Netscape Cookie 文件列定义](https://curl.se/docs/http-cookies.html)明确第 2 列决定是否包含 subdomains。这里没有发生默认 profile 或跨平台读取，但现有匹配放宽了应用自己 Cookie 的域约束。

建议保留 Netscape includeSubdomains / hostOnly，以及响应 Set-Cookie 是否显式声明 Domain：精确 host 可匹配，只有真正 domain Cookie 才允许子域。回归需同时验证 FALSE host-only 不到 passport、TRUE domain Cookie 可到适用域、访客初始化仍正常；不要通过默认浏览器导入解决。

本冻结版原报 W1/W2 已关闭，新增 W3 待实现者处理后重新冻结。抖音待总控最终冻结信号；没有因 17 项通过而给出两个平台的最终整体通过结论。主控真实样本仍仅 login_required、未取得正文/媒体，这是平台样本状态，不列为新代码缺陷或成功证明。

## 首次最终冻结信号后的复核（W3 当时未关闭）

本次实际只读验证覆盖以下固定快照，原反例重放前后四份源码 SHA 相同：

| 文件 | SHA-256 |
| --- | --- |
| `src/content-douyin.ts` | `b02a51760295e2c3f36e00d4fdcfe2582424997e5da783ee4766df62912c656e` |
| `src/content-weibo.ts` | `ed246f822652461f8197853e0a195dbd84cfee12e180b519d9034feabbf4692f` |
| `src/content-input.ts` | `1087b5b8cf06c8480a14654a43494bd8cb53ebfbfe167834e8819da8af3661dc` |
| `src/content-network.ts` | `a372f088284d0d0e937e763ce41698dc26efc95e4844f74bf044b2bab9ae2c78` |
| `src/content-social-reference.ts` | `be9b8a810911ab789b7ad401c451afc11b5977a9dd7d7d8c275bceaa50a57e08` |

### 已关闭与仍未关闭

| 项目 | 最终复核结果 |
| --- | --- |
| C1 不完整正文误 completed | 同一纯函数反例已为 partial，关闭 |
| D1 普通可见正文/标题误验证码 | 重放两个旧失败夹具，均保留原始说明、video saved、login_required=false，关闭 |
| D2 title 冒充 description | 重放无 description 夹具：真实验证流程下视频可保存，markdown 为空、body=unavailable；title 只作标题，关闭 |
| W1 JSON 正文含验证码误登录 | 冻结版正常 JSON 原文保留，login_required=false，关闭 |
| W2 矛盾长文身份放行 | 错误扩展正文未接受、保留摘要并 partial，关闭 |
| W3 host-only Cookie 扩到 passport 子域 | **仍失败**。最终冻结版微博仍是原 W3 的 ed246f… 快照，重放合成 FALSE Cookie +正常访客流程，`hostOnlySentToPassport=true`；需修复后重新冻结和复核 |

最终实际命令只运行 `content-douyin.test.ts`、`content-weibo.test.ts`、`content-social-input.test.ts`，**17 + 17 + 9 = 43/43，通过，无跳过**；没有全量、build 或 typecheck，也没有修改源码。该计数包括默认探测参数、MP4 接受和伪装 playlist 拒绝的定向用例；实际 2 秒 probe smoke 沿用总控的独立证据，没有据此声称平台 CDN 或登录样本已成功。

### 新短链边界

- 已核对 `fetchPublic` 只把逐跳已检查的 URL 链保存在 Response 弱映射，读取返回副本；没有把整条链序列化到正文/清单或新增日志。公网/DNS/重定向检查与跨 origin Cookie/授权头删除仍执行。公共输出继续使用既有 publicValue，私有可用输入 URL 与 canonical 的职责维持原契约。
- `t.cn → 精确帖子 → visitor` 与 `v.douyin → 精确作品 → 登录/验证` 的夹具均恢复先前精确目标，不把后来的验证页当 web 正文；只处理两个新短链域的该恢复分支。
- 微博短链只见 visitor/登录且没有任何帖子 ID 时明确拒绝；不同已声明帖子/作品 ID 的后续跳转明确拒绝。TV 保留 video:FID，帖子映射及媒体绑定继续由适配器核验。
- 上述 3 个新增回归及既有规范 URL、别名、MID/BID、无身份抖音验证落地、无关/私网重定向，共 social-input 9/9 通过。没有访问实际短链。

### 公共接入与实测边界

types/helper/input、acquireContent 动态路由、专用登录 Cookie 保存、服务缓存、UI/MCP 已按总控提供的冻结契约接入；本次未发现这些具体差异中新加的身份混存问题。正文不完整、图文未覆盖、探测失败和取消不会因“工具退出成功”就自动报告完整取得；事务/强制 mov 探测的已列用例通过。

真实平台样本仍应按总控/实现者的结果记录：微博样本 login_required，未取得正文或媒体；本审查没有重复真实请求。总控的实际 MP4 probe smoke（2 秒 H264/AAC 有效、伪装 playlist 拒绝）属于本地探测证据，和平台可用性分开。385 正式文件/queue 不变由总控维护证据，本对话只操作临时夹具、唯一审查报告。

该快照的交接结论为 W3 未关闭、其余原报问题已关闭；总控随后修复并重新冻结，当前结论由下面复核取代。43 项通过保留为该快照的定向证据，不代替 W3 精确反例。

## W3 重新冻结后的最终结论

总控修复后本次独立核验的 `src/content-weibo.ts` SHA-256 为 **`f9addf79b6e110868b2f19002a4668283779cf14209c16660813c23edccc4602`**。抖音仍为 b02a51…、input 为 1087b5…、network 为 a372f0…，与前次冻结快照相同。新增 `content-social-cookie-scope.test.ts` 为 `680d2f7a5eaed11fb0651ae3cc0226b0263e0feb60dccfa4ad09d7dbe41f16f2`。

- Netscape 第 2 列已保留为 hostOnly：FALSE 精确 host，TRUE 才允许子域，并拒绝无效布尔列。
- 响应 Set-Cookie 默认 host-only；显式 Domain 才转 domain Cookie。Path 未声明或无效时按请求目录默认，匹配检查路径分段边界。
- 独立运行新增 Cookie 作用域 4 项与短链输入 9 项：**13/13 通过，无跳过**。覆盖 FALSE/TRUE、响应无 Domain/有 Domain、路径边界/default Path、抖音已有正确域/路径正控制，以及前述短链恢复和不同身份拒绝。
- 再用原 W3 的真实调用路径重放两种合成 Cookie，前后源码 SHA 相同：

| Netscape includeSubdomains | 根 host 正常收到 Cookie | passport 子域收到 Cookie | 正常访客流程完成 |
| --- | --- | --- | --- |
| FALSE | true | **false** | true |
| TRUE | true | true | true |

原反例现为 green，domain Cookie 正控制也通过，W3 已关闭。抖音 D1/D2、微博 W1/W2 及 C1 的前次修复结论仍有效，没有因修复 hostOnly 改写正文、身份或媒体保存逻辑。

**本次只读审查无未关闭的 P1/P2，交总控统一验收。** 本阶段没有改源码、build、typecheck、全量运行或真实账号/平台请求，仅更新本报告和操作清理后的隔离夹具。总控已记录的第一次 421 验收与重新冻结后的统一检查应保留各自证据，不能用预期计数当实际结果。

真实样本边界保持：微博样本仅 login_required，未取得正文/媒体；抖音的代码/本地探测验证不等同于任意真实链接已可下载。总控真实 2 秒 MP4 probe smoke、正式 385 文件/queue 哈希检查，和本报告的模拟接口审查分别记录。

## 新增 Edge browser fallback：前置只读检查

用户随后要求两平台像小红书一样使用 Edge。总控负责新公共 helper 与测试，平台实现者接入各自模块，本对话仅更新此报告。开工快照中 `content-social-browser.ts` 尚未落盘，两个 Deps 尚无 captureBrowser，抖音 b02a51… / 微博 f9addf… 仍是上一版；**当前没有可执行的新浏览器实现，不能凭计划列出新 P1/P2 或宣布验证通过。** 未操作真实浏览器、默认 profile、实际账户、正式库或全量/构建。

### 已核实的接入位置

- 抖音当前页面非 2xx、最终页面身份不符或确认验证页，都会抛错后结束；元数据 fallback 仍是 yt-dlp。新的 Edge 入口需在适用失败出口之前介入，之后复用 extractDouyinWork / 元数据身份校验、描述完整性、受控下载及真实媒体探测；已有 HTTP 原文/视频成功时不因新增入口再抓或降级。
- 微博当前 getPost 两个官方接口都失败后结束；长文扩展失败则保留摘要/partial。新的 Edge 入口要保留这两种现有结果的区别，并把浏览器取得的数据重新交给 exactPost、boundText、TV FID 绑定和 saveVerified，而不能直接把 page/body 文本标完整。
- 当前专用登录也使用 `.content-profile/{platform}` 持久 Edge。已有 UI/CLI 会阻止正常 worker 活跃时登录，但 openContentLogin 内没有可见的应用级 profile lease；新增 helper 的并发策略需与同一专用登录入口协调。这是已观察到的接入条件，不把尚未实现的 helper 判为互斥失败。

### 总控给定公共接口

```ts
captureSocialBrowser(input: ContentInput, context: ContentContext,
  requests?: SocialBrowserJsonRequest[]): Promise<SocialBrowserSnapshot>
// request: {url, method?: "GET" | "POST", headers?, body?}
// snapshot: {finalUrl, html, responses: Array<{url, data}>, gated}
```

专用 profile 是 runtimeRoot 下该平台的应用目录。HTML/JSON 仅供本次内存解析，不持久化 Cookie 或未知原始响应；模块可通过 captureBrowser 依赖注入做隔离验证。本对话不会修改该公共接口或平台实现。

### 冻结后核对的三个具体流程

1. **目标与只读请求绑定。** 页面是当前单作品/帖子，捕获与有限请求仅取对应官方读端点；微博 POST 只应服务已绑定的 Component_Play_Playinfo 读取，不能因为请求类型允许 POST 就接受其他状态修改接口。metadata/url/body 中的 MID、BID、aweme_id、FID 仍按既有规范核验；推荐、头像、评论、其他 tab 的同域响应不能仅凭 hostname 混入。异常 finalUrl、不同 ID 或无精确目标数据时，无假 saved。
2. **HTTP 与 Edge 数据优先级。** 既有精确 HTTP 原文成功，captureBrowser 注入器应完全不调用；摘要缺全文、页面会话墙或元数据缺失时才使用适用 fallback。浏览器正常正文谈登录/验证码不重现 D1/W1；title 不冒充正文。gated 是诊断信号，不能覆盖已核验的原始内容；最终仍由精确主体/真实限制决定状态。浏览器数据错配、失败或探测失败时，旧 good asset 保留。
3. **profile 与退出边界。** 同平台的 capture/登录使用同一受保护 profile，避免两个入口同时操作同一持久会话；不读取默认 profile 或把 Cookie 手动扩大到其他 host。取消发生在 launch/goto/API/响应读取期间，必须只关闭本次创建的 context、释放本次 lease，不能杀掉用户已有 Edge 窗口或遗留资源。API 请求的 Cookie 继续尊重 host-only、Domain 和 Path；页面正常加载不等于所有后续请求都获得授权。

上述是对当前源码/明确接口的接入核对点，不是未经实现复现的阻塞清单。公共 helper 与平台模块冻结后，只用注入夹具核验实际差异，并把真正失败的 P1/P2 及证据追加在本文件；如果没有可复现问题则直接报告无阻塞。

阶段结论：前置检查完成，**尚无新增可复现 P1/P2**；新增 Edge 流程的单元结论和真实平台取得结果均待后续冻结/对应实测证据。此前已关闭的反馈保持关闭，不从上一版通过数推导浏览器 fallback 已有效。

## Edge 公共 helper 首轮实现：独立只读复核

本节取代前置阶段“尚无新实现”的状态，不取代尚未冻结的平台整体结论。总控通知首版落盘后，审查期间 helper 又加入目标 JSON 就绪通知、正常访客导航的有限读取重试，以及对中间 passport 页继续等待的处理；因此以下证据只绑定本次实际核对的版本：

| 文件 | SHA-256 |
| --- | --- |
| `src/content-social-browser.ts` | `edf82498f19477a9712d5c03d3c60980ff83af89f5fbf9782d1c9f6d9861ec0e` |
| `tests/content-social-browser.test.ts` | `54550504354cadd5af6c38f868149e84757a650c3e75bd567763219fbf10a1c4` |

独立运行 `node --import tsx --test tests/content-social-browser.test.ts`：**12 项通过、0 失败、0 跳过，退出码 0**；运行前后两文件 SHA-256 一致。前一 ed1b10… 版本也独立 12/12，通过后出现 passport 等待变更，已读完整新源码并对上表版本重新运行同一套定向测试。此前首版 11 项通过仅属于其当时实现，不混用计数。新增导航重试用例保留已观察的有效官方 JSON，并对被导航打断的主动读取作有限重试。

源码核对确认：专用 profile 固定在 runtimeRoot 的 `.content-profile/{douyin|weibo}`，同进程同路径互斥；主动请求限制数量、官方 HTTPS 读取端点、方法、body 和 header；显式 Cookie header 被拒绝，页面 fetch 通过浏览器自身 Cookie 作用域发出。被动捕获仅保留有界官方 JSON；gate 与 HTML/候选 JSON 同时返回，由平台适配器继续检查具体目标身份。helper 本身不宣称已取得全文或原媒体。

额外执行独占临时夹具，无源码/测试文件改动。夹具绑定前一 helper `ed1b107d4103688f0ce032c3a7d489f657ec2831e27acba8855f87eba3799076`，其取消/profile/route 逻辑在上表版本中未改变：

- 在 launch 返回之前取消：调用拒绝为 AbortError，返回的本次 context 被关闭一次，没有新建 page；相同 profile 随后可重新采集并正常关闭。
- 注入公网校验器、触发实际注册的 route 回调：正常 HTTP(S) 请求进入 continue；校验器拒绝的私网目标、带账号密码目标、file URL 进入 abort。该结果验证路由与校验器的接线，不冒充真实 DNS 或浏览器出站验证。
- 两项夹具前后 helper/测试 SHA-256 一致。夹具仅在系统临时目录创建唯一 `dwb-browser-review-` 根；递归清理前核对 realpath 的父目录和前缀，清理完成。

**本版本公共 helper 没有复现新增 P1/P2，可交总控继续集成。** 本对话未启动真实 Edge、读取实际账户/default profile、调用平台网络、写正式库或队列，未执行 build/typecheck/全量测试，仅更新本报告与使用已清理的 mock 临时夹具。

平台最终结论仍待接入冻结：审查时微博已出现 captureBrowser 适配，抖音仍在接入；不能将 helper 12 项通过推成两平台全文或视频保存成功。总控的早期 `logs/social-edge-20261014/weibo-browser.json` 已读回：匿名样本 FBqgOmDxO 页面 BID 匹配、gated=false，观察到三个 statuses/show 响应结构；随后 owner 明确该早期链接的 UID 1866405545 错误，不能证明该作者路径可稳定使用。准确链接和新下载证据见本节后的更新，不能用早期截图/JSON 取得推断原视频保存。

## 微博 Edge 接入复核与跨平台测试阻塞

总控要求继续复核微博接入，并提供匿名真实下载记录。此次核对的微博源文件 SHA-256 为 `5fb083179215ae663008888fc6e97e1384daeb7c059be8e19de8f21ff7a23adf`，模块测试为 `ba268c4053e10f97b79fec5b9d6fd4e6ac411d263beb06a9fa7c44a8b43bead0`，公共 helper 为上节 edf824…。

执行 `node --import tsx --test tests/content-weibo.test.ts tests/content-social-cookie-scope.test.ts`：微博 **30/30 通过**，Cookie 文件 **3/4 通过**，合计 **33/34、退出码 1**。上述三文件运行前后 SHA-256 相同，不能把组合运行称为全通过。微博模块用例默认注入 captureBrowser，因此其30项没有实际浏览器依赖；覆盖 HTTP 已成功时不启动 Edge、精确目标/API/FID、长文与原文保真、gate 不覆盖已核对主体、两个取消时点、脱敏错误和旧好文件保护。Cookie 的失败项属于下面旧抖音用例。

### T1/P2：旧 Cookie 用例走入了默认 Edge 回退

定位：`tests/content-social-cookie-scope.test.ts:54-55`，测试 SHA-256 `680d2f7a5eaed11fb0651ae3cc0226b0263e0feb60dccfa4ad09d7dbe41f16f2`。它只 mock Node fetch/DNS、返回 HTTP 验证页，然后不带 deps 调用 acquireDouyin；新增源码 `src/content-douyin.ts` 在 HTTP 验证后默认调用 captureSocialBrowser。此次抖音源文件快照 `78764022fbc75e9cbe6e54b40f9a7b719f69183723e7db29cf87bfa29d3fe480`，尚未由 owner 冻结。

实际失败是第55行 `assets.some(status === "login_required")` 为 false，用例耗时约4.76秒。这说明旧测试的依赖隔离和状态预期未随 browser fallback 更新，**不是证明 Cookie 域/Path 逻辑回退**。它还可能尝试创建真实 Edge context，Node fetch/DNS mock 不能覆盖浏览器网络。审查员运行组合测试前漏查该跨平台旧用例；发现后没有再运行默认 browser 的路径。用例使用新建系统临时 `social-cookie-scope-` 根及合成 Cookie，由现有 after 回调清理；没有使用实际账户/default profile 或正式库。不能声称本次组合运行绝对没有尝试启动浏览器。

建议总控在此用例显式注入 captureBrowser，返回当前目标、gated=true、responses=[]，让原 Cookie 作用域用例继续保有独立断言；需要 browser 状态覆盖时另用对应模块注入测试。本对话不会修改总控的共用测试文件。统一验收前需对修正后的用例复跑并关闭 T1。

独立的同构修正夹具已通过：只增加 gated=true 的 captureBrowser 注入，HTTP fetch/DNS/外部工具均显式 mock；验证浏览器注入恰好调用一次、结果 login_required、domainCookie/wwwHostOnly/workPath 存在、rootHostOnly/pathPrefixOnly 不发送。抖音源码前后仍为787640…，本次独占 `dwb-cookie-review-` 临时根已在 realpath 归属检查后清理。它确认修正方向可保留原 Cookie 断言，**不等于共用测试 T1 已修复**。

### 微博冻结与真实证据更新

owner 的最新交接已读回：微博源码/测试冻结为本节开头的5fb083… / ba268c…，与本次30项通过版本一致；没有复现微博接入实现的新增 P1/P2。helper 已核对 edf824… 的正常访客等待和有限导航重试，12项定向通过版本一致。

已读 `logs/social-edge-20261014/weibo-download-bootstrap-fixed.json`，记录匿名准确链接样本 FBqgOmDxO：body full、acquisition dedicated Edge official JSON、无警告、1份原视频 saved，**1,810,094字节、SHA-256 `17f407a0e005d2ab73b276e5d5e1d8345f89fecab7f9e521648f252738575aca`、总耗时3,568毫秒**。总控和 owner 交接说明此次使用 `https://weibo.com/5926682210/FBqgOmDxO`，真实 ffprobe 流/时长通过，样本随后清理且正式库未写入。本审查只读回记录和源码，没有再次下载或复跑该样本，也没有把耗时当视频时长。早期纯 HTTP 的 login_required 与错误 UID 的 Edge 失败保留为历史证据，不再当作当前准确链接匿名下载仍失败的结论。

本轮交接：公共 helper 和微博模块无新增实现阻塞；**共用 Cookie 回归 T1 仍须总控修正后关闭**；抖音仍待 owner 冻结后审查。未修改任何源文件/共用测试或实施发布。

## Edge 最后冻结快照：抖音与公共 helper 复核

总控随后给出抖音24项已通过、微博已冻结及公共 helper 新增第13项回归的最终审查要求。本次没有扩展功能/平台范围，只核对这三份现有实现及其定向用例。冻结快照：

| 文件 | SHA-256 |
| --- | --- |
| `src/content-douyin.ts` | `78764022fbc75e9cbe6e54b40f9a7b719f69183723e7db29cf87bfa29d3fe480` |
| `tests/content-douyin.test.ts` | `1bbf825098cda1c9dc73b0ce7207f4940234f2f4cf23bc23010fb1257e76ad1e` |
| `src/content-weibo.ts` | `5fb083179215ae663008888fc6e97e1384daeb7c059be8e19de8f21ff7a23adf` |
| `tests/content-weibo.test.ts` | `ba268c4053e10f97b79fec5b9d6fd4e6ac411d263beb06a9fa7c44a8b43bead0` |
| `src/content-social-browser.ts` | `edf82498f19477a9712d5c03d3c60980ff83af89f5fbf9782d1c9f6d9861ec0e` |
| `tests/content-social-browser.test.ts` | `d1a0db4a02ff07f10a66d263abc909bb6ad16816a9709bc8661c67daf922f274` |

独立运行 `node --import tsx --test tests/content-douyin.test.ts tests/content-social-browser.test.ts`：**37/37（抖音24 + helper13）、0失败、0跳过、退出码0**；四文件运行前后 SHA-256 一致。测试文件已先检查默认 captureBrowser/launch 注入，未重跑上节未隔离的 Cookie 用例；两个既有本地 ffprobe 正/负例正常运行，不作为真实抖音下载证据。加上前节同冻结版微博30项，三个模块共67项在本次独立定向运行中通过，**不是全项目67项或一次67项组合运行**。

新增第13项直接执行 helper 的等待判定：visitor.passport.weibo.cn 的 `/visitor/visitor` 中间页不抢先 ready；最终 gate 分类仍保留。抖音接入已核对 HTTP拒绝/壳页/缺视频链接时进入有限官方 detail 读取，exact ID与接口参数/端点共同限制候选；只使用结构主体，DOM video src 不作为原视频来源。浏览器补足时保留原有说明/作者，不用标题补正文；已完整HTTP目标不打开 Edge。gate 不抹去已核对目标；失败、身份错误、无媒体、取消均不将无效内容原子替换到旧文件上。原下载/probe/duration/hash 入口继续复用。

**最终实现审查结论：三份冻结实现未复现新增 P1/P2，可交总控统一验收；仅共用旧测试 T1/P2 尚未关闭。** 本对话没有修改实现、build/typecheck/全量测试、操作真实账户或写正式库；本次新增37项均由 mock 隔离浏览器。此前额外 Cookie 组合运行可能尝试默认 Edge 的边界及其失败证据仍按T1节如实保留。微博实际成功已有主控记录；抖音实际媒体结果由总控继续验证，本次24项不替代该证据。

## T1 修复后的最终交付结论

总控修复共用测试后，已读源码确认抖音 Cookie 用例显式注入目标匹配、gated=true 的 captureBrowser，另有 runTool mock；断言 capture恰1次及全部旧域/Path断言保留。新 `tests/content-social-cookie-scope.test.ts` SHA-256为 **`8d1473453623d34f8b0fc11c262f19b28e05515f92df32ada11a1cbc73253b00`**。

本次独立执行 `node --import tsx --test tests/content-social-cookie-scope.test.ts`：**4/4通过、0失败、0跳过、退出码0**。三份实现仍为上节787640…/5fb083…/edf824…，源码和该测试运行前后SHA-256一致。旧失败项现在约8.55毫秒；默认浏览器路径已由注入替代，原反例和新增调用次数断言均为green，**T1/P2已关闭**。之前33/34的红色证据保留，不改写成历史全通过。

抖音真实记录 `logs/social-edge-20261014/douyin-download.json` 已只读回：匿名准确单作品7691241374158556466取得原始说明、1份原视频 saved、无警告；**4,775,833字节、SHA-256 `406e29ea3e8f2c03be3b244be34273607e61de20f1b017404040a08f19dc23ad`**，coverage标明元数据26.539秒与实际26.538685秒核验一致，总耗时11,738毫秒。该次下载/真实ffprobe由总控执行，本对话没有复取媒体。微博桌面/移动同一媒体哈希与字节数由总控另记录，不能推成任意链接均可取得。

**本次独立审查最终无未决P1/P2，可交总控统一验收。** 三个模块及修正后的Cookie用例共71项在不同定向运行中通过（24+30+13+4），不代表全项目或一次71项组合运行。未修改实现/共用测试，未构建、全量运行、提交、发布或写正式库/队列。主控的最后build/typecheck/全量及正式文件/队列完整性结果由其独立验收记录确认。
