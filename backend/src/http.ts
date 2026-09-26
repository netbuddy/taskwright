/**
 * 路由与各接口（node:http，无框架）。所有路径以 /api/v1 开头；错误一律是 {"ok": false, "error": {code, message, data}}。
 * 这一版接上的是读取一侧、建任务与上传材料；启动 pi、事件流与转交用户操作的几个接口返回 not_implemented。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { ApiError } from "./errors.ts";
import * as library from "./library.ts";
import * as render from "./render.ts";
import { or } from "./py.ts";
import { MAX_UPLOAD, type Service, taskTypes, wordsLocator } from "./service.ts";

/** 材料原样取回时按扩展名给的内容类型；不在表里的给 application/octet-stream。 */
export const RAW_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

type Params = Record<string, string>;
interface Request {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  body: Buffer;
  params: Params;
}
interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  close?: boolean;
}
type Handler = (service: Service, req: Request) => Reply;

// ───────────── URL 的解码（与 Python 的 urllib.parse 相同） ─────────────

/** %XX 按 UTF-8 解码，不合法的字节换成替换字符；plus 为真时加号换成空格。 */
export function unquote(text: string, plus = false): string {
  const source = plus ? text.replaceAll("+", " ") : text;
  if (!source.includes("%")) return source;
  const out: string[] = [];
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) out.push(new TextDecoder("utf-8").decode(Uint8Array.from(bytes)));
    bytes = [];
  };
  for (let i = 0; i < source.length; i++) {
    const hex = source.slice(i + 1, i + 3);
    if (source[i] === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      flush();
      out.push(source[i]);
    }
  }
  flush();
  return out.join("");
}

/** 查询串 → 每个键取最后一个值；没有等号或值为空的项丢掉。 */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const value = pair.slice(at + 1);
    if (!value.length) continue;
    out[unquote(pair.slice(0, at), true)] = unquote(value, true);
  }
  return out;
}

// ───────────── 响应 ─────────────

export function json(status: number, body: unknown): Reply {
  return { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: Buffer.from(JSON.stringify(body), "utf-8") };
}

function bodyJson(req: Request): Record<string, any> {
  if (!req.body.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(req.body.toString("utf-8") || "{}");
  } catch {
    throw new ApiError("bad_request", "请求体不是合法的 JSON。");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiError("bad_request", "请求体应当是一个 JSON 对象。");
  return value as Record<string, any>;
}

// ───────────── multipart ─────────────

/** Content-Disposition 之类的头里的参数：name="…"（引号里的反斜杠转义还原）、name=token、name*=UTF-8''%XX。 */
export function headerParams(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const key = m[1].toLowerCase();
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].trim();
    if (key.endsWith("*")) {
      const parts = /^([^']*)'[^']*'(.*)$/.exec(raw);
      out[key.slice(0, -1)] = parts ? unquote(parts[2]) : raw;
      out[key] = raw;
    } else if (!(key in out)) {
      out[key] = raw;
    }
  }
  return out;
}

/** 取出 multipart 请求里的第一个文件：[文件名, 内容]。 */
export function parseMultipart(contentType: string, body: Buffer): [string, Buffer] {
  const boundary = headerParams(";" + contentType.split(";").slice(1).join(";")).boundary;
  if (contentType.split(";")[0].trim().toLowerCase().startsWith("multipart/") && boundary) {
    const delimiter = Buffer.from(`--${boundary}`, "latin1");
    let at = body.indexOf(delimiter);
    while (at >= 0) {
      let start = at + delimiter.length;
      if (body.slice(start, start + 2).toString("latin1") === "--") break;
      const lineEnd = body.indexOf("\r\n", start);
      if (lineEnd < 0) break;
      start = lineEnd + 2;
      const next = body.indexOf(Buffer.from(`\r\n--${boundary}`, "latin1"), start);
      const part = body.subarray(start, next >= 0 ? next : body.length);
      const headerEnd = part.indexOf("\r\n\r\n");
      const head = headerEnd >= 0 ? part.subarray(0, headerEnd).toString("utf-8") : part.toString("utf-8");
      const content = headerEnd >= 0 ? part.subarray(headerEnd + 4) : Buffer.alloc(0);
      const headers = new Map<string, string>();
      for (const line of head.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const disposition = headerParams(";" + (headers.get("content-disposition") ?? "").split(";").slice(1).join(";"));
      const typeParams = headerParams(";" + (headers.get("content-type") ?? "").split(";").slice(1).join(";"));
      const name = disposition.filename ?? typeParams.name;
      if (name) return [name, Buffer.from(content)];
      if (next < 0) break;
      at = next + 2;
    }
  }
  throw new ApiError("bad_request", "请求里没有文件。");
}

// ───────────── 各接口 ─────────────

const notImplemented: Handler = () => {
  throw new ApiError("not_implemented", "这个接口在这一版的后端里还没有接上。");
};

function sessionParam(req: Request, body: Record<string, any> = {}): string | null {
  return or(req.query.session, null) ?? or(body.session_id, null) ?? null;
}

const handlers: Record<string, Handler> = {
  list_tasks: (service) => json(200, { ok: true, tasks: service.listTasks() }),
  list_task_types: () => json(200, { ok: true, task_types: taskTypes() }),
  create_task: (service, req) => json(200, service.create(bodyJson(req))),
  get_task: (service, req) => json(200, { ok: true, ...service.taskPage(service.task(req.params.task)) }),
  list_sessions: (service, req) => json(200, { ok: true, sessions: service.task(req.params.task).sessions.list() }),
  revisions: (service, req) => {
    const rows = library.itemRevisions(service.task(req.params.task).dir, req.params.item);
    if (rows === null) throw new ApiError("not_found", `没有条目 ${req.params.item}。`);
    return json(200, { ok: true, item_id: req.params.item, revisions: rows });
  },
  revision_log: (service, req) => json(200, { ok: true, ...service.revisionLog(service.task(req.params.task)) }),
  material: (service, req) => {
    const t = service.task(req.params.task);
    const rel = req.query.path ?? "";
    const target = service.materialPath(t, rel);
    if (!isFile(target)) throw new ApiError("not_found", `没有材料 ${rel}。`);
    return json(200, { ok: true, path: rel, text: service.materialText(target, rel) });
  },
  material_raw: (service, req) => {
    const t = service.task(req.params.task);
    const rel = req.query.path ?? "";
    const target = service.materialPath(t, rel);
    if (!isFile(target)) throw new ApiError("not_found", `没有材料 ${rel}。`);
    return { status: 200, headers: { "Content-Type": RAW_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream" }, body: readFileSync(target) };
  },
  upload: (service, req) => {
    const t = service.task(req.params.task);
    const [name, data] = parseMultipart(String(req.headers["content-type"] ?? ""), req.body);
    return json(200, service.upload(t, name, data, sessionParam(req)));
  },
  documents: (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    if (or(body.format, "markdown") !== "markdown") throw new ApiError("bad_request", "现在只支持 markdown。");
    const lib = library.libraryOf(t.dir);
    const [revisionNo, items] = render.documentRequest(body);
    const text = render.render(t.dir, lib, revisionNo, items, wordsLocator(t));
    if (req.params.mode === "preview") return json(200, { ok: true, text });
    return {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${t.taskId}.md"` },
      body: Buffer.from(text, "utf-8"),
    };
  },
  // 下面几个接口要启动或驱动 pi，这一版还没有接上。
  new_session: notImplemented,
  events: notImplemented,
  snapshot: notImplemented,
  conversation: notImplemented,
  messages: notImplemented,
  actions: notImplemented,
  control: notImplemented,
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const T = "(?<task>[^/]+)";
export const ROUTES: [string, RegExp, string][] = ([
  ["GET", "/api/v1/tasks", "list_tasks"],
  ["GET", "/api/v1/task-types", "list_task_types"],
  ["POST", "/api/v1/tasks", "create_task"],
  ["GET", `/api/v1/tasks/${T}`, "get_task"],
  ["GET", `/api/v1/tasks/${T}/sessions`, "list_sessions"],
  ["POST", `/api/v1/tasks/${T}/sessions`, "new_session"],
  ["GET", `/api/v1/tasks/${T}/events`, "events"],
  ["GET", `/api/v1/tasks/${T}/snapshot`, "snapshot"],
  ["GET", `/api/v1/tasks/${T}/items/(?<item>[^/]+)/revisions`, "revisions"],
  ["GET", `/api/v1/tasks/${T}/revisions`, "revision_log"],
  ["GET", `/api/v1/tasks/${T}/materials/content`, "material"],
  ["GET", `/api/v1/tasks/${T}/materials/raw`, "material_raw"],
  ["POST", `/api/v1/tasks/${T}/materials`, "upload"],
  ["GET", `/api/v1/tasks/${T}/conversation`, "conversation"],
  ["POST", `/api/v1/tasks/${T}/messages`, "messages"],
  ["POST", `/api/v1/tasks/${T}/actions`, "actions"],
  ["POST", `/api/v1/tasks/${T}/control`, "control"],
  ["POST", `/api/v1/tasks/${T}/documents/(?<mode>preview|download)`, "documents"],
] as const).map(([m, p, n]) => [m, new RegExp(`^${p}$`, "s"), n]);

/** 路由分派：找到方法与路径都对得上的第一个接口，交给它；找不到是 not_found；接口抛的 ApiError 按错误形状回答。 */
export function dispatch(service: Service, req: Omit<Request, "params">): Reply {
  try {
    for (const [method, pattern, name] of ROUTES) {
      const match = pattern.exec(req.path);
      if (method === req.method && match) return handlers[name](service, { ...req, params: { ...(match.groups ?? {}) } });
    }
    throw new ApiError("not_found", `没有这个接口：${req.method} ${req.path}`);
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, error.body());
    console.error(error);
    return json(500, { ok: false, error: { code: "internal", message: "后端出错了。", data: { detail: String((error as Error)?.message ?? error) } } });
  }
}

const UNSUPPORTED = (method: string) => Buffer.from(`<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: 501</p>
        <p>Message: Unsupported method ('${method}').</p>
        <p>Error code explanation: 501 - Server does not support this operation.</p>
    </body>
</html>
`, "utf-8");

function send(res: ServerResponse, reply: Reply, head = false): void {
  const headers: Record<string, string | number> = { ...reply.headers, "Content-Length": reply.body.length };
  if (reply.close) headers.Connection = "close";
  res.writeHead(reply.status, headers);
  res.end(head ? undefined : reply.body);
}

/** 上传请求体的上限：文件 5 MB 加 multipart 的包装。更大的请求不读，直接以 too_large 拒绝。 */
const MAX_BODY = MAX_UPLOAD + 64 * 1024;

export function makeServer(service: Service) {
  return createServer((incoming, res) => {
    const method = incoming.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      send(res, { status: 501, headers: { "Content-Type": "text/html;charset=utf-8" }, body: UNSUPPORTED(method), close: true }, method === "HEAD");
      return;
    }
    const raw = incoming.url ?? "/";
    const q = raw.indexOf("?");
    const rawPath = (q >= 0 ? raw.slice(0, q) : raw).split("#")[0];
    const query = parseQuery(q >= 0 ? raw.slice(q + 1).split("#")[0] : "");
    const path = unquote(rawPath).replace(/\/+$/, "") || "/";
    const length = Number(incoming.headers["content-length"] ?? 0) || 0;
    const upload = /^\/api\/v1\/tasks\/([^/]+)\/materials$/s.exec(path);
    if (method === "POST" && length > MAX_BODY && upload) {
      // 与大文件有关的只有上传：先认任务（任务不在时照常报 not_found），再不读请求体就以 too_large 拒绝，并关掉这条连接。
      let reply: Reply;
      try {
        service.task(upload[1]);
        reply = json(413, new ApiError("too_large", "单个文件不能超过 5 MB。").body());
      } catch (error) {
        reply = error instanceof ApiError ? json(error.status, error.body()) : json(500, { ok: false, error: { code: "internal", message: "后端出错了。", data: { detail: String(error) } } });
      }
      send(res, { ...reply, close: true });
      incoming.resume();
      return;
    }
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).subarray(0, length);
      send(res, dispatch(service, { method, path, query, headers: incoming.headers, body }));
    });
    incoming.on("error", () => res.destroy());
  });
}
