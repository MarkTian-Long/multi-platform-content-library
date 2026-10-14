# 用户微博与抖音样本续验

本节承接用户在源码同步后补充的最终样本。实际编译CLI以原件模式执行入队、专用Edge采集和正式入库，旧资料保留；媒体及原回执只留本机，不随GitHub源码上传。

| 用户来源 | 实际内容 | 保存与核验 |
| --- | --- | --- |
| [微博QrPhU2TWO](https://weibo.com/6408047488/QrPhU2TWO) | 图文帖“出片日”，3张原图 | 正文、3个JPEG分别2,560,810/3,129,367/2,681,337字节，身份/字节/SHA与阅读页核验通过，completed |
| [抖音分享链接](https://v.douyin.com/Nx6Q2IX1ibQ/) | “吃光超市，赢100万美元”上集 | 视频227,954,243字节，元数据1197.688秒、实际1197.687596秒，完整FFmpeg解码0；描述与原件已保存 |

两条入队及worker退出0，worker35,999ms。本次是原件模式；现有小红书/视频号的文字稿继续保留，新样本未增加本地派生产物。此前12个任务对象未变，旧595个文件除queue.json增加这两条任务外大小/SHA均不变。

抖音首次已完整下载但条目partial：本实现没有采集原生评论/字幕，coverage却写not_attempted，使视频状态检查把它当成缺失。修复为明确not_supported；旧已核验抖音原件复用时仅归一这些旧字段，已有saved或其他状态保留。

两项新增反例分别覆盖新采集与旧原件复用，在旧代码均得到partial而非completed。修复后，原件模式completed，full模式仍要求派生产物；损坏源/身份错配/取消边界保留。定向41/41及独立41/41通过，独立检查四文件SHA不变，范围内无未决P1/P2。

实际新编译CLI禁用下载器后对刚保存的视频重试：work1,857ms，completed，原视频SHA仍为`4bfd1581aeac60b6a398cad065e21f83be2f435c041e386f57d8998dd77bab7b`；该哨兵证明未重新调用下载器，复用来源另由隔离测试的fetch0及禁止浏览器夹具核验。临时哨兵已移除。最终全量581/581、0失败/取消/跳过、19,030.254ms，类型/构建0，150源码检查前后SHA相同。

本机证据在`logs/platform-coverage-20261014/`：`user-social-samples.json`、`user-social-status-red/green.log`、`user-social-retry.json`、`user-social-full-tests.log`、`user-social-source-before/after.json`。当前源码和脱敏验收说明继续同步既有GitHub main；个人资料、账号、日志和恢复ZIP不上传。
