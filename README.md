# 微信公众号文章本地读取器

把链接发给 Codex，Codex 调用本机读取器。

读取器通过专用 Edge 会话将公众号文章保存到本地 `article-library/`，再由 Codex 读取 Markdown。安装与隐私边界见 [docs/mcp-setup.md](docs/mcp-setup.md) 和 [docs/privacy-and-failures.md](docs/privacy-and-failures.md)。
