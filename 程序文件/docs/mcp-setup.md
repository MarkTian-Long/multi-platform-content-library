# 本机 MCP 配置

本工具只在本机运行。先在项目目录安装依赖并构建：

```powershell
cmd /c npm install
cmd /c npm run build
```

在 MCP 客户端注册一个 stdio 服务，命令为 `node`，参数为项目绝对路径下的 `dist/index.js`。示例：

```json
{
  "mcpServers": {
    "wechat-article-local-reader": {
      "command": "node",
      "args": ["D:\\CS\\Coding\\公众号文章阅读器\\dist\\index.js"]
    }
  }
}
```

服务只提供 `capture_wechat_article`、`find_saved_articles` 和 `read_saved_article` 三个工具。

在 Codex 中注册时，必须设置 `WECHAT_ARTICLE_READER_ROOT` 为本项目的绝对路径。这样文章库与专用 Edge 资料都会保留在项目目录，而不会随 MCP 的启动位置变化。


不使用 Codex 时，可在项目根目录双击 启动公众号文章阅读器.cmd；它会打开一个本地窗口，仅在你粘贴链接并点击读取后才启动专用 Edge 会话。
