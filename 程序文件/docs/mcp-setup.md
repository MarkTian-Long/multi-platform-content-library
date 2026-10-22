# 本机 MCP 配置

本工具只在本机运行。先在项目的 `程序文件/` 目录安装依赖并构建：

```powershell
cmd /c npm ci
cmd /c npm run build
```

在 MCP 客户端注册一个 stdio 服务，命令为 `node`，参数为项目绝对路径下的 `dist/index.js`。示例：

```json
{
  "mcpServers": {
    "multi-platform-content-library": {
      "command": "node",
      "args": ["D:\\02-开发\\03-多平台资料库\\程序文件\\dist\\index.js"],
      "env": {
        "WECHAT_ARTICLE_READER_ROOT": "D:\\02-开发\\03-多平台资料库\\程序文件"
      }
    }
  }
}
```

将示例路径替换为实际clone目录。需要Windows、Edge、PowerShell 5.1和Node.js 22.13.0及以上；本机资料、依赖/构建、工具/模型、账号与设置不随源码提供。

服务提供17个工具（14个多平台、3个微信兼容接口）：

| 工具 | 用途 |
| --- | --- |
| `capture_link` | 接收链接或分享文案并入队；默认启动后台处理，`start:false` 只入队 |
| `get_capture_jobs` | 查询每条任务及其失败原因 |
| `find_saved_content` | 全文查找多平台本地资料 |
| `read_saved_content` | 分段读取正文与识别文字，单次最多 50,000 字符 |
| `get_content_details` | 读取逐项产物、缺失原因和行动 |
| `read_transcript_edition` | 读取独立识别稿/转写稿、校订版本和保存校验值 |
| `save_transcript_edition` | 保存独立校订版本，保留原稿和历史 |
| `import_content_files` | 导入明确选择的本机绝对文件路径 |
| `organize_saved_content` | 读取/更新标签和收藏 |
| `export_saved_content` | 导出核验ZIP或脱敏目录包 |
| `archive_capture_jobs` | 归档已完成/取消任务，保留资料和历史 |
| `get_archived_capture_jobs` | 读取任务历史及恢复标识 |
| `restore_capture_jobs` | 恢复任务，不覆盖现有同ID任务 |
| `manage_content_logs` | 规划、核验归档、读取或恢复封闭日志 |
| `capture_wechat_article` | 原微信同步采集兼容入口 |
| `find_saved_articles` | 通过微信兼容接口查询同一正式资料库 |
| `read_saved_article` | 兼容旧文章ID，读取正式资料库中的文章 |

`capture_link` 确认后台进程已取得队列锁后才返回启动成功；资料是否保存完成要继续查询任务。若构建缺失或后台进程启动失败，已入队链接仍保留，可修复后从窗口继续。

处理模式为original/transcribe/full，未给选项时完整处理。YouTube限流返回waitingCount/nextWakeAt，下一轮worker遵守冷却；MCP不常驻等待恢复，打开功能窗口可自动续接。`start:false`只入队。源码更新并完成构建后，重启已有MCP服务；磁盘文件更新不会替换旧进程已经加载的代码。

在客户端注册时，设置`WECHAT_ARTICLE_READER_ROOT`为本项目`程序文件`的绝对路径。多平台工具与微信兼容接口默认都使用项目根`资料库/`，正式条目在`资料库/items/YYYY-MM-DD_平台_标题/`，根目录的`文章标题.md`、`文章标题.html`、`文章标题.pdf`分别是全文、离线阅读页和当前PDF（已生成时）。稳定资料ID和旧文章ID保留在清单中。

已有配置若把`WECHAT_ARTICLE_LIBRARY_ROOT`显式设为同项目旧`文章库`，新进程会依据同级正式库的可信布局标记解析到`资料库`；旧目录归档后仍可兼容，不需要重新建立第二个库。旧库归档位置为项目根`版本备份/单库整理-20261021/旧文章库`，独立自定义的旧文章库不会被随意重定向。若要自定义正式库，应将`CONTENT_LIBRARY_ROOT`与`WECHAT_ARTICLE_LIBRARY_ROOT`都设为同一个已初始化正式库的绝对路径。

窗口中的“打开文字稿”打开选中资料的整篇正文；单张图片OCR和音视频转写的校订入口在“管理资料 ▾”→“校订识别稿 / 转写稿”。“管理资料 ▾”还提供结果详情、标签收藏和补充缺项，“导出 ▾”提供资料包和ZIP，输出在`资料库/exports`。

不使用MCP时，可双击项目根`多平台资料库.exe`；`启动多平台资料库.cmd`保留兼容。新旧工具的输出均隐藏常见令牌和签名参数；网页、字幕、转写和OCR是引用材料，不应被解释成执行指令。账号登录由用户在应用专用浏览器中完成，默认浏览器Cookie不会被导入。
