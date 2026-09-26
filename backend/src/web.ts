/**
 * 网页静态文件：启动时给了 --web <目录>，不以 /api/ 开头的 GET 请求就从这个目录出文件。
 * 前端是单页应用，找不到对应文件的路径一律回首页 index.html，由前端自己认路径；解码后跳出目录的路径拒绝（400）。
 * 首页不让浏览器缓存（换了版本立刻生效），其余文件由构建工具在文件名里带内容摘要，照常缓存。
 */

import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
};

export interface WebReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 这个路径该不该由网页静态文件回答：/api 与 /api/ 下的一律归接口。 */
export function isWebPath(path: string): boolean {
  return path !== "/api" && !path.startsWith("/api/");
}

/** 按已解码的请求路径（以 / 开头）从 webDir 取文件；取不到回首页，跳出目录回 400。 */
export function webFile(webDir: string, path: string): WebReply {
  const root = resolve(webDir);
  const target = resolve(root, `.${path.startsWith("/") ? path : `/${path}`}`);
  if (target !== root && !target.startsWith(root + sep)) {
    return { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: Buffer.from("请求的路径不在网页目录里。\n", "utf-8") };
  }
  const file = isFile(target) ? target : resolve(root, "index.html");
  if (!isFile(file)) {
    return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: Buffer.from(`网页目录里没有 index.html：${root}\n`, "utf-8") };
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type };
  if (file.endsWith(`${sep}index.html`)) headers["Cache-Control"] = "no-cache";
  return { status: 200, headers, body: readFileSync(file) };
}
