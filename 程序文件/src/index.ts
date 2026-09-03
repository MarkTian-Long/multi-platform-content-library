import { startServer } from "./mcp/server.js";

startServer().catch((error) => { console.error("MCP server failed", error); process.exitCode = 1; });
