import fs from "node:fs/promises";
import { atomicJson, containedFile, writableFile } from "./content-library.js";
import { privateAddress } from "./content-network.js";

export const DEFAULT_WECHAT_CHANNELS_PARSER = "https://v.mtotech.com/api/resolve";
export interface YoutubeNetworkSettings { mode: "auto" | "direct" | "proxy"; proxyUrl?: string }
export interface ContentSettings { schemaVersion: 1; wechatChannelsParser: { enabled: boolean; endpoint: string; proxyUrl?: string }; youtubeNetwork?: YoutubeNetworkSettings }
const FILE = ".content-settings.json";
const defaults = (): ContentSettings => ({ schemaVersion: 1, wechatChannelsParser: { enabled: false, endpoint: DEFAULT_WECHAT_CHANNELS_PARSER } });

export function parserEndpoint(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || privateAddress(host) || /(^|\.)(localhost|local)$/i.test(host)) throw new Error("解析服务需要无账号、查询参数的公网 HTTPS 地址");
  return url.toString();
}

export function parserProxy(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port) throw new Error("解析代理只接受本机已有的无凭据 HTTP(S) 代理地址");
  return url.toString();
}

function youtubeNetwork(value: unknown): YoutubeNetworkSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("YouTube网络设置格式无效");
  const setting = value as { mode?: unknown; proxyUrl?: unknown };
  if (typeof setting.mode !== "string" || !["auto", "direct", "proxy"].includes(setting.mode)) throw new Error("YouTube网络模式可选auto、direct或proxy");
  if (setting.mode !== "proxy") {
    if (setting.proxyUrl !== undefined) throw new Error("自动或直连模式不需要代理地址");
    return { mode: setting.mode as "auto" | "direct" };
  }
  if (typeof setting.proxyUrl !== "string" || !setting.proxyUrl.trim()) throw new Error("请选择正在运行的本机HTTP(S)代理地址");
  try { return { mode: "proxy", proxyUrl: parserProxy(setting.proxyUrl.trim()) }; }
  catch { throw new Error("YouTube代理只接受本机已有、无凭据的HTTP(S)地址及端口"); }
}

export async function readContentSettings(runtimeRoot: string): Promise<ContentSettings> {
  try {
    const file = await containedFile(runtimeRoot, FILE);
    if ((await fs.stat(file)).size > 16 * 1024) throw new Error("本地采集设置超过读取上限");
    const settings = JSON.parse(await fs.readFile(file, "utf8")) as ContentSettings;
    const parser = settings.wechatChannelsParser;
    if (settings.schemaVersion !== 1 || !parser || typeof parser.enabled !== "boolean" || typeof parser.endpoint !== "string") throw new Error("本地采集设置格式无效");
    return { schemaVersion: 1, wechatChannelsParser: { enabled: parser.enabled, endpoint: parserEndpoint(parser.endpoint), ...(parser.proxyUrl ? { proxyUrl: parserProxy(parser.proxyUrl) } : {}) }, ...(settings.youtubeNetwork === undefined ? {} : { youtubeNetwork: youtubeNetwork(settings.youtubeNetwork) }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
    throw error;
  }
}

export async function configureVideoParser(runtimeRoot: string, enabled: boolean, endpoint?: string, proxyUrl?: string): Promise<ContentSettings> {
  // Validate before touching the existing setting.
  const address = endpoint === undefined ? undefined : parserEndpoint(endpoint);
  const proxy = proxyUrl === undefined ? undefined : parserProxy(proxyUrl);
  const settings = await readContentSettings(runtimeRoot);
  settings.wechatChannelsParser = { ...settings.wechatChannelsParser, enabled, ...(address ? { endpoint: address } : {}), ...(proxy ? { proxyUrl: proxy } : {}) };
  await atomicJson(await writableFile(runtimeRoot, FILE), settings);
  return settings;
}

export async function configureYoutubeNetwork(runtimeRoot: string, mode: unknown, proxyUrl?: unknown): Promise<ContentSettings> {
  const network = youtubeNetwork({ mode, ...(proxyUrl === undefined ? {} : { proxyUrl }) });
  const settings = await readContentSettings(runtimeRoot);
  settings.youtubeNetwork = network;
  await atomicJson(await writableFile(runtimeRoot, FILE), settings);
  return settings;
}

/** A service credential is scoped to an exact endpoint and is never part of public settings. */
export async function readParserCredential(runtimeRoot: string, endpoint: string): Promise<string | undefined> {
  try {
    const file = await containedFile(runtimeRoot, ".content-parser-auth.json");
    if ((await fs.stat(file)).size > 16 * 1024) throw new Error("解析服务凭证文件超过读取上限");
    let auth: { schemaVersion?: number; endpoint?: string; credential?: string };
    try { auth = JSON.parse(await fs.readFile(file, "utf8")); }
    catch { throw new Error("解析服务凭证文件格式无效"); }
    if (!auth || auth.schemaVersion !== 1 || typeof auth.endpoint !== "string" || typeof auth.credential !== "string" || !auth.credential.trim() || /[\x00-\x1f\x7f]/.test(auth.credential) || auth.credential.length > 4096) throw new Error("解析服务凭证文件格式无效");
    return parserEndpoint(auth.endpoint) === parserEndpoint(endpoint) ? auth.credential.trim() : undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
