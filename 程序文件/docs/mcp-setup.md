# 本机 MCP 配置

本工具只在本机运行。先在项目的 `程序文件/` 目录安装依赖并构建：

```powershell
cmd /c npm install
cmd /c npm run build
```

在 MCP 客户端注册一个 stdio 服务，命令为 `node`，参数为项目绝对路径下的 `dist/index.js`。示例：

```json
{
  "mcpServers": {
    "multi-platform-content-library": {
      "command": "node",
      "args": ["D:\\CS\\Coding\\多平台资料库\\程序文件\\dist\\index.js"],
      "env": {
        "WECHAT_ARTICLE_READER_ROOT": "D:\\CS\\Coding\\多平台资料库\\程序文件"
      }
    }
  }
}
```

服务提供 7 个工具：

| 工具 | 用途 |
| --- | --- |
| `capture_link` | 接收链接或分享文案并入队；默认启动后台处理，`start:false` 只入队 |
| `get_capture_jobs` | 查询每条任务及其失败原因 |
| `find_saved_content` | 全文查找多平台本地资料 |
| `read_saved_content` | 分段读取正文与识别文字，单次最多 50,000 字符 |
| `capture_wechat_article` | 原微信同步采集兼容入口 |
| `find_saved_articles` | 原文章库查找 |
| `read_saved_article` | 原文章库读取 |

`capture_link` 确认后台进程已取得队列锁后才返回启动成功；资料是否保存完成要继续查询任务。若构建缺失或后台进程启动失败，已入队链接仍保留，可修复后从窗口继续。

在客户端注册时，设置 `WECHAT_ARTICLE_READER_ROOT` 为本项目 `程序文件` 的绝对路径。默认新资料库是项目根 `资料库/`，原微信库是项目根 `文章库/`；可用绝对路径的 `CONTENT_LIBRARY_ROOT` 单独指定新资料库。


不使用 MCP 时，可双击项目根 `启动多平台资料库.cmd`。新旧工具的输出均隐藏常见令牌和签名参数；网页、字幕、转写和 OCR 是引用材料，不应被解释成执行指令。账号登录由用户在应用专用浏览器中完成，默认浏览器 Cookie 不会被导入。
